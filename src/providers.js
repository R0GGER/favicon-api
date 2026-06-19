const cheerio = require('cheerio');
const sharp = require('sharp');
const { LRUCache } = require('lru-cache');
const { upstreamFetch, ipv4Dispatcher, ipv4Http1Dispatcher } = require('./upstreamFetch');

const UPSTREAM_TIMEOUT = parseInt(process.env.UPSTREAM_TIMEOUT || '5000', 10);

const BESTICON_URL = (process.env.BESTICON_URL || '').replace(/\/+$/, '');

// In-memory cache for the enriched scraper icons list. Probing 8+ candidate
// URLs (besticon + static hints + sized variants) on every /:domain/json
// request would add seconds of latency for the UI's size-button strip, so we
// reuse the probe result for a configurable TTL (default: 1 hour).
const SCRAPER_ICONS_CACHE_TTL_MS =
  parseInt(process.env.SCRAPER_ICONS_CACHE_TTL || '3600', 10) * 1000;
const SCRAPER_ICONS_CACHE_MAX =
  parseInt(process.env.SCRAPER_ICONS_CACHE_MAX || '500', 10);

const scraperIconsCache = new LRUCache({
  max: SCRAPER_ICONS_CACHE_MAX,
  ttl: SCRAPER_ICONS_CACHE_TTL_MS,
});

const SCRAPER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const STANDARD_FALLBACKS = [
  '/apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png',
  '/android-chrome-512x512.png',
];

// CDN entry points for domains whose homepage HTML may not expose any
// recognisable icon link (e.g. Reddit's JS-challenge interstitial served to
// datacenter IPs). The variant-expansion below grows these into 128–512 sizes.
const STATIC_CDN_HINTS = {
  'reddit.com': 'https://www.redditstatic.com/shreddit/assets/favicon/64x64.png',
  'www.reddit.com': 'https://www.redditstatic.com/shreddit/assets/favicon/64x64.png',
};

const HTML_MIN_BYTES = 256;

function scraperDocumentHeaders(referer, dest = 'document') {
  const headers = {
    'User-Agent': SCRAPER_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Dest': dest,
    'Sec-Fetch-Mode': dest === 'document' ? 'navigate' : 'cors',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': dest === 'document' ? '?1' : undefined,
  };
  if (referer) {
    headers.Referer = referer;
    headers['Sec-Fetch-Site'] = 'same-origin';
  }
  for (const key of Object.keys(headers)) {
    if (headers[key] === undefined) delete headers[key];
  }
  return headers;
}

function scraperImageHeaders(referer, url) {
  const headers = {
    'User-Agent': SCRAPER_USER_AGENT,
    Accept: 'image/avif,image/webp,image/apng,image/png,image/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Dest': 'image',
    'Sec-Fetch-Mode': 'no-cors',
  };
  if (referer) {
    headers.Referer = referer;
    try {
      const sameOrigin = new URL(referer).origin === new URL(url).origin;
      headers['Sec-Fetch-Site'] = sameOrigin ? 'same-origin' : 'cross-site';
      if (!sameOrigin) headers.Origin = new URL(referer).origin;
    } catch {
      headers['Sec-Fetch-Site'] = 'cross-site';
    }
  }
  return headers;
}

async function fetchUpstreamRaw(url, { redirect = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT);

  try {
    const init = { signal: controller.signal };
    if (redirect) init.redirect = 'follow';
    const res = await upstreamFetch(url, init);

    if (!res.ok) return null;

    const contentType = res.headers.get('content-type') || 'image/png';
    const buffer = Buffer.from(await res.arrayBuffer());

    if (buffer.length === 0) return null;

    return { buffer, contentType, url };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchScraperAsset(url, referer) {
  // Bare upstreamFetch first — required on VPS/datacenter hosts where extra headers break CDNs.
  const bare = await fetchUpstreamRaw(url);
  if (bare) return bare;

  const minimal = {
    'User-Agent': SCRAPER_USER_AGENT,
    Accept: 'image/avif,image/webp,image/apng,image/png,image/*;q=0.8',
  };
  if (referer) minimal.Referer = referer;

  const result = await fetchFavicon(url, scraperImageHeaders(referer, url));
  if (result) return result;

  return fetchFavicon(url, minimal);
}

function isDisplayFaviconCandidate(candidate) {
  const href = candidate.href.toLowerCase();
  // Safari pinned-tab SVGs are monochrome mask icons, not UI favicons.
  if (href.includes('safari-pinned-tab') || href.includes('mask-icon')) return false;
  // PWA manifest monochrome icons (e.g. YouTube white logo for adaptive UI).
  if (href.includes('/monochrome/') || /(?:^|[/_-])white(?:[_\-./]|$)/i.test(href)) return false;
  return true;
}

function isMonochromeManifestIcon(icon) {
  const purpose = String(icon.purpose || 'any')
    .toLowerCase()
    .split(/\s+/);
  if (purpose.includes('monochrome')) return true;
  const src = String(icon.src || '').toLowerCase();
  return src.includes('/monochrome/') || /(?:^|[/_-])white(?:[_\-./]|$)/i.test(src);
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const unique = [];
  for (const c of candidates) {
    if (!isDisplayFaviconCandidate(c)) continue;
    if (!seen.has(c.href)) {
      seen.add(c.href);
      unique.push(c);
    }
  }
  return unique;
}

// Stop probing larger NxN variants when pixel size jumps too sharply — some CDNs
// host unrelated marketing art at 512x512 while 64–192 are the actual favicon set
// (e.g. redditstatic.com/shreddit/assets/favicon/).
const MAX_FAVICON_SIZE_JUMP = 2.5;

const SCRAPER_PROBE_BATCH_SIZE = parseInt(
  process.env.SCRAPER_PROBE_BATCH_SIZE || '4',
  10
);

async function runInBatches(items, batchSize, worker) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const settled = await Promise.allSettled(batch.map(worker));
    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value) results.push(s.value);
    }
  }
  return results;
}

function faviconVariantGroupKey(href) {
  const m = href.match(/^(.*\/)(\d+)x\2(\.(?:png|webp|jpe?g))(\?.*)?$/i);
  if (!m) return null;
  return `${m[1]}${m[3]}${m[4] || ''}`;
}

// Probe well-known larger size variants for URLs that follow an NxN pattern,
// e.g. .../favicon/64x64.png -> .../favicon/{128x128,192x192,256x256,512x512}.png
// Many SPAs (Reddit, etc.) only expose a single small icon in SSR/interstitial
// HTML while larger variants exist on the same CDN path.
const SIZE_VARIANTS = [128, 152, 180, 192, 256, 384, 512];

function expandSizedVariants(href) {
  const out = [];
  const m = href.match(/^(.*\/)(\d+)x\2(\.(?:png|webp|jpe?g))(\?.*)?$/i);
  if (!m) return out;
  const [, prefix, currentSize, ext, qs = ''] = m;
  const current = parseInt(currentSize, 10);
  for (const size of SIZE_VARIANTS) {
    if (size === current) continue;
    out.push({
      href: `${prefix}${size}x${size}${ext}${qs}`,
      sizes: `${size}x${size}`,
      type: '',
    });
  }
  return out;
}

function candidateDeclaredSize(candidate) {
  return parseSizesAttr(candidate.sizes) || 0;
}

function rankCandidates(candidates) {
  return dedupeCandidates(candidates)
    .map((c) => ({ ...c, declaredSize: parseSizesAttr(c.sizes) }))
    .sort((a, b) => {
      if (b.declaredSize !== a.declaredSize) return b.declaredSize - a.declaredSize;
      return formatScore(b.type) - formatScore(a.type);
    });
}

async function probeScraperCandidates(candidates, referer, limit = 16) {
  const slice = candidates.slice(0, limit);
  const variantGroups = new Map();
  const loose = [];

  for (const candidate of slice) {
    const key = faviconVariantGroupKey(candidate.href);
    if (key) {
      if (!variantGroups.has(key)) variantGroups.set(key, []);
      variantGroups.get(key).push(candidate);
    } else {
      loose.push(candidate);
    }
  }

  let best = null;
  let bestScore = -1;

  function updateBest(result, width, format) {
    const score = width * 100 + formatScore(format);
    if (score > bestScore) {
      bestScore = score;
      best = { ...result, provider: 'scraper' };
    }
  }

  async function probeOne(candidate) {
    const result = await fetchScraperAsset(candidate.href, referer);
    if (!result) return null;

    try {
      const meta = await sharp(result.buffer).metadata();
      const width = Math.min(meta.width || 0, meta.height || 0);
      const format = meta.format || '';
      if (width <= 0) return null;
      return { result, width, format };
    } catch {
      return null;
    }
  }

  // Variant groups: process groups in parallel, but keep the sequential
  // size-jump heuristic inside each group intact.
  async function processGroup(group) {
    const sorted = [...group].sort(
      (a, b) => candidateDeclaredSize(a) - candidateDeclaredSize(b) || a.href.localeCompare(b.href)
    );
    const hits = [];
    let lastWidth = 0;
    for (const candidate of sorted) {
      const hit = await probeOne(candidate);
      if (!hit) continue;
      if (lastWidth > 0 && hit.width > lastWidth * MAX_FAVICON_SIZE_JUMP) break;
      lastWidth = hit.width;
      hits.push(hit);
    }
    return hits;
  }

  const groupResults = await Promise.all(
    [...variantGroups.values()].map(processGroup)
  );
  for (const hits of groupResults) {
    for (const hit of hits) updateBest(hit.result, hit.width, hit.format);
  }

  // Loose candidates: probe in parallel batches.
  const looseHits = await runInBatches(loose, SCRAPER_PROBE_BATCH_SIZE, probeOne);
  for (const hit of looseHits) updateBest(hit.result, hit.width, hit.format);

  return best;
}

const PROVIDERS = {
  google: (domain, size = 32) =>
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${size}`,
  googleV2: (domain, size = 128) =>
    `https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://${encodeURIComponent(domain)}&size=${size}`,
  duckduckgo: (domain) =>
    `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`,
  yandex: (domain) =>
    `https://favicon.yandex.net/favicon/${encodeURIComponent(domain)}`,
  faviconSo: (domain) =>
    `https://favicon.so/api/favicon?url=${encodeURIComponent(domain)}`,
  vemetric: (domain, size, format) => {
    const params = new URLSearchParams();
    if (size) params.set('size', size);
    if (format) params.set('format', format);
    const qs = params.toString();
    return `https://favicon.vemetric.com/${encodeURIComponent(domain)}${qs ? '?' + qs : ''}`;
  },
  faviconDev: (domain) =>
    `https://favicon-3j1.pages.dev/favicon/${encodeURIComponent(domain)}`,
  faviconkit: (domain, size = 128) =>
    `https://ico.faviconkit.net/favicon/${encodeURIComponent(domain)}?sz=${size}`,
  logoDev: (domain, token) =>
    `https://img.logo.dev/${encodeURIComponent(domain)}?token=${encodeURIComponent(token || '')}`,
  selfhst: (service, variant = 'color') => {
    const suffix = variant === 'light' ? '-light' : variant === 'dark' ? '-dark' : '';
    return `https://cdn.jsdelivr.net/gh/selfhst/icons/png/${encodeURIComponent(service)}${suffix}.png`;
  },
};

async function fetchFavicon(url, requestHeaders) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT);

  try {
    const res = await upstreamFetch(url, {
      signal: controller.signal,
      headers: requestHeaders || { 'User-Agent': 'FaviconProxy/1.0' },
    });

    if (!res.ok) return null;

    const contentType = res.headers.get('content-type') || 'image/png';
    const buffer = Buffer.from(await res.arrayBuffer());

    if (buffer.length === 0) return null;

    return { buffer, contentType, url };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGoogle(domain, size = 32) {
  const url = PROVIDERS.google(domain, size);
  const result = await fetchFavicon(url);
  return result ? { ...result, provider: 'google' } : null;
}

async function fetchGoogleV2(domain, size = 128) {
  const url = PROVIDERS.googleV2(domain, size);
  const result = await fetchFavicon(url);
  return result ? { ...result, provider: 'googlev2' } : null;
}

async function fetchDuckDuckGo(domain) {
  const url = PROVIDERS.duckduckgo(domain);
  const result = await fetchFavicon(url);
  return result ? { ...result, provider: 'duckduckgo' } : null;
}

async function fetchYandex(domain) {
  const url = PROVIDERS.yandex(domain);
  const result = await fetchFavicon(url);
  return result ? { ...result, provider: 'yandex' } : null;
}

async function fetchFaviconSo(domain) {
  const url = PROVIDERS.faviconSo(domain);
  const result = await fetchFavicon(url);
  return result ? { ...result, provider: 'faviconso' } : null;
}

async function fetchVemetric(domain, size, format) {
  const url = PROVIDERS.vemetric(domain, size, format);
  const result = await fetchFavicon(url);
  return result ? { ...result, provider: 'vemetric' } : null;
}

async function fetchFaviconDev(domain) {
  const url = PROVIDERS.faviconDev(domain);
  const result = await fetchFavicon(url);
  return result ? { ...result, provider: 'favicondev' } : null;
}

async function fetchFaviconkit(domain, size = 128) {
  const url = PROVIDERS.faviconkit(domain, size);
  const result = await fetchFavicon(url);
  return result ? { ...result, provider: 'faviconkit' } : null;
}

async function fetchLogoDev(domain) {
  const token = process.env.LOGODEV_TOKEN;
  if (!token) return null;
  const url = PROVIDERS.logoDev(domain, token);
  const result = await fetchFavicon(url);
  return result ? { ...result, provider: 'logodev' } : null;
}

async function fetchSelfhst(service, variant = 'color') {
  const url = PROVIDERS.selfhst(service, variant);
  const result = await fetchFavicon(url);
  return result ? { ...result, provider: 'selfhst' } : null;
}

// Parse "16x16" / "32x32 64x64" sizes attribute, return largest square dimension or 0.
function parseSizesAttr(sizes) {
  if (!sizes || typeof sizes !== 'string') return 0;
  if (sizes.toLowerCase() === 'any') return 1024;
  let max = 0;
  for (const token of sizes.trim().split(/\s+/)) {
    const m = token.match(/^(\d+)x(\d+)$/i);
    if (m) {
      const w = parseInt(m[1], 10);
      const h = parseInt(m[2], 10);
      max = Math.max(max, Math.min(w, h));
    }
  }
  return max;
}

function formatScore(format) {
  if (!format) return 0;
  const f = format.toLowerCase();
  if (f === 'svg' || f === 'svg+xml') return 50;
  if (f === 'png') return 40;
  if (f === 'webp') return 35;
  if (f === 'ico' || f === 'x-icon') return 20;
  return 10;
}


async function fetchManifestIcons(manifestUrl, referer) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT);
  try {
    let res = await upstreamFetch(manifestUrl, { signal: controller.signal });
    if (!res.ok) {
      res = await upstreamFetch(manifestUrl, {
        signal: controller.signal,
        headers: scraperDocumentHeaders(referer, 'manifest'),
      });
    }
    if (!res.ok) return [];
    const json = await res.json();
    if (!json || !Array.isArray(json.icons)) return [];
    return json.icons
      .filter((icon) => {
        if (!icon || !icon.src || isMonochromeManifestIcon(icon)) return false;
        const size = parseSizesAttr(icon.sizes || '');
        return size >= 512;
      })
      .map((icon) => ({
        href: new URL(icon.src, manifestUrl).toString(),
        sizes: icon.sizes || '',
        type: icon.type || '',
      }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function pageUrlsForDomain(domain) {
  const urls = [`https://${domain}/`];
  if (!domain.startsWith('www.')) urls.push(`https://www.${domain}/`);
  return urls;
}

function staticHintCandidates(domain) {
  const lower = domain.toLowerCase();
  const bare = lower.replace(/^www\./, '');
  const href = STATIC_CDN_HINTS[lower] || STATIC_CDN_HINTS[bare];
  if (!href) return [];
  return [{ href, sizes: '64x64', type: 'image/png' }];
}

// Build extra candidate URLs for a domain by combining:
//   - static CDN hints (e.g. redditstatic.com/.../64x64.png for reddit.com)
//   - sized variants of each hint (128, 152, 180, 192, ...)
//   - sized variants of any URLs we already know about (`knownUrls`)
// URLs already present in `knownUrls` are skipped so the caller can keep its
// pre-existing metadata (besticon already returns widths for those).
function deriveHintCandidates(domain, knownUrls = []) {
  const seen = new Set(knownUrls);
  const out = [];

  function pushUnique(candidate) {
    if (!candidate || !candidate.href) return;
    if (seen.has(candidate.href)) return;
    seen.add(candidate.href);
    out.push(candidate);
  }

  for (const hint of staticHintCandidates(domain)) {
    pushUnique(hint);
    for (const v of expandSizedVariants(hint.href)) pushUnique(v);
  }

  for (const url of knownUrls) {
    for (const v of expandSizedVariants(url)) pushUnique(v);
  }

  return out;
}

async function probeIconMetadata(href, referer) {
  const result = await fetchScraperAsset(href, referer);
  if (!result) return null;
  try {
    const meta = await sharp(result.buffer).metadata();
    const width = meta.width || 0;
    const height = meta.height || 0;
    if (width <= 0 || height <= 0) return null;
    return {
      url: href,
      width,
      height,
      format: meta.format ? String(meta.format).toLowerCase() : null,
      bytes: result.buffer.length,
    };
  } catch {
    return null;
  }
}

// Returns the merged + sorted list of every icon we can find for `domain`:
// besticon's discoveries plus anything we can reach ourselves via the static
// CDN hints and sized-variant expansion. This is the source of truth for the
// /:domain/json icons array shown as the size-button strip on the UI.
async function fetchScraperAllIcons(domain) {
  const cached = scraperIconsCache.get(domain);
  if (cached) return cached;

  const referer = `https://${domain}/`;
  const besticonIcons = BESTICON_URL ? await fetchBesticonAllIcons(domain) : [];

  const byUrl = new Map();
  for (const icon of besticonIcons) {
    if (!icon || !icon.url || byUrl.has(icon.url)) continue;
    byUrl.set(icon.url, { ...icon });
  }

  const extras = deriveHintCandidates(domain, [...byUrl.keys()]);

  if (extras.length > 0) {
    const probed = await runInBatches(extras, SCRAPER_PROBE_BATCH_SIZE, (c) =>
      probeIconMetadata(c.href, referer)
    );
    for (const p of probed) {
      if (p && p.url && !byUrl.has(p.url)) byUrl.set(p.url, p);
    }
  }

  const sorted = [...byUrl.values()].sort((a, b) => {
    const areaA = (a.width || 0) * (a.height || a.width || 0);
    const areaB = (b.width || 0) * (b.height || b.width || 0);
    if (areaB !== areaA) return areaB - areaA;
    return (b.width || 0) - (a.width || 0);
  });

  scraperIconsCache.set(domain, sorted);
  return sorted;
}

async function fetchScraperPage(domain) {
  const baseUrl = `https://${domain}/`;
  const attempts = [
    { label: 'bare-h2', dispatcher: ipv4Dispatcher, headers: null },
    { label: 'bare-h1', dispatcher: ipv4Http1Dispatcher, headers: null },
    {
      label: 'curl-h1',
      dispatcher: ipv4Http1Dispatcher,
      headers: { 'User-Agent': 'curl/8.7.1', Accept: 'text/html,*/*' },
    },
    {
      label: 'chrome-h1',
      dispatcher: ipv4Http1Dispatcher,
      headers: {
        'User-Agent': SCRAPER_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    },
    {
      label: 'chrome-doc-h1',
      dispatcher: ipv4Http1Dispatcher,
      headers: (url) => scraperDocumentHeaders(url),
    },
  ];

  for (const pageUrl of pageUrlsForDomain(domain)) {
    for (const attempt of attempts) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT);
      try {
        const init = {
          signal: controller.signal,
          redirect: 'follow',
          dispatcher: attempt.dispatcher,
        };
        if (attempt.headers) {
          init.headers =
            typeof attempt.headers === 'function' ? attempt.headers(pageUrl) : attempt.headers;
        }
        const res = await upstreamFetch(pageUrl, init);
        if (!res.ok) continue;
        const html = await res.text();
        if (html.length >= HTML_MIN_BYTES) {
          return {
            html,
            finalBaseUrl: res.url || pageUrl,
            htmlFetchMethod: `${attempt.label} ${pageUrl}`,
          };
        }
      } catch {
        /* try next */
      } finally {
        clearTimeout(timer);
      }
    }
  }

  return { html: null, finalBaseUrl: baseUrl, htmlFetchMethod: null };
}


function parseIconCandidatesFromHtml(html, finalBaseUrl) {
  const linkCandidates = [];
  const $ = cheerio.load(html);
  const baseHref = $('base[href]').attr('href');
  const resolveBase = baseHref
    ? new URL(baseHref, finalBaseUrl).toString()
    : finalBaseUrl;

  $('link[rel]').each((_, el) => {
    const rel = ($(el).attr('rel') || '').toLowerCase();
    const href = $(el).attr('href');
    if (!href) return;

    const relTokens = rel.split(/\s+/);
    const isIcon = relTokens.some((r) =>
      [
        'icon',
        'shortcut',
        'apple-touch-icon',
        'apple-touch-icon-precomposed',
        'fluid-icon',
      ].includes(r)
    );
    if (!isIcon) return;

    try {
      linkCandidates.push({
        href: new URL(href, resolveBase).toString(),
        sizes: $(el).attr('sizes') || '',
        type: $(el).attr('type') || '',
      });
    } catch {
      /* ignore invalid URLs */
    }
  });

  return {
    primaryCandidates: linkCandidates,
    resolveBase,
    linkCount: linkCandidates.length,
  };
}

async function buildScraperCandidates(domain, html, finalBaseUrl) {
  const baseUrl = `https://${domain}/`;
  const primaryCandidates = [];
  const fallbackCandidates = [];

  if (html) {
    try {
      const parsed = parseIconCandidatesFromHtml(html, finalBaseUrl);
      primaryCandidates.push(...parsed.primaryCandidates);

      const $ = cheerio.load(html);
      const manifestHref = $('link[rel="manifest"]').attr('href');
      if (manifestHref) {
        try {
          const resolveBase = parsed.resolveBase;
          const manifestUrl = new URL(manifestHref, resolveBase).toString();
          const manifestIcons = await fetchManifestIcons(manifestUrl, finalBaseUrl);
          primaryCandidates.push(...manifestIcons);
        } catch {
          /* ignore invalid manifest URL */
        }
      }
    } catch {
      /* parsing failed - fall through to fallbacks */
    }
  }

  if (primaryCandidates.length === 0) {
    primaryCandidates.push(...staticHintCandidates(domain));
  }

  const variantCandidates = [];
  for (const c of primaryCandidates) {
    variantCandidates.push(...expandSizedVariants(c.href));
  }
  primaryCandidates.push(...variantCandidates);

  for (const fallback of STANDARD_FALLBACKS) {
    try {
      fallbackCandidates.push({
        href: new URL(fallback, baseUrl).toString(),
        sizes: '',
        type: '',
      });
    } catch {
      /* ignore */
    }
  }

  return {
    rankedPrimary: rankCandidates(primaryCandidates),
    rankedFallback: rankCandidates(fallbackCandidates),
  };
}

// Query a sidecar besticon (https://github.com/mat/besticon) instance for the
// list of icons it discovered for `domain`. Besticon already runs the HTML
// scrape + manifest parse + size probing server-side and returns a JSON array
// sorted by area (largest first). Errored entries are filtered out, all
// successful icons are kept (including very small ones) so callers can decide
// what to do with them.
async function fetchBesticonAllIcons(domain) {
  if (!BESTICON_URL) return [];

  const url = `${BESTICON_URL}/allicons.json?url=${encodeURIComponent(domain)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return [];

    const body = await res.json();
    const list = Array.isArray(body) ? body : Array.isArray(body?.icons) ? body.icons : [];

    return list
      .filter((i) => i && !i.error && typeof i.url === 'string')
      .map((i) => ({
        url: i.url,
        width: Number.isFinite(i.width) ? i.width : 0,
        height: Number.isFinite(i.height) ? i.height : 0,
        format: i.format ? String(i.format).toLowerCase() : null,
        bytes: Number.isFinite(i.bytes) ? i.bytes : 0,
      }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// Convert raw besticon icons into the `{ href, sizes, type }` candidate shape
// used by rankCandidates / probeScraperCandidates.
function besticonIconsToCandidates(icons) {
  return icons
    .filter((i) => (i.width || 0) > 0)
    .map((i) => ({
      href: i.url,
      sizes: i.width ? `${i.width}x${i.height || i.width}` : '',
      type: i.format ? `image/${i.format}` : '',
    }));
}

async function fetchBesticonCandidates(domain) {
  return besticonIconsToCandidates(await fetchBesticonAllIcons(domain));
}

async function fetchScraper(domain) {
  if (BESTICON_URL) {
    const besticonCandidates = await fetchBesticonCandidates(domain);
    if (besticonCandidates.length > 0) {
      const referer = `https://${domain}/`;
      // Augment besticon's discoveries with static CDN hints + sized variants
      // so domains whose origin blocks besticon's datacenter IP (Reddit, etc.)
      // still get the full size ladder probed and the largest icon picked.
      const hintCandidates = deriveHintCandidates(
        domain,
        besticonCandidates.map((c) => c.href)
      );
      const combined = rankCandidates([...besticonCandidates, ...hintCandidates]);
      const best = await probeScraperCandidates(combined, referer, 32);
      if (best) return best;
    }
  }

  const { html, finalBaseUrl } = await fetchScraperPage(domain);
  const { rankedPrimary, rankedFallback } = await buildScraperCandidates(domain, html, finalBaseUrl);

  const bestPrimary = await probeScraperCandidates(rankedPrimary, finalBaseUrl);
  if (bestPrimary) return bestPrimary;

  return probeScraperCandidates(rankedFallback, finalBaseUrl);
}

module.exports = {
  fetchGoogle,
  fetchGoogleV2,
  fetchDuckDuckGo,
  fetchYandex,
  fetchFaviconSo,
  fetchVemetric,
  fetchFaviconDev,
  fetchFaviconkit,
  fetchLogoDev,
  fetchSelfhst,
  fetchScraper,
  fetchScraperAsset,
  fetchBesticonAllIcons,
  fetchScraperAllIcons,
  PROVIDERS,
};

const cheerio = require('cheerio');
const sharp = require('sharp');
const { upstreamFetch, ipv4Dispatcher, ipv4Http1Dispatcher } = require('./upstreamFetch');

const UPSTREAM_TIMEOUT = parseInt(process.env.UPSTREAM_TIMEOUT || '5000', 10);

const SCRAPER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const STANDARD_FALLBACKS = [
  '/apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png',
  '/android-chrome-512x512.png',
];

const STATIC_CDN_HINTS = {};

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

function faviconVariantGroupKey(href) {
  const m = href.match(/^(.*\/)(\d+)x\2(\.(?:png|webp|jpe?g))(\?.*)?$/i);
  if (!m) return null;
  return `${m[1]}${m[3]}${m[4] || ''}`;
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

  for (const group of variantGroups.values()) {
    const sorted = [...group].sort(
      (a, b) => candidateDeclaredSize(a) - candidateDeclaredSize(b) || a.href.localeCompare(b.href)
    );
    let lastWidth = 0;
    for (const candidate of sorted) {
      const hit = await probeOne(candidate);
      if (!hit) continue;
      if (lastWidth > 0 && hit.width > lastWidth * MAX_FAVICON_SIZE_JUMP) break;
      lastWidth = hit.width;
      updateBest(hit.result, hit.width, hit.format);
    }
  }

  for (const candidate of loose) {
    const hit = await probeOne(candidate);
    if (hit) updateBest(hit.result, hit.width, hit.format);
  }

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
      ['apple-touch-icon', 'apple-touch-icon-precomposed'].includes(r)
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

async function fetchScraper(domain) {
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
  PROVIDERS,
};

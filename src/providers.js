const crypto = require('crypto');
const cheerio = require('cheerio');
const sharp = require('sharp');
const {
  rasterizeSvgToSize,
  readImageDimensions,
  toDisplayPng,
  looksLikeSvg,
  isBlankFavicon,
  isUnusableIcon,
  MIN_SOURCE_SIZE,
  SVG_DISPLAY_SIZE,
  resizeIcon,
} = require('./imageNormalize');
const { LRUCache } = require('lru-cache');
const { upstreamFetch, ipv4Dispatcher, ipv4Http1Dispatcher } = require('./upstreamFetch');
const cache = require('./cache');
const scraperDiskCache = require('./scraperDiskCache');
const { serviceSlugFromDomain } = require('./serviceSlugFromDomain');
const { iconTagForDomain } = require('./domainIconTags');

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

// Homepage HTML + related upstream probes are reused across fetchScraper,
// fetchScraperAllIcons, and the v1 API so parallel /:domain/json + /s/ requests
// do not each re-fetch the same origin HTML, besticon JSON, manifests, and icons.
const scraperPageCache = new LRUCache({
  max: SCRAPER_ICONS_CACHE_MAX,
  ttl: SCRAPER_ICONS_CACHE_TTL_MS,
});
const besticonIconsCache = new LRUCache({
  max: SCRAPER_ICONS_CACHE_MAX,
  ttl: SCRAPER_ICONS_CACHE_TTL_MS,
});
const manifestFetchCache = new LRUCache({
  max: SCRAPER_ICONS_CACHE_MAX * 8,
  ttl: SCRAPER_ICONS_CACHE_TTL_MS,
});
const probeMetadataCache = new LRUCache({
  max: SCRAPER_ICONS_CACHE_MAX * 24,
  ttl: SCRAPER_ICONS_CACHE_TTL_MS,
});
const scraperPageInflight = new Map();

function invalidateScraperDomainCaches(domain) {
  scraperIconsCache.delete(domain);
  scraperPageCache.delete(domain);
  besticonIconsCache.delete(domain);
  scraperPageInflight.delete(domain);
  googleWorkspaceLogoCache.delete(domain);
  googleWorkspaceLogoInflight.delete(domain);
  scraperDiskCache.invalidateDomain(domain).catch(() => {});
}

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

// Direct manifest URLs for domains whose homepage HTML does not expose a
// <link rel="manifest"> to the scraper (SPA shells, bot interstitials).
const STATIC_MANIFEST_HINTS = {
  'ah.nl': 'https://static.ah.nl/ah-static/favicon/nld/site.webmanifest',
  'www.ah.nl': 'https://static.ah.nl/ah-static/favicon/nld/site.webmanifest',
};

const MANIFEST_BASENAMES = [
  'manifest.webmanifest',
  'site.webmanifest',
  'manifest.json',
  'app.webmanifest',
  'webmanifest.json',
];

const MANIFEST_ROOT_PREFIXES = ['', 'favicon/', 'favicons/', 'assets/', 'static/'];

const MANIFEST_PROBE_MAX = parseInt(process.env.MANIFEST_PROBE_MAX || '12', 10);

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

function assetCacheKey(url) {
  return crypto.createHash('sha1').update(url).digest('hex');
}

async function fetchScraperAssetUncached(url, referer) {
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

async function fetchScraperAsset(url, referer) {
  const key = assetCacheKey(url);

  const raw = await cache.get('asset-raw', key, null);
  if (raw?.buffer) {
    return { buffer: raw.buffer, contentType: raw.contentType, url: raw.url || url };
  }

  // Reuse bytes already on disk from /s-asset or sized scraper routes.
  const display = await cache.get('asset-v2', key, null);
  if (display?.buffer) {
    return { buffer: display.buffer, contentType: display.contentType, url: display.url || url };
  }

  const result = await fetchScraperAssetUncached(url, referer);
  if (result?.buffer) {
    await cache.set('asset-raw', key, null, { ...result, provider: 'asset-raw' });
  }
  return result;
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

// Stop treating the largest NxN variant as unrelated marketing art when the
// size jump is sharp but the URL is still under a /favicon(s)/ path (Reddit
// serves 192 and 512 in the same folder; 256 may 404 in between).
const MAX_FAVICON_SIZE_JUMP = 2.5;

function faviconVariantGroupAllowsLargeJump(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return path.includes('/favicon/') || path.includes('/favicons/');
  } catch {
    return false;
  }
}

const SCRAPER_PROBE_BATCH_SIZE = parseInt(
  process.env.SCRAPER_PROBE_BATCH_SIZE || '4',
  10
);

// Max output dimension for /s/:domain. Picks the largest available source icon,
// then downscales to this size when the source is larger. 0 = no cap.
const SCRAPER_MAX_ICON_SIZE = parseInt(process.env.SCRAPER_MAX_ICON_SIZE || '0', 10);

function scraperMaxIconSizeEnabled() {
  return Number.isFinite(SCRAPER_MAX_ICON_SIZE) && SCRAPER_MAX_ICON_SIZE > 0;
}

async function capScraperProxyOutput(entry) {
  if (!entry?.buffer || !scraperMaxIconSizeEnabled()) return entry;

  const dims = await readImageDimensions(entry.buffer, {
    contentType: entry.contentType,
    url: entry.url,
  });
  if (!dims || dims.width <= 0) return entry;

  const side = Math.min(dims.width, dims.height || dims.width);
  if (side <= SCRAPER_MAX_ICON_SIZE) return entry;

  try {
    const originalBuffer = entry.originalBuffer || entry.buffer;
    const buffer = await sharp(entry.buffer)
      .resize(SCRAPER_MAX_ICON_SIZE, SCRAPER_MAX_ICON_SIZE, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();
    return {
      ...entry,
      buffer,
      contentType: 'image/png',
      originalBuffer,
    };
  } catch {
    return entry;
  }
}

function getScraperMaxIconSize() {
  return scraperMaxIconSizeEnabled() ? SCRAPER_MAX_ICON_SIZE : 0;
}

// When true, the scraper falls back to service-icon catalogs (selfhst,
// dashboardicons) and Google faviconV2 when direct HTML scraping fails for a
// domain.  Default = true.
const SCRAPER_FALLBACK = (() => {
  const raw = String(process.env.SCRAPER_FALLBACK ?? '').trim().toLowerCase();
  if (raw === '') return true;
  return !['false', '0', 'no', 'off'].includes(raw);
})();

function getScraperFallback() {
  return SCRAPER_FALLBACK;
}

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
      best = { ...result, provider: 'scraper', sourceWidth: width };
    }
  }

  async function probeOne(candidate) {
    const result = await fetchScraperAsset(candidate.href, referer);
    if (!result) return null;

    const dims = await readImageDimensions(result.buffer, {
      contentType: result.contentType,
      url: candidate.href,
    });
    if (!dims || dims.width <= 0) return null;

    let width = Math.min(dims.width, dims.height || dims.width);
    const format = dims.format || '';
    const isSvg = format === 'svg' || looksLikeSvg(result.buffer)
      || (result.contentType || '').toLowerCase().includes('svg');
    if (isSvg) width = Math.max(width, 512);
    return { result, width, format };
  }

  // Variant groups: probe every declared size, then drop a suspiciously large
  // outlier only when it is not on a /favicon(s)/ path.
  async function processGroup(group) {
    const sorted = [...group].sort(
      (a, b) => candidateDeclaredSize(b) - candidateDeclaredSize(a) || a.href.localeCompare(b.href)
    );
    const hits = [];
    for (const candidate of sorted) {
      const hit = await probeOne(candidate);
      if (hit) hits.push(hit);
    }
    hits.sort((a, b) => b.width - a.width);
    if (hits.length >= 2) {
      const [largest, second] = hits;
      const largestUrl = largest.result.url || '';
      if (
        largest.width > second.width * MAX_FAVICON_SIZE_JUMP &&
        !faviconVariantGroupAllowsLargeJump(largestUrl)
      ) {
        hits.shift();
      }
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

  if (!best) return null;

  try {
    const displayed = await toDisplayPng(best.buffer, {
      contentType: best.contentType,
      url: best.url,
    });
    return capScraperProxyOutput({
      ...best,
      buffer: displayed.buffer,
      contentType: displayed.contentType,
      originalSvgBuffer: displayed.originalSvgBuffer || null,
      provider: 'scraper',
    });
  } catch {
    return capScraperProxyOutput({ ...best, provider: 'scraper' });
  }
}

// Upstream PNG catalogs suffix files by icon tone (-light = pale icon, -dark = dark icon).
// API/UI variants name the preview: light = pale icon on a dark background, dark = dark icon on a light background.
function pngVariantSuffix(variant) {
  if (variant === 'light') return '-light';
  if (variant === 'dark') return '-dark';
  return '';
}

// LobeHub folders follow OS color-scheme naming (light/ = for light UI, dark/ = for dark UI).
function lobehubThemeForVariant(variant) {
  if (variant === 'light') return 'dark';
  if (variant === 'dark') return 'light';
  return variant;
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
    `https://www.faviconextractor.com/favicon/${encodeURIComponent(domain)}`,
  faviconkit: (domain, size = 128) =>
    `https://ico.faviconkit.net/favicon/${encodeURIComponent(domain)}?sz=${size}`,
  logoDev: (domain, token) =>
    `https://img.logo.dev/${encodeURIComponent(domain)}?token=${encodeURIComponent(token || '')}&fallback=404`,
  brandfetch: (domain, clientId, size = 128, opts = {}) => {
    const { type, theme, format } = normalizeBrandfetchOptions(opts);
    const base = `https://cdn.brandfetch.io/${encodeURIComponent(domain)}`;
    const parts = [base];

    // SVG is vector — h/w does not change the file; only raster formats use native sizing.
    if (size > 0 && format !== 'svg') {
      parts.push(`/h/${size}/w/${size}`);
    }
    parts.push('/fallback/404');
    if (theme) parts.push(`/theme/${theme}`);
    parts.push(`/${type}.${format}`);
    return `${parts.join('')}?c=${encodeURIComponent(clientId || '')}`;
  },
  selfhst: (service, variant = 'color', format = 'png') => {
    const suffix = pngVariantSuffix(variant);
    if (format === 'svg') {
      return `https://cdn.jsdelivr.net/gh/selfhst/icons/svg/${encodeURIComponent(service)}${suffix}.svg`;
    }
    return `https://cdn.jsdelivr.net/gh/selfhst/icons/png/${encodeURIComponent(service)}${suffix}.png`;
  },
  dashboardIcons: (service, variant = 'color', format = 'png') => {
    if (format === 'svg') {
      return `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/${encodeURIComponent(service)}.svg`;
    }
    const suffix = pngVariantSuffix(variant);
    return `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/${encodeURIComponent(service)}${suffix}.png`;
  },
  lobehub: (service) => {
    const slug = encodeURIComponent(service);
    return `https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/${slug}.svg`;
  },
  svgl: (service, variant = 'color', format = 'png') => {
    const entry = getSvglEntrySync(service);
    if (!entry) return '';
    const route = svglRouteForVariant(entry, variant);
    return route ? svglAssetUrl(route) : '';
  },
  faviconRun: (domain, size = 128) =>
    `https://favicon.run/favicon?domain=${encodeURIComponent(domain)}&sz=${size}`,
  twentyIcons: (domain, size = 128) =>
    `https://twenty-icons.com/${encodeURIComponent(domain)}/${size}`,
  ryanjc: (domain) =>
    `https://api.favicon.ryanjc.com/?url=${encodeURIComponent(domain)}`,
};

const TWENTYICONS_NATIVE_SIZES = [16, 32, 64, 128, 180, 192];

function twentyIconsReferenceSize(requestedSize) {
  const idx = TWENTYICONS_NATIVE_SIZES.indexOf(requestedSize);
  if (idx <= 0) return null;
  return TWENTYICONS_NATIVE_SIZES[idx - 1];
}

async function twentyIconsUpscaleMetrics(largeBuf, smallBuf, largeSize, smallSize) {
  const ch = 4;
  const downscaled = await sharp(largeBuf)
    .resize(smallSize, smallSize)
    .ensureAlpha()
    .raw()
    .toBuffer();
  const smallRaw = await sharp(smallBuf).ensureAlpha().raw().toBuffer();
  const len = Math.min(downscaled.length, smallRaw.length);
  let sumSq = 0;
  for (let i = 0; i < len; i++) {
    const d = downscaled[i] - smallRaw[i];
    sumSq += d * d;
  }
  const rms = Math.sqrt(sumSq / len);

  const gradientEnergy = (data, w, h) => {
    let sum = 0;
    let count = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = (y * w + x) * ch;
        sum += Math.abs(data[i] - data[i - ch]) + Math.abs(data[i] - data[i + ch]);
        count++;
      }
    }
    return count ? sum / count : 0;
  };

  const largeRaw = await sharp(largeBuf).ensureAlpha().raw().toBuffer();
  const smallEnergy = gradientEnergy(smallRaw, smallSize, smallSize);
  const ratio = gradientEnergy(largeRaw, largeSize, largeSize) / Math.max(smallEnergy, 1);
  return { rms, ratio };
}

function looksLikeTwentyIconsUpscale({ rms, ratio }) {
  // Upstream often returns the correct pixel dimensions while upscaling from the
  // previous native step (e.g. reddit.com/128 is a soft 64→128 upscale).
  return ratio < 0.55 && rms < 15;
}

const FAVICON_FETCH_HEADERS = {
  'User-Agent': SCRAPER_USER_AGENT,
  Accept: 'image/avif,image/webp,image/apng,image/png,image/*;q=0.8',
};

// Brandfetch serves its own "B" mark when a domain has no icon but fallback/404
// is not honoured (or a stale cache entry used the old URL without fallback/404).
const BRANDFETCH_PLACEHOLDER_SHA256 = new Set([
  '8436afdb367436824cc3a1e960006af724a5cb7ff4087fe3c938c307389a34a6', // 128px webp
]);

function brandfetchFetchHeaders(domain, format = 'svg') {
  const headers = {
    ...FAVICON_FETCH_HEADERS,
    Referer: `https://${domain}/`,
  };
  if (format === 'svg') {
    headers.Accept = 'image/svg+xml,image/*;q=0.8';
  }
  return headers;
}

function normalizeBrandfetchOptions(opts = {}) {
  const VALID_TYPES = new Set(['icon', 'symbol', 'logo']);
  const VALID_FORMATS = new Set(['svg', 'png', 'webp', 'jpg']);
  const VALID_THEMES = new Set(['light', 'dark']);

  let type = String(opts.type || 'symbol').toLowerCase();
  let format = String(opts.format || 'svg').toLowerCase();
  if (format === 'jpeg') format = 'jpg';
  if (!VALID_TYPES.has(type)) type = 'symbol';
  if (!VALID_FORMATS.has(format)) format = 'svg';

  let theme = opts.theme ? String(opts.theme).toLowerCase() : null;
  if (theme && !VALID_THEMES.has(theme)) theme = null;

  return { type, format, theme };
}

function brandfetchCacheKey(size, opts = {}) {
  const { type, format, theme } = normalizeBrandfetchOptions(opts);
  const sizePart = format === 'svg' ? 'svg' : String(size);
  return `${sizePart}_${type}_${format}_${theme || 'color'}`;
}

function brandfetchTypeThemeAttempts(opts = {}) {
  const base = normalizeBrandfetchOptions(opts);
  if (opts.strict) {
    return [{ type: base.type, theme: base.theme }];
  }

  const attempts = [];
  const seen = new Set();
  const push = (patch) => {
    const next = normalizeBrandfetchOptions({ ...base, ...patch });
    const key = `${next.type}|${next.theme || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    attempts.push({ type: next.type, theme: next.theme });
  };

  push({});
  if (!opts.themeExplicit && base.theme) push({ theme: null });
  if (base.type !== 'icon') {
    push({ type: 'icon' });
    if (!opts.themeExplicit && base.theme) push({ type: 'icon', theme: null });
  }
  if (base.type !== 'logo') {
    push({ type: 'logo' });
    if (!opts.themeExplicit && base.theme) push({ type: 'logo', theme: null });
  }
  return attempts;
}

function brandfetchFormatAttempts(opts = {}) {
  const base = normalizeBrandfetchOptions(opts);
  if (opts.formatExplicit) return [base.format];
  if (base.format === 'svg') return ['svg', 'png', 'webp'];
  return [base.format];
}

function brandfetchAttemptOrder(opts = {}) {
  const base = normalizeBrandfetchOptions(opts);
  const formats = brandfetchFormatAttempts(opts);
  const attempts = [];
  const seen = new Set();

  for (const tt of brandfetchTypeThemeAttempts(opts)) {
    for (const format of formats) {
      const next = normalizeBrandfetchOptions({ ...base, ...tt, format });
      const key = `${next.type}|${next.format}|${next.theme || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      attempts.push(next);
    }
  }
  return attempts;
}

function isBrandfetchPlaceholder(buffer, domain) {
  if (!buffer || buffer.length === 0) return false;
  const lower = String(domain || '').toLowerCase().replace(/^www\./, '');
  if (lower === 'brandfetch.io') return false;
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  return BRANDFETCH_PLACEHOLDER_SHA256.has(hash);
}

function brandfetchActualFormat(result) {
  const ct = (result.contentType || '').toLowerCase();
  if (ct.includes('svg') || looksLikeSvg(result.buffer)) return 'svg';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('png')) return 'png';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  return null;
}

async function fetchFavicon(url, requestHeaders) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT);

  try {
    const res = await upstreamFetch(url, {
      signal: controller.signal,
      headers: requestHeaders || FAVICON_FETCH_HEADERS,
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
  if (!result) return null;
  if (await isBlankFavicon(result.buffer, result)) return null;
  return { ...result, provider: 'yandex' };
}

async function fetchFaviconSo(domain) {
  const url = PROVIDERS.faviconSo(domain);
  const result = await fetchFavicon(url);
  if (!result) return null;
  if (await isUnusableIcon(result.buffer, { ...result, provider: 'faviconso' })) return null;
  return { ...result, provider: 'faviconso' };
}

async function fetchVemetric(domain, size, format) {
  const url = PROVIDERS.vemetric(domain, size, format);
  const result = await fetchFavicon(url);
  if (!result) return null;
  if (await isUnusableIcon(result.buffer, { ...result, provider: 'vemetric' })) return null;
  return { ...result, provider: 'vemetric' };
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

async function fetchFaviconRun(domain, size = 128) {
  const url = PROVIDERS.faviconRun(domain, size);
  const result = await fetchFavicon(url);
  return result ? { ...result, provider: 'faviconrun' } : null;
}

async function fetchTwentyIcons(domain, size = 128) {
  const url = PROVIDERS.twentyIcons(domain, size);
  const result = await fetchFavicon(url);
  if (!result) return null;
  const meta = { contentType: result.contentType, url: result.url };
  const dims = await readImageDimensions(result.buffer, meta);
  if (dims) {
    const side = Math.min(dims.width || 0, dims.height || dims.width || 0);
    if (side < size) return null;
  }

  const refSize = twentyIconsReferenceSize(size);
  if (refSize) {
    const refResult = await fetchFavicon(PROVIDERS.twentyIcons(domain, refSize));
    if (refResult) {
      try {
        const metrics = await twentyIconsUpscaleMetrics(
          result.buffer,
          refResult.buffer,
          size,
          refSize
        );
        if (looksLikeTwentyIconsUpscale(metrics)) return null;
      } catch {
        // If analysis fails, keep the nominal-size result.
      }
    }
  }

  return { ...result, provider: 'twentyicons' };
}

async function fetchRyanjc(domain) {
  const url = PROVIDERS.ryanjc(domain);
  const result = await fetchFavicon(url);
  if (!result) return null;
  if (await isUnusableIcon(result.buffer, { ...result, provider: 'ryanjc' })) return null;
  return { ...result, provider: 'ryanjc' };
}

async function fetchBrandfetch(domain, size = 128, opts = {}) {
  const clientId = process.env.BRANDFETCH_CLIENT_ID;
  if (!clientId) return null;
  const requested = normalizeBrandfetchOptions(opts);

  for (const attempt of brandfetchAttemptOrder(opts)) {
    const url = PROVIDERS.brandfetch(domain, clientId, size, attempt);
    const result = await fetchFavicon(url, brandfetchFetchHeaders(domain, attempt.format));
    if (!result) continue;

    const contentType = (result.contentType || '').toLowerCase();
    if (!contentType.startsWith('image/')) continue;

    const actualFormat = brandfetchActualFormat(result);
    if (!actualFormat || actualFormat !== attempt.format) continue;

    if (actualFormat !== 'svg' && (await isBlankFavicon(result.buffer, result))) continue;
    if (actualFormat !== 'svg' && isBrandfetchPlaceholder(result.buffer, domain)) continue;

    return { ...result, provider: 'brandfetch', ...requested, resolvedFormat: actualFormat };
  }
  return null;
}

const {
  getSelfhstSlugCandidates,
  getDashboardIconsSlugCandidates,
  getLobehubSlugCandidates,
  getSvglSlugCandidates,
  getSvglEntrySync,
  ensureSelfhstIndex,
  ensureLobehubIndex,
  resolveServiceSlug,
  resolveSelfhstSlugSync,
  normalizeServiceAliasKey,
} = require('./serviceAliases');

const SVGL_ASSET_BASE = 'https://cdn.jsdelivr.net/gh/pheralb/svgl@main/static';

function svglAssetUrl(routePath) {
  if (!routePath) return '';
  if (routePath.startsWith('http')) return routePath;
  return `${SVGL_ASSET_BASE}${routePath.startsWith('/') ? routePath : `/${routePath}`}`;
}

function svglRouteForVariant(entry, variant) {
  const route = entry?.route;
  if (!route) return null;
  if (typeof route === 'string') return variant === 'color' ? route : null;
  // SVGL asset names follow background theme (_light = for light UI, _dark = for dark UI).
  if (variant === 'light') return route.dark || null;
  if (variant === 'dark') return route.light || null;
  return route.light || route.dark || null;
}

async function fetchServiceIcon(buildUrl, getCandidates, service, variant, provider) {
  const candidates = await getCandidates(service);
  const variants = variant === 'color' ? ['color', 'light', 'dark'] : [variant];

  for (const slug of candidates) {
    for (const v of variants) {
      const result = await fetchFavicon(buildUrl(slug, v));
      if (result) return { ...result, provider, service: slug, variant: v };
    }
  }
  return null;
}

async function fetchSelfhstPng(slug, variant) {
  const { entries } = await ensureSelfhstIndex();
  const entry = entries.find((e) => e.slug === slug);

  // selfh.st PNG light/dark assets sometimes bake in mismatched backgrounds; prefer SVG.
  if (variant !== 'color' && entry?.hasSvg) {
    const svgUrl = PROVIDERS.selfhst(slug, variant, 'svg');
    const svgResult = await fetchFavicon(svgUrl);
    if (svgResult) {
      return { ...svgResult, provider: 'selfhst', service: slug, variant };
    }
  }

  const url = PROVIDERS.selfhst(slug, variant, 'png');
  const result = await fetchFavicon(url);
  return result ? { ...result, provider: 'selfhst', service: slug, variant } : null;
}

async function fetchSelfhst(service, variant = 'color', { strict = false, format = 'png' } = {}) {
  const wantSvg = format === 'svg';
  const { entries } = await ensureSelfhstIndex();
  const entryBySlug = new Map(entries.map((entry) => [entry.slug, entry]));

  if (wantSvg) {
    const candidates = strict
      ? [resolveSelfhstSlugSync(service) || normalizeServiceAliasKey(service)].filter(Boolean)
      : await getSelfhstSlugCandidates(service, { strict });
    for (const slug of candidates) {
      if (!entryBySlug.get(slug)?.hasSvg) continue;
      const url = PROVIDERS.selfhst(slug, variant, 'svg');
      const result = await fetchFavicon(url);
      if (result) {
        return { ...result, provider: 'selfhst', service: slug, variant, format: 'svg' };
      }
    }
    return null;
  }

  if (variant !== 'color') {
    const slug = resolveSelfhstSlugSync(service) || normalizeServiceAliasKey(service);
    if (!slug) return null;
    return fetchSelfhstPng(slug, variant);
  }

  const candidates = await getSelfhstSlugCandidates(service, { strict });
  const variants = ['color', 'light', 'dark'];

  for (const slug of candidates) {
    for (const v of variants) {
      const result = await fetchSelfhstPng(slug, v);
      if (result) return result;
    }
  }
  return null;
}

async function fetchDashboardIcons(service, variant = 'color', { strict = false, format = 'png' } = {}) {
  const wantSvg = format === 'svg';

  if (wantSvg) {
    if (variant !== 'color') return null;
    const candidates = strict
      ? [await resolveServiceSlug(service)].filter(Boolean)
      : await getDashboardIconsSlugCandidates(service, { strict });
    for (const slug of candidates) {
      const url = PROVIDERS.dashboardIcons(slug, 'color', 'svg');
      const result = await fetchFavicon(url);
      if (result) {
        return { ...result, provider: 'dashboardicons', service: slug, variant: 'color', format: 'svg' };
      }
    }
    return null;
  }

  if (variant !== 'color') {
    const slug = await resolveServiceSlug(service);
    const result = await fetchFavicon(PROVIDERS.dashboardIcons(slug, variant, 'png'));
    return result
      ? { ...result, provider: 'dashboardicons', service: slug, variant }
      : null;
  }

  return fetchServiceIcon(
    (slug, v) => PROVIDERS.dashboardIcons(slug, v, 'png'),
    (s) => getDashboardIconsSlugCandidates(s, { strict }),
    service,
    variant,
    'dashboardicons'
  );
}

const LOBEHUB_THEME_PNG_CDN =
  'https://cdn.jsdelivr.net/npm/@lobehub/icons-static-png@latest';

function lobehubThemePngUrls(slug, theme) {
  const enc = encodeURIComponent(slug);
  return [
    `${LOBEHUB_THEME_PNG_CDN}/${theme}/${enc}.png`,
    `${LOBEHUB_THEME_PNG_CDN}/${theme}/${enc}-color.png`,
  ];
}

async function lobehubThemePngAvailable(slug, theme) {
  for (const url of lobehubThemePngUrls(slug, theme)) {
    const result = await fetchFavicon(url);
    if (result) return true;
  }
  return false;
}

async function fetchLobehubThemePng(slug, uiVariant, size) {
  const theme = lobehubThemeForVariant(uiVariant);
  for (const url of lobehubThemePngUrls(slug, theme)) {
    const result = await fetchFavicon(url);
    if (!result) continue;
    try {
      const buffer = await resizeIcon(result.buffer, size);
      return {
        buffer,
        contentType: 'image/png',
        url: result.url,
        provider: 'lobehub',
        service: slug,
        variant: uiVariant,
        size,
      };
    } catch {
      return { ...result, provider: 'lobehub', service: slug, variant: uiVariant, size };
    }
  }
  return null;
}

function lobehubUrlsForSlug(slug, _variant, entry) {
  const base = `https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/${encodeURIComponent(slug)}`;

  const urls = [];
  if (entry?.hasColor) urls.push(`${base}-color.svg`);
  if (entry?.hasBrandColor) urls.push(`${base}-brand-color.svg`);
  urls.push(`${base}.svg`);
  if (entry?.hasBrand) urls.push(`${base}-brand.svg`);
  return urls;
}

async function fetchLobehub(service, variant = 'color', size = 128, { strict = false, format = 'png' } = {}) {
  const wantSvg = format === 'svg';
  if (wantSvg && (variant === 'light' || variant === 'dark')) return null;

  const index = await ensureLobehubIndex();
  const candidates = await getLobehubSlugCandidates(service, { strict });

  for (const slug of candidates) {
    const entry = index.entries.get(slug);

    if (variant === 'light' || variant === 'dark') {
      const themed = await fetchLobehubThemePng(slug, variant, size);
      if (themed) return themed;
      continue;
    }

    for (const url of lobehubUrlsForSlug(slug, 'color', entry)) {
      const result = await fetchFavicon(url);
      if (!result) continue;

      const contentType = (result.contentType || '').toLowerCase();
      const isSvg = contentType.includes('svg') || url.toLowerCase().endsWith('.svg');
      if (isSvg && wantSvg) {
        return {
          ...result,
          provider: 'lobehub',
          service: slug,
          variant: 'color',
          format: 'svg',
        };
      }
      if (isSvg) {
        const buffer = await rasterizeSvgToSize(result.buffer, size);
        return {
          buffer,
          contentType: 'image/png',
          url: result.url,
          provider: 'lobehub',
          service: slug,
          variant: 'color',
          size,
        };
      }

      return { ...result, provider: 'lobehub', service: slug, variant: 'color', size };
    }
  }
  return null;
}

async function fetchSvgl(service, variant = 'color', size = 128, { strict = false, format = 'png' } = {}) {
  const wantSvg = format === 'svg';
  const candidates = await getSvglSlugCandidates(service, { strict });
  const variants = [variant];

  for (const slug of candidates) {
    const entry = getSvglEntrySync(slug);
    if (!entry) continue;
    for (const v of variants) {
      const route = svglRouteForVariant(entry, v);
      if (!route) continue;
      const url = svglAssetUrl(route);
      const result = await fetchFavicon(url);
      if (!result) continue;

      const contentType = (result.contentType || '').toLowerCase();
      const isSvg = contentType.includes('svg') || url.toLowerCase().endsWith('.svg');
      if (isSvg && wantSvg) {
        return {
          ...result,
          provider: 'svgl',
          service: slug,
          variant: v,
          format: 'svg',
        };
      }
      if (isSvg) {
        const buffer = await rasterizeSvgToSize(result.buffer, size);
        return {
          buffer,
          contentType: 'image/png',
          url: result.url,
          provider: 'svgl',
          service: slug,
          variant: v,
          size,
        };
      }

      return { ...result, provider: 'svgl', service: slug, variant: v, size };
    }
  }
  return null;
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
  if (manifestFetchCache.has(manifestUrl)) {
    return manifestFetchCache.get(manifestUrl);
  }

  const diskManifest = await scraperDiskCache.getManifest(manifestUrl);
  if (diskManifest !== undefined) {
    manifestFetchCache.set(manifestUrl, diskManifest);
    return diskManifest;
  }

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
    if (!res.ok) {
      manifestFetchCache.set(manifestUrl, []);
      scraperDiskCache.setManifest(manifestUrl, []);
      return [];
    }
    const json = await res.json();
    if (!json || !Array.isArray(json.icons)) {
      manifestFetchCache.set(manifestUrl, []);
      scraperDiskCache.setManifest(manifestUrl, []);
      return [];
    }
    const icons = json.icons
      .filter((icon) => {
        if (!icon || !icon.src || isMonochromeManifestIcon(icon)) return false;
        const size = parseSizesAttr(icon.sizes || '');
        // Empty/missing sizes are probed later; only skip when a size is declared below 128.
        if (size > 0 && size < 128) return false;
        return true;
      })
      .map((icon) => ({
        href: new URL(icon.src, manifestUrl).toString(),
        sizes: icon.sizes || '',
        type: icon.type || '',
      }));
    manifestFetchCache.set(manifestUrl, icons);
    scraperDiskCache.setManifest(manifestUrl, icons);
    return icons;
  } catch {
    manifestFetchCache.set(manifestUrl, []);
    scraperDiskCache.setManifest(manifestUrl, []);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function relIncludesToken(rel, token) {
  return String(rel || '')
    .toLowerCase()
    .split(/\s+/)
    .includes(token);
}

function parseManifestHrefsFromHtml(html, resolveBase) {
  if (!html || !resolveBase) return [];
  const $ = cheerio.load(html);
  const urls = [];
  $('link[rel]').each((_, el) => {
    const rel = $(el).attr('rel') || '';
    if (!relIncludesToken(rel, 'manifest')) return;
    const href = $(el).attr('href');
    if (!href) return;
    try {
      urls.push(new URL(href, resolveBase).toString());
    } catch {
      /* ignore invalid URLs */
    }
  });
  return urls;
}

function parseLinkHeaderManifestUrls(linkHeader, baseUrl) {
  if (!linkHeader || !baseUrl) return [];
  const urls = [];
  for (const part of String(linkHeader).split(/,(?=\s*<)/)) {
    if (!/\brel\s*=\s*["']?[^"']*\bmanifest\b/i.test(part)) continue;
    const m = part.match(/<\s*([^>]+)\s*>/);
    if (!m) continue;
    try {
      urls.push(new URL(m[1].trim(), baseUrl).toString());
    } catch {
      /* ignore invalid URLs */
    }
  }
  return urls;
}

function directoryOfUrl(href) {
  try {
    const u = new URL(href);
    const path = u.pathname;
    const lastSlash = path.lastIndexOf('/');
    if (lastSlash < 0) return null;
    const dir = lastSlash === 0 ? '/' : path.slice(0, lastSlash + 1);
    return `${u.origin}${dir}`;
  } catch {
    return null;
  }
}

function manifestUrlsFromDirectories(directories) {
  const urls = [];
  const seenDirs = new Set();
  for (const dir of directories) {
    if (!dir || seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    const base = dir.endsWith('/') ? dir : `${dir}/`;
    for (const name of MANIFEST_BASENAMES) {
      try {
        urls.push(new URL(name, base).toString());
      } catch {
        /* ignore */
      }
    }
  }
  return urls;
}

function wellKnownManifestUrlsForOrigin(origin) {
  const urls = [];
  const base = origin.endsWith('/') ? origin : `${origin}/`;
  for (const prefix of MANIFEST_ROOT_PREFIXES) {
    for (const name of MANIFEST_BASENAMES) {
      try {
        urls.push(new URL(prefix + name, base).toString());
      } catch {
        /* ignore */
      }
    }
  }
  return urls;
}

function originsForDomain(domain) {
  const origins = new Set();
  try {
    origins.add(new URL(`https://${domain}/`).origin);
  } catch {
    /* ignore */
  }
  if (!domain.startsWith('www.')) {
    try {
      origins.add(new URL(`https://www.${domain}/`).origin);
    } catch {
      /* ignore */
    }
  }
  return [...origins];
}

function staticManifestHint(domain) {
  const lower = domain.toLowerCase();
  const bare = lower.replace(/^www\./, '');
  return STATIC_MANIFEST_HINTS[lower] || STATIC_MANIFEST_HINTS[bare] || null;
}

function discoverManifestUrls(
  domain,
  { html = null, finalBaseUrl = null, iconCandidates = [], linkHeader = null } = {}
) {
  const ordered = [];
  const seen = new Set();

  function push(url) {
    if (!url || seen.has(url)) return;
    seen.add(url);
    ordered.push(url);
  }

  const baseUrl = finalBaseUrl || `https://${domain}/`;
  let resolveBase = baseUrl;
  if (html) {
    const parsed = parseIconCandidatesFromHtml(html, baseUrl);
    resolveBase = parsed.resolveBase || baseUrl;
  }

  const hint = staticManifestHint(domain);
  if (hint) push(hint);

  for (const u of parseManifestHrefsFromHtml(html, resolveBase)) push(u);
  for (const u of parseLinkHeaderManifestUrls(linkHeader, baseUrl)) push(u);

  const iconHrefs = iconCandidates
    .map((c) => (typeof c === 'string' ? c : c && c.href))
    .filter(Boolean);
  const dirs = iconHrefs.map(directoryOfUrl).filter(Boolean);
  for (const u of manifestUrlsFromDirectories(dirs)) push(u);

  for (const origin of originsForDomain(domain)) {
    for (const u of wellKnownManifestUrlsForOrigin(origin)) push(u);
  }

  return ordered;
}

async function resolveManifestIcons(manifestUrls, referer, { maxAttempts = MANIFEST_PROBE_MAX } = {}) {
  const slice = manifestUrls.slice(0, maxAttempts);
  for (const manifestUrl of slice) {
    const icons = await fetchManifestIcons(manifestUrl, referer);
    if (icons.length > 0) return icons;
  }
  return [];
}

async function loadManifestIconCandidates(
  domain,
  { html = null, finalBaseUrl = null, linkHeader = null, iconCandidates = [] } = {}
) {
  const referer = finalBaseUrl || `https://${domain}/`;
  const urls = discoverManifestUrls(domain, {
    html,
    finalBaseUrl,
    iconCandidates,
    linkHeader,
  });
  return resolveManifestIcons(urls, referer);
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
  if (probeMetadataCache.has(href)) {
    return probeMetadataCache.get(href);
  }

  const diskProbe = await scraperDiskCache.getProbe(href);
  if (diskProbe !== undefined) {
    probeMetadataCache.set(href, diskProbe);
    return diskProbe;
  }

  const result = await fetchScraperAsset(href, referer);
  if (!result) {
    probeMetadataCache.set(href, null);
    scraperDiskCache.setProbe(href, null);
    return null;
  }

  const dims = await readImageDimensions(result.buffer, {
    contentType: result.contentType,
    url: href,
  });
  if (!dims || dims.width <= 0 || dims.height <= 0) {
    probeMetadataCache.set(href, null);
    scraperDiskCache.setProbe(href, null);
    return null;
  }

  const format = dims.format ? String(dims.format).toLowerCase() : null;
  const isSvg =
    format === 'svg' ||
    looksLikeSvg(result.buffer) ||
    (result.contentType || '').toLowerCase().includes('svg');
  let width = dims.width;
  let height = dims.height;
  if (isSvg) {
    width = Math.max(width, SVG_DISPLAY_SIZE);
    height = Math.max(height, SVG_DISPLAY_SIZE);
  }

  const meta = {
    url: href,
    width,
    height,
    format: isSvg ? 'svg' : format,
    bytes: result.buffer.length,
  };
  probeMetadataCache.set(href, meta);
  scraperDiskCache.setProbe(href, meta);
  return meta;
}

// Returns the merged + sorted list of every icon we can find for `domain`:
// besticon's discoveries plus anything we can reach ourselves via the static
// CDN hints and sized-variant expansion. This is the source of truth for the
// /:domain/json icons array shown as the size-button strip on the UI.
async function fetchScraperAllIcons(domain) {
  const cached = scraperIconsCache.get(domain);
  if (Array.isArray(cached) && cached.length > 0) return cached;

  const diskIcons = await scraperDiskCache.getIcons(domain);
  if (Array.isArray(diskIcons) && diskIcons.length > 0) {
    scraperIconsCache.set(domain, diskIcons);
    return diskIcons;
  }

  const referer = `https://${domain}/`;
  const { html, finalBaseUrl, linkHeader } = await fetchScraperPage(domain);
  const besticonIcons = BESTICON_URL ? await fetchBesticonAllIcons(domain) : [];

  const byUrl = new Map();
  for (const icon of besticonIcons) {
    if (!icon || !icon.url || byUrl.has(icon.url)) continue;
    byUrl.set(icon.url, { ...icon });
  }

  const iconCandidates = [...byUrl.keys()].map((href) => ({ href }));
  const pageLinkCandidates = [];
  if (html) {
    try {
      const parsed = parseIconCandidatesFromHtml(html, finalBaseUrl || referer, domain);
      iconCandidates.push(...parsed.primaryCandidates);
      for (const candidate of parsed.primaryCandidates) {
        pageLinkCandidates.push(candidate);
        for (const variant of expandSizedVariants(candidate.href)) {
          pageLinkCandidates.push({ ...candidate, ...variant });
        }
      }
    } catch {
      /* ignore */
    }
  }

  // Google product subdomains that redirect to a login page expose no product
  // logo in their own HTML; recover it from the workspace marketing page so the
  // size strip reflects the real (scalable) logo instead of the tiny favicon.
  const workspaceLogoCandidates = await googleWorkspaceLogoFallback(domain, html);
  for (const candidate of workspaceLogoCandidates) {
    pageLinkCandidates.push(candidate);
    for (const variant of expandSizedVariants(candidate.href)) {
      pageLinkCandidates.push({ ...candidate, ...variant });
    }
  }

  if (pageLinkCandidates.length > 0) {
    const probed = await runInBatches(
      dedupeCandidates(pageLinkCandidates),
      SCRAPER_PROBE_BATCH_SIZE,
      (c) => probeIconMetadata(c.href, referer)
    );
    for (const p of probed) {
      if (p && p.url && !byUrl.has(p.url)) byUrl.set(p.url, p);
    }
  }

  try {
    const manifestIcons = await loadManifestIconCandidates(domain, {
      html,
      finalBaseUrl,
      linkHeader,
      iconCandidates,
    });
    if (manifestIcons.length > 0) {
      const probed = await runInBatches(manifestIcons, SCRAPER_PROBE_BATCH_SIZE, (c) =>
        probeIconMetadata(c.href, referer)
      );
      for (const p of probed) {
        if (p && p.url && !byUrl.has(p.url)) byUrl.set(p.url, p);
      }
    }
  } catch {
    /* manifest discovery is best-effort */
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

  let sorted = [...byUrl.values()].sort((a, b) => {
    const areaA = (a.width || 0) * (a.height || a.width || 0);
    const areaB = (b.width || 0) * (b.height || b.width || 0);
    if (areaB !== areaA) return areaB - areaA;
    return (b.width || 0) - (a.width || 0);
  });

  // Keep the discovered-icon list (which drives the size strip and the sized
  // /scraper/{size}/… endpoints) consistent with the icon fetchScraper() will
  // actually serve. Two cases resolve to a catalog icon instead of the scraped
  // favicon:
  //   1. Override — an explicit domainIconTags mapping (e.g. azure.microsoft.com
  //      → microsoft-azure) is authoritative over the site's generic favicon,
  //      unless the scrape already found a specific Google product logo.
  //   2. Fallback — discovery only surfaced sub-128px icons (bot wall / sign-in
  //      redirect exposing just a 16/32px favicon).
  const largestDiscovered = sorted.reduce(
    (max, icon) => Math.max(max, icon.width || 0, icon.height || 0),
    0
  );
  const discoveredHasProductLogo = [...byUrl.keys()].some((u) =>
    /gstatic\.com\/images\/branding\/productlogos\//i.test(u)
  );
  const overrideWithCatalog = !!iconTagForDomain(domain) && !discoveredHasProductLogo;
  if (SCRAPER_FALLBACK && (overrideWithCatalog || largestDiscovered < MIN_SOURCE_SIZE)) {
    try {
      const fb = await fetchScraperCatalogFallback(domain);
      if (fb && fb.url) {
        const dims = await readImageDimensions(fb.buffer, {
          contentType: fb.contentType,
          url: fb.url,
        }).catch(() => null);
        const width = dims
          ? Math.max(dims.width || 0, dims.height || 0)
          : scraperMaxIconSizeEnabled()
            ? SCRAPER_MAX_ICON_SIZE
            : MIN_SOURCE_SIZE;
        if (width >= MIN_SOURCE_SIZE) {
          const format = /\.svg(?:$|[?#])/i.test(fb.url)
            ? 'svg'
            : (fb.contentType || '').includes('svg')
              ? 'svg'
              : 'png';
          const catalogIcon = {
            url: fb.url,
            width,
            height: width,
            format,
            bytes: fb.buffer ? fb.buffer.length : 0,
          };
          if (overrideWithCatalog) {
            // The curated icon is authoritative: it is the only icon we expose,
            // so every size and the size strip reflect exactly what is served.
            sorted = [catalogIcon];
          } else if (!byUrl.has(fb.url)) {
            sorted.unshift(catalogIcon);
          }
        }
      }
    } catch {
      /* catalog reflection is best-effort */
    }
  }

  scraperIconsCache.set(domain, sorted);
  if (sorted.length > 0) {
    scraperDiskCache.setIcons(domain, sorted);
  } else {
    scraperDiskCache.invalidateDomain(domain).catch(() => {});
  }
  return sorted;
}

async function fetchScraperPageUncached(domain) {
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
          const linkHeader = res.headers.get('link') || res.headers.get('Link') || null;
          return {
            html,
            finalBaseUrl: res.url || pageUrl,
            htmlFetchMethod: `${attempt.label} ${pageUrl}`,
            linkHeader,
          };
        }
      } catch {
        /* try next */
      } finally {
        clearTimeout(timer);
      }
    }
  }

  return { html: null, finalBaseUrl: baseUrl, htmlFetchMethod: null, linkHeader: null };
}

async function fetchScraperPage(domain, { bypassCache = false } = {}) {
  if (!bypassCache) {
    const cached = scraperPageCache.get(domain);
    if (cached) return cached;

    const diskPage = await scraperDiskCache.getPage(domain);
    if (diskPage !== undefined) {
      scraperPageCache.set(domain, diskPage);
      return diskPage;
    }

    const inflight = scraperPageInflight.get(domain);
    if (inflight) return inflight;
  }

  const run = async () => {
    const result = await fetchScraperPageUncached(domain);
    if (!bypassCache) {
      scraperPageCache.set(domain, result);
      scraperDiskCache.setPage(domain, result);
    }
    return result;
  };

  if (bypassCache) return run();

  const promise = run().finally(() => scraperPageInflight.delete(domain));
  scraperPageInflight.set(domain, promise);
  return promise;
}

// Google product domains (meet, chat, drive, calendar, keep, …) redirect
// anonymous/bot requests to their workspace.google.com marketing page. That
// page's <link rel="icon"> is only a tiny generic Google "G", but its body
// references every Google product's real, current logo on the gstatic
// "productlogos" CDN, e.g.
//   https://www.gstatic.com/images/branding/productlogos/meet_2026/v2/web/192px.svg
// Matching one of those to the requested domain lets the scraper serve the
// site's actual icon (scraped live, so it tracks Google's redesigns) instead of
// the redirected marketing page's generic favicon — no per-domain hardcoding.
const GOOGLE_PRODUCT_LOGO_RE =
  /https?:\/\/[^"'\s)<>]*gstatic\.com\/images\/branding\/productlogos\/([^/"'\s)<>]+)\/[^"'\s)<>]+\.(?:svg|png)(?:[?#][^"'\s)<>]*)?/gi;

// Candidate product tokens derived from a domain, used to match a productlogos
// path segment (year suffix stripped): the leading label (meet.google.com →
// "meet") plus the resolved service slug and its parts (mail.google.com →
// "gmail"; drive.google.com → "google-drive" → "drive").
function googleProductTokens(domain) {
  const tokens = new Set();
  if (!domain || typeof domain !== 'string') return tokens;
  const labels = domain.toLowerCase().split('.').filter(Boolean);
  if (labels[0]) tokens.add(labels[0]);
  const slug = serviceSlugFromDomain(domain);
  if (slug) {
    tokens.add(slug.toLowerCase());
    for (const part of slug.toLowerCase().split('-')) {
      if (part) tokens.add(part);
    }
  }
  return tokens;
}

function googleProductLogoCandidates(html, domain) {
  if (!html || !domain) return [];
  if (!/gstatic\.com\/images\/branding\/productlogos\//i.test(html)) return [];

  const tokens = googleProductTokens(domain);
  if (tokens.size === 0) return [];

  const out = [];
  const seen = new Set();
  for (const match of html.matchAll(GOOGLE_PRODUCT_LOGO_RE)) {
    const url = match[0];
    const product = (match[1] || '').toLowerCase().replace(/_\d{4}$/, '');
    if (!product || !tokens.has(product)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const isSvg = /\.svg(?:$|[?#])/i.test(url);
    out.push({
      href: url,
      sizes: isSvg ? 'any' : '192x192',
      type: isSvg ? 'image/svg+xml' : 'image/png',
      rel: 'icon',
    });
  }
  return out;
}

// Some Google product subdomains (drive, docs, sheets, slides, …) redirect
// anonymous requests to the accounts.google.com login page, whose HTML exposes
// no product logo at all (only a generic favicon). Others (meet, chat, calendar)
// redirect to their workspace.google.com marketing page, which does. When the
// site's own HTML yields no matching product logo, fall back to scraping the
// product's workspace.google.com marketing page — a reliable, public, live
// source of every product's current logo (so no per-domain hardcoded URLs).
const GOOGLE_WORKSPACE_PRODUCT_BASE = 'https://workspace.google.com/products/';

const googleWorkspaceLogoCache = new LRUCache({
  max: SCRAPER_ICONS_CACHE_MAX,
  ttl: SCRAPER_ICONS_CACHE_TTL_MS,
});
const googleWorkspaceLogoInflight = new Map();

function isGoogleProductSubdomain(domain) {
  if (!domain || typeof domain !== 'string') return false;
  const d = domain.toLowerCase();
  return d.endsWith('.google.com') && d.split('.').filter(Boolean).length >= 3;
}

// Ordered workspace product-page slugs to try for a Google product subdomain,
// e.g. drive.google.com → ["drive", …]; mail.google.com → ["mail","gmail"].
function googleWorkspaceProductSlugs(domain) {
  const out = [];
  const seen = new Set();
  const add = (s) => {
    const v = (s || '').toLowerCase().trim();
    // Skip the bare "google" token: `products/google/` 404s (a large body) and
    // every other workspace page redundantly lists all product logos anyway.
    if (v && v !== 'google' && /^[a-z0-9-]+$/.test(v) && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  };
  const labels = domain.toLowerCase().split('.').filter(Boolean);
  add(labels[0]);
  // The resolved service slug maps aliases to the real workspace product
  // (e.g. mail → gmail). Only its individual parts are ever valid product
  // slugs — the hyphenated form (e.g. "google-drive") never is.
  const slug = serviceSlugFromDomain(domain);
  if (slug) {
    for (const part of slug.split('-')) add(part);
  }
  return out;
}

async function fetchGoogleWorkspaceProductHtml(slug) {
  const url = `${GOOGLE_WORKSPACE_PRODUCT_BASE}${encodeURIComponent(slug)}/`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT);
  try {
    const res = await upstreamFetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: scraperDocumentHeaders(),
    });
    if (!res.ok) return null;
    const html = await res.text();
    return html && html.length >= HTML_MIN_BYTES ? html : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function computeGoogleWorkspaceLogoCandidates(domain) {
  for (const slug of googleWorkspaceProductSlugs(domain)) {
    const html = await fetchGoogleWorkspaceProductHtml(slug);
    if (!html) continue;
    const candidates = googleProductLogoCandidates(html, domain);
    if (candidates.length > 0) return candidates;
  }
  return [];
}

async function fetchGoogleWorkspaceLogoCandidates(domain) {
  if (googleWorkspaceLogoCache.has(domain)) return googleWorkspaceLogoCache.get(domain);
  if (googleWorkspaceLogoInflight.has(domain)) return googleWorkspaceLogoInflight.get(domain);
  const promise = computeGoogleWorkspaceLogoCandidates(domain)
    .then((candidates) => {
      googleWorkspaceLogoCache.set(domain, candidates);
      return candidates;
    })
    .finally(() => googleWorkspaceLogoInflight.delete(domain));
  googleWorkspaceLogoInflight.set(domain, promise);
  return promise;
}

// Returns Google product-logo candidates from the workspace marketing page, but
// only when needed: the domain is a Google product subdomain AND its own HTML
// did not already expose a matching product logo (meet/chat/calendar do, so they
// skip the extra fetch).
async function googleWorkspaceLogoFallback(domain, primaryHtml) {
  if (!isGoogleProductSubdomain(domain)) return [];
  if (primaryHtml && googleProductLogoCandidates(primaryHtml, domain).length > 0) return [];
  return fetchGoogleWorkspaceLogoCandidates(domain);
}

function parseIconCandidatesFromHtml(html, finalBaseUrl, domain = null) {
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
        rel,
      });
    } catch {
      /* ignore invalid URLs */
    }
  });

  // Icons referenced in the page body (Google product logos on redirected
  // marketing pages). These are absolute gstatic URLs, so no base resolution.
  if (domain) {
    linkCandidates.push(...googleProductLogoCandidates(html, domain));
  }

  return {
    primaryCandidates: linkCandidates,
    resolveBase,
    linkCount: linkCandidates.length,
  };
}

async function buildScraperCandidates(
  domain,
  html,
  finalBaseUrl,
  linkHeader = null,
  extraCandidates = []
) {
  const baseUrl = `https://${domain}/`;
  const primaryCandidates = [];
  const fallbackCandidates = [];

  let parsed = { primaryCandidates: [], resolveBase: finalBaseUrl || baseUrl };
  if (html) {
    try {
      parsed = parseIconCandidatesFromHtml(html, finalBaseUrl, domain);
      primaryCandidates.push(...parsed.primaryCandidates);
    } catch {
      /* parsing failed - fall through */
    }
  }

  if (extraCandidates.length > 0) primaryCandidates.push(...extraCandidates);

  try {
    const manifestIcons = await loadManifestIconCandidates(domain, {
      html,
      finalBaseUrl,
      linkHeader,
      iconCandidates: parsed.primaryCandidates,
    });
    primaryCandidates.push(...manifestIcons);
  } catch {
    /* manifest discovery is best-effort */
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
async function fetchBesticonAllIcons(domain, { bypassCache = false } = {}) {
  if (!BESTICON_URL) return [];

  if (!bypassCache) {
    const cached = besticonIconsCache.get(domain);
    if (cached) return cached;

    const diskBesticon = await scraperDiskCache.getBesticon(domain);
    if (diskBesticon !== undefined) {
      besticonIconsCache.set(domain, diskBesticon);
      return diskBesticon;
    }
  }

  const url = `${BESTICON_URL}/allicons.json?url=${encodeURIComponent(domain)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      if (!bypassCache) {
        besticonIconsCache.set(domain, []);
        scraperDiskCache.setBesticon(domain, []);
      }
      return [];
    }

    const body = await res.json();
    const list = Array.isArray(body) ? body : Array.isArray(body?.icons) ? body.icons : [];

    const icons = list
      .filter((i) => i && !i.error && typeof i.url === 'string')
      .map((i) => ({
        url: i.url,
        width: Number.isFinite(i.width) ? i.width : 0,
        height: Number.isFinite(i.height) ? i.height : 0,
        format: i.format ? String(i.format).toLowerCase() : null,
        bytes: Number.isFinite(i.bytes) ? i.bytes : 0,
      }));
    if (!bypassCache) {
      besticonIconsCache.set(domain, icons);
      scraperDiskCache.setBesticon(domain, icons);
    }
    return icons;
  } catch {
    if (!bypassCache) {
      besticonIconsCache.set(domain, []);
      scraperDiskCache.setBesticon(domain, []);
    }
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

async function fetchScraperForDomain(domain) {
  const referer = `https://${domain}/`;
  const { html, finalBaseUrl, linkHeader } = await fetchScraperPage(domain);

  // For Google product subdomains that redirect to a login page (drive, docs, …)
  // the scraped HTML has no product logo; recover it from the workspace page.
  const workspaceLogoCandidates = await googleWorkspaceLogoFallback(domain, html);

  if (BESTICON_URL) {
    const besticonCandidates = await fetchBesticonCandidates(domain);
    if (besticonCandidates.length > 0) {
      let parsed = { primaryCandidates: [] };
      if (html) {
        try {
          parsed = parseIconCandidatesFromHtml(html, finalBaseUrl, domain);
        } catch {
          /* ignore */
        }
      }
      const manifestIcons = await loadManifestIconCandidates(domain, {
        html,
        finalBaseUrl,
        linkHeader,
        iconCandidates: [...parsed.primaryCandidates, ...besticonCandidates],
      });
      const hintCandidates = deriveHintCandidates(
        domain,
        besticonCandidates.map((c) => c.href)
      );
      // The sidecar besticon does its own HTML scrape but only understands
      // <link>/manifest/well-known-path icons — it misses icons referenced in
      // the page body (e.g. Google product logos on redirected marketing pages).
      // Merge our own parsed HTML candidates (+ sized variants) so those win too.
      const pageLinkCandidates = [];
      for (const candidate of [
        ...parsed.primaryCandidates,
        ...workspaceLogoCandidates,
      ]) {
        pageLinkCandidates.push(candidate);
        for (const variant of expandSizedVariants(candidate.href)) {
          pageLinkCandidates.push({ ...candidate, ...variant });
        }
      }
      const combined = rankCandidates([
        ...besticonCandidates,
        ...pageLinkCandidates,
        ...hintCandidates,
        ...manifestIcons,
      ]);
      const best = await probeScraperCandidates(combined, referer, 32);
      if (best) return best;
    }
  }

  const { rankedPrimary, rankedFallback } = await buildScraperCandidates(
    domain,
    html,
    finalBaseUrl,
    linkHeader,
    workspaceLogoCandidates
  );

  const bestPrimary = await probeScraperCandidates(rankedPrimary, finalBaseUrl);
  if (bestPrimary) return bestPrimary;

  return probeScraperCandidates(rankedFallback, finalBaseUrl);
}

async function normalizeFallbackResult(entry, provider) {
  try {
    const displayed = await toDisplayPng(entry.buffer, {
      contentType: entry.contentType,
      url: entry.url,
    });
    return capScraperProxyOutput({
      ...entry,
      buffer: displayed.buffer,
      contentType: displayed.contentType,
      provider,
    });
  } catch {
    return capScraperProxyOutput({ ...entry, provider });
  }
}

async function fetchScraperCatalogFallback(domain) {
  const slug = serviceSlugFromDomain(domain);
  if (!slug) return null;

  // The slug is derived from the domain label, not typed by a user, so resolve
  // it strictly (exact catalog slug / curated alias only). A fuzzy match here
  // would replace a site's real favicon with a similarly-named but unrelated
  // catalog icon (e.g. maflplus.eu → "mailplus"); when there's no strict match
  // we fall through to genuine HTML scraping instead.
  const selfhstResult = await fetchSelfhst(slug, 'color', { strict: true });
  if (selfhstResult) {
    return normalizeFallbackResult(selfhstResult, 'scraper-fallback:selfhst');
  }

  const dashResult = await fetchDashboardIcons(slug, 'color', { strict: true });
  if (dashResult) {
    return normalizeFallbackResult(dashResult, 'scraper-fallback:dashboardicons');
  }

  const svglResult = await fetchSvgl(slug, 'color', 128, { strict: true });
  if (svglResult) {
    return normalizeFallbackResult(svglResult, 'scraper-fallback:svgl');
  }

  return null;
}

async function fetchScraperGoogleFallback(domain) {
  const size = scraperMaxIconSizeEnabled()
    ? Math.min(SCRAPER_MAX_ICON_SIZE, 256)
    : 128;
  const googleResult = await fetchGoogleV2(domain, size);
  if (!googleResult) return null;

  const dims = await readImageDimensions(googleResult.buffer, {
    contentType: googleResult.contentType,
    url: googleResult.url,
  });
  if (!dims || dims.width <= 1 || dims.height <= 1) return null;

  return normalizeFallbackResult(googleResult, 'scraper-fallback:googlev2');
}

async function fetchScraper(domain) {
  // Direct HTML scrape first. Curated catalogs (selfhst, dashboardicons) are
  // only preferred when the site's own best icon is too small to be useful
  // (e.g. facebook.com only exposes a 60×60 favicon). When the site exposes a
  // large icon of its own (e.g. github.com's 512px app-icon), keep it instead
  // of overriding it with a catalog logo.
  const result = await fetchScraperForDomain(domain);
  const scrapedBigEnough = !!result && (result.sourceWidth || 0) >= MIN_SOURCE_SIZE;

  // A curated domain→icon-tag mapping (domainIconTags.js) is an intentional
  // override: prefer the branded catalog icon over the site's own — often
  // generic — favicon. E.g. azure.microsoft.com serves the plain Microsoft
  // four-square logo, not the Azure icon. Exception: when the HTML scrape
  // already found a specific product logo (Google's gstatic productlogos, which
  // are the exact, current brand icons), keep that instead of the catalog.
  const hasExplicitIconTag = !!iconTagForDomain(domain);
  const scrapedIsProductLogo =
    !!result && /gstatic\.com\/images\/branding\/productlogos\//i.test(result.url || '');

  if (SCRAPER_FALLBACK && hasExplicitIconTag && !scrapedIsProductLogo) {
    const catalogResult = await fetchScraperCatalogFallback(domain);
    if (catalogResult) return catalogResult;
  }

  if (SCRAPER_FALLBACK && !scrapedBigEnough) {
    const catalogResult = await fetchScraperCatalogFallback(domain);
    if (catalogResult) return catalogResult;
  }

  if (result) return result;

  if (!domain.startsWith('www.')) {
    const wwwResult = await fetchScraperForDomain(`www.${domain}`);
    if (wwwResult) {
      wwwResult.fallbackDomain = `www.${domain}`;
      return wwwResult;
    }
  }

  // Google faviconV2 is the universal last resort when scraping and catalogs
  // both returned nothing.
  if (SCRAPER_FALLBACK) {
    return fetchScraperGoogleFallback(domain);
  }

  return null;
}

const VARIANT_AVAILABILITY_TTL_MS = 24 * 60 * 60 * 1000;
const variantAvailabilityCache = new Map();

function readVariantAvailabilityCache(key) {
  const cached = variantAvailabilityCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.loadedAt > VARIANT_AVAILABILITY_TTL_MS) {
    variantAvailabilityCache.delete(key);
    return null;
  }
  return cached.value;
}

function writeVariantAvailabilityCache(key, value) {
  variantAvailabilityCache.set(key, { loadedAt: Date.now(), value });
}

async function probePngVariantAvailability(cacheKey, urlForVariant) {
  const color = await fetchFavicon(urlForVariant('color'));
  if (!color) {
    writeVariantAvailabilityCache(cacheKey, null);
    return null;
  }

  const [light, dark] = await Promise.all([
    fetchFavicon(urlForVariant('light')),
    fetchFavicon(urlForVariant('dark')),
  ]);

  const value = {
    color: true,
    light: !!light,
    dark: !!dark,
  };
  writeVariantAvailabilityCache(cacheKey, value);
  return value;
}

async function getSelfhstVariantAvailability(slug) {
  if (!slug) return null;

  const cacheKey = `selfhst:${slug}`;
  const cached = readVariantAvailabilityCache(cacheKey);
  if (cached !== null) return cached;

  const { entries } = await ensureSelfhstIndex();
  const entry = entries.find((e) => e.slug === slug);
  if (!entry) {
    writeVariantAvailabilityCache(cacheKey, null);
    return null;
  }

  const color = await fetchFavicon(PROVIDERS.selfhst(slug, 'color', 'png'));
  if (!color) {
    writeVariantAvailabilityCache(cacheKey, null);
    return null;
  }

  const urlForVariant = (variant) => (
    entry.hasSvg
      ? PROVIDERS.selfhst(slug, variant, 'svg')
      : PROVIDERS.selfhst(slug, variant, 'png')
  );

  const [light, dark] = await Promise.all([
    fetchFavicon(urlForVariant('light')),
    fetchFavicon(urlForVariant('dark')),
  ]);

  const value = {
    color: true,
    light: !!light,
    dark: !!dark,
  };
  writeVariantAvailabilityCache(cacheKey, value);
  return value;
}

async function getDashboardIconsVariantAvailability(slug) {
  if (!slug) return null;

  const cacheKey = `dashboardicons:${slug}`;
  const cached = readVariantAvailabilityCache(cacheKey);
  if (cached !== null) return cached;

  return probePngVariantAvailability(
    cacheKey,
    (variant) => PROVIDERS.dashboardIcons(slug, variant)
  );
}

async function getLobehubVariantAvailability(slug) {
  if (!slug) return null;

  const cacheKey = `lobehub:${slug}`;
  const cached = readVariantAvailabilityCache(cacheKey);
  if (cached !== null) return cached;

  const index = await ensureLobehubIndex();
  const entry = index.entries?.get(slug);
  if (!entry) {
    writeVariantAvailabilityCache(cacheKey, null);
    return null;
  }

  let color = false;
  for (const url of lobehubUrlsForSlug(slug, 'color', entry)) {
    if (await fetchFavicon(url)) {
      color = true;
      break;
    }
  }
  if (!color) {
    writeVariantAvailabilityCache(cacheKey, null);
    return null;
  }

  const [light, dark] = await Promise.all([
    lobehubThemePngAvailable(slug, 'dark'),
    lobehubThemePngAvailable(slug, 'light'),
  ]);

  const value = { color: true, light, dark };
  writeVariantAvailabilityCache(cacheKey, value);
  return value;
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
  fetchFaviconRun,
  fetchTwentyIcons,
  fetchRyanjc,
  fetchBrandfetch,
  normalizeBrandfetchOptions,
  brandfetchCacheKey,
  fetchSelfhst,
  fetchDashboardIcons,
  fetchLobehub,
  fetchSvgl,
  fetchScraper,
  fetchScraperAsset,
  fetchScraperPage,
  parseIconCandidatesFromHtml,
  googleWorkspaceLogoFallback,
  fetchManifestIcons,
  discoverManifestUrls,
  resolveManifestIcons,
  loadManifestIconCandidates,
  fetchBesticonAllIcons,
  fetchScraperAllIcons,
  parseSizesAttr,
  expandSizedVariants,
  getScraperMaxIconSize,
  capScraperProxyOutput,
  getScraperFallback,
  PROVIDERS,
  getSelfhstVariantAvailability,
  getDashboardIconsVariantAvailability,
  getLobehubVariantAvailability,
  invalidateScraperDomainCaches,
};

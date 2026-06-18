const cheerio = require('cheerio');
const sharp = require('sharp');

const UPSTREAM_TIMEOUT = parseInt(process.env.UPSTREAM_TIMEOUT || '5000', 10);

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

async function fetchFavicon(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'FaviconProxy/1.0' },
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

// Probe well-known larger size variants for URLs that follow a NxN pattern,
// e.g. .../favicon/64x64.png -> .../favicon/{128x128,192x192,256x256,512x512}.png
// Many SPAs (Reddit, etc.) only expose a single small icon in SSR HTML while
// larger variants exist on the same CDN path and are injected by client-side JS.
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

async function fetchManifestIcons(manifestUrl, baseUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT);
  try {
    const res = await fetch(manifestUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'FaviconProxy/1.0' },
    });
    if (!res.ok) return [];
    const json = await res.json();
    if (!json || !Array.isArray(json.icons)) return [];
    return json.icons
      .filter((icon) => icon && icon.src)
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

async function fetchScraper(domain) {
  const baseUrl = `https://${domain}/`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT);

  let html;
  let finalBaseUrl = baseUrl;
  try {
    const res = await fetch(baseUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; FaviconProxy/1.0; +https://github.com/R0GGER/maflplus-favicon-api)',
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    if (!res.ok) {
      html = null;
    } else {
      finalBaseUrl = res.url || baseUrl;
      html = await res.text();
    }
  } catch {
    html = null;
  } finally {
    clearTimeout(timer);
  }

  const candidates = [];

  if (html) {
    try {
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
            'mask-icon',
            'fluid-icon',
          ].includes(r)
        );
        if (!isIcon) return;

        try {
          const absolute = new URL(href, resolveBase).toString();
          candidates.push({
            href: absolute,
            sizes: $(el).attr('sizes') || '',
            type: $(el).attr('type') || '',
          });
        } catch {
          /* ignore invalid URLs */
        }
      });

      const manifestHref = $('link[rel="manifest"]').attr('href');
      if (manifestHref) {
        try {
          const manifestUrl = new URL(manifestHref, resolveBase).toString();
          const manifestIcons = await fetchManifestIcons(manifestUrl, resolveBase);
          candidates.push(...manifestIcons);
        } catch {
          /* ignore invalid manifest URL */
        }
      }
    } catch {
      /* parsing failed - fall through to fallbacks */
    }
  }

  for (const fallback of [
    '/favicon.ico',
    '/apple-touch-icon.png',
    '/apple-touch-icon-precomposed.png',
  ]) {
    try {
      candidates.push({
        href: new URL(fallback, baseUrl).toString(),
        sizes: '',
        type: '',
      });
    } catch {
      /* ignore */
    }
  }

  // Expand any NxN.ext URLs into larger size variants on the same CDN path.
  const variantCandidates = [];
  for (const c of candidates) {
    variantCandidates.push(...expandSizedVariants(c.href));
  }
  candidates.push(...variantCandidates);

  // Deduplicate by URL while preserving order.
  const seen = new Set();
  const unique = [];
  for (const c of candidates) {
    if (!seen.has(c.href)) {
      seen.add(c.href);
      unique.push(c);
    }
  }

  // Score-rank candidates: prefer larger declared sizes, then better formats.
  const ranked = unique
    .map((c) => ({ ...c, declaredSize: parseSizesAttr(c.sizes) }))
    .sort((a, b) => {
      if (b.declaredSize !== a.declaredSize) return b.declaredSize - a.declaredSize;
      return formatScore(b.type) - formatScore(a.type);
    });

  // Try in order; first successful fetch with positive image dimensions wins.
  let best = null;
  let bestScore = -1;
  for (const candidate of ranked.slice(0, 12)) {
    const result = await fetchFavicon(candidate.href);
    if (!result) continue;

    let width = 0;
    let format = '';
    try {
      const meta = await sharp(result.buffer).metadata();
      width = Math.min(meta.width || 0, meta.height || 0);
      format = meta.format || '';
    } catch {
      /* non-image or unsupported - skip */
      continue;
    }

    if (width <= 0) continue;

    const score = width * 100 + formatScore(format);
    if (score > bestScore) {
      bestScore = score;
      best = { ...result, provider: 'scraper' };
      if (width >= 128) break;
    }
  }

  return best;
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

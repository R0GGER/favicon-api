const sharp = require('sharp');
const {
  fetchGoogle,
  fetchGoogleV2,
  fetchDuckDuckGo,
  fetchYandex,
  fetchFaviconSo,
  fetchVemetric,
  fetchFaviconDev,
  fetchFaviconkit,
  fetchFaviconRun,
  fetchTwentyIcons,
  fetchRyanjc,
  fetchSelfhst,
  fetchDashboardIcons,
  fetchLobehub,
  fetchSvgl,
  fetchScraper,
} = require('./providers');
const cache = require('./cache');
const { isUnusableIcon } = require('./imageNormalize');
const { serviceSlugFromDomain } = require('./serviceSlugFromDomain');
const { notFoundEntry } = require('./notFoundPlaceholder');

const VALID_DEFAULT_PROVIDERS = new Set([
  'scraper', 'google', 'googlev2', 'duckduckgo', 'yandex',
  'faviconso', 'vemetric', 'favicondev', 'faviconkit', 'faviconrun', 'twentyicons', 'ryanjc',
  'logodev', 'brandfetch', 'selfhst', 'dashboardicons', 'lobehub', 'svgl',
]);

const DEFAULT_PROVIDER = (() => {
  const val = (process.env.DEFAULT_PROVIDER || '').trim().toLowerCase();
  if (!val) return null;
  if (!VALID_DEFAULT_PROVIDERS.has(val)) {
    console.warn(
      `DEFAULT_PROVIDER="${process.env.DEFAULT_PROVIDER}" is not valid. ` +
      `Valid values: ${[...VALID_DEFAULT_PROVIDERS].join(', ')}. Falling back to default order.`
    );
    return null;
  }
  if (val === 'logodev' && !process.env.LOGODEV_TOKEN) {
    console.warn('DEFAULT_PROVIDER="logodev" requires LOGODEV_TOKEN to be set. Falling back to default order.');
    return null;
  }
  if (val === 'brandfetch' && !process.env.BRANDFETCH_CLIENT_ID) {
    console.warn('DEFAULT_PROVIDER="brandfetch" requires BRANDFETCH_CLIENT_ID to be set. Falling back to default order.');
    return null;
  }
  return val;
})();

const HEAD_START_MS = parseInt(process.env.PICK_HEAD_START_MS || '150', 10);

async function analyzeImage(buffer) {
  try {
    const metadata = await sharp(buffer).metadata();
    return {
      width: metadata.width || 0,
      height: metadata.height || 0,
      format: metadata.format || 'unknown',
      size: buffer.length,
    };
  } catch {
    return { width: 0, height: 0, format: 'unknown', size: buffer.length };
  }
}

function scoreCandidate(info) {
  let score = 0;
  const TARGET = 32;

  if (info.width === TARGET && info.height === TARGET) {
    score += 1000;
  } else if (info.width > 0 && info.height > 0) {
    const distance = Math.abs(info.width - TARGET) + Math.abs(info.height - TARGET);
    score += Math.max(0, 500 - distance * 10);
  }

  if (info.format === 'png') score += 50;
  else if (info.format === 'svg') score += 40;
  else if (info.format === 'ico') score += 20;

  score += Math.min(info.size / 100, 100);

  return score;
}

function buildFallbackFetchers(domain) {
  const all = {
    scraper:    () => fetchWithCache('scraper', domain, null, () => fetchScraper(domain)),
    googlev2:   () => fetchWithCache('googlev2', domain, 128, () => fetchGoogleV2(domain, 128)),
    duckduckgo: () => fetchWithCache('duckduckgo', domain, null, () => fetchDuckDuckGo(domain)),
    google:     () => fetchWithCache('google', domain, 32, () => fetchGoogle(domain, 32)),
    faviconkit: () => fetchWithCache('faviconkit', domain, 128, () => fetchFaviconkit(domain, 128)),
    faviconrun: () => fetchWithCache('faviconrun', domain, 128, () => fetchFaviconRun(domain, 128)),
    twentyicons: () => fetchWithCache('twentyicons', domain, 128, () => fetchTwentyIcons(domain, 128)),
    ryanjc:     () => fetchWithCache('ryanjc', domain, null, () => fetchRyanjc(domain)),
    faviconso:  () => fetchWithCache('faviconso', domain, null, () => fetchFaviconSo(domain)),
    vemetric:   () => fetchWithCache('vemetric', domain, null, () => fetchVemetric(domain)),
    favicondev: () => fetchWithCache('favicondev', domain, null, () => fetchFaviconDev(domain)),
    yandex:     () => fetchWithCache('yandex', domain, null, () => fetchYandex(domain)),
  };

  // logo.dev is intentionally excluded from the best-pick race. It has a
  // monthly token quota and returns a generated monogram when fallback is not
  // set to 404; we request fallback=404 so unknown domains return nothing useful.
  // It stays available on its dedicated /logodev/{size}/{domain} route.

  // Slug is derived from the domain label, so catalog lookups are resolved
  // strictly (exact slug / curated alias) — never a fuzzy match that would pick
  // a similarly-named but unrelated icon (e.g. maflplus.eu → "mailplus").
  const slug = serviceSlugFromDomain(domain);
  if (slug) {
    all.selfhst = () =>
      fetchWithCache('selfhst', slug, null, () => fetchSelfhst(slug, 'color', { strict: true }));
    all.dashboardicons = () =>
      fetchWithCache('dashboardicons', slug, null, () =>
        fetchDashboardIcons(slug, 'color', { strict: true })
      );
    all.lobehub = () =>
      fetchWithCache('lobehub', slug, '128_c_v2', () =>
        fetchLobehub(slug, 'color', 128, { strict: true })
      );
    all.svgl = () =>
      fetchWithCache('svgl', slug, '128_c_v2', () =>
        fetchSvgl(slug, 'color', 128, { strict: true })
      );
  }

  const defaultOrder = [
    'scraper', 'googlev2', 'duckduckgo',
    'google', 'faviconkit', 'faviconrun', 'twentyicons', 'ryanjc', 'faviconso', 'vemetric', 'favicondev', 'yandex',
  ];

  if (DEFAULT_PROVIDER && all[DEFAULT_PROVIDER]) {
    const rest = defaultOrder.filter((k) => k !== DEFAULT_PROVIDER);
    return [DEFAULT_PROVIDER, ...rest].map((k) => all[k]).filter(Boolean);
  }

  return defaultOrder.map((k) => all[k]).filter(Boolean);
}

function buildServiceFetchers(service) {
  const all = {
    selfhst: () => fetchWithCache('selfhst', service, null, () => fetchSelfhst(service)),
    dashboardicons: () =>
      fetchWithCache('dashboardicons', service, null, () => fetchDashboardIcons(service)),
    lobehub: () =>
      fetchWithCache('lobehub', service, '128_c_v2', () => fetchLobehub(service, 'color', 128)),
    svgl: () =>
      fetchWithCache('svgl', service, '128_c_v2', () => fetchSvgl(service, 'color', 128)),
  };

  const defaultOrder = ['selfhst', 'dashboardicons', 'lobehub', 'svgl'];
  if (DEFAULT_PROVIDER && all[DEFAULT_PROVIDER]) {
    const rest = defaultOrder.filter((k) => k !== DEFAULT_PROVIDER);
    return [DEFAULT_PROVIDER, ...rest].map((k) => all[k]);
  }

  return defaultOrder.map((k) => all[k]);
}

async function raceFetchers(fallbacks, cacheProvider, cacheKey, cacheSize) {
  if (fallbacks.length === 0) {
    return notFoundEntry(cacheSize || 32);
  }

  const wrap = (fetcher) =>
    Promise.resolve().then(fetcher).then((r) => {
      if (!r || !r.buffer || r.buffer.length === 0) throw new Error('empty');
      return r;
    });

  const storeAndReturn = async (result) => {
    const entry = {
      buffer: result.buffer,
      contentType: result.contentType,
      provider: result.provider,
      url: result.url,
    };
    await cache.set(cacheProvider, cacheKey, cacheSize, entry);
    return entry;
  };

  // When DEFAULT_PROVIDER is set, use it exclusively before any fallback race.
  // A head-start alone is not enough for slow providers (e.g. scraper): fast CDN
  // placeholders such as ryanjc's generic globe SVG would still win after 150ms.
  if (DEFAULT_PROVIDER) {
    try {
      return await storeAndReturn(await wrap(fallbacks[0]));
    } catch {
      if (fallbacks.length === 1) return notFoundEntry(cacheSize || 32);
      fallbacks = fallbacks.slice(1);
    }
  }

  const firstPromise = wrap(fallbacks[0]);
  const racers = [firstPromise];

  if (fallbacks.length > 1) {
    const restTrigger = new Promise((resolve) => {
      const timer = setTimeout(resolve, HEAD_START_MS);
      firstPromise.then(
        () => {},
        () => {
          clearTimeout(timer);
          resolve();
        }
      );
    });
    const restPromise = restTrigger.then(() =>
      Promise.any(fallbacks.slice(1).map(wrap))
    );
    racers.push(restPromise);
  }

  try {
    return await storeAndReturn(await Promise.any(racers));
  } catch {
    return notFoundEntry(cacheSize || 32);
  }
}

async function pickBest(domain) {
  const cached = await cache.get('best', domain, 32);
  if (cached) {
    if (cached.notFound || cached.provider === 'none') {
      await cache.del('best', domain, 32);
    } else if (DEFAULT_PROVIDER && cached.provider !== DEFAULT_PROVIDER) {
      // Pre-2.8.12 `best` entries can hold a fast CDN fallback (e.g. duckduckgo's
      // generic Google favicon for calendar.google.com) even when DEFAULT_PROVIDER
      // is scraper. Those icons pass isUnusableIcon, so invalidate and re-pick.
      await cache.del('best', domain, 32);
    } else if (!(await isUnusableIcon(cached.buffer, cached))) {
      return cached;
    } else {
      await cache.del('best', domain, 32);
    }
  }

  const fallbacks = buildFallbackFetchers(domain);
  return raceFetchers(fallbacks, 'best', domain, 32);
}

async function pickBestService(service) {
  const cached = await cache.get('best-service', service, null);
  if (cached) {
    if (cached.notFound || cached.provider === 'none') {
      await cache.del('best-service', service, null);
    } else if (DEFAULT_PROVIDER && cached.provider !== DEFAULT_PROVIDER) {
      await cache.del('best-service', service, null);
    } else if (!(await isUnusableIcon(cached.buffer, cached))) {
      return cached;
    } else {
      await cache.del('best-service', service, null);
    }
  }

  const fallbacks = buildServiceFetchers(service);
  return raceFetchers(fallbacks, 'best-service', service, null);
}

async function fetchWithCache(provider, domain, size, fetcher) {
  const cached = await cache.get(provider, domain, size);
  if (cached) {
    if (!(await isUnusableIcon(cached.buffer, cached))) return cached;
    await cache.del(provider, domain, size);
  }

  const result = await fetcher();
  if (result && (await isUnusableIcon(result.buffer, result))) return null;
  if (result) {
    await cache.set(provider, domain, size, result);
  }
  return result;
}

async function normalizeTo32(buffer) {
  try {
    return await sharp(buffer)
      .resize(32, 32, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
  } catch {
    return buffer;
  }
}

module.exports = { pickBest, pickBestService, fetchWithCache };

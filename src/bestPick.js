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
  fetchSelfhst,
  fetchDashboardIcons,
  fetchLobehub,
  fetchSvgl,
  fetchScraper,
} = require('./providers');
const cache = require('./cache');
const { isBlankFavicon } = require('./imageNormalize');
const { iconTagForDomain } = require('./domainIconTags');
const { serviceSlugFromDomain } = require('./serviceSlugFromDomain');

const VALID_DEFAULT_PROVIDERS = new Set([
  'scraper', 'google', 'googlev2', 'duckduckgo', 'yandex',
  'faviconso', 'vemetric', 'favicondev', 'faviconkit', 'faviconrun',
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

const TRANSPARENT_1X1_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB' +
  'Nl7BcQAAAABJRU5ErkJggg==',
  'base64'
);

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

const CATALOG_RACE_KEYS = ['selfhst', 'dashboardicons', 'lobehub', 'svgl'];

function buildDomainRaceOrder(domain, all) {
  const baseOrder = [
    'scraper', 'googlev2', 'duckduckgo',
    'google', 'faviconkit', 'faviconrun', 'faviconso', 'vemetric', 'favicondev', 'yandex',
  ];

  if (!iconTagForDomain(domain)) return baseOrder;

  const catalogs = CATALOG_RACE_KEYS.filter((k) => all[k]);
  return ['scraper', ...catalogs];
}

function buildFallbackFetchers(domain) {
  const all = {
    scraper:    () => fetchWithCache('scraper', domain, null, () => fetchScraper(domain)),
    googlev2:   () => fetchWithCache('googlev2', domain, 128, () => fetchGoogleV2(domain, 128)),
    duckduckgo: () => fetchWithCache('duckduckgo', domain, null, () => fetchDuckDuckGo(domain)),
    google:     () => fetchWithCache('google', domain, 32, () => fetchGoogle(domain, 32)),
    faviconkit: () => fetchWithCache('faviconkit', domain, 128, () => fetchFaviconkit(domain, 128)),
    faviconrun: () => fetchWithCache('faviconrun', domain, 128, () => fetchFaviconRun(domain, 128)),
    faviconso:  () => fetchWithCache('faviconso', domain, null, () => fetchFaviconSo(domain)),
    vemetric:   () => fetchWithCache('vemetric', domain, null, () => fetchVemetric(domain)),
    favicondev: () => fetchWithCache('favicondev', domain, null, () => fetchFaviconDev(domain)),
    yandex:     () => fetchWithCache('yandex', domain, null, () => fetchYandex(domain)),
  };

  // logo.dev is intentionally excluded from the best-pick race. It has a
  // monthly token quota and always returns a generated monogram placeholder
  // for domains it has no real logo for, which would otherwise win the race
  // over the slower scraper that finds the site's actual favicon. It stays
  // available on its dedicated /logodev/{size}/{domain} route.

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

  const defaultOrder = buildDomainRaceOrder(domain, all);

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
    return {
      buffer: TRANSPARENT_1X1_PNG,
      contentType: 'image/png',
      provider: 'none',
      notFound: true,
    };
  }

  const wrap = (fetcher) =>
    Promise.resolve().then(fetcher).then((r) => {
      if (!r || !r.buffer || r.buffer.length === 0) throw new Error('empty');
      return r;
    });

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
    const result = await Promise.any(racers);
    const entry = {
      buffer: result.buffer,
      contentType: result.contentType,
      provider: result.provider,
    };
    await cache.set(cacheProvider, cacheKey, cacheSize, entry);
    return entry;
  } catch {
    return {
      buffer: TRANSPARENT_1X1_PNG,
      contentType: 'image/png',
      provider: 'none',
      notFound: true,
    };
  }
}

async function pickBest(domain, { refresh = false } = {}) {
  if (!refresh) {
    const cached = await cache.get('best', domain, 32);
    if (cached) return cached;
  } else {
    await cache.del('best', domain, 32);
  }

  // Same chain as GET /scraper/{domain} — avoids the best-pick race returning a
  // fast parent-brand favicon (e.g. Google "G" for drive.google.com).
  if (iconTagForDomain(domain)) {
    const scraperEntry = await fetchWithCache('scraper', domain, null, () => fetchScraper(domain));
    if (scraperEntry) {
      const entry = {
        buffer: scraperEntry.buffer,
        contentType: scraperEntry.contentType,
        provider: scraperEntry.provider,
        url: scraperEntry.url,
      };
      await cache.set('best', domain, 32, entry);
      return entry;
    }
  }

  const fallbacks = buildFallbackFetchers(domain);
  return raceFetchers(fallbacks, 'best', domain, 32);
}

async function pickBestService(service) {
  const cached = await cache.get('best-service', service, null);
  if (cached) return cached;

  const fallbacks = buildServiceFetchers(service);
  return raceFetchers(fallbacks, 'best-service', service, null);
}

async function fetchWithCache(provider, domain, size, fetcher) {
  const cached = await cache.get(provider, domain, size);
  if (cached) {
    if (!(await isBlankFavicon(cached.buffer, cached))) return cached;
    await cache.del(provider, domain, size);
  }

  const result = await fetcher();
  if (result && (await isBlankFavicon(result.buffer, result))) return null;
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

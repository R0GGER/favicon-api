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
  fetchLogoDev,
  fetchSelfhst,
  fetchDashboardIcons,
  fetchScraper,
} = require('./providers');
const cache = require('./cache');

const VALID_DEFAULT_PROVIDERS = new Set([
  'scraper', 'google', 'googlev2', 'duckduckgo', 'yandex',
  'faviconso', 'vemetric', 'favicondev', 'faviconkit', 'logodev',
  'selfhst', 'dashboardicons',
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

function serviceSlugFromDomain(domain) {
  const first = domain.toLowerCase().split('.')[0];
  const slug = first.replace(/[^a-z0-9._-]/g, '');
  return /^[a-z0-9][a-z0-9._-]*$/.test(slug) ? slug : null;
}

function buildFallbackFetchers(domain) {
  const all = {
    scraper:    () => fetchWithCache('scraper', domain, null, () => fetchScraper(domain)),
    googlev2:   () => fetchWithCache('googlev2', domain, 128, () => fetchGoogleV2(domain, 128)),
    duckduckgo: () => fetchWithCache('duckduckgo', domain, null, () => fetchDuckDuckGo(domain)),
    google:     () => fetchWithCache('google', domain, 32, () => fetchGoogle(domain, 32)),
    faviconkit: () => fetchWithCache('faviconkit', domain, 128, () => fetchFaviconkit(domain, 128)),
    faviconso:  () => fetchWithCache('faviconso', domain, null, () => fetchFaviconSo(domain)),
    vemetric:   () => fetchWithCache('vemetric', domain, null, () => fetchVemetric(domain)),
    favicondev: () => fetchWithCache('favicondev', domain, null, () => fetchFaviconDev(domain)),
    yandex:     () => fetchWithCache('yandex', domain, null, () => fetchYandex(domain)),
  };

  if (process.env.LOGODEV_TOKEN) {
    all.logodev = () => fetchWithCache('logodev', domain, null, () => fetchLogoDev(domain));
  }

  const slug = serviceSlugFromDomain(domain);
  if (slug) {
    all.selfhst = () => fetchWithCache('selfhst', slug, null, () => fetchSelfhst(slug));
    all.dashboardicons = () =>
      fetchWithCache('dashboardicons', slug, null, () => fetchDashboardIcons(slug));
  }

  const defaultOrder = [
    'scraper', 'googlev2', 'duckduckgo',
    ...(process.env.LOGODEV_TOKEN ? ['logodev'] : []),
    'google', 'faviconkit', 'faviconso', 'vemetric', 'favicondev', 'yandex',
  ];

  if (DEFAULT_PROVIDER && all[DEFAULT_PROVIDER]) {
    const rest = defaultOrder.filter((k) => k !== DEFAULT_PROVIDER);
    return [DEFAULT_PROVIDER, ...rest].map((k) => all[k]).filter(Boolean);
  }

  return defaultOrder.map((k) => all[k]).filter(Boolean);
}

async function pickBest(domain) {
  const cached = await cache.get('best', domain, 32);
  if (cached) return cached;

  const fallbacks = buildFallbackFetchers(domain);
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

  // Head-start strategy: kick off the preferred provider (first in priority
  // order, e.g. DEFAULT_PROVIDER) immediately. Start the rest after
  // HEAD_START_MS, or sooner if the preferred provider already failed.
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
    await cache.set('best', domain, 32, entry);
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

async function fetchWithCache(provider, domain, size, fetcher) {
  const cached = await cache.get(provider, domain, size);
  if (cached) return cached;

  const result = await fetcher();
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

module.exports = { pickBest, fetchWithCache };

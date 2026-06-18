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
  fetchScraper,
} = require('./providers');
const cache = require('./cache');

const TRANSPARENT_1X1_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB' +
  'Nl7BcQAAAABJRU5ErkJggg==',
  'base64'
);

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

async function pickBest(domain) {
  const cached = await cache.get('best', domain, 32);
  if (cached) return cached;

  const fallbacks = [
    () => fetchWithCache('scraper', domain, null, () => fetchScraper(domain)),
    () => fetchWithCache('googlev2', domain, 128, () => fetchGoogleV2(domain, 128)),
    () => fetchWithCache('duckduckgo', domain, null, () => fetchDuckDuckGo(domain)),
    () => fetchWithCache('google', domain, 32, () => fetchGoogle(domain, 32)),
    () => fetchWithCache('faviconkit', domain, 128, () => fetchFaviconkit(domain, 128)),
    () => fetchWithCache('faviconso', domain, null, () => fetchFaviconSo(domain)),
    () => fetchWithCache('vemetric', domain, null, () => fetchVemetric(domain)),
    () => fetchWithCache('favicondev', domain, null, () => fetchFaviconDev(domain)),
    () => fetchWithCache('yandex', domain, null, () => fetchYandex(domain)),
  ];

  if (process.env.LOGODEV_TOKEN) {
    fallbacks.splice(2, 0, () =>
      fetchWithCache('logodev', domain, null, () => fetchLogoDev(domain))
    );
  }

  for (const fetcher of fallbacks) {
    const result = await fetcher();
    if (result && result.buffer && result.buffer.length > 0) {
      const entry = {
        buffer: result.buffer,
        contentType: result.contentType,
        provider: result.provider,
      };
      await cache.set('best', domain, 32, entry);
      return entry;
    }
  }

  return {
    buffer: TRANSPARENT_1X1_PNG,
    contentType: 'image/png',
    provider: 'none',
    notFound: true,
  };
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

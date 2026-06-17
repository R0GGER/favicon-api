const UPSTREAM_TIMEOUT = parseInt(process.env.UPSTREAM_TIMEOUT || '5000', 10);

const PROVIDERS = {
  google: (domain, size = 32) =>
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${size}`,
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

module.exports = { fetchGoogle, fetchDuckDuckGo, fetchYandex, fetchFaviconSo, fetchVemetric, fetchFaviconDev, PROVIDERS };

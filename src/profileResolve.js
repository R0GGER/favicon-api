/**
 * Resolver for stateless favicon profiles (see src/customProfile.js).
 *
 * Given a parsed target (domain or service) and a decoded profile
 * ({ preferred, fallbacks, size }), walk the provider chain and return the
 * first usable icon:
 *
 *   - A provider that yields an SVG satisfies any minimum size and is served
 *     as-is (image/svg+xml).
 *   - A provider that yields a raster icon must have a source whose smaller
 *     side is >= the minimum size; it is then resized to exactly that size and
 *     served as PNG.
 *   - Otherwise fall through to the next entry. If the whole chain fails, a
 *     not-found placeholder is returned with notFound: true.
 */
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
  fetchLogoDev,
  fetchBrandfetch,
  fetchSelfhst,
  fetchDashboardIcons,
  fetchLobehub,
  fetchSvgl,
  fetchScraper,
} = require('./providers');
const { fetchWithCache } = require('./bestPick');
const {
  looksLikeSvg,
  readImageDimensions,
  resizeIcon,
  normalizeEntryForPng,
  entryLooksLikeIco,
} = require('./imageNormalize');
const { serviceSlugFromDomain } = require('./serviceSlugFromDomain');
const cache = require('./cache');
const { notFoundEntry } = require('./notFoundPlaceholder');

// Raster domain providers with no SVG output. `max` is the largest native size
// the upstream offers (null = the upstream has no size parameter). We always
// request the largest available source so the min-size check has the best
// chance of passing, then downscale to the exact requested size.
const RASTER_PROVIDERS = {
  google: { max: 128, fetch: (d, s) => fetchGoogle(d, s) },
  googlev2: { max: 256, fetch: (d, s) => fetchGoogleV2(d, s) },
  faviconkit: { max: 256, fetch: (d, s) => fetchFaviconkit(d, s) },
  faviconrun: { max: 256, fetch: (d, s) => fetchFaviconRun(d, s) },
  vemetric: { max: 256, fetch: (d, s) => fetchVemetric(d, s) },
  duckduckgo: { max: null, fetch: (d) => fetchDuckDuckGo(d) },
  yandex: { max: null, fetch: (d) => fetchYandex(d) },
  faviconso: { max: null, fetch: (d) => fetchFaviconSo(d) },
  favicondev: { max: null, fetch: (d) => fetchFaviconDev(d) },
  logodev: { max: '404', fetch: (d) => fetchLogoDev(d) },
};

const CATALOG_FETCHERS = {
  selfhst: fetchSelfhst,
  dashboardicons: fetchDashboardIcons,
};

function isSvgEntry(entry) {
  if (!entry || !entry.buffer) return false;
  const ct = (entry.contentType || '').toLowerCase();
  return ct.includes('svg') || looksLikeSvg(entry.buffer);
}

async function adaptScraper(domain) {
  const entry = await fetchWithCache('scraper', domain, null, () => fetchScraper(domain));
  if (!entry || !entry.buffer || entry.buffer.length === 0) return null;
  if (entry.originalSvgBuffer && entry.originalSvgBuffer.length > 0) {
    return {
      buffer: entry.originalSvgBuffer,
      contentType: 'image/svg+xml',
      isSvg: true,
      provider: 'scraper',
      url: entry.url,
    };
  }
  return { ...entry, isSvg: isSvgEntry(entry), provider: 'scraper' };
}

// selfhst / dashboardicons: fixed-size catalog PNGs + an SVG variant. Prefer
// the SVG, fall back to the PNG.
async function adaptCatalog(providerKey, slug, strict) {
  const fetchFn = CATALOG_FETCHERS[providerKey];
  const svg = await fetchWithCache(providerKey, slug, 'profile_svg', () =>
    fetchFn(slug, 'color', { strict, format: 'svg' })
  );
  if (svg && isSvgEntry(svg)) return { ...svg, isSvg: true, provider: providerKey };

  const png = await fetchWithCache(providerKey, slug, 'profile_png', () =>
    fetchFn(slug, 'color', { strict, format: 'png' })
  );
  if (png && png.buffer && png.buffer.length > 0) {
    return { ...png, isSvg: isSvgEntry(png), provider: providerKey };
  }
  return null;
}

// lobehub / svgl: native vector catalogs. Prefer SVG, else a PNG rasterized to
// the requested size.
async function adaptVectorCatalog(providerKey, fetchFn, slug, strict, size) {
  const svg = await fetchWithCache(providerKey, slug, 'profile_svg', () =>
    fetchFn(slug, 'color', size, { strict, format: 'svg' })
  );
  if (svg && isSvgEntry(svg)) return { ...svg, isSvg: true, provider: providerKey };

  const png = await fetchWithCache(providerKey, slug, `profile_png_${size}`, () =>
    fetchFn(slug, 'color', size, { strict, format: 'png' })
  );
  if (png && png.buffer && png.buffer.length > 0) {
    return { ...png, isSvg: isSvgEntry(png), provider: providerKey };
  }
  return null;
}

async function adaptBrandfetch(domain, size) {
  if (!process.env.BRANDFETCH_CLIENT_ID) return null;
  const entry = await fetchWithCache('brandfetch', domain, `profile_${size}`, () =>
    fetchBrandfetch(domain, size, { format: 'svg' })
  );
  if (!entry || !entry.buffer || entry.buffer.length === 0) return null;
  return { ...entry, isSvg: isSvgEntry(entry), provider: 'brandfetch' };
}

async function adaptRaster(providerKey, domain) {
  const cfg = RASTER_PROVIDERS[providerKey];
  if (!cfg) return null;
  const entry = cfg.max
    ? await fetchWithCache(providerKey, domain, cfg.max, () => cfg.fetch(domain, cfg.max))
    : await fetchWithCache(providerKey, domain, null, () => cfg.fetch(domain));
  if (!entry || !entry.buffer || entry.buffer.length === 0) return null;
  return { ...entry, isSvg: isSvgEntry(entry), provider: providerKey };
}

async function fetchCandidate(provider, target, size) {
  const domain = target.type === 'domain' ? target.value : null;
  const service = target.type === 'service' ? target.value : null;
  // Domain-derived slugs are resolved strictly (exact slug / curated alias) so a
  // fuzzy match never swaps in an unrelated icon; user-typed service names may
  // match fuzzily.
  const slug = service || (domain ? serviceSlugFromDomain(domain) : null);
  const strict = target.type === 'domain';

  switch (provider) {
    case 'scraper':
      return domain ? adaptScraper(domain) : null;
    case 'brandfetch':
      return domain ? adaptBrandfetch(domain, size) : null;
    case 'selfhst':
    case 'dashboardicons':
      return slug ? adaptCatalog(provider, slug, strict) : null;
    case 'lobehub':
      return slug ? adaptVectorCatalog('lobehub', fetchLobehub, slug, strict, size) : null;
    case 'svgl':
      return slug ? adaptVectorCatalog('svgl', fetchSvgl, slug, strict, size) : null;
    default:
      return domain && RASTER_PROVIDERS[provider] ? adaptRaster(provider, domain) : null;
  }
}

// Turn a raw candidate into the bytes to serve, or null when a raster source is
// below the minimum size (caller then falls through to the next provider).
async function finalizeCandidate(candidate, size) {
  if (candidate.isSvg) {
    return { buffer: candidate.buffer, contentType: 'image/svg+xml' };
  }

  let buffer = candidate.buffer;
  let contentType = candidate.contentType;

  if (entryLooksLikeIco(candidate)) {
    try {
      const normalized = await normalizeEntryForPng(candidate);
      buffer = normalized.buffer;
      contentType = normalized.contentType;
    } catch {
      return null;
    }
  }

  const dims = await readImageDimensions(buffer, { contentType, url: candidate.url });
  if (!dims) return null;
  const side = Math.min(dims.width || 0, dims.height || dims.width || 0);
  if (side < size) return null;

  try {
    const resized = await resizeIcon(buffer, size);
    return { buffer: resized, contentType: 'image/png' };
  } catch {
    return null;
  }
}

async function resolveProfileIcon(target, profile, id) {
  const { preferred, fallbacks, size } = profile;
  const cacheDomain = `${id}_${target.value}`;

  const cached = await cache.get('profile', cacheDomain, size);
  if (cached) {
    if (cached.notFound || cached.provider === 'none') {
      await cache.del('profile', cacheDomain, size);
    } else {
      return cached;
    }
  }

  const chain = [preferred, ...fallbacks];
  for (const provider of chain) {
    let candidate = null;
    try {
      candidate = await fetchCandidate(provider, target, size);
    } catch {
      candidate = null;
    }
    if (!candidate || !candidate.buffer || candidate.buffer.length === 0) continue;

    const served = await finalizeCandidate(candidate, size);
    if (!served) continue;

    const entry = {
      buffer: served.buffer,
      contentType: served.contentType,
      provider: candidate.provider || provider,
    };
    if (candidate.url) entry.url = candidate.url;
    await cache.set('profile', cacheDomain, size, entry);
    return entry;
  }

  return notFoundEntry(size);
}

module.exports = { resolveProfileIcon };

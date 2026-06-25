const dns = require('dns');
// Prefer IPv4 for upstream fetches — many VPS/datacenter IPv6 routes fail or
// hang against CDNs (e.g. redditstatic.com) while IPv4 works fine.
dns.setDefaultResultOrder('ipv4first');

const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const path = require('path');
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
  fetchLobehub,
  fetchScraper,
  fetchScraperAsset,
  fetchScraperAllIcons,
  getScraperMaxIconSize,
  invalidateScraperDomainCaches,
  PROVIDERS,
  getSelfhstVariantAvailability,
  getDashboardIconsVariantAvailability,
} = require('./providers');
const { pickBest, pickBestService, fetchWithCache } = require('./bestPick');
const {
  resolveServiceMatches,
  ensureDashboardIndex,
  ensureSelfhstIndex,
  ensureLobehubIndex,
  getLobehubVariantAvailability,
} = require('./serviceAliases');
const { serviceSlugFromDomain, listDomainIconTags } = require('./serviceSlugFromDomain');
const { toDisplayPng } = require('./imageNormalize');
const cache = require('./cache');
const apiRoutes = require('./apiRoutes');
const apiStore = require('./apiStore');
const { extractDomainFromInput } = require('./domainValidation');

// Mirror of the parsing logic in src/apiRoutes.js (kept local so the homepage
// /providers endpoint can advertise the current API mode to the docs page
// without importing the router itself).
const API_REQUIRE_KEY = (() => {
  const raw = String(process.env.API_REQUIRE_KEY ?? '').trim().toLowerCase();
  if (raw === '') return true;
  return !['false', '0', 'no', 'off'].includes(raw);
})();

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.set('trust proxy', true);

// SEO / templated index. The HTML template ships with `__BASE_URL__` tokens
// in the <head> (canonical, Open Graph, Twitter Card, JSON-LD) so absolute
// URLs resolve to whichever public origin the deployment is reached on,
// without requiring the operator to bake the hostname into the image.
const INDEX_HTML_TEMPLATE = fs.readFileSync(
  path.join(__dirname, 'public', 'index.html'),
  'utf8'
);
const API_HTML_TEMPLATE = fs.readFileSync(
  path.join(__dirname, 'public', 'api.html'),
  'utf8'
);

function getBaseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function renderTemplate(template) {
  return (req, res) => {
    const html = template.replace(/__BASE_URL__/g, getBaseUrl(req));
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.send(html);
  };
}

app.get(['/', '/index.html'], renderTemplate(INDEX_HTML_TEMPLATE));
app.get(['/api', '/api.html'], renderTemplate(API_HTML_TEMPLATE));

// Browser custom search engine: /search?q=example.com → homepage with results.
app.get('/search', (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) {
    return res.redirect(302, '/');
  }
  res.redirect(302, `/?q=${encodeURIComponent(q)}`);
});

// OpenSearch descriptor for one-click "Add search engine" in Firefox/Chrome/etc.
app.get('/opensearch.xml', (req, res) => {
  const baseUrl = getBaseUrl(req);
  const body =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">\n' +
    '  <ShortName>FaviconAPI</ShortName>\n' +
    '  <Description>Look up favicons for any domain or service name</Description>\n' +
    `  <Url type="text/html" template="${baseUrl}/search?q={searchTerms}"/>\n` +
    `  <Image height="64" width="64" type="image/png">${baseUrl}/favicon.png</Image>\n` +
    '</OpenSearchDescription>\n';
  res.set('Content-Type', 'application/opensearchdescription+xml; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(body);
});

// robots.txt: allow indexing of the homepage and static assets only.
// The favicon API endpoints (catch-all /:domain, /g, /d, ...) are not
// useful in search results and would otherwise waste crawl budget on a
// potentially infinite URL space.
app.get('/robots.txt', (req, res) => {
  const baseUrl = getBaseUrl(req);
  const body =
    '# FaviconAPI\n' +
    '# Index the homepage + static assets only; the favicon API endpoints\n' +
    '# are not useful in search results and produce an unbounded URL space.\n' +
    '\n' +
    'User-agent: *\n' +
    'Allow: /$\n' +
    'Allow: /api\n' +
    'Allow: /api.html\n' +
    'Allow: /favicon.png\n' +
    'Allow: /logo.png\n' +
    'Allow: /sitemap.xml\n' +
    'Disallow: /\n' +
    '\n' +
    `Sitemap: ${baseUrl}/sitemap.xml\n`;
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(body);
});

// sitemap.xml: single-URL sitemap pointing at the homepage. The host is
// derived from the request so it works behind any reverse proxy without
// configuration (relies on `trust proxy` above for X-Forwarded-Proto).
app.get('/sitemap.xml', (req, res) => {
  const baseUrl = getBaseUrl(req);
  const body =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    '  <url>\n' +
    `    <loc>${baseUrl}/</loc>\n` +
    '    <changefreq>monthly</changefreq>\n' +
    '    <priority>1.0</priority>\n' +
    '  </url>\n' +
    '  <url>\n' +
    `    <loc>${baseUrl}/api</loc>\n` +
    '    <changefreq>monthly</changefreq>\n' +
    '    <priority>0.8</priority>\n' +
    '  </url>\n' +
    '</urlset>\n';
  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(body);
});

app.use(
  express.static(path.join(__dirname, 'public'), {
    // Disable directory-index auto-serving so requests for `/` (and the
    // raw `/index.html` file) are handled by the templated renderIndex
    // route above — otherwise the unrendered `__BASE_URL__` tokens would
    // leak to the browser.
    index: false,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.set('Cache-Control', 'no-cache');
      }
    },
  })
);

// FaviconAPIs-style JSON API (/api/v1/favicon) + public CDN route
// (/cdn/favicons/:domain.png). Mounted before the catch-all `/:domain`
// route below so its paths take precedence.
app.use(apiRoutes);

const VALID_GOOGLE_SIZES = new Set([16, 32, 64, 128]);
const VALID_GOOGLEV2_SIZES = new Set([16, 32, 64, 128, 256]);
const VALID_FAVICONKIT_SIZES = new Set([16, 32, 64, 128, 256]);
const VALID_VEMETRIC_FORMATS = new Set(['png', 'jpg', 'webp']);
const VALID_SELFHST_VARIANTS = new Set(['color', 'light', 'dark']);
const VALID_DASHBOARDICONS_VARIANTS = new Set(['color', 'light', 'dark']);
const VALID_LOBEHUB_VARIANTS = new Set(['color', 'light', 'dark']);
const VALID_LOBEHUB_SIZES = new Set([64, 128, 256]);
const DEFAULT_LOBEHUB_SIZE = 128;
const SERVICE_SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;
const CACHE_CONTROL = 'public, max-age=86400';
const JSON_CACHE_CONTROL = 'no-cache';

function sendFavicon(res, entry) {
  res.set('Content-Type', entry.contentType);
  res.set('Cache-Control', CACHE_CONTROL);
  res.set('X-Favicon-Source', entry.provider);
  if (entry.url) res.set('X-Favicon-Url', entry.url);
  res.send(entry.buffer);
}

function extractDomain(raw) {
  return extractDomainFromInput(raw);
}

function normalizeServiceSlug(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function extractService(raw) {
  const slug = normalizeServiceSlug(raw);
  if (!slug || !SERVICE_SLUG_RE.test(slug)) return null;
  return slug;
}

function parseDomainOrService(raw) {
  const domain = extractDomain(raw);
  if (domain) return { type: 'domain', value: domain };
  const service = extractService(raw);
  if (service) return { type: 'service', value: service };
  return null;
}

function buildCatalogVariantEndpoints(host, routePrefix, slug, sourceFn, availability) {
  if (!slug || !availability) return null;

  const encoded = encodeURIComponent(slug);
  const proxyBase = `${host}/${routePrefix}/${encoded}`;
  const variants = {};

  if (availability.color) {
    variants.color = {
      proxy: proxyBase,
      source: sourceFn(slug, 'color'),
    };
  }
  if (availability.light) {
    variants.light = {
      proxy: `${proxyBase}?variant=light`,
      source: sourceFn(slug, 'light'),
    };
  }
  if (availability.dark) {
    variants.dark = {
      proxy: `${proxyBase}?variant=dark`,
      source: sourceFn(slug, 'dark'),
    };
  }

  if (!variants.color) return null;

  return {
    service: slug,
    proxy: variants.color.proxy,
    source: variants.color.source,
    variants,
  };
}

function emptyCatalogProvider() {
  return { service: null, query: null, proxy: null, source: null, variants: null };
}

async function buildServiceCatalogEndpoints(host, query, selfhstServiceSlug, dashboardServiceSlug, lobehubServiceSlug) {
  const sizedEntries = (sizes, proxyPath, sourceFn) =>
    Object.fromEntries(
      sizes.map((size) => [
        String(size),
        { proxy: `${host}${proxyPath(size)}`, source: sourceFn(size) },
      ])
    );

  const [selfhstAvailability, dashboardAvailability, lobehubAvailability] = await Promise.all([
    selfhstServiceSlug
      ? getSelfhstVariantAvailability(selfhstServiceSlug)
      : Promise.resolve(null),
    dashboardServiceSlug
      ? getDashboardIconsVariantAvailability(dashboardServiceSlug)
      : Promise.resolve(null),
    lobehubServiceSlug
      ? Promise.resolve(getLobehubVariantAvailability(lobehubServiceSlug))
      : Promise.resolve(null),
  ]);

  const selfhstBlock = buildCatalogVariantEndpoints(
    host,
    'sh',
    selfhstServiceSlug,
    PROVIDERS.selfhst,
    selfhstAvailability
  );
  const selfhst = selfhstBlock
    ? { ...selfhstBlock, query }
    : emptyCatalogProvider();

  const dashboardBlock = buildCatalogVariantEndpoints(
    host,
    'di',
    dashboardServiceSlug,
    PROVIDERS.dashboardIcons,
    dashboardAvailability
  );
  const dashboardicons = dashboardBlock
    ? { ...dashboardBlock, query }
    : emptyCatalogProvider();

  const lobehubAvailabilityResolved = lobehubAvailability;
  const lobehubBlock = buildCatalogVariantEndpoints(
    host,
    'lb',
    lobehubServiceSlug,
    PROVIDERS.lobehub,
    lobehubAvailabilityResolved
  );
  const lobehubSizes = [64, 128, 256];
  const lobehubSlugEncoded = lobehubServiceSlug
    ? encodeURIComponent(lobehubServiceSlug)
    : null;
  const lobehub = lobehubBlock
    ? {
        ...lobehubBlock,
        query,
        proxy: `${host}/lb/${lobehubSlugEncoded}?size=${DEFAULT_LOBEHUB_SIZE}`,
        sizes: sizedEntries(
          lobehubSizes,
          (size) => `/lb/${lobehubSlugEncoded}?size=${size}`,
          () => PROVIDERS.lobehub(lobehubServiceSlug)
        ),
        variants: Object.fromEntries(
          Object.entries(lobehubBlock.variants).map(([variant, entry]) => [
            variant,
            {
              proxy: `${host}/lb/${lobehubSlugEncoded}?size=${DEFAULT_LOBEHUB_SIZE}${
                variant === 'color' ? '' : `&variant=${variant}`
              }`,
              source: entry.source,
            },
          ])
        ),
      }
    : { ...emptyCatalogProvider(), sizes: null };

  return { selfhst, dashboardicons, lobehub };
}

// Google favicon proxy: /g/:size/:domain
app.get('/g/:size/:domain', async (req, res) => {
  const size = parseInt(req.params.size, 10);
  if (!VALID_GOOGLE_SIZES.has(size)) {
    return res.status(400).json({ error: 'Invalid size. Use 16, 32, 64, or 128.' });
  }

  const domain = extractDomain(req.params.domain);
  if (!domain) return res.status(400).json({ error: 'Invalid domain.' });

  try {
    const entry = await fetchWithCache('google', domain, size, () => fetchGoogle(domain, size));
    if (!entry) return res.status(502).json({ error: 'Upstream fetch failed.' });
    sendFavicon(res, entry);
  } catch (err) {
    console.error('Google proxy error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
});

// Google v2 favicon proxy: /g2/:size/:domain
app.get('/g2/:size/:domain', async (req, res) => {
  const size = parseInt(req.params.size, 10);
  if (!VALID_GOOGLEV2_SIZES.has(size)) {
    return res.status(400).json({ error: 'Invalid size. Use 16, 32, 64, 128, or 256.' });
  }

  const domain = extractDomain(req.params.domain);
  if (!domain) return res.status(400).json({ error: 'Invalid domain.' });

  try {
    const entry = await fetchWithCache('googlev2', domain, size, () => fetchGoogleV2(domain, size));
    if (!entry) return res.status(502).json({ error: 'Upstream fetch failed.' });
    sendFavicon(res, entry);
  } catch (err) {
    console.error('Google v2 proxy error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
});

// DuckDuckGo favicon proxy: /d/:domain
app.get('/d/:domain', async (req, res) => {
  const domain = extractDomain(req.params.domain);
  if (!domain) return res.status(400).json({ error: 'Invalid domain.' });

  try {
    const entry = await fetchWithCache('duckduckgo', domain, null, () => fetchDuckDuckGo(domain));
    if (!entry) return res.status(502).json({ error: 'Upstream fetch failed.' });
    sendFavicon(res, entry);
  } catch (err) {
    console.error('DuckDuckGo proxy error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
});

// Yandex favicon proxy: /y/:domain
app.get('/y/:domain', async (req, res) => {
  const domain = extractDomain(req.params.domain);
  if (!domain) return res.status(400).json({ error: 'Invalid domain.' });

  try {
    const entry = await fetchWithCache('yandex', domain, null, () => fetchYandex(domain));
    if (!entry) return res.status(502).json({ error: 'Upstream fetch failed.' });
    sendFavicon(res, entry);
  } catch (err) {
    console.error('Yandex proxy error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
});

// Favicon.so proxy: /f/:domain
app.get('/f/:domain', async (req, res) => {
  const domain = extractDomain(req.params.domain);
  if (!domain) return res.status(400).json({ error: 'Invalid domain.' });

  try {
    const entry = await fetchWithCache('faviconso', domain, null, () => fetchFaviconSo(domain));
    if (!entry) return res.status(502).json({ error: 'Upstream fetch failed.' });
    sendFavicon(res, entry);
  } catch (err) {
    console.error('Favicon.so proxy error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
});

// Vemetric favicon proxy: /v/:domain
app.get('/v/:domain', async (req, res) => {
  const domain = extractDomain(req.params.domain);
  if (!domain) return res.status(400).json({ error: 'Invalid domain.' });

  const size = req.query.size ? parseInt(req.query.size, 10) : null;
  const format = req.query.format || null;

  if (format && !VALID_VEMETRIC_FORMATS.has(format)) {
    return res.status(400).json({ error: 'Invalid format. Use png, jpg, or webp.' });
  }

  try {
    const cacheSize = size || format || null;
    const entry = await fetchWithCache('vemetric', domain, cacheSize, () => fetchVemetric(domain, size, format));
    if (!entry) return res.status(502).json({ error: 'Upstream fetch failed.' });
    sendFavicon(res, entry);
  } catch (err) {
    console.error('Vemetric proxy error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
});

// Favicon-3j1 proxy: /p/:domain
app.get('/p/:domain', async (req, res) => {
  const domain = extractDomain(req.params.domain);
  if (!domain) return res.status(400).json({ error: 'Invalid domain.' });

  try {
    const entry = await fetchWithCache('favicondev', domain, null, () => fetchFaviconDev(domain));
    if (!entry) return res.status(502).json({ error: 'Upstream fetch failed.' });
    sendFavicon(res, entry);
  } catch (err) {
    console.error('Favicon-3j1 proxy error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
});

// Faviconkit proxy: /k/:size/:domain
app.get('/k/:size/:domain', async (req, res) => {
  const size = parseInt(req.params.size, 10);
  if (!VALID_FAVICONKIT_SIZES.has(size)) {
    return res.status(400).json({ error: 'Invalid size. Use 16, 32, 64, 128, or 256.' });
  }

  const domain = extractDomain(req.params.domain);
  if (!domain) return res.status(400).json({ error: 'Invalid domain.' });

  try {
    const entry = await fetchWithCache('faviconkit', domain, size, () => fetchFaviconkit(domain, size));
    if (!entry) return res.status(502).json({ error: 'Upstream fetch failed.' });
    sendFavicon(res, entry);
  } catch (err) {
    console.error('Faviconkit proxy error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
});

// logo.dev proxy: /l/:domain (requires LOGODEV_TOKEN)
app.get('/l/:domain', async (req, res) => {
  if (!process.env.LOGODEV_TOKEN) {
    return res.status(503).json({ error: 'logo.dev not configured. Set LOGODEV_TOKEN.' });
  }

  const domain = extractDomain(req.params.domain);
  if (!domain) return res.status(400).json({ error: 'Invalid domain.' });

  try {
    const entry = await fetchWithCache('logodev', domain, null, () => fetchLogoDev(domain));
    if (!entry) return res.status(502).json({ error: 'Upstream fetch failed.' });
    sendFavicon(res, entry);
  } catch (err) {
    console.error('logo.dev proxy error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
});

// Generic asset proxy used by the HTML Scraper card to render every icon
// besticon discovered for a domain. Some upstream CDNs (Reddit, Twitter, ...)
// block direct browser <img> loads via Referer/UA filtering; fetching them
// server-side with the scraper's existing header strategy bypasses that and
// gives us a clean same-origin URL. Cached on disk + LRU keyed by URL hash.
const PRIVATE_HOST_RE = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|::1$|fe80:|fc00:|fd00:)/i;

app.get('/s-asset', async (req, res) => {
  const raw = req.query.url;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) {
    return res.status(400).json({ error: 'Invalid url query.' });
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return res.status(400).json({ error: 'Invalid url.' });
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return res.status(400).json({ error: 'Only http(s) urls are allowed.' });
  }
  if (PRIVATE_HOST_RE.test(parsed.hostname)) {
    return res.status(400).json({ error: 'Disallowed host.' });
  }

  const target = parsed.toString();
  const hash = crypto.createHash('sha1').update(target).digest('hex');
  const referer = `${parsed.protocol}//${parsed.hostname}/`;

  try {
    const entry = await fetchWithCache('asset-v2', hash, null, async () => {
      const result = await fetchScraperAsset(target, referer);
      if (!result) return null;
      try {
        const displayed = await toDisplayPng(result.buffer, {
          contentType: result.contentType,
          url: target,
        });
        return {
          ...result,
          buffer: displayed.buffer,
          contentType: displayed.contentType,
          provider: 'asset',
        };
      } catch {
        return { ...result, provider: 'asset' };
      }
    });
    if (!entry) return res.status(502).json({ error: 'Could not fetch asset.' });
    sendFavicon(res, entry);
  } catch (err) {
    console.error('Asset proxy error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
});

// HTML scraper proxy: /s/:domain[?refresh=1]
app.get('/s/:domain', async (req, res) => {
  const domain = extractDomain(req.params.domain);
  if (!domain) return res.status(400).json({ error: 'Invalid domain.' });

  const refresh = req.query.refresh === '1' || req.query.nocache === '1';

  try {
    if (refresh) {
      await cache.del('scraper', domain, null);
      invalidateScraperDomainCaches(domain);
    }
    const entry = await fetchWithCache('scraper', domain, null, () => fetchScraper(domain));
    if (!entry) return res.status(502).json({ error: 'Could not scrape favicon.' });
    sendFavicon(res, entry);
  } catch (err) {
    console.error('Scraper proxy error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
});

// Explicit domain → icon-tag table (see src/domainIconTags.js)
app.get('/domain-icon-tags', (req, res) => {
  res.json({ entries: listDomainIconTags() });
});

// Resolve a service search term to canonical icon slug(s): /services/resolve/:service
app.get('/services/resolve/:service', async (req, res) => {
  const raw = decodeURIComponent(req.params.service || '');
  const host = raw.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim().toLowerCase();
  let service = host.includes('.') ? serviceSlugFromDomain(host) : null;
  if (!service) service = extractService(raw);
  if (!service) return res.status(400).json({ error: 'Invalid service name.' });

  try {
    const matches = await resolveServiceMatches(service);
    res.json(matches);
  } catch (err) {
    console.error('Service resolve error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
});

// selfhst icons (service-name based): /sh/:service[?variant=color|light|dark]
app.get('/sh/:service', async (req, res) => {
  const service = extractService(req.params.service);
  if (!service) return res.status(400).json({ error: 'Invalid service name.' });

  const variant = (req.query.variant || 'color').toString().toLowerCase();
  if (!VALID_SELFHST_VARIANTS.has(variant)) {
    return res.status(400).json({ error: 'Invalid variant. Use color, light, or dark.' });
  }

  try {
    const cacheKey = variant === 'color' ? null : `${variant}_v3`;
    const entry = await fetchWithCache('selfhst', service, cacheKey, () => fetchSelfhst(service, variant));
    if (!entry) return res.status(404).json({ error: 'Service icon not found.' });
    sendFavicon(res, entry);
  } catch (err) {
    console.error('selfhst proxy error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
});

// homarr-labs/dashboard-icons (service-name based): /di/:service[?variant=color|light|dark]
app.get('/di/:service', async (req, res) => {
  const service = extractService(req.params.service);
  if (!service) return res.status(400).json({ error: 'Invalid service name.' });

  const variant = (req.query.variant || 'color').toString().toLowerCase();
  if (!VALID_DASHBOARDICONS_VARIANTS.has(variant)) {
    return res.status(400).json({ error: 'Invalid variant. Use color, light, or dark.' });
  }

  try {
    const cacheKey = variant === 'color' ? null : `${variant}_v3`;
    const entry = await fetchWithCache(
      'dashboardicons',
      service,
      cacheKey,
      () => fetchDashboardIcons(service, variant)
    );
    if (!entry) return res.status(404).json({ error: 'Service icon not found.' });
    sendFavicon(res, entry);
  } catch (err) {
    console.error('Dashboard Icons proxy error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
});

// LobeHub icons (service-name based): /lb/:service[?variant=color|light|dark][&size=64|128|256]
app.get('/lb/:service', async (req, res) => {
  const service = extractService(req.params.service);
  if (!service) return res.status(400).json({ error: 'Invalid service name.' });

  const variant = (req.query.variant || 'color').toString().toLowerCase();
  if (!VALID_LOBEHUB_VARIANTS.has(variant)) {
    return res.status(400).json({ error: 'Invalid variant. Use color, light, or dark.' });
  }

  const size = parseInt(req.query.size || String(DEFAULT_LOBEHUB_SIZE), 10);
  if (!VALID_LOBEHUB_SIZES.has(size)) {
    return res.status(400).json({ error: 'Invalid size. Use 64, 128, or 256.' });
  }

  try {
    const cacheKey = `${size}_${variant === 'color' ? 'c' : variant}_v3`;
    const entry = await fetchWithCache(
      'lobehub',
      service,
      cacheKey,
      () => fetchLobehub(service, variant, size)
    );
    if (!entry) return res.status(404).json({ error: 'Service icon not found.' });
    sendFavicon(res, entry);
  } catch (err) {
    console.error('LobeHub proxy error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
});

// Provider availability/config: /providers
app.get('/providers', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    logoDev: !!process.env.LOGODEV_TOKEN,
    logoDevToken: process.env.LOGODEV_TOKEN || null,
    defaultProvider: (process.env.DEFAULT_PROVIDER || '').trim().toLowerCase() || null,
    upstreamIpv4: true,
    api: {
      requireKey: API_REQUIRE_KEY,
      cacheTtl: parseInt(process.env.API_CACHE_TTL || '604800', 10),
      plans: { ...apiStore.PLAN_LIMITS },
    },
  });
});

// JSON list of favicon endpoint URLs for a domain or service: /:domain/json
app.get('/:domain/json', async (req, res) => {
  const parsed = parseDomainOrService(req.params.domain);
  if (!parsed) return res.status(400).json({ error: 'Invalid domain or service name.' });

  const host = `${req.protocol}://${req.get('host')}`;

  if (parsed.type === 'service') {
    const service = parsed.value;
    const encoded = encodeURIComponent(service);

    try {
      const matches = await resolveServiceMatches(service);
      const { selfhst, dashboardicons, lobehub } = await buildServiceCatalogEndpoints(
        host,
        service,
        matches.providers.selfhst.resolved,
        matches.providers.dashboardicons.resolved,
        matches.providers.lobehub.resolved
      );

      res.set('Cache-Control', JSON_CACHE_CONTROL);
      return res.json({
        service,
        endpoints: {
          best: {
            proxy: `${host}/${encoded}`,
            source: null,
          },
          resolve: {
            proxy: `${host}/services/resolve/${encoded}`,
            source: null,
          },
          selfhst,
          dashboardicons,
          lobehub,
        },
      });
    } catch (err) {
      console.error('Service JSON error:', err.message);
      return res.status(500).json({ error: 'Internal error.' });
    }
  }

  const domain = parsed.value;
  const encoded = encodeURIComponent(domain);
  const [scraperCached, scraperAllIcons] = await Promise.all([
    cache.get('scraper', domain, null),
    fetchScraperAllIcons(domain),
    ensureDashboardIndex(),
    ensureSelfhstIndex(),
    ensureLobehubIndex(),
  ]);

  const googleSizes = [16, 32, 64, 128];
  const googleV2Sizes = [16, 32, 64, 128, 256];
  const faviconkitSizes = [16, 32, 64, 128, 256];
  const vemetricSizes = [16, 32, 64, 128, 256];
  const vemetricFormats = ['png', 'jpg', 'webp'];

  const sizedEntries = (sizes, proxyPath, sourceFn) =>
    Object.fromEntries(
      sizes.map((size) => [
        String(size),
        { proxy: `${host}${proxyPath(size)}`, source: sourceFn(size) },
      ])
    );

  const vemetricVariants = {
    default: {
      proxy: `${host}/v/${encoded}`,
      source: PROVIDERS.vemetric(domain),
    },
    sizes: sizedEntries(
      vemetricSizes,
      (size) => `/v/${encoded}?size=${size}`,
      (size) => PROVIDERS.vemetric(domain, size)
    ),
    formats: Object.fromEntries(
      vemetricFormats.map((format) => [
        format,
        {
          proxy: `${host}/v/${encoded}?format=${format}`,
          source: PROVIDERS.vemetric(domain, null, format),
        },
      ])
    ),
  };

  const logoDevConfigured = !!process.env.LOGODEV_TOKEN;
  const logodev = {
    proxy: `${host}/l/${encoded}`,
    // Omit upstream URL: it embeds LOGODEV_TOKEN in the query string.
    source: null,
    configured: logoDevConfigured,
  };

  const serviceSlug = serviceSlugFromDomain(domain);

  let selfhstServiceSlug = null;
  let dashboardServiceSlug = null;
  let lobehubServiceSlug = null;
  if (serviceSlug) {
    const matches = await resolveServiceMatches(serviceSlug);
    selfhstServiceSlug = matches.providers.selfhst.resolved;
    dashboardServiceSlug = matches.providers.dashboardicons.resolved;
    lobehubServiceSlug = matches.providers.lobehub.resolved;
  }

  const { selfhst, dashboardicons, lobehub } = await buildServiceCatalogEndpoints(
    host,
    serviceSlug,
    selfhstServiceSlug,
    dashboardServiceSlug,
    lobehubServiceSlug
  );

  res.set('Cache-Control', JSON_CACHE_CONTROL);
  res.json({
    domain,
    endpoints: {
      best: {
        proxy: `${host}/${encoded}`,
        source: null,
      },
      google: sizedEntries(
        googleSizes,
        (size) => `/g/${size}/${encoded}`,
        (size) => PROVIDERS.google(domain, size)
      ),
      googlev2: sizedEntries(
        googleV2Sizes,
        (size) => `/g2/${size}/${encoded}`,
        (size) => PROVIDERS.googleV2(domain, size)
      ),
      duckduckgo: {
        proxy: `${host}/d/${encoded}`,
        source: PROVIDERS.duckduckgo(domain),
      },
      yandex: {
        proxy: `${host}/y/${encoded}`,
        source: PROVIDERS.yandex(domain),
      },
      faviconso: {
        proxy: `${host}/f/${encoded}`,
        source: PROVIDERS.faviconSo(domain),
      },
      vemetric: vemetricVariants,
      favicondev: {
        proxy: `${host}/p/${encoded}`,
        source: PROVIDERS.faviconDev(domain),
      },
      faviconkit: sizedEntries(
        faviconkitSizes,
        (size) => `/k/${size}/${encoded}`,
        (size) => PROVIDERS.faviconkit(domain, size)
      ),
      logodev,
      scraper: {
        proxy: `${host}/s/${encoded}`,
        source: scraperCached?.url || null,
        maxIconSize: getScraperMaxIconSize(),
        icons: scraperAllIcons,
      },
      selfhst,
      dashboardicons,
      lobehub,
    },
  });
});

// Direct / best-pick favicon: /:domain or /:service
app.get('/:domain', async (req, res) => {
  const parsed = parseDomainOrService(req.params.domain);
  if (!parsed) return res.status(400).json({ error: 'Invalid domain or service name.' });

  try {
    const entry = parsed.type === 'domain'
      ? await pickBest(parsed.value)
      : await pickBestService(parsed.value);
    if (entry.notFound) {
      res.status(404);
    }
    sendFavicon(res, entry);
  } catch (err) {
    console.error('Best-pick error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Favicon proxy listening on port ${PORT}`);
});

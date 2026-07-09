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
  fetchFaviconRun,
  fetchTwentyIcons,
  fetchRyanjc,
  fetchLogoDev,
  fetchBrandfetch,
  normalizeBrandfetchOptions,
  brandfetchCacheKey,
  fetchSelfhst,
  fetchDashboardIcons,
  fetchLobehub,
  fetchSvgl,
  fetchScraper,
  fetchScraperAsset,
  fetchScraperAllIcons,
  getScraperMaxIconSize,
  capScraperProxyOutput,
  getScraperFallback,
  invalidateScraperDomainCaches,
  PROVIDERS,
  getSelfhstVariantAvailability,
  getDashboardIconsVariantAvailability,
  getLobehubVariantAvailability,
} = require('./providers');
const { pickBest, pickBestService, fetchWithCache } = require('./bestPick');
const {
  resolveServiceMatches,
  ensureDashboardIndex,
  ensureSelfhstIndex,
  ensureLobehubIndex,
  ensureSvglIndex,
  getSvglVariantAvailability,
} = require('./serviceAliases');
const { serviceSlugFromDomain, listDomainIconTags } = require('./serviceSlugFromDomain');
const {
  toDisplayPng,
  normalizeEntryForPng,
  entryLooksLikeIco,
  resizeIcon,
  rasterizeSvgToSize,
  readImageDimensions,
  looksLikeSvg,
  looksLikeIco,
} = require('./imageNormalize');
const cache = require('./cache');
const apiRoutes = require('./apiRoutes');
const apiStore = require('./apiStore');
const { renderDocPage, NAV_PAGES, buildSearchIndex } = require('./docsRender');
const { extractDomainFromInput } = require('./domainValidation');
const { decodeProfile } = require('./customProfile');
const { resolveProfileIcon } = require('./profileResolve');

const { version: APP_VERSION } = require('../package.json');

// Mirror of the parsing logic in src/apiRoutes.js (kept local so the homepage
// /providers endpoint can advertise the current API mode to the docs page
// without importing the router itself).
const API_REQUIRE_KEY = (() => {
  const raw = String(process.env.API_REQUIRE_KEY ?? '').trim().toLowerCase();
  if (raw === '') return true;
  return !['false', '0', 'no', 'off'].includes(raw);
})();

const UI_INCLUDE_APP_ICONS = (() => {
  const raw = String(process.env.UI_INCLUDE_APP_ICONS ?? '').trim().toLowerCase();
  if (raw === '') return true;
  return !['false', '0', 'no', 'off'].includes(raw);
})();

const UI_CARD_URL = (() => {
  const raw = String(process.env.UI_CARD_URL ?? '').trim().toLowerCase();
  return raw === 'source' ? 'source' : 'proxy';
})();

const UI_ENABLE_DOCS = (() => {
  const raw = String(process.env.UI_ENABLE_DOCS ?? '').trim().toLowerCase();
  if (raw === '') return true;
  return !['false', '0', 'no', 'off'].includes(raw);
})();

function escapeHtmlAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// Umami-compatible analytics snippet for /, /api, and /docs. Both script src
// and website ID must be set; leave either empty to disable tracking.
const UI_ANALYTICS_SCRIPT = (() => {
  const src = String(process.env.UI_ANALYTICS_SCRIPT_SRC ?? '').trim();
  const id = String(process.env.UI_ANALYTICS_WEBSITE_ID ?? '').trim();
  if (!src || !id) return '';
  if (!/^https?:\/\//i.test(src)) return '';
  const domains = String(process.env.UI_ANALYTICS_DOMAINS ?? '').trim();
  const domainsAttr = domains ? ` data-domains="${escapeHtmlAttr(domains)}"` : '';
  return `<script defer src="${escapeHtmlAttr(src)}" data-website-id="${escapeHtmlAttr(id)}"${domainsAttr}></script>`;
})();

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.set('trust proxy', true);

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.sendStatus(204);
  }
  next();
});

// SEO / templated index. The HTML template ships with `__BASE_URL__` tokens
// in the <head> (canonical, Open Graph, Twitter Card, JSON-LD) so absolute
// URLs resolve to whichever public origin the deployment is reached on,
// without requiring the operator to bake the hostname into the image.
// `__VERSION__` is substituted from package.json for the page footer.
const INDEX_HTML_TEMPLATE = fs.readFileSync(
  path.join(__dirname, 'public', 'index.html'),
  'utf8'
);
const API_HTML_TEMPLATE = fs.readFileSync(
  path.join(__dirname, 'public', 'api.html'),
  'utf8'
);
const DOCS_HTML_TEMPLATE = fs.readFileSync(
  path.join(__dirname, 'public', 'docs.html'),
  'utf8'
);

function getBaseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function renderTemplate(template) {
  return (req, res) => {
    const baseUrl = getBaseUrl(req);
    const html = template
      .replace(/__BASE_URL__/g, baseUrl)
      .replace(/__VERSION__/g, APP_VERSION)
      .replace(/__ANALYTICS_SCRIPT__/g, UI_ANALYTICS_SCRIPT)
      .replace(/__DOCS_HIDDEN_ATTR__/g, UI_ENABLE_DOCS ? '' : 'hidden')
      .replace(
        /__DOCS_SAMEAS_SUFFIX__/g,
        UI_ENABLE_DOCS ? `,\n      "${baseUrl}/docs/getting-started"` : ''
      );
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.send(html);
  };
}

app.get(['/', '/index.html'], renderTemplate(INDEX_HTML_TEMPLATE));
app.get(['/api', '/api.html'], renderTemplate(API_HTML_TEMPLATE));

function renderDocsPage(slug) {
  return (req, res) => {
    const html = renderDocPage(slug, DOCS_HTML_TEMPLATE);
    if (!html) {
      return res.status(404).send('Not found');
    }
    const rendered = html
      .replace(/__BASE_URL__/g, getBaseUrl(req))
      .replace(/__VERSION__/g, APP_VERSION)
      .replace(/__ANALYTICS_SCRIPT__/g, UI_ANALYTICS_SCRIPT);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.send(rendered);
  };
}

if (UI_ENABLE_DOCS) {
  let _docsSearchIndex = null;
  app.get('/api/docs/search-index', (_req, res) => {
    if (!_docsSearchIndex) _docsSearchIndex = buildSearchIndex();
    res.set('Cache-Control', 'no-cache');
    res.json(_docsSearchIndex);
  });

  app.get(['/docs', '/docs/'], (_req, res) => {
    res.redirect(301, '/docs/getting-started');
  });
  app.get('/docs/:slug', (req, res, next) => {
    const slug = String(req.params.slug || '').trim();
    if (!slug || slug.includes('.')) {
      return next();
    }
    return renderDocsPage(slug)(req, res);
  });
} else {
  app.get(['/docs', '/docs/', '/docs.html'], (_req, res) => {
    res.status(404).send('Not found');
  });
  app.get('/docs/:slug', (_req, res) => {
    res.status(404).send('Not found');
  });
}

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
  const docsAllow = UI_ENABLE_DOCS ? 'Allow: /docs\nAllow: /docs/\n' : '';
  const body =
    '# FaviconAPI\n' +
    '# Index the homepage + static assets only; the favicon API endpoints\n' +
    '# are not useful in search results and produce an unbounded URL space.\n' +
    '\n' +
    'User-agent: *\n' +
    'Allow: /$\n' +
    'Allow: /api\n' +
    'Allow: /api.html\n' +
    docsAllow +
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
  const docsEntries = UI_ENABLE_DOCS
    ? NAV_PAGES.map(
        ({ slug }) =>
          '  <url>\n' +
          `    <loc>${baseUrl}/docs/${slug}</loc>\n` +
          '    <changefreq>monthly</changefreq>\n' +
          '    <priority>0.7</priority>\n' +
          '  </url>\n'
      ).join('')
    : '';
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
    docsEntries +
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
// faviconV2 also serves a 180px raster (the common apple-touch-icon size) in
// addition to the standard power-of-two sizes.
const VALID_GOOGLEV2_SIZES = new Set([16, 32, 64, 128, 180, 256]);
const VALID_VEMETRIC_SIZES = new Set([16, 32, 64, 128, 256]);
const VALID_FAVICONKIT_SIZES = new Set([16, 32, 64, 128, 256]);
const VALID_SCRAPER_SIZES = new Set([16, 32, 64, 128, 256, 512]);
const SCRAPER_SIZES_ARRAY = [16, 32, 64, 128, 256, 512];
const VALID_VEMETRIC_FORMATS = new Set(['png', 'jpg', 'webp']);
const VALID_SELFHST_VARIANTS = new Set(['color', 'light', 'dark']);
const VALID_DASHBOARDICONS_VARIANTS = new Set(['color', 'light', 'dark']);
const VALID_LOBEHUB_VARIANTS = new Set(['color', 'light', 'dark']);
const VALID_SVGL_VARIANTS = new Set(['color', 'light', 'dark']);
const VALID_CATALOG_FORMATS = new Set(['png', 'svg']);
const VALID_FAVICONRUN_SIZES = new Set([16, 32, 64, 128, 256]);
const FAVICONRUN_SIZES_ARRAY = [16, 32, 64, 128, 256];
const VALID_TWENTYICONS_SIZES = new Set([16, 32, 64, 128, 180, 192]);
const TWENTYICONS_SIZES_ARRAY = [16, 32, 64, 128, 180, 192];
const VALID_BRANDFETCH_SIZES = new Set([16, 32, 64, 128, 256, 512]);
const BRANDFETCH_SIZES_ARRAY = [16, 32, 64, 128, 256, 512];
const VALID_LOBEHUB_SIZES = new Set([64, 128, 256]);
const VALID_SVGL_SIZES = new Set([64, 128, 256]);
const DEFAULT_LOBEHUB_SIZE = 128;
const DEFAULT_SVGL_SIZE = 128;

// Uniform proxy-URL scheme: baseurl/{provider}/{size}/{ext}/{domain}. Providers
// without a native upstream size accept the path size segment and are resized
// server-side; the offered set + sensible default sizes are defined here.
// `ext` is the file extension (png, svg, …); catalog providers use png|svg.
const RESIZE_SIZES = new Set([16, 32, 64, 128, 256]);
const RESIZE_SIZES_ARRAY = [16, 32, 64, 128, 256];
const CATALOG_SIZES_ARRAY = [16, 32, 64, 128, 256];
// SVG catalog routes are vector — the path size segment is always 0.
const CATALOG_SVG_SIZE = 0;

function catalogProxyPathSize(size, format) {
  return format === 'svg' ? CATALOG_SVG_SIZE : size;
}

function catalogRouteSizeError(size, format, pngSizes, pngLabel) {
  if (format === 'svg') {
    if (size === CATALOG_SVG_SIZE || pngSizes.has(size)) return null;
    return `Invalid size. Use ${CATALOG_SVG_SIZE} for SVG.`;
  }
  if (!pngSizes.has(size)) return `Invalid size. Use ${pngLabel}.`;
  return null;
}
const GOOGLE_SIZES_ARRAY = [16, 32, 64, 128];
const GOOGLEV2_SIZES_ARRAY = [16, 32, 64, 128, 180, 256];
const FAVICONKIT_SIZES_ARRAY = [16, 32, 64, 128, 256];
const VEMETRIC_SIZES_ARRAY = [16, 32, 64, 128, 256];
const LOBEHUB_SIZES_ARRAY = [64, 128, 256];
const SVGL_SIZES_ARRAY = [64, 128, 256];
// Default size for each provider's top-level `proxy` URL. Native providers
// default to 128; the resize-based domain providers default to 64 to avoid
// upscaling their typically small source icons.
const DEFAULT_NATIVE_SIZE = 128;
const DEFAULT_RESIZE_SIZE = 64;
const DEFAULT_CATALOG_SIZE = 128;
const SERVICE_SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;
const CACHE_CONTROL = 'public, max-age=86400, immutable';
const NOT_FOUND_CACHE_CONTROL = 'no-store';
const JSON_CACHE_CONTROL = 'no-cache';

function sendFavicon(res, entry) {
  res.set('Content-Type', entry.contentType);
  res.set('Cache-Control', entry.notFound ? NOT_FOUND_CACHE_CONTROL : CACHE_CONTROL);
  res.set('X-Favicon-Source', entry.provider);
  if (entry.url) res.set('X-Favicon-Url', entry.url);
  if (entry.resolvedFormat) res.set('X-Brandfetch-Format', entry.resolvedFormat);
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

// Build a uniform catalog-provider block under the canonical
// /{provider}/{size}/{ext}/{slug}[?variant=] scheme. `sizes` lists the offered set,
// `defaultSize` is used for the top-level + variant proxy URLs. `variant`
// stays a query parameter because it is a separate dimension from size/format.
function buildCatalogBlock(host, routeName, slug, sourceFn, availability, sizes, defaultSize, defaultFormat = 'png') {
  if (!slug || !availability || !availability.color) return null;

  const encoded = encodeURIComponent(slug);
  const proxyFor = (size, variant, format = defaultFormat) => {
    const pathSize = catalogProxyPathSize(size, format);
    const base = `${host}/${routeName}/${pathSize}/${format}/${encoded}`;
    return variant && variant !== 'color' ? `${base}?variant=${variant}` : base;
  };

  const variants = {};
  for (const variant of ['color', 'light', 'dark']) {
    if (availability[variant]) {
      variants[variant] = {
        proxy: proxyFor(defaultSize, variant, defaultFormat),
        source: sourceFn(slug, variant, defaultFormat),
        svg: {
          proxy: proxyFor(defaultSize, variant, 'svg'),
          source: sourceFn(slug, variant, 'svg'),
        },
      };
    }
  }

  const sizesMap = Object.fromEntries(
    sizes.map((size) => [
      String(size),
      { proxy: proxyFor(size, 'color', 'png'), source: sourceFn(slug, 'color', 'png') },
    ])
  );

  const block = {
    service: slug,
    proxy: proxyFor(defaultSize, 'color', defaultFormat),
    source: sourceFn(slug, 'color', defaultFormat),
    sizes: sizesMap,
    variants,
  };

  if (defaultFormat === 'svg') {
    block.png = {
      proxy: proxyFor(defaultSize, 'color', 'png'),
      source: sourceFn(slug, 'color', 'png'),
    };
  } else {
    block.svg = {
      proxy: proxyFor(defaultSize, 'color', 'svg'),
      source: sourceFn(slug, 'color', 'svg'),
    };
  }

  return block;
}

function parseCatalogFormat(raw) {
  const format = (raw || 'png').toString().toLowerCase();
  return VALID_CATALOG_FORMATS.has(format) ? format : null;
}

function resolveCatalogFormat(req) {
  if (req.params.ext != null && String(req.params.ext).trim() !== '') {
    const format = parseCatalogFormat(req.params.ext);
    if (!format) return { error: 'Invalid extension. Use png or svg.' };
    return { format };
  }
  const format = parseCatalogFormat(req.query.format);
  if (req.query.format != null && String(req.query.format).trim() !== '' && !format) {
    return { error: 'Invalid format. Use png or svg.' };
  }
  return { format: format || 'png' };
}

function catalogCacheKey(variant, format, { size, lobehub, selfhst } = {}) {
  if (lobehub) {
    const v = variant === 'color' ? 'c' : variant;
    if (format === 'svg') return `${v}_svg_v4`;
    return `${size}_${v}_png_v4`;
  }
  const parts = [];
  if (variant !== 'color') parts.push(variant);
  if (format === 'svg') parts.push('svg');
  const version = selfhst && variant !== 'color' && format !== 'svg' ? 'v5' : 'v4';
  return parts.length ? `${parts.join('_')}_${version}` : null;
}

function svglCacheKey(variant, format, size) {
  const v = variant === 'color' ? 'c' : variant;
  if (format === 'svg') return `${v}_svg_v4`;
  return `${size}_${v}_png_v4`;
}

// Canonical path extension for raster domain providers (output is always PNG).
function resolvePngPathExtension(req) {
  if (req.params.ext != null && String(req.params.ext).trim() !== '') {
    const ext = String(req.params.ext).toLowerCase();
    if (ext !== 'png') return { error: 'Invalid extension. Use png.' };
    return { ext: 'png' };
  }
  return { ext: 'png' };
}

function resolveVemetricFormat(req) {
  if (req.params.ext != null && String(req.params.ext).trim() !== '') {
    let ext = String(req.params.ext).toLowerCase();
    if (ext === 'jpeg') ext = 'jpg';
    if (!VALID_VEMETRIC_FORMATS.has(ext)) {
      return { error: 'Invalid extension. Use png, jpg, or webp.' };
    }
    return { format: ext };
  }
  const format = req.query.format || null;
  if (format && !VALID_VEMETRIC_FORMATS.has(format)) {
    return { error: 'Invalid format. Use png, jpg, or webp.' };
  }
  return { format };
}

const VALID_BRANDFETCH_FORMATS = new Set(['svg', 'png', 'webp', 'jpg']);

function resolveBrandfetchFormat(req) {
  if (req.params.ext != null && String(req.params.ext).trim() !== '') {
    let ext = String(req.params.ext).toLowerCase();
    if (ext === 'jpeg') ext = 'jpg';
    if (!VALID_BRANDFETCH_FORMATS.has(ext)) {
      return { error: 'Invalid extension. Use svg, png, webp, or jpg.' };
    }
    return { format: ext };
  }
  let format = req.query.format ? String(req.query.format).toLowerCase() : null;
  if (format === 'jpeg') format = 'jpg';
  if (format && !VALID_BRANDFETCH_FORMATS.has(format)) {
    return { error: 'Invalid format. Use svg, png, webp, or jpg.' };
  }
  return { format: format || 'svg' };
}

function brandfetchRouteSizeError(size, format) {
  if (format === 'svg') {
    if (size === CATALOG_SVG_SIZE || VALID_BRANDFETCH_SIZES.has(size)) return null;
    return `Invalid size. Use ${CATALOG_SVG_SIZE} for SVG.`;
  }
  if (!VALID_BRANDFETCH_SIZES.has(size)) {
    return 'Invalid size. Use 16, 32, 64, 128, 256, or 512.';
  }
  return null;
}

function emptyCatalogProvider() {
  return { service: null, query: null, proxy: null, source: null, sizes: null, variants: null };
}

async function buildServiceCatalogEndpoints(
  host,
  query,
  selfhstServiceSlug,
  dashboardServiceSlug,
  lobehubServiceSlug,
  svglServiceSlug
) {
  const [selfhstAvailability, dashboardAvailability, lobehubAvailability, svglAvailability] =
    await Promise.all([
    selfhstServiceSlug
      ? getSelfhstVariantAvailability(selfhstServiceSlug)
      : Promise.resolve(null),
    dashboardServiceSlug
      ? getDashboardIconsVariantAvailability(dashboardServiceSlug)
      : Promise.resolve(null),
    lobehubServiceSlug
      ? getLobehubVariantAvailability(lobehubServiceSlug)
      : Promise.resolve(null),
    svglServiceSlug
      ? Promise.resolve(getSvglVariantAvailability(svglServiceSlug))
      : Promise.resolve(null),
  ]);

  const selfhstBlock = buildCatalogBlock(
    host,
    'selfhst',
    selfhstServiceSlug,
    (slug, variant, format = 'png') => (
      format === 'png' && variant !== 'color'
        ? PROVIDERS.selfhst(slug, variant, 'svg')
        : PROVIDERS.selfhst(slug, variant, format)
    ),
    selfhstAvailability,
    CATALOG_SIZES_ARRAY,
    DEFAULT_CATALOG_SIZE
  );
  const selfhst = selfhstBlock ? { ...selfhstBlock, query } : emptyCatalogProvider();

  const dashboardBlock = buildCatalogBlock(
    host,
    'dashboardicons',
    dashboardServiceSlug,
    PROVIDERS.dashboardIcons,
    dashboardAvailability,
    CATALOG_SIZES_ARRAY,
    DEFAULT_CATALOG_SIZE
  );
  const dashboardicons = dashboardBlock ? { ...dashboardBlock, query } : emptyCatalogProvider();

  const lobehubBlock = buildCatalogBlock(
    host,
    'lobehub',
    lobehubServiceSlug,
    PROVIDERS.lobehub,
    lobehubAvailability,
    LOBEHUB_SIZES_ARRAY,
    DEFAULT_LOBEHUB_SIZE
  );
  const lobehub = lobehubBlock ? { ...lobehubBlock, query } : emptyCatalogProvider();

  const svglBlock = buildCatalogBlock(
    host,
    'svgl',
    svglServiceSlug,
    PROVIDERS.svgl,
    svglAvailability,
    SVGL_SIZES_ARRAY,
    DEFAULT_SVGL_SIZE,
    'svg'
  );
  const svgl = svglBlock ? { ...svglBlock, query } : emptyCatalogProvider();

  return { selfhst, dashboardicons, lobehub, svgl };
}

// Downscale an icon to `size` only when its source is larger. Upscaling a small
// upstream icon (e.g. Yandex's fixed 16x16) just produces a blurry result, so
// when the source is already <= the requested size the native bytes are served
// unchanged. Returns the (possibly resized) entry.
async function downscaleEntryToSize(entry, size) {
  const wasIco = entryLooksLikeIco(entry);
  try {
    const normalized = wasIco ? await normalizeEntryForPng(entry) : entry;
    let buffer = normalized.buffer;
    let contentType = normalized.contentType;

    const dims = await readImageDimensions(buffer, {
      contentType,
      url: entry.url,
    });
    const side = dims ? Math.min(dims.width || 0, dims.height || dims.width || 0) : 0;
    if (side > size) {
      const resized = await resizeIcon(buffer, size);
      return { ...entry, buffer: resized, contentType: 'image/png' };
    }
    if (wasIco || normalized !== entry) {
      return { ...entry, buffer, contentType: 'image/png' };
    }
  } catch (err) {
    if (wasIco) throw err;
    /* fall through and serve native bytes for other formats */
  }
  return entry;
}

// Render an icon at `size`. SVG sources (e.g. Vemetric always returns a small
// intrinsic SVG) are rasterized to a crisp size×size PNG so they fill the card
// like the other providers instead of rendering at their tiny intrinsic size.
// Raster sources are only downscaled, never upscaled.
async function renderIconToSize(entry, size) {
  const contentType = (entry.contentType || '').toLowerCase();
  const isSvg = contentType.includes('svg') || looksLikeSvg(entry.buffer);
  if (isSvg) {
    try {
      const buffer = await rasterizeSvgToSize(entry.buffer, size);
      return { ...entry, buffer, contentType: 'image/png' };
    } catch {
      return entry;
    }
  }
  // Upstreams such as DuckDuckGo serve .ico (image/x-icon) while the proxy path
  // uses /png/ — decode to PNG before resize so browsers can render the icon.
  if (entryLooksLikeIco(entry)) {
    try {
      entry = await normalizeEntryForPng(entry);
    } catch {
      return entry;
    }
  }
  return downscaleEntryToSize(entry, size);
}

// Server-side resize handler factory for providers without a native upstream
// size parameter. The base icon is fetched (and cached unsized), then downscaled
// to the requested path size (never upscaled) so the canonical
// /{provider}/{size}/{ext}/{domain} scheme stays meaningful without blurring.
function makeResizeProviderHandler(providerKey, label, fetchFn) {
  return async (req, res) => {
    const extResult = resolvePngPathExtension(req);
    if (extResult.error) return res.status(400).json({ error: extResult.error });

    const size = parseInt(req.params.size, 10);
    if (!RESIZE_SIZES.has(size)) {
      return res.status(400).json({ error: 'Invalid size. Use 16, 32, 64, 128, or 256.' });
    }

    const domain = extractDomain(req.params.domain);
    if (!domain) return res.status(400).json({ error: 'Invalid domain.' });

    try {
      const entry = await fetchWithCache(providerKey, domain, null, () => fetchFn(domain));
      if (!entry) return res.status(502).json({ error: 'Upstream fetch failed.' });
      sendFavicon(res, await renderIconToSize(entry, size));
    } catch (err) {
      console.error(`${label} proxy error:`, err.message);
      res.status(500).json({ error: 'Internal error.' });
    }
  };
}

// Legacy (sizeless, native-resolution) handler factory for the original short
// routes, kept as aliases so existing URLs/bookmarks keep working unchanged.
function makeNativeProviderHandler(providerKey, label, fetchFn) {
  return async (req, res) => {
    const domain = extractDomain(req.params.domain);
    if (!domain) return res.status(400).json({ error: 'Invalid domain.' });

    try {
      const entry = await fetchWithCache(providerKey, domain, null, () => fetchFn(domain));
      if (!entry) return res.status(502).json({ error: 'Upstream fetch failed.' });
      sendFavicon(res, await normalizeEntryForPng(entry));
    } catch (err) {
      console.error(`${label} proxy error:`, err.message);
      res.status(500).json({ error: 'Internal error.' });
    }
  };
}

// Google favicon proxy: /google/:size/:ext/:domain (alias: /g/:size/:ext/:domain)
// Legacy: /google/:size/:domain
async function googleSizedHandler(req, res) {
  const extResult = resolvePngPathExtension(req);
  if (extResult.error) return res.status(400).json({ error: extResult.error });

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
}
app.get(['/google/:size/:ext/:domain', '/g/:size/:ext/:domain'], googleSizedHandler);
app.get(['/google/:size/:domain', '/g/:size/:domain'], googleSizedHandler);

// Google v2 favicon proxy: /googlev2/:size/:ext/:domain (alias: /g2/:size/:ext/:domain)
async function googleV2SizedHandler(req, res) {
  const extResult = resolvePngPathExtension(req);
  if (extResult.error) return res.status(400).json({ error: extResult.error });

  const size = parseInt(req.params.size, 10);
  if (!VALID_GOOGLEV2_SIZES.has(size)) {
    return res.status(400).json({ error: 'Invalid size. Use 16, 32, 64, 128, 180, or 256.' });
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
}
app.get(['/googlev2/:size/:ext/:domain', '/g2/:size/:ext/:domain'], googleV2SizedHandler);
app.get(['/googlev2/:size/:domain', '/g2/:size/:domain'], googleV2SizedHandler);

// DuckDuckGo favicon proxy: /duckduckgo/:size/:ext/:domain (alias: /d/:size/:ext/:domain)
const duckduckgoSizedHandler = makeResizeProviderHandler('duckduckgo', 'DuckDuckGo', fetchDuckDuckGo);
app.get(
  ['/duckduckgo/:size/:ext/:domain', '/d/:size/:ext/:domain'],
  duckduckgoSizedHandler
);
app.get(
  ['/duckduckgo/:size/:domain', '/d/:size/:domain'],
  duckduckgoSizedHandler
);
app.get('/d/:domain', makeNativeProviderHandler('duckduckgo', 'DuckDuckGo', fetchDuckDuckGo));

// Yandex favicon proxy: /yandex/:size/:ext/:domain (alias: /y/:size/:ext/:domain)
const yandexSizedHandler = makeResizeProviderHandler('yandex', 'Yandex', fetchYandex);
app.get(['/yandex/:size/:ext/:domain', '/y/:size/:ext/:domain'], yandexSizedHandler);
app.get(['/yandex/:size/:domain', '/y/:size/:domain'], yandexSizedHandler);
app.get('/y/:domain', makeNativeProviderHandler('yandex', 'Yandex', fetchYandex));

// Favicon.so proxy: /faviconso/:size/:ext/:domain (alias: /f/:size/:ext/:domain)
const faviconSoSizedHandler = makeResizeProviderHandler('faviconso', 'Favicon.so', fetchFaviconSo);
app.get(['/faviconso/:size/:ext/:domain', '/f/:size/:ext/:domain'], faviconSoSizedHandler);
app.get(['/faviconso/:size/:domain', '/f/:size/:domain'], faviconSoSizedHandler);
app.get('/f/:domain', makeNativeProviderHandler('faviconso', 'Favicon.so', fetchFaviconSo));

// Vemetric favicon proxy: /vemetric/:size/:ext/:domain (alias: /v/:size/:ext/:domain)
// Legacy: /v/:size/:domain, /v/:domain[?size=][&format=]
async function vemetricSizedHandler(req, res) {
  const formatResult = resolveVemetricFormat(req);
  if (formatResult.error) return res.status(400).json({ error: formatResult.error });
  const { format } = formatResult;

  const size = parseInt(req.params.size, 10);
  if (!VALID_VEMETRIC_SIZES.has(size)) {
    return res.status(400).json({ error: 'Invalid size. Use 16, 32, 64, 128, or 256.' });
  }

  const domain = extractDomain(req.params.domain);
  if (!domain) return res.status(400).json({ error: 'Invalid domain.' });

  try {
    const cacheKey = format ? `${size}_${format}` : String(size);
    const entry = await fetchWithCache('vemetric', domain, cacheKey, () => fetchVemetric(domain, size, format));
    if (!entry) return res.status(502).json({ error: 'Upstream fetch failed.' });
    sendFavicon(res, format ? entry : await renderIconToSize(entry, size));
  } catch (err) {
    console.error('Vemetric proxy error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
}
app.get(['/vemetric/:size/:ext/:domain', '/v/:size/:ext/:domain'], vemetricSizedHandler);
app.get(['/vemetric/:size/:domain', '/v/:size/:domain'], vemetricSizedHandler);

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
    sendFavicon(res, format ? entry : await renderIconToSize(entry, size || DEFAULT_NATIVE_SIZE));
  } catch (err) {
    console.error('Vemetric proxy error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
});

// Favicon-3j1 proxy: /favicondev/:size/:ext/:domain (alias: /p/:size/:ext/:domain)
const faviconDevSizedHandler = makeResizeProviderHandler('favicondev', 'Favicon-3j1', fetchFaviconDev);
app.get(['/favicondev/:size/:ext/:domain', '/p/:size/:ext/:domain'], faviconDevSizedHandler);
app.get(['/favicondev/:size/:domain', '/p/:size/:domain'], faviconDevSizedHandler);
app.get('/p/:domain', makeNativeProviderHandler('favicondev', 'Favicon-3j1', fetchFaviconDev));

// Faviconkit proxy: /faviconkit/:size/:ext/:domain (alias: /k/:size/:ext/:domain)
async function faviconkitSizedHandler(req, res) {
  const extResult = resolvePngPathExtension(req);
  if (extResult.error) return res.status(400).json({ error: extResult.error });

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
}
app.get(['/faviconkit/:size/:ext/:domain', '/k/:size/:ext/:domain'], faviconkitSizedHandler);
app.get(['/faviconkit/:size/:domain', '/k/:size/:domain'], faviconkitSizedHandler);

// favicon.run proxy: /faviconrun/:size/:ext/:domain (alias: /fr/:size/:ext/:domain)
async function faviconRunSizedHandler(req, res) {
  const extResult = resolvePngPathExtension(req);
  if (extResult.error) return res.status(400).json({ error: extResult.error });

  const size = parseInt(req.params.size, 10);
  if (!VALID_FAVICONRUN_SIZES.has(size)) {
    return res.status(400).json({ error: 'Invalid size. Use 16, 32, 64, 128, or 256.' });
  }

  const domain = extractDomain(req.params.domain);
  if (!domain) return res.status(400).json({ error: 'Invalid domain.' });

  try {
    const entry = await fetchWithCache('faviconrun', domain, size, () => fetchFaviconRun(domain, size));
    if (!entry) return res.status(502).json({ error: 'Upstream fetch failed.' });
    sendFavicon(res, entry);
  } catch (err) {
    console.error('favicon.run proxy error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
}
app.get(['/faviconrun/:size/:ext/:domain', '/fr/:size/:ext/:domain'], faviconRunSizedHandler);
app.get(['/faviconrun/:size/:domain', '/fr/:size/:domain'], faviconRunSizedHandler);

// twenty-icons.com proxy: /twentyicons/:size/:ext/:domain (alias: /ti/:size/:ext/:domain)
async function twentyIconsSizedHandler(req, res) {
  const extResult = resolvePngPathExtension(req);
  if (extResult.error) return res.status(400).json({ error: extResult.error });

  const size = parseInt(req.params.size, 10);
  if (!VALID_TWENTYICONS_SIZES.has(size)) {
    return res.status(400).json({ error: 'Invalid size. Use 16, 32, 64, 128, 180, or 192.' });
  }

  const domain = extractDomain(req.params.domain);
  if (!domain) return res.status(400).json({ error: 'Invalid domain.' });

  try {
    const entry = await fetchWithCache('twentyicons', domain, size, () => fetchTwentyIcons(domain, size));
    if (!entry) return res.status(502).json({ error: 'Upstream fetch failed.' });
    sendFavicon(res, entry);
  } catch (err) {
    console.error('twenty-icons.com proxy error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
}
app.get(['/twentyicons/:size/:ext/:domain', '/ti/:size/:ext/:domain'], twentyIconsSizedHandler);
app.get(['/twentyicons/:size/:domain', '/ti/:size/:domain'], twentyIconsSizedHandler);

// favicon.ryanjc.com proxy: /ryanjc/:size/:ext/:domain (alias: /rj/:size/:ext/:domain)
const ryanjcSizedHandler = makeResizeProviderHandler('ryanjc', 'favicon.ryanjc.com', fetchRyanjc);
app.get(['/ryanjc/:size/:ext/:domain', '/rj/:size/:ext/:domain'], ryanjcSizedHandler);
app.get(['/ryanjc/:size/:domain', '/rj/:size/:domain'], ryanjcSizedHandler);
app.get('/rj/:domain', makeNativeProviderHandler('ryanjc', 'favicon.ryanjc.com', fetchRyanjc));

// logo.dev proxy: /logodev/:size/:domain (alias: /l/:size/:domain) - requires LOGODEV_TOKEN
async function logoDevSizedHandler(req, res) {
  if (!process.env.LOGODEV_TOKEN) {
    return res.status(503).json({ error: 'logo.dev not configured. Set LOGODEV_TOKEN.' });
  }

  const size = parseInt(req.params.size, 10);
  if (!RESIZE_SIZES.has(size)) {
    return res.status(400).json({ error: 'Invalid size. Use 16, 32, 64, 128, or 256.' });
  }

  const domain = extractDomain(req.params.domain);
  if (!domain) return res.status(400).json({ error: 'Invalid domain.' });

  try {
    const entry = await fetchWithCache('logodev', domain, '404', () => fetchLogoDev(domain));
    if (!entry) return res.status(502).json({ error: 'Upstream fetch failed.' });
    sendFavicon(res, await downscaleEntryToSize(entry, size));
  } catch (err) {
    console.error('logo.dev proxy error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
}
app.get(['/logodev/:size/:domain', '/l/:size/:domain'], logoDevSizedHandler);

app.get('/l/:domain', async (req, res) => {
  if (!process.env.LOGODEV_TOKEN) {
    return res.status(503).json({ error: 'logo.dev not configured. Set LOGODEV_TOKEN.' });
  }

  const domain = extractDomain(req.params.domain);
  if (!domain) return res.status(400).json({ error: 'Invalid domain.' });

  try {
    const entry = await fetchWithCache('logodev', domain, '404', () => fetchLogoDev(domain));
    if (!entry) return res.status(502).json({ error: 'Upstream fetch failed.' });
    sendFavicon(res, entry);
  } catch (err) {
    console.error('logo.dev proxy error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
});

function brandfetchQuerySuffix(opts = {}) {
  const o = normalizeBrandfetchOptions(opts);
  const params = new URLSearchParams();
  if (o.type !== 'symbol') params.set('type', o.type);
  if (o.theme) params.set('theme', o.theme);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

function brandfetchFetchOpts(query = {}, { pathFormat = false } = {}) {
  return {
    ...query,
    formatExplicit:
      pathFormat || (query.format != null && String(query.format).trim() !== ''),
    themeExplicit: query.theme != null && String(query.theme).trim() !== '',
    strict: query.strict === '1' || query.strict === 'true',
  };
}

// Brandfetch proxy: /brandfetch/:size/:ext/:domain (alias: /bf/:size/:ext/:domain)
// SVG routes use size 0 in the path; raster routes use native sizes 16–512.
// Query: ?type=icon|symbol|logo&theme=light|dark (defaults: symbol, svg)
// Legacy: /brandfetch/:size/:domain still accepts ?format= for backward compatibility.
async function brandfetchSizedHandler(req, res) {
  if (!process.env.BRANDFETCH_CLIENT_ID) {
    return res.status(503).json({ error: 'Brandfetch not configured. Set BRANDFETCH_CLIENT_ID.' });
  }

  const formatResult = resolveBrandfetchFormat(req);
  if (formatResult.error) return res.status(400).json({ error: formatResult.error });
  const { format } = formatResult;

  const size = parseInt(req.params.size, 10);
  const sizeError = brandfetchRouteSizeError(size, format);
  if (sizeError) return res.status(400).json({ error: sizeError });

  const domain = extractDomain(req.params.domain);
  if (!domain) return res.status(400).json({ error: 'Invalid domain.' });

  const pathHasExt = req.params.ext != null && String(req.params.ext).trim() !== '';
  const bfQuery = { ...req.query, format };
  const bfOpts = normalizeBrandfetchOptions(bfQuery);
  const fetchSize = format === 'svg' ? DEFAULT_NATIVE_SIZE : size;

  try {
    const cacheKey = brandfetchCacheKey(fetchSize, bfOpts);
    const entry = await fetchWithCache('brandfetch', domain, cacheKey, () =>
      fetchBrandfetch(domain, fetchSize, brandfetchFetchOpts(bfQuery, { pathFormat: pathHasExt }))
    );
    if (!entry) return res.status(502).json({ error: 'Upstream fetch failed.' });
    sendFavicon(res, entry);
  } catch (err) {
    console.error('Brandfetch proxy error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
}
app.get(['/brandfetch/:size/:ext/:domain', '/bf/:size/:ext/:domain'], brandfetchSizedHandler);
app.get(['/brandfetch/:size/:domain', '/bf/:size/:domain'], brandfetchSizedHandler);

app.get('/bf/:domain', async (req, res) => {
  if (!process.env.BRANDFETCH_CLIENT_ID) {
    return res.status(503).json({ error: 'Brandfetch not configured. Set BRANDFETCH_CLIENT_ID.' });
  }

  const domain = extractDomain(req.params.domain);
  if (!domain) return res.status(400).json({ error: 'Invalid domain.' });

  const bfOpts = normalizeBrandfetchOptions(req.query);

  try {
    const cacheKey = brandfetchCacheKey(DEFAULT_NATIVE_SIZE, bfOpts);
    const entry = await fetchWithCache('brandfetch', domain, cacheKey, () =>
      fetchBrandfetch(domain, DEFAULT_NATIVE_SIZE, brandfetchFetchOpts(req.query))
    );
    if (!entry) return res.status(502).json({ error: 'Upstream fetch failed.' });
    sendFavicon(res, entry);
  } catch (err) {
    console.error('Brandfetch proxy error:', err.message);
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

// HTML scraper proxy.
//   Canonical: /scraper/:size/:ext/:domain   (sized, ext=png)
//              /scraper/:domain               (auto / largest available)
//   Legacy:    /scraper/:size/:domain, /s/:size/:domain, /s/:domain
// `?refresh=1` (or `?nocache=1`) bypasses + invalidates the caches.
async function scraperHandler(req, res) {
  if (req.params.ext != null && String(req.params.ext).trim() !== '') {
    const extResult = resolvePngPathExtension(req);
    if (extResult.error) return res.status(400).json({ error: extResult.error });
  }

  const domain = extractDomain(req.params.domain);
  if (!domain) return res.status(400).json({ error: 'Invalid domain.' });

  const refresh = req.query.refresh === '1' || req.query.nocache === '1';
  // Size from the path segment takes precedence over the legacy ?size= query.
  const pathSize = req.params.size ? parseInt(req.params.size, 10) : 0;
  const querySize = req.query.size ? parseInt(req.query.size, 10) : 0;
  const sizeParam = pathSize || querySize;

  if (sizeParam && (sizeParam < 1 || sizeParam > 1024)) {
    return res.status(400).json({ error: 'Invalid size. Use a value between 1 and 1024.' });
  }

  try {
    if (refresh) {
      await cache.del('scraper', domain, null);
      invalidateScraperDomainCaches(domain);
    }

    if (sizeParam) {
      const served = await serveSizedScraperIcon(domain, sizeParam);
      if (served) return sendFavicon(res, served);
    }

    const entry = await fetchWithCache('scraper', domain, null, () => fetchScraper(domain));
    if (!entry) return res.status(502).json({ error: 'Could not scrape favicon.' });

    if (sizeParam) {
      const rendered = await renderScraperEntryToSize(entry, domain, sizeParam);
      return sendFavicon(res, rendered);
    }

    // Enforce SCRAPER_MAX_ICON_SIZE at serve time too, not just when the icon is
    // first fetched/cached. A cache entry written before the cap was configured
    // (e.g. a full 512px source) would otherwise keep being served at full size;
    // capScraperProxyOutput downscales it (and is a no-op when already within the
    // cap or when the cap is disabled).
    sendFavicon(res, await capScraperProxyOutput(entry));
  } catch (err) {
    console.error('Scraper proxy error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
}
app.get(['/scraper/:size/:ext/:domain', '/s/:size/:ext/:domain'], scraperHandler);
app.get(['/scraper/:size/:domain', '/s/:size/:domain'], scraperHandler);
app.get(['/scraper/:domain', '/s/:domain'], scraperHandler);

async function renderScraperEntryToSize(entry, domain, size) {
  const url = (entry?.url || '').toLowerCase();
  const referer = `https://${domain}/`;

  if (entry?.originalSvgBuffer?.length) {
    try {
      const buffer = await rasterizeSvgToSize(entry.originalSvgBuffer, size);
      return { ...entry, buffer, contentType: 'image/png' };
    } catch {
      /* fall through */
    }
  }

  if (url.endsWith('.svg')) {
    try {
      const fetched = await fetchScraperAsset(entry.url, referer);
      if (fetched?.buffer && looksLikeSvg(fetched.buffer)) {
        const buffer = await rasterizeSvgToSize(fetched.buffer, size);
        return { ...entry, buffer, contentType: 'image/png' };
      }
    } catch {
      /* fall through */
    }
  }

  return renderIconToSize(entry, size);
}

async function serveSizedScraperIcon(domain, size) {
  let allIcons;
  try {
    allIcons = await fetchScraperAllIcons(domain);
  } catch {
    return null;
  }
  if (!allIcons || allIcons.length === 0) return null;

  // If no discovered icon can natively satisfy the requested size, defer to the
  // scraper's fallback chain (catalog / Google) instead of upscaling a tiny
  // source. e.g. facebook.com only exposes a 60×60 favicon.ico to scrapers, so
  // /scraper/128/facebook.com should serve the high-res selfh.st/dashboard icon
  // rather than a blurry 60→128 upscale. Returning null makes scraperHandler
  // fall through to fetchScraper() (which runs the catalog/Google fallback) and
  // resize that result to the requested size.
  const largestWidth = allIcons.reduce((max, i) => Math.max(max, i.width || 0), 0);
  if (largestWidth < size) return null;

  // Pick the smallest source icon that is >= the requested size (sharpest
  // downscale). allIcons is sorted largest-first.
  let bestIcon = allIcons[0];
  for (let i = allIcons.length - 1; i >= 0; i--) {
    if ((allIcons[i].width || 0) >= size) {
      bestIcon = allIcons[i];
      break;
    }
  }

  const iconUrl = bestIcon.url;
  const hash = crypto.createHash('sha1').update(iconUrl).digest('hex');
  const referer = `https://${domain}/`;

  const fullRes = await fetchWithCache('asset-v2', hash, null, async () => {
    const fetched = await fetchScraperAsset(iconUrl, referer);
    if (!fetched) return null;

    const isSvg =
      bestIcon.format === 'svg' ||
      looksLikeSvg(fetched.buffer) ||
      (fetched.contentType || '').toLowerCase().includes('svg') ||
      iconUrl.toLowerCase().endsWith('.svg');
    if (isSvg) {
      return {
        ...fetched,
        provider: 'scraper',
        isSvg: true,
      };
    }

    try {
      const displayed = await toDisplayPng(fetched.buffer, {
        contentType: fetched.contentType,
        url: iconUrl,
      });
      return {
        ...fetched,
        buffer: displayed.buffer,
        contentType: displayed.contentType,
        provider: 'scraper',
      };
    } catch {
      return { ...fetched, provider: 'scraper' };
    }
  });

  if (!fullRes) return null;

  if (fullRes.isSvg || looksLikeSvg(fullRes.buffer) || iconUrl.toLowerCase().endsWith('.svg')) {
    const buf = await rasterizeSvgToSize(fullRes.buffer, size);
    return { buffer: buf, contentType: 'image/png', provider: 'scraper', url: iconUrl };
  }

  const dims = await readImageDimensions(fullRes.buffer, {
    contentType: fullRes.contentType,
    url: iconUrl,
  });
  const side = dims ? Math.min(dims.width || 0, dims.height || dims.width || 0) : 0;
  if (side > size) {
    const buf = await resizeIcon(fullRes.buffer, size);
    return { buffer: buf, contentType: 'image/png', provider: 'scraper', url: iconUrl };
  }

  return { buffer: fullRes.buffer, contentType: fullRes.contentType || 'image/png', provider: 'scraper', url: iconUrl };
}

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

// selfhst icons (service-name based).
//   Canonical: /selfhst/:size/:ext/:service[?variant=color|light|dark]  (size 0 for svg)
//   Legacy:    /selfhst/:size/:service[?format=png|svg], /sh/:size/:service, /sh/:service
async function selfhstSizedHandler(req, res) {
  const service = extractService(req.params.service);
  if (!service) return res.status(400).json({ error: 'Invalid service name.' });

  const formatResult = resolveCatalogFormat(req);
  if (formatResult.error) return res.status(400).json({ error: formatResult.error });
  const { format } = formatResult;

  const size = parseInt(req.params.size, 10);
  const sizeError = catalogRouteSizeError(size, format, RESIZE_SIZES, '16, 32, 64, 128, or 256');
  if (sizeError) return res.status(400).json({ error: sizeError });

  const variant = (req.query.variant || 'color').toString().toLowerCase();
  if (!VALID_SELFHST_VARIANTS.has(variant)) {
    return res.status(400).json({ error: 'Invalid variant. Use color, light, or dark.' });
  }

  try {
    const cacheKey = catalogCacheKey(variant, format, { selfhst: true });
    const entry = await fetchWithCache('selfhst', service, cacheKey, () =>
      fetchSelfhst(service, variant, { format })
    );
    if (!entry) return res.status(404).json({ error: 'Service icon not found.' });
    if (format === 'svg') {
      sendFavicon(res, entry);
    } else {
      sendFavicon(res, await renderIconToSize(entry, size));
    }
  } catch (err) {
    console.error('selfhst proxy error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
}
app.get(['/selfhst/:size/:ext/:service', '/sh/:size/:ext/:service'], selfhstSizedHandler);
app.get(['/selfhst/:size/:service', '/sh/:size/:service'], selfhstSizedHandler);

app.get('/sh/:service', async (req, res) => {
  const service = extractService(req.params.service);
  if (!service) return res.status(400).json({ error: 'Invalid service name.' });

  const variant = (req.query.variant || 'color').toString().toLowerCase();
  if (!VALID_SELFHST_VARIANTS.has(variant)) {
    return res.status(400).json({ error: 'Invalid variant. Use color, light, or dark.' });
  }

  const formatResult = resolveCatalogFormat(req);
  if (formatResult.error) return res.status(400).json({ error: formatResult.error });
  const { format } = formatResult;

  try {
    const cacheKey = catalogCacheKey(variant, format, { selfhst: true });
    const entry = await fetchWithCache('selfhst', service, cacheKey, () =>
      fetchSelfhst(service, variant, { format })
    );
    if (!entry) return res.status(404).json({ error: 'Service icon not found.' });
    sendFavicon(res, entry);
  } catch (err) {
    console.error('selfhst proxy error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
});

// homarr-labs/dashboard-icons (service-name based).
//   Canonical: /dashboardicons/:size/:ext/:service[?variant=color|light|dark]
//   Legacy:    /dashboardicons/:size/:service[?format=png|svg], /di/:size/:service, /di/:service
async function dashboardIconsSizedHandler(req, res) {
  const service = extractService(req.params.service);
  if (!service) return res.status(400).json({ error: 'Invalid service name.' });

  const formatResult = resolveCatalogFormat(req);
  if (formatResult.error) return res.status(400).json({ error: formatResult.error });
  const { format } = formatResult;

  const size = parseInt(req.params.size, 10);
  const sizeError = catalogRouteSizeError(size, format, RESIZE_SIZES, '16, 32, 64, 128, or 256');
  if (sizeError) return res.status(400).json({ error: sizeError });

  const variant = (req.query.variant || 'color').toString().toLowerCase();
  if (!VALID_DASHBOARDICONS_VARIANTS.has(variant)) {
    return res.status(400).json({ error: 'Invalid variant. Use color, light, or dark.' });
  }

  try {
    const cacheKey = catalogCacheKey(variant, format);
    const entry = await fetchWithCache(
      'dashboardicons',
      service,
      cacheKey,
      () => fetchDashboardIcons(service, variant, { format })
    );
    if (!entry) return res.status(404).json({ error: 'Service icon not found.' });
    if (format === 'svg') {
      sendFavicon(res, entry);
    } else {
      sendFavicon(res, await downscaleEntryToSize(entry, size));
    }
  } catch (err) {
    console.error('Dashboard Icons proxy error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
}
app.get(['/dashboardicons/:size/:ext/:service', '/di/:size/:ext/:service'], dashboardIconsSizedHandler);
app.get(['/dashboardicons/:size/:service', '/di/:size/:service'], dashboardIconsSizedHandler);

app.get('/di/:service', async (req, res) => {
  const service = extractService(req.params.service);
  if (!service) return res.status(400).json({ error: 'Invalid service name.' });

  const variant = (req.query.variant || 'color').toString().toLowerCase();
  if (!VALID_DASHBOARDICONS_VARIANTS.has(variant)) {
    return res.status(400).json({ error: 'Invalid variant. Use color, light, or dark.' });
  }

  const formatResult = resolveCatalogFormat(req);
  if (formatResult.error) return res.status(400).json({ error: formatResult.error });
  const { format } = formatResult;

  try {
    const cacheKey = catalogCacheKey(variant, format);
    const entry = await fetchWithCache(
      'dashboardicons',
      service,
      cacheKey,
      () => fetchDashboardIcons(service, variant, { format })
    );
    if (!entry) return res.status(404).json({ error: 'Service icon not found.' });
    sendFavicon(res, entry);
  } catch (err) {
    console.error('Dashboard Icons proxy error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
});

// LobeHub icons (service-name based). Native PNG sizes 64, 128, 256.
//   Canonical: /lobehub/:size/:ext/:service[?variant=color|light|dark]
//   Legacy:    /lobehub/:size/:service[?format=png|svg], /lb/:size/:service, /lb/:service
async function lobehubSizedHandler(req, res) {
  const service = extractService(req.params.service);
  if (!service) return res.status(400).json({ error: 'Invalid service name.' });

  const formatResult = resolveCatalogFormat(req);
  if (formatResult.error) return res.status(400).json({ error: formatResult.error });
  const { format } = formatResult;

  const size = parseInt(req.params.size, 10);
  const sizeError = catalogRouteSizeError(size, format, VALID_LOBEHUB_SIZES, '64, 128, or 256');
  if (sizeError) return res.status(400).json({ error: sizeError });

  const variant = (req.query.variant || 'color').toString().toLowerCase();
  if (!VALID_LOBEHUB_VARIANTS.has(variant)) {
    return res.status(400).json({ error: 'Invalid variant. Use color, light, or dark.' });
  }

  const rasterSize = format === 'svg' ? DEFAULT_LOBEHUB_SIZE : size;

  try {
    const cacheKey = catalogCacheKey(variant, format, { size: rasterSize, lobehub: true });
    const entry = await fetchWithCache(
      'lobehub',
      service,
      cacheKey,
      () => fetchLobehub(service, variant, rasterSize, { format })
    );
    if (!entry) return res.status(404).json({ error: 'Service icon not found.' });
    sendFavicon(res, entry);
  } catch (err) {
    console.error('LobeHub proxy error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
}
app.get(['/lobehub/:size/:ext/:service', '/lb/:size/:ext/:service'], lobehubSizedHandler);
app.get(['/lobehub/:size/:service', '/lb/:size/:service'], lobehubSizedHandler);

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

  const formatResult = resolveCatalogFormat(req);
  if (formatResult.error) return res.status(400).json({ error: formatResult.error });
  const { format } = formatResult;

  try {
    const cacheKey = catalogCacheKey(variant, format, { size, lobehub: true });
    const entry = await fetchWithCache(
      'lobehub',
      service,
      cacheKey,
      () => fetchLobehub(service, variant, size, { format })
    );
    if (!entry) return res.status(404).json({ error: 'Service icon not found.' });
    sendFavicon(res, entry);
  } catch (err) {
    console.error('LobeHub proxy error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
});

// SVGL icons (service-name based). Native sizes 64, 128, 256.
//   Canonical: /svgl/:size/:ext/:service[?variant=color|light|dark]
//   Legacy:    /svgl/:size/:service, /sv/:size/:service, /sv/:service
async function svglSizedHandler(req, res) {
  const service = extractService(req.params.service);
  if (!service) return res.status(400).json({ error: 'Invalid service name.' });

  const formatResult = resolveCatalogFormat(req);
  if (formatResult.error) return res.status(400).json({ error: formatResult.error });
  const { format } = formatResult;

  const size = parseInt(req.params.size, 10);
  const sizeError = catalogRouteSizeError(size, format, VALID_SVGL_SIZES, '64, 128, or 256');
  if (sizeError) return res.status(400).json({ error: sizeError });

  const variant = (req.query.variant || 'color').toString().toLowerCase();
  if (!VALID_SVGL_VARIANTS.has(variant)) {
    return res.status(400).json({ error: 'Invalid variant. Use color, light, or dark.' });
  }

  const rasterSize = format === 'svg' ? DEFAULT_SVGL_SIZE : size;

  try {
    const cacheKey = svglCacheKey(variant, format, rasterSize);
    const entry = await fetchWithCache(
      'svgl',
      service,
      cacheKey,
      () => fetchSvgl(service, variant, rasterSize, { format })
    );
    if (!entry) return res.status(404).json({ error: 'Service icon not found.' });
    sendFavicon(res, entry);
  } catch (err) {
    console.error('SVGL proxy error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
}
app.get(['/svgl/:size/:ext/:service', '/sv/:size/:ext/:service'], svglSizedHandler);
app.get(['/svgl/:size/:service', '/sv/:size/:service'], svglSizedHandler);

app.get('/sv/:service', async (req, res) => {
  const service = extractService(req.params.service);
  if (!service) return res.status(400).json({ error: 'Invalid service name.' });

  const variant = (req.query.variant || 'color').toString().toLowerCase();
  if (!VALID_SVGL_VARIANTS.has(variant)) {
    return res.status(400).json({ error: 'Invalid variant. Use color, light, or dark.' });
  }

  const size = parseInt(req.query.size || String(DEFAULT_SVGL_SIZE), 10);
  if (!VALID_SVGL_SIZES.has(size)) {
    return res.status(400).json({ error: 'Invalid size. Use 64, 128, or 256.' });
  }

  const formatResult = resolveCatalogFormat(req);
  if (formatResult.error) return res.status(400).json({ error: formatResult.error });
  const { format } = formatResult;

  try {
    const cacheKey = svglCacheKey(variant, format, size);
    const entry = await fetchWithCache(
      'svgl',
      service,
      cacheKey,
      () => fetchSvgl(service, variant, size, { format })
    );
    if (!entry) return res.status(404).json({ error: 'Service icon not found.' });
    sendFavicon(res, entry);
  } catch (err) {
    console.error('SVGL proxy error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
});

// Provider availability/config: /providers
app.get('/providers', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    logoDev: !!process.env.LOGODEV_TOKEN,
    logoDevToken: process.env.LOGODEV_TOKEN || null,
    brandfetch: !!process.env.BRANDFETCH_CLIENT_ID,
    defaultProvider: (process.env.DEFAULT_PROVIDER || '').trim().toLowerCase() || null,
    includeAppIcons: UI_INCLUDE_APP_ICONS,
    urlMode: UI_CARD_URL,
    docsEnabled: UI_ENABLE_DOCS,
    scraperMaxIconSize: getScraperMaxIconSize(),
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
      const { selfhst, dashboardicons, lobehub, svgl } = await buildServiceCatalogEndpoints(
        host,
        service,
        matches.providers.selfhst.resolved,
        matches.providers.dashboardicons.resolved,
        matches.providers.lobehub.resolved,
        matches.providers.svgl.resolved
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
          svgl,
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
    ensureSvglIndex(),
  ]);

  // www-fallback: when scraper finds no icons for a bare domain, try www.domain.
  let wwwFallback = null;
  if (
    (!scraperAllIcons || scraperAllIcons.length === 0) &&
    !domain.startsWith('www.')
  ) {
    const wwwDomain = `www.${domain}`;
    const wwwIcons = await fetchScraperAllIcons(wwwDomain);
    if (wwwIcons && wwwIcons.length > 0) {
      wwwFallback = {
        domain: wwwDomain,
        icons: wwwIcons,
        proxy: `${req.protocol}://${req.get('host')}/scraper/${encodeURIComponent(wwwDomain)}`,
      };
    }
  }

  const vemetricFormats = ['png', 'jpg', 'webp'];

  const sizedEntries = (sizes, proxyPath, sourceFn) =>
    Object.fromEntries(
      sizes.map((size) => [
        String(size),
        { proxy: `${host}${proxyPath(size)}`, source: sourceFn(size) },
      ])
    );

  // Uniform domain-provider block under the canonical
  // baseurl/{provider}/{size}/{ext}/{domain} scheme. `proxy` points at the default
  // size; `sizes` lists every offered size.
  const uniformProvider = (name, sizes, defaultSize, sourceFn, ext = 'png') => ({
    proxy: `${host}/${name}/${defaultSize}/${ext}/${encoded}`,
    source: sourceFn(defaultSize),
    sizes: sizedEntries(sizes, (size) => `/${name}/${size}/${ext}/${encoded}`, sourceFn),
  });

  const vemetricVariants = {
    ...uniformProvider(
      'vemetric',
      VEMETRIC_SIZES_ARRAY,
      DEFAULT_NATIVE_SIZE,
      (size) => PROVIDERS.vemetric(domain, size)
    ),
    formats: Object.fromEntries(
      vemetricFormats.map((format) => [
        format,
        {
          proxy: `${host}/vemetric/${DEFAULT_NATIVE_SIZE}/${format}/${encoded}`,
          source: PROVIDERS.vemetric(domain, DEFAULT_NATIVE_SIZE, format),
        },
      ])
    ),
  };

  const logoDevConfigured = !!process.env.LOGODEV_TOKEN;
  const logodev = {
    proxy: `${host}/logodev/${DEFAULT_RESIZE_SIZE}/${encoded}`,
    // Omit upstream URL: it embeds LOGODEV_TOKEN in the query string.
    source: null,
    configured: logoDevConfigured,
    sizes: sizedEntries(
      RESIZE_SIZES_ARRAY,
      (size) => `/logodev/${size}/${encoded}`,
      () => null
    ),
  };

  const brandfetchConfigured = !!process.env.BRANDFETCH_CLIENT_ID;
  const brandfetchSymbolQs = brandfetchQuerySuffix({ type: 'symbol' });
  const brandfetch = {
    proxy: `${host}/brandfetch/${CATALOG_SVG_SIZE}/svg/${encoded}${brandfetchSymbolQs}`,
    // Omit upstream URL: it embeds BRANDFETCH_CLIENT_ID in the query string.
    source: null,
    configured: brandfetchConfigured,
    type: 'symbol',
    format: 'svg',
    theme: null,
    sizes: sizedEntries(
      BRANDFETCH_SIZES_ARRAY,
      (size) => `/brandfetch/${size}/png/${encoded}${brandfetchSymbolQs}`,
      () => null
    ),
  };

  const serviceSlug = serviceSlugFromDomain(domain);

  let selfhstServiceSlug = null;
  let dashboardServiceSlug = null;
  let lobehubServiceSlug = null;
  let svglServiceSlug = null;
  if (serviceSlug) {
    // serviceSlug comes from the domain label (not a user-typed query), so
    // resolve it strictly to avoid advertising fuzzily-matched, unrelated
    // catalog icons (e.g. maflplus.eu → "mailplus") in the JSON endpoints list.
    const matches = await resolveServiceMatches(serviceSlug, { strict: true });
    selfhstServiceSlug = matches.providers.selfhst.resolved;
    dashboardServiceSlug = matches.providers.dashboardicons.resolved;
    lobehubServiceSlug = matches.providers.lobehub.resolved;
    svglServiceSlug = matches.providers.svgl.resolved;
  }

  const { selfhst, dashboardicons, lobehub, svgl } = await buildServiceCatalogEndpoints(
    host,
    serviceSlug,
    selfhstServiceSlug,
    dashboardServiceSlug,
    lobehubServiceSlug,
    svglServiceSlug
  );

  res.set('Cache-Control', JSON_CACHE_CONTROL);
  res.json({
    domain,
    endpoints: {
      best: {
        proxy: `${host}/${encoded}`,
        source: null,
      },
      google: uniformProvider(
        'google',
        GOOGLE_SIZES_ARRAY,
        DEFAULT_NATIVE_SIZE,
        (size) => PROVIDERS.google(domain, size)
      ),
      googlev2: uniformProvider(
        'googlev2',
        GOOGLEV2_SIZES_ARRAY,
        DEFAULT_NATIVE_SIZE,
        (size) => PROVIDERS.googleV2(domain, size)
      ),
      duckduckgo: uniformProvider(
        'duckduckgo',
        RESIZE_SIZES_ARRAY,
        DEFAULT_RESIZE_SIZE,
        () => PROVIDERS.duckduckgo(domain)
      ),
      yandex: uniformProvider(
        'yandex',
        RESIZE_SIZES_ARRAY,
        DEFAULT_RESIZE_SIZE,
        () => PROVIDERS.yandex(domain)
      ),
      faviconso: uniformProvider(
        'faviconso',
        RESIZE_SIZES_ARRAY,
        DEFAULT_RESIZE_SIZE,
        () => PROVIDERS.faviconSo(domain)
      ),
      vemetric: vemetricVariants,
      favicondev: uniformProvider(
        'favicondev',
        RESIZE_SIZES_ARRAY,
        DEFAULT_RESIZE_SIZE,
        () => PROVIDERS.faviconDev(domain)
      ),
      faviconkit: uniformProvider(
        'faviconkit',
        FAVICONKIT_SIZES_ARRAY,
        DEFAULT_NATIVE_SIZE,
        (size) => PROVIDERS.faviconkit(domain, size)
      ),
      faviconrun: uniformProvider(
        'faviconrun',
        FAVICONRUN_SIZES_ARRAY,
        DEFAULT_NATIVE_SIZE,
        (size) => PROVIDERS.faviconRun(domain, size)
      ),
      twentyicons: uniformProvider(
        'twentyicons',
        TWENTYICONS_SIZES_ARRAY,
        DEFAULT_NATIVE_SIZE,
        (size) => PROVIDERS.twentyIcons(domain, size)
      ),
      ryanjc: uniformProvider(
        'ryanjc',
        RESIZE_SIZES_ARRAY,
        DEFAULT_RESIZE_SIZE,
        () => PROVIDERS.ryanjc(domain)
      ),
      logodev,
      brandfetch,
      scraper: {
        proxy: `${host}/scraper/${encoded}`,
        source: scraperCached?.url || null,
        sizes: Object.fromEntries(
          SCRAPER_SIZES_ARRAY.map((size) => [
            String(size),
            { proxy: `${host}/scraper/${size}/png/${encoded}`, source: scraperCached?.url || null },
          ])
        ),
        maxIconSize: getScraperMaxIconSize(),
        fallback: getScraperFallback(),
        fallbackProvider: scraperCached?.provider?.startsWith('scraper-fallback:')
          ? scraperCached.provider.replace('scraper-fallback:', '')
          : null,
        icons: scraperAllIcons.map((icon) => ({
          ...icon,
          proxy: `${host}/scraper/${icon.width || 128}/png/${encoded}`,
        })),
        wwwFallback: wwwFallback
          ? {
              ...wwwFallback,
              icons: (wwwFallback.icons || []).map((icon) => ({
                ...icon,
                proxy: `${host}/scraper/${icon.width || 128}/png/${encodeURIComponent(wwwFallback.domain)}`,
              })),
            }
          : null,
      },
      selfhst,
      dashboardicons,
      lobehub,
      svgl,
    },
  });
});

// Custom profile favicon: /:id/:target where :id is a base64url-encoded profile
// (preferred provider + fallbacks + min size; see src/customProfile.js). When
// :id is not a valid profile, fall through so other routes / the 404 handler
// take over. Registered after /:domain/json so the literal */json route wins.
app.get('/:cfg/:target', async (req, res, next) => {
  const profile = decodeProfile(req.params.cfg);
  if (!profile) return next();

  const parsed = parseDomainOrService(req.params.target);
  if (!parsed) return res.status(400).json({ error: 'Invalid domain or service name.' });

  try {
    const entry = await resolveProfileIcon(parsed, profile, req.params.cfg);
    if (entry.notFound) res.status(404);
    sendFavicon(res, entry);
  } catch (err) {
    console.error('Profile resolve error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
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

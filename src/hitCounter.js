/**
 * Counts how often each domain is actually requested, feeding the `rank`
 * column of the preload database (src/preloadStore.js).
 *
 * Every route that hands out an icon for a domain counts: /{domain},
 * /scraper/{size}/{domain} and the other provider aliases, /{domain}/json,
 * the profile resolve route, and /api/v1/favicon.
 *
 * Hits are deduplicated per visitor per domain within a short window. One
 * search on the web UI fires 15-25 requests (the /json discovery call plus one
 * per provider card), so counting each of them would make browsing the site
 * outweigh real embedded favicons by more than an order of magnitude.
 * Requests from `scripts/preload-top-sites.js` (`FaviconProxy-preload`) are
 * skipped: a ranking run writes those domains itself with the list as `source`.
 */
const { LRUCache } = require('lru-cache');
const preloadStore = require('./preloadStore');
const { extractDomainFromInput } = require('./domainValidation');

const DEDUPE_MS = (() => {
  const val = parseInt(process.env.PRELOAD_HIT_DEDUPE_MS, 10);
  return Number.isFinite(val) && val >= 0 ? val : 60000;
})();

// First path segments that never carry a domain.
const SKIP_SEGMENTS = new Set([
  'assets',
  'favicons',
  'docs',
  'admin',
  'api',
  'cdn',
  's-asset',
  'services',
  'providers',
  'search',
]);

// extractDomainFromInput() rejects scanner paths and .xml/.txt/.html/.json, but
// not image extensions — so /logo.svg, /favicons/favicon.ico and the CDN route's
// /cdn/favicons/example.com.png would otherwise be read as hostnames. None of
// these are real TLDs, so rejecting the suffix outright is safe.
const IMAGE_SUFFIXES = ['.png', '.ico', '.svg', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp'];

const recent = DEDUPE_MS > 0 ? new LRUCache({ max: 20000, ttl: DEDUPE_MS }) : null;

/** Warming runs must not inflate popularity or create `traffic` rows. */
const PRELOAD_UA = /FaviconProxy-preload/i;

function isPreloadRequest(req) {
  const ua =
    (typeof req.get === 'function' ? req.get('user-agent') : null) ||
    (req.headers && req.headers['user-agent']) ||
    '';
  return PRELOAD_UA.test(String(ua));
}

/**
 * The domain a request path refers to, or null when the path is not a
 * domain-scoped icon route. The domain is the last segment on every icon route
 * (`/scraper/32/png/reddit.com`), except `/{domain}/json` where it is the one
 * before it.
 */
function domainFromRequestPath(pathname) {
  if (typeof pathname !== 'string' || pathname === '/') return null;

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const segments = decoded.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  if (SKIP_SEGMENTS.has(segments[0].toLowerCase())) return null;

  const last = segments[segments.length - 1];
  const candidate =
    last.toLowerCase() === 'json' && segments.length > 1 ? segments[segments.length - 2] : last;

  const lower = candidate.toLowerCase();
  if (IMAGE_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return null;

  return extractDomainFromInput(candidate);
}

/** Record one lookup, unless this visitor already asked for it very recently. */
function countDomainHit(req, domain) {
  if (!preloadStore.TRACK_HITS || !domain) return;
  if (isPreloadRequest(req)) return;
  if (recent) {
    const key = `${req.ip}|${domain}`;
    if (recent.has(key)) return;
    recent.set(key, 1);
  }
  preloadStore.recordHit(domain);
}

/**
 * Express middleware counting successful icon lookups. Runs on `finish` so a
 * 404 on a typo or a bot scan never creates a row.
 */
function hitCounterMiddleware(req, res, next) {
  if (!preloadStore.TRACK_HITS || req.method !== 'GET') return next();
  if (isPreloadRequest(req)) return next();
  const domain = domainFromRequestPath(req.path);
  if (domain) {
    res.on('finish', () => {
      if (res.statusCode === 200) countDomainHit(req, domain);
    });
  }
  next();
}

module.exports = { hitCounterMiddleware, countDomainHit, domainFromRequestPath, DEDUPE_MS };

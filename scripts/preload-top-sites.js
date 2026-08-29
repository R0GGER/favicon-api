#!/usr/bin/env node
/**
 * Preload favicon caches for the world's most visited websites.
 *
 * For each domain this script calls:
 *   1. Standard API  — GET /{domain}  (best-pick, same as the homepage API example)
 *   2. API v1        — GET /api/v1/favicon?url=https://{domain}
 *
 * Domain sources:
 *   dataforseo  — most Google ranking keywords (default; closest to "highest PageRank")
 *   similarweb  — most visited (https://www.similarweb.com/top-websites/)
 *   backlinko   — most popular by monthly visits (https://backlinko.com/most-popular-websites)
 *   db / file   — your own preload database or a local list
 * Origins from ranking dumps are deduplicated to their registrable domain via
 * the Public Suffix List. Curated website lists keep the host as published.
 *
 * Example:
 *   docker compose exec favicon-api node scripts/preload-top-sites.js --base-url http://127.0.0.1:3000
 */

const fs = require('fs');
const https = require('https');
// Known CDN/DNS/ad-infrastructure domains that never have a browsable favicon.
// Shared with the preload blocklist seed in scripts/manage-preload.js.
const { isServiceDomain } = require('../src/serviceDomains');
const { isAdultDomain } = require('../src/adultDomains');
const preloadSets = require('../src/preloadSets');
const preloadStore = require('../src/preloadStore');

const SOURCE_ALIASES = {
  visited: 'similarweb',
  popular: 'backlinko',
  pagerank: 'dataforseo',
};
const RANKING_SOURCES = new Set(['dataforseo', 'similarweb', 'backlinko', 'file', 'db']);

// DataForSEO "Top 1000 Websites By Ranking Keywords" free tool. Backed by their
// WordPress admin-ajax endpoint (action=dfs_ranked_domains), it returns a fine
// 1..1000 ranking of the sites with the most Google organic keywords, worldwide
// (location=0) or per country.
// See https://dataforseo.com/free-seo-stats/top-1000-websites
const DATAFORSEO_AJAX_URL = 'https://dataforseo.com/wp-admin/admin-ajax.php';
// Country name -> DataForSEO location ID (0 = Worldwide). Mirrors the country
// picker on the free-tool page. Used to translate a friendly --location name.
const DATAFORSEO_LOCATIONS = {
  Worldwide: 0, Algeria: 2012, Angola: 2024, Argentina: 2032, Armenia: 2051,
  Australia: 2036, Austria: 2040, Bahrain: 2048, Bangladesh: 2050, Belgium: 2056,
  Bolivia: 2068, Brazil: 2076, Bulgaria: 2100, Canada: 2124, Chile: 2152,
  Colombia: 2170, 'Costa Rica': 2188, Croatia: 2191, Cyprus: 2196, Czechia: 2203,
  Denmark: 2208, Ecuador: 2218, Egypt: 2818, 'El Salvador': 2222, Estonia: 2233,
  Finland: 2246, France: 2250, Germany: 2276, Greece: 2300, Guatemala: 2320,
  Hungary: 2348, India: 2356, Indonesia: 2360, Ireland: 2372, Israel: 2376,
  Italy: 2380, Japan: 2392, Jordan: 2400, Kenya: 2404, Latvia: 2428,
  Lithuania: 2440, Malaysia: 2458, Malta: 2470, Mexico: 2484, Morocco: 2504,
  Netherlands: 2528, 'New Zealand': 2554, Nicaragua: 2558, Nigeria: 2566,
  Norway: 2578, Pakistan: 2586, Paraguay: 2600, Peru: 2604, Poland: 2616,
  Portugal: 2620, Romania: 2642, Russia: 2643, 'Saudi Arabia': 2682, Serbia: 2688,
  Singapore: 2702, Slovakia: 2703, Slovenia: 2705, 'South Africa': 2710,
  Spain: 2724, 'Sri Lanka': 2144, Sweden: 2752, Switzerland: 2756, Thailand: 2764,
  Tunisia: 2788, Turkiye: 2792, Ukraine: 2804, 'United Arab Emirates': 2784,
  'United Kingdom': 2826, 'United States': 2840, Uruguay: 2858, Venezuela: 2862,
  Vietnam: 2704,
};
// Mozilla Public Suffix List — used to collapse origins to their registrable
// domain (eTLD+1), e.g. pt.xhamster.com -> xhamster.com, form.kemkes.go.id ->
// kemkes.go.id. Fetched at runtime to keep this script dependency-free.
const PUBLIC_SUFFIX_LIST_URL = 'https://publicsuffix.org/list/public_suffix_list.dat';
const USER_AGENT = 'FaviconProxy-preload/1.0';

/** Normalize a raw origin/domain into a bare hostname (no scheme/path/www). */
function normalizeHost(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const host = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');
  return host || null;
}

/** Naive registrable domain (last two labels) — fallback when no PSL is loaded. */
function registrableGuess(host) {
  const parts = host.split('.');
  return parts.length <= 2 ? host : parts.slice(-2).join('.');
}

/** Parse a Public Suffix List .dat body into fast lookup sets. */
function parsePublicSuffixList(text) {
  const rules = new Set();
  const wildcards = new Set(); // parent part of a "*.parent" rule
  const exceptions = new Set(); // rule body of a "!rule"
  for (const line of text.split(/\r?\n/)) {
    const rule = line.trim();
    if (!rule || rule.startsWith('//')) continue;
    if (rule.startsWith('!')) {
      exceptions.add(rule.slice(1).toLowerCase());
    } else if (rule.startsWith('*.')) {
      wildcards.add(rule.slice(2).toLowerCase());
    } else {
      rules.add(rule.toLowerCase());
    }
  }
  return { rules, wildcards, exceptions };
}

/** Public suffix (eTLD) of a host per the PSL algorithm. */
function publicSuffix(host, psl) {
  const labels = host.split('.');
  // Exception rules win outright: the suffix is the rule minus its first label.
  for (let i = 0; i < labels.length; i += 1) {
    if (psl.exceptions.has(labels.slice(i).join('.'))) {
      return labels.slice(i + 1).join('.');
    }
  }
  let bestLabelCount = null;
  for (let i = 0; i < labels.length; i += 1) {
    const candidateLabels = labels.length - i;
    if (psl.rules.has(labels.slice(i).join('.'))) {
      if (bestLabelCount === null || candidateLabels > bestLabelCount) {
        bestLabelCount = candidateLabels;
      }
    }
    const parent = labels.slice(i + 1).join('.');
    if (parent && psl.wildcards.has(parent)) {
      if (bestLabelCount === null || candidateLabels > bestLabelCount) {
        bestLabelCount = candidateLabels;
      }
    }
  }
  // No rule matched: the default rule "*" makes the last label the suffix.
  if (bestLabelCount === null) bestLabelCount = 1;
  return labels.slice(labels.length - bestLabelCount).join('.');
}

/**
 * Registrable domain (eTLD+1). With a loaded PSL this correctly handles
 * multi-level suffixes (co.uk, go.id, gov.co); without one it falls back to the
 * last two labels.
 */
function registrableDomain(host, psl) {
  if (!host) return null;
  if (!psl) return registrableGuess(host);
  const suffix = publicSuffix(host, psl);
  const suffixLabelCount = suffix ? suffix.split('.').length : 0;
  const labels = host.split('.');
  if (labels.length <= suffixLabelCount) return host; // host is itself a suffix
  return labels.slice(labels.length - suffixLabelCount - 1).join('.');
}

/**
 * Dedupe, drop service/adult domains, and cap to `limit`.
 * `collapseRegistrable` (default true) maps origins to eTLD+1 via the PSL.
 * Curated website lists pass false so hosts such as gemini.google.com stay.
 */
function applyFilters(rawDomains, {
  filterServices,
  excludeAdult = false,
  limit,
  psl = null,
  collapseRegistrable = true,
}) {
  const out = [];
  const seen = new Set();
  for (const raw of rawDomains) {
    const host = normalizeHost(raw);
    if (!host || !host.includes('.')) continue;
    const domain = collapseRegistrable ? registrableDomain(host, psl) : host;
    if (!domain || !domain.includes('.')) continue;
    if (seen.has(domain)) continue;
    if (filterServices && isServiceDomain(domain)) continue;
    if (excludeAdult && isAdultDomain(domain)) continue;
    seen.add(domain);
    out.push(domain);
    if (out.length >= limit) break;
  }
  return out;
}

/** `--adult include|exclude`. Default include (matches SimilarWeb's published list). */
function resolveAdultMode(args) {
  if (args['exclude-adult'] === true) return 'exclude';
  if (args['include-adult'] === true) return 'include';
  const raw = args.adult;
  if (raw === undefined || raw === true) return 'include';
  const value = String(raw).toLowerCase();
  if (value === 'exclude' || value === 'no' || value === 'off') return 'exclude';
  if (value === 'include' || value === 'yes' || value === 'on') return 'include';
  throw new Error(`Unknown --adult "${raw}" (expected: include or exclude).`);
}

function resolveSource(raw, hasDomainsFile) {
  let source = String(raw || (hasDomainsFile ? 'file' : 'dataforseo')).toLowerCase();
  source = SOURCE_ALIASES[source] || source;
  if (!RANKING_SOURCES.has(source)) {
    throw new Error(
      `Unknown --source "${raw}" (expected: similarweb, backlinko, dataforseo, db or file).`,
    );
  }
  return source;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i += 1;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function usage(code = 0) {
  const msg = [
    'Preload favicon caches for the most-visited / most-popular websites.',
    'Ranking dumps (dataforseo) are deduplicated to their registrable domain',
    '(eTLD+1) via the Public Suffix List. Curated lists keep the published host.',
    '',
    'Usage:',
    '  node scripts/preload-top-sites.js [options]',
    '',
    'Options:',
    '  --base-url URL       FaviconAPI base URL',
    '                       (default: PRELOAD_BASE_URL or http://localhost:3100)',
    '  --source NAME        Domain source (default: dataforseo):',
    '                       similarweb = most visited, SimilarWeb worldwide top 50',
    '                                    (https://www.similarweb.com/top-websites/).',
    '                                    Extra slots filled from Backlinko.',
    '                       backlinko  = most popular, Semrush monthly visits',
    '                                    (https://backlinko.com/most-popular-websites).',
    '                                    NSFW already removed by the publisher.',
    '                       dataforseo = most Google ranking keywords (top ~1000).',
    '                                    Alias: pagerank.',
    '                       db         = enabled domains from the preload database,',
    '                                    highest usage rank first. List position is',
    '                                    only a tiebreaker (see manage-preload.js)',
    '                       file       = local list (requires --domains-file)',
    '                       Aliases: visited=similarweb, popular=backlinko.',
    '  --adult MODE         include (default) or exclude porn/adult domains.',
    '                       SimilarWeb marks Adult-category sites; other sources',
    '                       use the built-in adult-domain list. Backlinko is',
    '                       already NSFW-free. Aliases: --exclude-adult / --include-adult.',
    '  --location LOC       DataForSEO country: name or numeric ID (default: Worldwide).',
    '                       E.g. --location Netherlands, --location "United States", 2528',
    '  --limit N            Number of domains to preload (default: 500)',
    '  --min-rank N         --source db only: skip traffic-only domains below this',
    '                       usage rank (hit count; default: PRELOAD_MIN_RANK, normally 3).',
    '                       List-imported domains still fill remaining slots.',
    '  --concurrency N      Parallel domain workers (default: 4)',
    '  --api-key KEY        API key for /api/v1/favicon',
    '                       (or PRELOAD_API_KEY / API_KEY env var)',
    '  --domains-file PATH  Local domain list (one domain per line); sets --source file',
    '  --no-filter          Do NOT drop known service/infra domains (CDN, DNS, etc.)',
    '  --sizes LIST         Scraper sizes to warm via /scraper/{size}/{domain}',
    '                       (default: 16,32,64,128,256,512). Comma-separated subset',
    '                       to override. Multiplies requests per domain.',
    '  --skip-sizes         Skip scraper size warming',
    '  --skip-standard      Skip GET /{domain}',
    '  --skip-v1            Skip GET /api/v1/favicon',
    '  --timeout MS         Per-request timeout in ms (default: 30000)',
    '  --dry-run            Print domains only, do not call the API',
    '',
    'Examples:',
    '  node scripts/preload-top-sites.js',
    '  node scripts/preload-top-sites.js --source similarweb --limit 100 --adult exclude',
    '  node scripts/preload-top-sites.js --source backlinko --limit 100',
    '  node scripts/preload-top-sites.js --source db',
    '  node scripts/preload-top-sites.js --limit 1000',
    '  node scripts/preload-top-sites.js --location Netherlands --limit 200',
    '  docker compose exec favicon-api node scripts/preload-top-sites.js --base-url http://127.0.0.1:3000',
    '',
  ].join('\n');
  process.stdout.write(msg);
  process.exit(code);
}

function httpsRequest(
  url,
  { method = 'GET', headers = {}, timeoutMs = 30000, maxRedirects = 5, body = null } = {},
) {
  return new Promise((resolve, reject) => {
    const finalHeaders = { 'User-Agent': USER_AGENT, ...headers };
    if (body != null && finalHeaders['Content-Length'] === undefined) {
      finalHeaders['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request(
      url,
      { method, headers: finalHeaders, timeout: timeoutMs },
      (res) => {
        if (
          maxRedirects > 0 &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          const nextUrl = new URL(res.headers.location, url).href;
          res.resume();
          // Follow redirects as GET without re-sending the body (per HTTP norms).
          httpsRequest(nextUrl, { method: 'GET', headers, timeoutMs, maxRedirects: maxRedirects - 1 })
            .then(resolve)
            .catch(reject);
          return;
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`Timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

async function fetchWithTimeout(url, { timeoutMs, headers = {} }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, ...headers },
      signal: controller.signal,
      redirect: 'follow',
    });
    const body = await res.arrayBuffer();
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: Buffer.from(body),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a raw --location value (numeric DataForSEO ID or country name) into
 * `{ id, name }`. Defaults to Worldwide (0). Throws on an unknown country name.
 */
function resolveLocation(raw) {
  if (raw === undefined || raw === null || raw === '' || raw === true) {
    return { id: 0, name: 'Worldwide' };
  }
  const str = String(raw).trim();
  if (/^\d+$/.test(str)) {
    const id = parseInt(str, 10);
    const name = Object.keys(DATAFORSEO_LOCATIONS).find((k) => DATAFORSEO_LOCATIONS[k] === id);
    return { id, name: name || `location ${id}` };
  }
  const key = str.toLowerCase();
  const match = Object.keys(DATAFORSEO_LOCATIONS).find((k) => k.toLowerCase() === key);
  if (!match) {
    throw new Error(
      `Unknown --location "${str}". Use a numeric DataForSEO location ID or a ` +
        'country name (e.g. "Netherlands", "United States", "Worldwide").',
    );
  }
  return { id: DATAFORSEO_LOCATIONS[match], name: match };
}

/**
 * Fetch the raw DataForSEO top-1000 ranking for a location as an array of
 * `{ position, domain, count, etv }`, sorted by ascending rank (1 = top).
 */
async function fetchDataForSeoRanked(locationId, timeoutMs) {
  const body = `action=dfs_ranked_domains&location=${encodeURIComponent(locationId)}`;
  const res = await httpsRequest(DATAFORSEO_AJAX_URL, {
    method: 'POST',
    timeoutMs,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json',
    },
    body,
  });
  if (res.status !== 200) {
    throw new Error(`DataForSEO request failed (HTTP ${res.status}).`);
  }
  let json;
  try {
    json = JSON.parse(res.body.toString('utf8'));
  } catch {
    throw new Error('DataForSEO returned invalid JSON.');
  }
  if (!Array.isArray(json) || json.length === 0) {
    throw new Error(
      'DataForSEO returned no ranked domains (service may be temporarily unavailable).',
    );
  }
  json.sort((a, b) => (a.position || 0) - (b.position || 0));
  return json;
}

/**
 * DataForSEO top-1000 as a domain list in rank order, after service-drop and
 * eTLD+1 dedup.
 */
async function fetchDataForSeoDomains(
  limit,
  timeoutMs,
  { filterServices, excludeAdult = false, psl = null, locationId = 0 },
) {
  const ranked = await fetchDataForSeoRanked(locationId, timeoutMs);
  const raw = ranked.map((r) => r.domain).filter(Boolean);
  const domains = applyFilters(raw, { filterServices, excludeAdult, limit, psl });
  if (domains.length === 0) {
    throw new Error('DataForSEO list was empty after filtering.');
  }
  return { domains };
}

/** Download and parse the Public Suffix List; returns null on failure. */
async function loadPublicSuffixList(timeoutMs) {
  try {
    const res = await httpsRequest(PUBLIC_SUFFIX_LIST_URL, { timeoutMs });
    if (res.status !== 200) {
      throw new Error(`HTTP ${res.status}`);
    }
    return parsePublicSuffixList(res.body.toString('utf8'));
  } catch (err) {
    console.warn(
      `Warning: could not load Public Suffix List (${err.message || err}); ` +
        'falling back to last-two-labels for domain deduplication.',
    );
    return null;
  }
}

function loadDomainsFromFile(filePath, limit, filterServices, excludeAdult, psl) {
  const raw = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const domains = applyFilters(raw, { filterServices, excludeAdult, limit, psl });
  if (domains.length === 0) {
    throw new Error(`No domains found in ${filePath}`);
  }
  return domains;
}

function siteUrl(baseUrl, domain) {
  return `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(domain)}`;
}

function scraperSizeUrl(baseUrl, domain, size) {
  const root = baseUrl.replace(/\/+$/, '');
  return `${root}/scraper/${size}/${encodeURIComponent(domain)}`;
}

function v1Url(baseUrl, domain) {
  const root = baseUrl.replace(/\/+$/, '');
  const target = `https://${domain}`;
  return `${root}/api/v1/favicon?url=${encodeURIComponent(target)}`;
}

function v1Headers(apiKey) {
  if (!apiKey) return {};
  return { Authorization: `Bearer ${apiKey}` };
}

async function preloadStandard(baseUrl, domain, timeoutMs) {
  const url = siteUrl(baseUrl, domain);
  const res = await fetchWithTimeout(url, { timeoutMs });
  const contentType = res.headers['content-type'] || '';
  if (res.status === 200 && contentType.startsWith('image/')) {
    return { ok: true, status: res.status, bytes: res.body.length };
  }
  return {
    ok: false,
    status: res.status,
    error: res.status === 200 ? `Unexpected content-type: ${contentType}` : `HTTP ${res.status}`,
  };
}

async function preloadScraperSize(baseUrl, domain, size, timeoutMs) {
  const url = scraperSizeUrl(baseUrl, domain, size);
  const res = await fetchWithTimeout(url, { timeoutMs });
  const contentType = res.headers['content-type'] || '';
  if (res.status === 200 && contentType.startsWith('image/')) {
    return { ok: true, status: res.status, bytes: res.body.length };
  }
  return {
    ok: false,
    status: res.status,
    error: res.status === 200 ? `Unexpected content-type: ${contentType}` : `HTTP ${res.status}`,
  };
}

async function preloadV1(baseUrl, domain, apiKey, timeoutMs) {
  const url = v1Url(baseUrl, domain);
  const res = await fetchWithTimeout(url, { timeoutMs, headers: v1Headers(apiKey) });
  if (res.status !== 200) {
    let detail = `HTTP ${res.status}`;
    try {
      const json = JSON.parse(res.body.toString('utf8'));
      if (json.error) detail = json.error;
      if (json.code) detail = `${json.code}: ${detail}`;
    } catch {
      // ignore parse errors
    }
    return { ok: false, status: res.status, error: detail };
  }

  try {
    const json = JSON.parse(res.body.toString('utf8'));
    if (json.url && json.domain) {
      return { ok: true, status: res.status, cached: !!json.cached, sourceType: json.sourceType || null };
    }
    return { ok: false, status: res.status, error: 'Invalid JSON response' };
  } catch {
    return { ok: false, status: res.status, error: 'Invalid JSON response' };
  }
}

async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await fn(items[index], index);
    }
  }

  const workers = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

function fmtDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 100) / 10;
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = Math.round((sec % 60) * 10) / 10;
  return `${min}m ${rem}s`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) usage(0);
  if (args._.length > 0) usage(1);

  const baseUrl = String(args['base-url'] || process.env.PRELOAD_BASE_URL || 'http://localhost:3100').trim();
  const limit = Math.max(1, parseInt(args.limit || process.env.PRELOAD_LIMIT || '500', 10));
  const concurrency = Math.max(1, parseInt(args.concurrency || process.env.PRELOAD_CONCURRENCY || '4', 10));
  const timeoutMs = Math.max(1000, parseInt(args.timeout || process.env.PRELOAD_TIMEOUT || '30000', 10));
  const apiKey = String(args['api-key'] || process.env.PRELOAD_API_KEY || process.env.API_KEY || '').trim();
  const skipStandard = !!args['skip-standard'];
  const skipV1 = !!args['skip-v1'];
  const skipSizes = !!args['skip-sizes'];
  const dryRun = !!args['dry-run'];
  const filterServices = !args['no-filter'];
  const adultMode = resolveAdultMode(args);
  const excludeAdult = adultMode === 'exclude';

  // Scraper sizes to warm via /scraper/{size}/{domain}. Default: all valid sizes.
  const VALID_SIZES = [16, 32, 64, 128, 256, 512];
  let sizes = [];
  if (!skipSizes) {
    const sizesArg =
      args.sizes === undefined || args.sizes === true
        ? String(VALID_SIZES.join(','))
        : String(args.sizes || '');
    sizes = sizesArg
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => VALID_SIZES.includes(n));
    if (sizesArg.trim() && sizes.length === 0) {
      throw new Error(`Invalid --sizes; choose from ${VALID_SIZES.join(', ')}.`);
    }
  }
  const source = resolveSource(args.source, !!args['domains-file']);

  if (skipStandard && skipV1 && sizes.length === 0) {
    throw new Error(
      'Nothing to do: --skip-standard, --skip-v1, and --skip-sizes are all set.',
    );
  }

  const location = resolveLocation(args.location);

  // Public Suffix List lets us dedupe origins to their registrable domain
  // (eTLD+1) so pt.xhamster.com and xhamster.com collapse to one entry.
  // Curated website lists keep the published host and do not need it.
  const needsPsl = source === 'dataforseo' || source === 'file';
  const psl = needsPsl ? await loadPublicSuffixList(timeoutMs) : null;

  // domain -> { id } for result writeback. Filled from --source db, and from
  // recordSourceList for ranking lists so those rows are not left as `traffic`.
  const domainMeta = new Map();

  let domains;
  if (source === 'db') {
    const minRank =
      args['min-rank'] === undefined || args['min-rank'] === true
        ? preloadStore.MIN_RANK
        : parseInt(args['min-rank'], 10);
    if (!Number.isFinite(minRank)) {
      throw new Error('--min-rank must be a number.');
    }
    const fetchLimit = excludeAdult ? Math.max(limit * 3, limit) : limit;
    const rows = preloadStore.listForPreload({ limit: fetchLimit, minRank });
    const picked = [];
    for (const row of rows) {
      if (excludeAdult && isAdultDomain(row.domain)) continue;
      picked.push(row);
      if (picked.length >= limit) break;
    }
    if (picked.length === 0) {
      throw new Error(
        `No enabled domains with rank >= ${minRank} in ${preloadStore.DB_PATH}. ` +
          'Add some with scripts/manage-preload.js, or lower --min-rank.',
      );
    }
    domains = picked.map((row) => row.domain);
    for (const row of picked) domainMeta.set(row.domain, { id: row.id });
    console.log(
      `Preload database (${preloadStore.DB_PATH}): ${domains.length} domains, rank >= ${minRank}`,
    );
  } else if (source === 'file' || args['domains-file']) {
    if (!args['domains-file']) {
      throw new Error('--source file requires --domains-file PATH.');
    }
    domains = loadDomainsFromFile(
      args['domains-file'],
      limit,
      filterServices,
      excludeAdult,
      psl,
    );
    console.log(`Loaded ${domains.length} domains from ${args['domains-file']}`);
  } else if (source === 'similarweb') {
    console.log(`Fetching SimilarWeb most-visited list (top ${limit})…`);
    const sw = await preloadSets.fetchSimilarwebDomains(limit, {
      excludeAdult,
      timeoutMs: Math.max(timeoutMs, 20000),
    });
    domains = sw.domains;
    const origin = sw.live ? 'live scrape' : 'built-in snapshot';
    const fillNote = sw.filled
      ? `; filled extra from Backlinko`
      : '';
    console.log(
      `SimilarWeb (${origin}, ${sw.available} ranked): ${domains.length} domains${fillNote}`,
    );
  } else if (source === 'backlinko') {
    console.log(`Fetching Backlinko / Semrush most-popular list (top ${limit})…`);
    const bl = await preloadSets.fetchBacklinkoDomains(limit, {
      excludeAdult,
      timeoutMs: Math.max(timeoutMs, 20000),
    });
    domains = bl.domains;
    const origin = bl.live ? 'live scrape' : 'built-in snapshot';
    console.log(`Backlinko (${origin}, ${bl.available} ranked): ${domains.length} domains`);
  } else {
    console.log(`Fetching top ${limit} domains from DataForSEO (${location.name})…`);
    const dfs = await fetchDataForSeoDomains(limit, timeoutMs, {
      filterServices,
      excludeAdult,
      psl,
      locationId: location.id,
    });
    domains = dfs.domains;
    console.log(`DataForSEO list (DataForSEO ${location.name}): ${domains.length} domains`);
  }
  if (filterServices && source !== 'db' && source !== 'similarweb' && source !== 'backlinko') {
    console.log('Service/infra domains (CDN, DNS, tracking) filtered out.');
  }
  if (excludeAdult) {
    console.log('Adult/porn domains excluded.');
  }
  if (!domains || domains.length === 0) {
    throw new Error('No domains left after filtering.');
  }

  if (dryRun) {
    domains.forEach((domain, i) => console.log(`${i + 1}\t${domain}`));
    return;
  }

  // Persist ranking-source domains before the API calls, with the list name as
  // `source`. Otherwise the hit counter creates the same rows as `traffic`.
  if (source !== 'db') {
    const recorded = preloadStore.recordSourceList(domains, source);
    for (const row of recorded) domainMeta.set(row.domain, { id: row.id });
    if (recorded.length) {
      console.log(
        `Preload database: ${recorded.length} domains stored as source=${source}`,
      );
    }
  }

  const modes = [];
  if (!skipStandard) modes.push('standard (GET /{domain})');
  if (!skipV1) modes.push('API v1 (/api/v1/favicon)');
  if (sizes.length) modes.push(`scraper sizes (${sizes.join(', ')})`);

  console.log(`Base URL: ${baseUrl}`);
  console.log(`Modes: ${modes.join(', ')}`);
  console.log(`Concurrency: ${concurrency}, timeout: ${timeoutMs}ms`);
  if (!skipV1 && apiKey) console.log('API key: provided');
  console.log('');

  const stats = {
    standard: { ok: 0, fail: 0 },
    v1: { ok: 0, fail: 0, cached: 0, fresh: 0 },
    sizes: { ok: 0, fail: 0 },
    failures: [],
  };

  const started = Date.now();
  let completed = 0;

  // Result writeback. Rows are buffered and flushed per batch: better-sqlite3
  // writes synchronously, so a write per domain would stall the event loop in
  // the middle of the concurrent fetches.
  const WRITEBACK_BATCH = 25;
  const writebackQueue = [];
  let writebackRows = 0;

  function flushWriteback(force = false) {
    if (writebackQueue.length === 0) return;
    if (!force && writebackQueue.length < WRITEBACK_BATCH) return;
    writebackRows += preloadStore.recordPreloadResults(writebackQueue.splice(0));
  }

  function queueWriteback(row) {
    const meta = domainMeta.get(row.domain);
    if (!meta) return;

    const result = [];
    const errors = [];
    if (!skipStandard) {
      result.push(row.standard.ok ? 'standard_ok' : 'standard_fail');
      if (!row.standard.ok) errors.push(`standard: ${row.standard.error || row.standard.status}`);
    }
    if (!skipV1) {
      result.push(row.v1.ok ? 'v1_ok' : 'v1_fail');
      if (!row.v1.ok) errors.push(`v1: ${row.v1.error || row.v1.status}`);
    }
    if (row.sizes) {
      result.push(row.sizes.fail === 0 ? 'sizes_ok' : `sizes_${row.sizes.ok}/${sizes.length}`);
      if (row.sizes.fail > 0) errors.push(`sizes: ${row.sizes.errors.join(', ')}`);
    }

    writebackQueue.push({
      id: meta.id,
      ok: errors.length === 0,
      result: result.join(','),
      error: errors.length ? errors.join('; ') : null,
    });
    flushWriteback();
  }

  await mapPool(domains, concurrency, async (domain) => {
    const row = { domain, standard: null, v1: null, sizes: null };

    if (!skipStandard) {
      try {
        row.standard = await preloadStandard(baseUrl, domain, timeoutMs);
        if (row.standard.ok) stats.standard.ok += 1;
        else stats.standard.fail += 1;
      } catch (err) {
        row.standard = { ok: false, error: err.message || String(err) };
        stats.standard.fail += 1;
      }
    }

    if (!skipV1) {
      try {
        row.v1 = await preloadV1(baseUrl, domain, apiKey, timeoutMs);
        if (row.v1.ok) {
          stats.v1.ok += 1;
          if (row.v1.cached) stats.v1.cached += 1;
          else stats.v1.fresh += 1;
        } else {
          stats.v1.fail += 1;
        }
      } catch (err) {
        row.v1 = { ok: false, error: err.message || String(err) };
        stats.v1.fail += 1;
      }
    }

    if (sizes.length) {
      row.sizes = { ok: 0, fail: 0, errors: [] };
      for (const size of sizes) {
        try {
          const r = await preloadScraperSize(baseUrl, domain, size, timeoutMs);
          if (r.ok) {
            row.sizes.ok += 1;
            stats.sizes.ok += 1;
          } else {
            row.sizes.fail += 1;
            stats.sizes.fail += 1;
            row.sizes.errors.push(`${size}: ${r.error || r.status}`);
          }
        } catch (err) {
          row.sizes.fail += 1;
          stats.sizes.fail += 1;
          row.sizes.errors.push(`${size}: ${err.message || String(err)}`);
        }
      }
    }

    completed += 1;
    const standardTag = skipStandard
      ? ''
      : row.standard.ok
        ? 'std=ok'
        : `std=fail(${row.standard.error || row.standard.status})`;
    const v1Tag = skipV1
      ? ''
      : row.v1.ok
        ? `v1=ok${row.v1.cached ? ',cached' : ''}`
        : `v1=fail(${row.v1.error || row.v1.status})`;
    const sizesTag = row.sizes
      ? `sizes=${row.sizes.ok}/${sizes.length}${row.sizes.fail ? ' fail' : ''}`
      : '';
    const tags = [standardTag, v1Tag, sizesTag].filter(Boolean).join(' ');
    console.log(`[${completed}/${domains.length}] ${domain}${tags ? ` — ${tags}` : ''}`);

    if (
      (!skipStandard && !row.standard.ok) ||
      (!skipV1 && !row.v1.ok) ||
      (row.sizes && row.sizes.fail > 0)
    ) {
      stats.failures.push(row);
    }

    queueWriteback(row);
    return row;
  });

  flushWriteback(true);

  const elapsed = Date.now() - started;
  console.log('');
  console.log(`Done in ${fmtDuration(elapsed)} (${domains.length} domains)`);
  if (!skipStandard) {
    console.log(`Standard API: ${stats.standard.ok} ok, ${stats.standard.fail} failed`);
  }
  if (!skipV1) {
    console.log(
      `API v1: ${stats.v1.ok} ok (${stats.v1.cached} cached, ${stats.v1.fresh} fresh), ${stats.v1.fail} failed`,
    );
  }
  if (sizes.length) {
    console.log(
      `Scraper sizes (${sizes.join(', ')}): ${stats.sizes.ok} ok, ${stats.sizes.fail} failed`,
    );
  }
  if (domainMeta.size) {
    console.log(`DB updated: ${writebackRows} rows`);
  }

  if (stats.failures.length > 0) {
    console.log('');
    console.log(`Failures (${stats.failures.length}):`);
    for (const row of stats.failures.slice(0, 25)) {
      const parts = [];
      if (row.standard && !row.standard.ok) parts.push(`standard: ${row.standard.error || row.standard.status}`);
      if (row.v1 && !row.v1.ok) parts.push(`v1: ${row.v1.error || row.v1.status}`);
      if (row.sizes && row.sizes.fail > 0) parts.push(`sizes: ${row.sizes.errors.join(', ')}`);
      console.log(`  ${row.domain} — ${parts.join('; ')}`);
    }
    if (stats.failures.length > 25) {
      console.log(`  … and ${stats.failures.length - 25} more`);
    }
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

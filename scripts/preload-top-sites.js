#!/usr/bin/env node
/**
 * Preload favicon caches for the world's most visited websites.
 *
 * For each domain this script calls:
 *   1. Standard API  — GET /{domain}  (best-pick, same as the homepage API example)
 *   2. API v1        — GET /api/v1/favicon?url=https://{domain}
 *
 * Domains come from the Chrome UX Report (CrUX) most-visited ranking by
 * default (--source crux); Tranco and local files are also supported. Origins
 * are deduplicated to their registrable domain via the Public Suffix List.
 *
 * Example:
 *   docker compose exec favicon-api node scripts/preload-top-sites.js --base-url http://127.0.0.1:3000
 */

const fs = require('fs');
const https = require('https');
const zlib = require('zlib');

const TRANCO_LATEST_URL = 'https://tranco-list.eu/latest_list';
// Chrome UX Report top-million, cached monthly from Google BigQuery. Ranked by
// real Chrome page visits, so pure infrastructure (CDN/DNS/tracking backends)
// and dead sites do not appear — unlike Tranco's DNS/traffic-based ranking.
const CRUX_LATEST_URL =
  'https://raw.githubusercontent.com/zakird/crux-top-lists/main/data/global/current.csv.gz';
// Mozilla Public Suffix List — used to collapse origins to their registrable
// domain (eTLD+1), e.g. pt.xhamster.com -> xhamster.com, form.kemkes.go.id ->
// kemkes.go.id. Fetched at runtime to keep this script dependency-free.
const PUBLIC_SUFFIX_LIST_URL = 'https://publicsuffix.org/list/public_suffix_list.dat';
const USER_AGENT = 'FaviconProxy-preload/1.0';

// Pure service/infrastructure domains that have no user-facing website or
// favicon (CDN, DNS/registry, cloud backends, ad/tracking endpoints). These
// occasionally still surface in ranking lists; we drop them so the preload set
// only contains real, browsable websites. Company sites that happen to also run
// infra (e.g. cloudflare.com, appsflyer.com, criteo.com) are deliberately NOT
// listed here. Matching also covers subdomains (foo.gstatic.com).
const SERVICE_DOMAINS = new Set([
  // Google infrastructure / CDN / ads / tracking
  'gstatic.com', 'googleapis.com', 'googleusercontent.com', 'googlevideo.com',
  'ggpht.com', 'gvt1.com', 'gvt2.com', 'googlesyndication.com', 'googletagmanager.com',
  'googletagservices.com', 'googleadservices.com', 'google-analytics.com',
  'doubleclick.net', 'app-measurement.com', 'usercontent.goog', '2mdn.net',
  // Apple infrastructure
  'aaplimg.com', 'apple-dns.net', 'mzstatic.com', 'cdn-apple.com',
  // Microsoft infrastructure
  'microsoftonline.com', 'windowsupdate.com', 'trafficmanager.net', 'azureedge.net',
  'windows.net', 'msedge.net', 'cloudapp.net', 's-microsoft.com',
  // Meta / Facebook infrastructure
  'fbcdn.net', 'cdninstagram.com', 'whatsapp.net', 'fbsbx.com',
  // Amazon / AWS infrastructure
  'amazonaws.com', 'cloudfront.net', 'media-amazon.com', 'ssl-images-amazon.com',
  // CDNs
  'akamai.net', 'akamaiedge.net', 'akamaihd.net', 'akadns.net', 'akam.net',
  'edgekey.net', 'edgesuite.net', 'fastly.net', 'fastlylb.net', 'llnwd.net',
  // DNS / registry infrastructure
  'gtld-servers.net', 'root-servers.net', 'nstld.com', 'domaincontrol.com',
  'ripn.net', 'registrar-servers.com',
  // Ad / tracking endpoints (no browsable site)
  'adnxs.com', 'adsrvr.org', 'criteo.net', 'scorecardresearch.com',
  'appsflyersdk.com', 'demdex.net', 'rubiconproject.com', 'pubmatic.com',
  'casalemedia.com',
  // TikTok / ByteDance infrastructure
  'tiktokcdn.com', 'tiktokv.com', 'bytefcdn.com', 'byteoversea.com', 'ibyteimg.com',
]);

function isServiceDomain(host) {
  if (SERVICE_DOMAINS.has(host)) return true;
  for (const svc of SERVICE_DOMAINS) {
    if (host.endsWith(`.${svc}`)) return true;
  }
  return false;
}

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
 * Dedupe (collapsing to registrable domain), drop service domains, and cap to
 * `limit`. When `cruxSet` is provided, only domains present in the Chrome UX
 * Report are kept (proves real browser visits — excludes dead / infra-only
 * domains). `psl` enables correct eTLD+1 deduplication.
 */
function applyFilters(rawDomains, { filterServices, limit, cruxSet = null, psl = null }) {
  const out = [];
  const seen = new Set();
  for (const raw of rawDomains) {
    const host = normalizeHost(raw);
    if (!host || !host.includes('.')) continue;
    const domain = registrableDomain(host, psl);
    if (!domain || !domain.includes('.')) continue;
    if (seen.has(domain)) continue;
    if (filterServices && isServiceDomain(domain)) continue;
    if (cruxSet && !cruxSet.has(domain)) continue;
    seen.add(domain);
    out.push(domain);
    if (out.length >= limit) break;
  }
  return out;
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
    'Preload favicon caches for the most-visited websites (CrUX by default).',
    'Origins are deduplicated to their registrable domain (eTLD+1) via the',
    'Public Suffix List (e.g. pt.xhamster.com -> xhamster.com).',
    '',
    'Usage:',
    '  node scripts/preload-top-sites.js [options]',
    '',
    'Options:',
    '  --base-url URL       FaviconAPI base URL',
    '                       (default: PRELOAD_BASE_URL or http://localhost:3100)',
    '  --source NAME        Domain source: crux (default), verified, tranco, or file',
    '                       crux     = Chrome UX Report, ranked by real page visits.',
    '                                  Ordered high→low by CrUX popularity tier, with',
    '                                  Tranco rank as within-tier tiebreaker. Excludes',
    '                                  dead sites.',
    '                       verified = Tranco ranking, kept only if the site also',
    '                                  appears in CrUX (fine ordering + real visits)',
    '                       tranco   = raw Tranco DNS/traffic ranking',
    '                       file     = local list (requires --domains-file)',
    '  --limit N            Number of domains to preload (default: 500)',
    '  --concurrency N      Parallel domain workers (default: 4)',
    '  --api-key KEY        API key for /api/v1/favicon',
    '                       (or PRELOAD_API_KEY / API_KEY env var)',
    '  --domains-file PATH  Local domain list (one domain per line); sets --source file',
    '  --no-filter          Do NOT drop known service/infra domains (CDN, DNS, etc.)',
    '  --sizes LIST         Also warm extra icon sizes via /scraper/{size}/{domain}.',
    '                       Comma-separated; valid: 16,32,64,128,256. Bare --sizes',
    '                       warms all five. Multiplies requests per domain.',
    '  --skip-standard      Skip GET /{domain}',
    '  --skip-v1            Skip GET /api/v1/favicon',
    '  --timeout MS         Per-request timeout in ms (default: 30000)',
    '  --dry-run            Print domains only, do not call the API',
    '',
    'Examples:',
    '  node scripts/preload-top-sites.js',
    '  node scripts/preload-top-sites.js --limit 1000',
    '  node scripts/preload-top-sites.js --source tranco --limit 100',
    '  docker compose exec favicon-api node scripts/preload-top-sites.js --base-url http://127.0.0.1:3000',
    '',
  ].join('\n');
  process.stdout.write(msg);
  process.exit(code);
}

function httpsRequest(url, { method = 'GET', headers = {}, timeoutMs = 30000, maxRedirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method, headers: { 'User-Agent': USER_AGENT, ...headers }, timeout: timeoutMs },
      (res) => {
        if (
          maxRedirects > 0 &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          const nextUrl = new URL(res.headers.location, url).href;
          res.resume();
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

async function resolveTrancoListId(timeoutMs) {
  const res = await httpsRequest(TRANCO_LATEST_URL, {
    method: 'GET',
    timeoutMs,
    maxRedirects: 0,
  });
  const location = res.headers.location || res.headers.Location;
  if (!location) {
    throw new Error('Could not resolve latest Tranco list ID (missing redirect).');
  }
  const match = String(location).match(/\/list\/([^/]+)/);
  if (!match) {
    throw new Error(`Unexpected Tranco redirect location: ${location}`);
  }
  return match[1];
}

async function fetchTrancoDomains(limit, timeoutMs, { filterServices, cruxSet = null, psl = null }) {
  const listId = await resolveTrancoListId(timeoutMs);
  // Over-fetch so filtering (service drop + optional CrUX intersection) still
  // leaves at least `limit` domains.
  const factor = cruxSet ? 6 : filterServices ? 3 : 1;
  const rawLimit = Math.min(Math.max(limit * factor, limit), 1000000);
  const csvUrl = `https://tranco-list.eu/download/${listId}/${rawLimit}`;
  const res = await httpsRequest(csvUrl, { timeoutMs });
  if (res.status !== 200) {
    throw new Error(`Tranco download failed (${res.status}) for ${csvUrl}`);
  }

  const raw = [];
  for (const line of res.body.toString('utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const comma = trimmed.indexOf(',');
    raw.push(comma >= 0 ? trimmed.slice(comma + 1) : trimmed);
  }

  const domains = applyFilters(raw, { filterServices, limit, cruxSet, psl });
  if (domains.length === 0) {
    throw new Error('Tranco list was empty after filtering.');
  }
  return { listId, domains };
}

/**
 * Fetch Tranco as a Map of registrable domain -> rank (1 = most popular). Used
 * only as a within-tier tiebreaker to give CrUX a fine high→low ordering.
 */
async function fetchTrancoRankMap(count, timeoutMs, psl) {
  const listId = await resolveTrancoListId(timeoutMs);
  const rawLimit = Math.min(Math.max(count, 1), 1000000);
  const csvUrl = `https://tranco-list.eu/download/${listId}/${rawLimit}`;
  const res = await httpsRequest(csvUrl, { timeoutMs });
  if (res.status !== 200) {
    throw new Error(`Tranco download failed (${res.status}) for ${csvUrl}`);
  }

  const rankByDomain = new Map();
  let rank = 0;
  for (const line of res.body.toString('utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const comma = trimmed.indexOf(',');
    rank += 1;
    const host = normalizeHost(comma >= 0 ? trimmed.slice(comma + 1) : trimmed);
    if (!host || !host.includes('.')) continue;
    const domain = registrableDomain(host, psl);
    if (domain && !rankByDomain.has(domain)) rankByDomain.set(domain, rank);
  }
  return { listId, rankByDomain };
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

/**
 * Download and decompress the CrUX top-million list.
 *
 * CrUX ranks sites in coarse popularity buckets (1000, 10000, …) rather than a
 * fine 1..N order, and does not sort within a bucket. That makes it a great
 * membership signal ("is this a real, currently-visited site?") but a poor
 * source of ordered top-N results — hence it is used to verify Tranco's order.
 *
 * Returns:
 *   tierByDomain — Map of registrable domain -> best (smallest) CrUX rank tier,
 *                  in first-seen file order. Its keys double as the membership
 *                  set of every real, currently-visited site.
 */
async function loadCrux(timeoutMs, psl) {
  const res = await httpsRequest(CRUX_LATEST_URL, { timeoutMs });
  if (res.status !== 200) {
    throw new Error(`CrUX download failed (${res.status}) for ${CRUX_LATEST_URL}`);
  }

  let csv;
  try {
    csv = zlib.gunzipSync(res.body).toString('utf8');
  } catch (err) {
    throw new Error(`Could not decompress CrUX list: ${err.message || err}`);
  }

  const tierByDomain = new Map();
  const lines = csv.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const comma = line.indexOf(',');
    const origin = comma >= 0 ? line.slice(0, comma) : line;
    // CrUX CSV header is "origin,rank".
    if (i === 0 && origin.toLowerCase() === 'origin') continue;
    const tier = comma >= 0 ? parseInt(line.slice(comma + 1), 10) : Number.MAX_SAFE_INTEGER;
    const host = normalizeHost(origin);
    if (!host || !host.includes('.')) continue;
    const domain = registrableDomain(host, psl);
    if (!domain || !domain.includes('.')) continue;
    const existing = tierByDomain.get(domain);
    // Keep the most popular tier seen for this registrable domain.
    if (existing === undefined || tier < existing) tierByDomain.set(domain, tier);
  }

  if (tierByDomain.size === 0) {
    throw new Error('CrUX list was empty.');
  }
  return { tierByDomain };
}

function loadDomainsFromFile(filePath, limit, filterServices, psl) {
  const raw = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const domains = applyFilters(raw, { filterServices, limit, psl });
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
  const dryRun = !!args['dry-run'];
  const filterServices = !args['no-filter'];

  // Extra icon sizes to warm via the scraper's sized route (/scraper/{size}/{domain}).
  const VALID_SIZES = [16, 32, 64, 128, 256];
  const sizesArg = args.sizes === true ? String(VALID_SIZES.join(',')) : String(args.sizes || '');
  const sizes = sizesArg
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => VALID_SIZES.includes(n));
  if (sizesArg.trim() && sizes.length === 0) {
    throw new Error(`Invalid --sizes; choose from ${VALID_SIZES.join(', ')}.`);
  }
  const source = String(
    args.source || (args['domains-file'] ? 'file' : 'crux'),
  ).toLowerCase();

  if (skipStandard && skipV1 && sizes.length === 0) {
    throw new Error(
      'Nothing to do: both --skip-standard and --skip-v1 are set (and no --sizes).',
    );
  }
  if (!['verified', 'crux', 'tranco', 'file'].includes(source)) {
    throw new Error(
      `Unknown --source "${source}" (expected: verified, crux, tranco, or file).`,
    );
  }

  // Public Suffix List lets us dedupe origins to their registrable domain
  // (eTLD+1) so pt.xhamster.com and xhamster.com collapse to one entry.
  const psl = await loadPublicSuffixList(timeoutMs);

  let listId = null;
  let domains;
  if (source === 'file' || args['domains-file']) {
    if (!args['domains-file']) {
      throw new Error('--source file requires --domains-file PATH.');
    }
    domains = loadDomainsFromFile(args['domains-file'], limit, filterServices, psl);
    console.log(`Loaded ${domains.length} domains from ${args['domains-file']}`);
  } else if (source === 'tranco') {
    console.log(`Fetching top ${limit} domains from Tranco…`);
    const tranco = await fetchTrancoDomains(limit, timeoutMs, { filterServices, psl });
    listId = tranco.listId;
    domains = tranco.domains;
    console.log(`Tranco list ${listId}: ${domains.length} domains`);
  } else if (source === 'crux') {
    console.log('Fetching most-visited sites from CrUX (ordered high→low)…');
    const { tierByDomain } = await loadCrux(timeoutMs, psl);
    // CrUX only ranks in coarse tiers (1000/10K/100K/1M) with random order
    // within a tier, so we use Tranco's fine rank as a within-tier tiebreaker.
    const trancoCount = Math.min(Math.max(limit * 5, 50000), 1000000);
    let trancoRank = new Map();
    try {
      ({ rankByDomain: trancoRank } = await fetchTrancoRankMap(trancoCount, timeoutMs, psl));
    } catch (err) {
      console.warn(
        `Warning: Tranco tiebreaker unavailable (${err.message || err}); ` +
          'order within a CrUX tier stays as-is.',
      );
    }

    const entries = [];
    for (const [domain, tier] of tierByDomain) {
      if (filterServices && isServiceDomain(domain)) continue;
      entries.push({ domain, tier, rank: trancoRank.get(domain) ?? Infinity });
    }
    // Sort by CrUX tier (popularity magnitude) then Tranco rank; Array.sort is
    // stable, so equal-tier/equal-rank domains keep CrUX file order.
    entries.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.rank !== b.rank) return a.rank - b.rank;
      return 0;
    });
    domains = entries.slice(0, limit).map((e) => e.domain);
    listId = 'CrUX-current';
    console.log(
      `CrUX list (${listId}): ${domains.length} domains, ordered by popularity ` +
        `tier then rank${trancoRank.size ? '' : ' (no tiebreaker)'}.`,
    );
  } else {
    // verified: Tranco order, kept only if the site really appears in CrUX.
    console.log(`Fetching most-visited sites (Tranco order, verified via CrUX)…`);
    const { tierByDomain } = await loadCrux(timeoutMs, psl);
    const domainSet = new Set(tierByDomain.keys());
    const tranco = await fetchTrancoDomains(limit, timeoutMs, {
      filterServices,
      cruxSet: domainSet,
      psl,
    });
    listId = `${tranco.listId} (CrUX-verified)`;
    domains = tranco.domains;
    console.log(`Verified list ${listId}: ${domains.length} domains`);
    console.log('Dead sites and service-only domains excluded (not in CrUX).');
  }
  if (filterServices) {
    console.log('Service/infra domains (CDN, DNS, tracking) filtered out.');
  }

  if (dryRun) {
    domains.forEach((domain, i) => console.log(`${i + 1}\t${domain}`));
    return;
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

    return row;
  });

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

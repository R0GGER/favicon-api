#!/usr/bin/env node
/**
 * Preload favicon caches for the world's most visited websites.
 *
 * For each domain this script calls:
 *   1. Standard API  — GET /{domain}  (best-pick, same as the homepage API example)
 *   2. API v1        — GET /api/v1/favicon?url=https://{domain}
 *
 * Domains are fetched from the latest Tranco top-sites ranking by default.
 *
 * Example:
 *   docker compose exec favicon-api node scripts/preload-top-sites.js --base-url http://127.0.0.1:3000
 */

const fs = require('fs');
const https = require('https');

const TRANCO_LATEST_URL = 'https://tranco-list.eu/latest_list';
const USER_AGENT = 'FaviconProxy-preload/1.0';

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
    'Preload favicon caches for popular websites (Tranco top list).',
    '',
    'Usage:',
    '  node scripts/preload-top-sites.js [options]',
    '',
    'Options:',
    '  --base-url URL       FaviconAPI base URL',
    '                       (default: PRELOAD_BASE_URL or http://localhost:3100)',
    '  --limit N            Number of domains to preload (default: 500)',
    '  --concurrency N      Parallel domain workers (default: 4)',
    '  --api-key KEY        API key for /api/v1/favicon',
    '                       (or PRELOAD_API_KEY / API_KEY env var)',
    '  --domains-file PATH  Local domain list (one domain per line) instead of Tranco',
    '  --skip-standard      Skip GET /{domain}',
    '  --skip-v1            Skip GET /api/v1/favicon',
    '  --timeout MS         Per-request timeout in ms (default: 30000)',
    '  --dry-run            Print domains only, do not call the API',
    '',
    'Examples:',
    '  node scripts/preload-top-sites.js',
    '  node scripts/preload-top-sites.js --base-url http://localhost:3100 --limit 100',
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

async function fetchTrancoDomains(limit, timeoutMs) {
  const listId = await resolveTrancoListId(timeoutMs);
  const csvUrl = `https://tranco-list.eu/download/${listId}/${limit}`;
  const res = await httpsRequest(csvUrl, { timeoutMs });
  if (res.status !== 200) {
    throw new Error(`Tranco download failed (${res.status}) for ${csvUrl}`);
  }

  const domains = [];
  for (const line of res.body.toString('utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const comma = trimmed.indexOf(',');
    const domain = (comma >= 0 ? trimmed.slice(comma + 1) : trimmed).trim().toLowerCase();
    if (domain && domain.includes('.')) domains.push(domain);
    if (domains.length >= limit) break;
  }

  if (domains.length === 0) {
    throw new Error('Tranco list was empty.');
  }
  return { listId, domains };
}

function loadDomainsFromFile(filePath, limit) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const domains = [];
  for (const line of raw.split(/\r?\n/)) {
    const domain = line
      .replace(/^\s*\d+\s*,?\s*/, '')
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .trim()
      .toLowerCase();
    if (!domain || !domain.includes('.')) continue;
    domains.push(domain);
    if (domains.length >= limit) break;
  }
  if (domains.length === 0) {
    throw new Error(`No domains found in ${filePath}`);
  }
  return domains;
}

function siteUrl(baseUrl, domain) {
  return `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(domain)}`;
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

  if (skipStandard && skipV1) {
    throw new Error('Nothing to do: both --skip-standard and --skip-v1 are set.');
  }

  let listId = null;
  let domains;
  if (args['domains-file']) {
    domains = loadDomainsFromFile(args['domains-file'], limit);
    console.log(`Loaded ${domains.length} domains from ${args['domains-file']}`);
  } else {
    console.log(`Fetching top ${limit} domains from Tranco…`);
    const tranco = await fetchTrancoDomains(limit, timeoutMs);
    listId = tranco.listId;
    domains = tranco.domains;
    console.log(`Tranco list ${listId}: ${domains.length} domains`);
  }

  if (dryRun) {
    domains.forEach((domain, i) => console.log(`${i + 1}\t${domain}`));
    return;
  }

  const modes = [];
  if (!skipStandard) modes.push('standard (GET /{domain})');
  if (!skipV1) modes.push('API v1 (/api/v1/favicon)');

  console.log(`Base URL: ${baseUrl}`);
  console.log(`Modes: ${modes.join(', ')}`);
  console.log(`Concurrency: ${concurrency}, timeout: ${timeoutMs}ms`);
  if (!skipV1 && apiKey) console.log('API key: provided');
  console.log('');

  const stats = {
    standard: { ok: 0, fail: 0 },
    v1: { ok: 0, fail: 0, cached: 0, fresh: 0 },
    failures: [],
  };

  const started = Date.now();
  let completed = 0;

  await mapPool(domains, concurrency, async (domain) => {
    const row = { domain, standard: null, v1: null };

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
    const tags = [standardTag, v1Tag].filter(Boolean).join(' ');
    console.log(`[${completed}/${domains.length}] ${domain}${tags ? ` — ${tags}` : ''}`);

    if (
      (!skipStandard && !row.standard.ok) ||
      (!skipV1 && !row.v1.ok)
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

  if (stats.failures.length > 0) {
    console.log('');
    console.log(`Failures (${stats.failures.length}):`);
    for (const row of stats.failures.slice(0, 25)) {
      const parts = [];
      if (row.standard && !row.standard.ok) parts.push(`standard: ${row.standard.error || row.standard.status}`);
      if (row.v1 && !row.v1.ok) parts.push(`v1: ${row.v1.error || row.v1.status}`);
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

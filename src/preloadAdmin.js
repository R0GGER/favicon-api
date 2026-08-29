/**
 * Shared logic for managing the preload database (src/preloadStore.js).
 *
 * Both front ends sit on top of this module — the CLI (scripts/manage-preload.js)
 * and the web manager (src/adminRoutes.js) — so a rule such as "icon overrides
 * must be https" or the CSV column order is defined exactly once.
 *
 * The preload-run helpers at the bottom track a `preload-top-sites.js` child
 * process through files next to the database rather than in memory: the service
 * runs as a cluster of workers, so the worker that answers the progress poll is
 * usually not the one that started the run.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const preloadStore = require('./preloadStore');
const preloadSets = require('./preloadSets');
const { isAdultDomain } = require('./adultDomains');
const { extractDomainFromInput } = require('./domainValidation');

// Column order of the CSV export, kept identical to the historical
// "export - preload_domains.csv" so existing sheets keep working.
const CSV_COLUMNS = [
  'id',
  'domain',
  'enabled',
  'source',
  'rank',
  'last_preloaded_at',
  'last_preload_result',
  'last_error',
  'alter_icon_url',
];

// --- validation -------------------------------------------------------------

/**
 * Lowercased hostname, or null when the input cannot be a domain. A pasted URL
 * is reduced to its host. `www.` is deliberately kept: the hit counter stores
 * whatever host was requested, so stripping it here would split one site over
 * two rows that never merge.
 */
function normalizeDomain(raw) {
  let value = String(raw ?? '').trim();
  if (!value) return null;
  if (value.includes('://')) {
    try {
      value = new URL(value).hostname;
    } catch {
      return null;
    }
  }
  value = value.replace(/\/.*$/, '').replace(/:\d+$/, '');
  return extractDomainFromInput(value);
}

/** Blocklist patterns are a hostname or a `*.hostname` wildcard. */
function normalizePattern(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return null;
  if (value.startsWith('*.')) {
    const rest = normalizeDomain(value.slice(2));
    return rest ? `*.${rest}` : null;
  }
  return normalizeDomain(value);
}

/**
 * Validate an icon override URL. Only https is accepted: the override is
 * fetched server-side and cached under the domain's key, so a plaintext or
 * exotic-scheme source would be a downgrade for every consumer of that icon.
 */
function parseIconUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, error: 'Icon URL is empty.' };
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, error: `Invalid icon URL "${text}".` };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: `Icon URL must be https (got "${parsed.protocol}").` };
  }
  return { ok: true, href: parsed.href };
}

const BULK_ACTIONS = new Set(['disable', 'enable', 'delete']);
const BULK_MAX = 500;

/**
 * Enable, disable or delete many domains in one request. Invalid names are
 * reported rather than aborting the batch; blocked hosts cannot be enabled.
 */
function bulkDomains({ action, domains } = {}) {
  const op = String(action || '').trim().toLowerCase();
  if (!BULK_ACTIONS.has(op)) {
    return { ok: false, code: 'invalid_action', error: 'Action must be disable, enable or delete.' };
  }
  if (!Array.isArray(domains) || domains.length === 0) {
    return { ok: false, code: 'empty', error: 'Select at least one domain.' };
  }
  if (domains.length > BULK_MAX) {
    return {
      ok: false,
      code: 'too_many',
      error: `At most ${BULK_MAX} domains at a time.`,
    };
  }

  const unique = [];
  const seen = new Set();
  const invalid = [];
  for (const raw of domains) {
    const host = normalizeDomain(raw);
    if (!host) {
      invalid.push(String(raw ?? ''));
      continue;
    }
    if (seen.has(host)) continue;
    seen.add(host);
    unique.push(host);
  }

  if (!unique.length) {
    return { ok: false, code: 'invalid_domain', error: 'No valid domains in the selection.', invalid };
  }

  if (op === 'delete') {
    return {
      ok: true,
      action: op,
      requested: unique.length,
      changed: preloadStore.removeDomains(unique),
      invalid,
    };
  }

  const enabled = op === 'enable';
  const blocked = [];
  const targets = [];
  for (const host of unique) {
    if (enabled && preloadStore.isBlocked(host)) blocked.push(host);
    else targets.push(host);
  }

  return {
    ok: true,
    action: op,
    requested: unique.length,
    changed: targets.length ? preloadStore.setEnabledMany(targets, enabled) : 0,
    blocked,
    invalid,
  };
}

function parseBoolField(raw) {
  if (raw === undefined || raw === null) return null;
  const val = String(raw).trim().toLowerCase();
  if (val === '') return null;
  if (['1', 'true', 'yes', 'y', 'on'].includes(val)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(val)) return false;
  return null;
}

// --- CSV --------------------------------------------------------------------

/** Parse CSV text into row objects keyed by the (lowercased) header names. */
function parseCsv(text) {
  const rows = [];
  let field = '';
  let record = [];
  let inQuotes = false;

  const pushField = () => {
    record.push(field);
    field = '';
  };
  const pushRecord = () => {
    pushField();
    if (record.length > 1 || record[0] !== '') rows.push(record);
    record = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ',') pushField();
    else if (ch === '\r') continue;
    else if (ch === '\n') pushRecord();
    else field += ch;
  }
  if (field !== '' || record.length > 0) pushRecord();

  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((cells) => {
    const row = {};
    header.forEach((name, idx) => {
      row[name] = cells[idx] === undefined ? '' : cells[idx].trim();
    });
    return row;
  });
}

function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(
      [
        row.id,
        row.domain,
        row.enabled ? 'true' : 'false',
        row.source,
        row.rank,
        row.lastPreloadedAt,
        row.lastPreloadResult,
        row.lastError,
        row.alterIconUrl,
      ]
        .map(csvEscape)
        .join(',')
    );
  }
  return lines.join('\n') + '\n';
}

/**
 * Import CSV text. `domain` is the key; `id` and the `last_*` columns are
 * ignored because the next preload run rewrites them. Blocked domains are
 * reported instead of silently created.
 */
function importCsv(text) {
  const rows = parseCsv(String(text || ''));
  const result = { total: rows.length, imported: 0, skipped: 0, invalid: 0, blocked: [] };
  if (rows.length === 0) return result;

  for (const row of rows) {
    const domain = normalizeDomain(row.domain);
    if (!domain) {
      result.invalid += 1;
      continue;
    }
    if (preloadStore.isBlocked(domain)) {
      result.blocked.push(domain);
      result.skipped += 1;
      continue;
    }

    const rankRaw = String(row.rank || '').trim();
    const rank = rankRaw === '' ? null : parseInt(rankRaw, 10);
    const source = String(row.source || '').trim() || null;
    const iconUrlRaw = String(row.alter_icon_url || '').trim();
    let iconUrl = null;
    if (iconUrlRaw) {
      const parsed = parseIconUrl(iconUrlRaw);
      if (!parsed.ok) {
        result.invalid += 1;
        continue;
      }
      iconUrl = parsed.href;
    }

    preloadStore.upsertManual({
      domain,
      rank: Number.isFinite(rank) ? rank : null,
      source,
      iconUrl,
      enabled: parseBoolField(row.enabled),
    });
    result.imported += 1;
  }

  return result;
}

// --- listing ----------------------------------------------------------------

const STATUS_FILTERS = new Set(['all', 'enabled', 'disabled', 'manual', 'blocked', 'failing', 'overrides']);
const SORT_FIELDS = new Set(['domain', 'rank', 'state', 'source', 'fails', 'last', 'icon']);

function compareNullableText(a, b, descending) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const cmp = String(a).localeCompare(String(b), undefined, { sensitivity: 'base' });
  return descending ? -cmp : cmp;
}

function compareDomainRows(a, b, field, descending) {
  const mul = descending ? -1 : 1;
  switch (field) {
    case 'domain':
      return mul * String(a.domain).localeCompare(String(b.domain), undefined, { sensitivity: 'base' });
    case 'rank': {
      const byRank = mul * ((a.rank || 0) - (b.rank || 0));
      if (byRank !== 0) return byRank;
      const posA = a.sourceRank > 0 ? a.sourceRank : 2147483647;
      const posB = b.sourceRank > 0 ? b.sourceRank : 2147483647;
      return posA - posB;
    }
    case 'state':
      return mul * ((a.enabled ? 1 : 0) - (b.enabled ? 1 : 0));
    case 'source':
      return compareNullableText(a.source, b.source, descending);
    case 'fails':
      return mul * ((a.failCount || 0) - (b.failCount || 0));
    case 'last':
      return compareNullableText(a.lastPreloadedAt, b.lastPreloadedAt, descending);
    case 'icon':
      return compareNullableText(a.alterIconUrl, b.alterIconUrl, descending);
    default:
      return mul * ((a.rank || 0) - (b.rank || 0));
  }
}

/**
 * Filtered, paginated view for the web manager. The whole table is read and
 * narrowed in JS on purpose: the list is a few thousand rows at most, and this
 * keeps every SQL statement in preloadStore.
 */
function listDomains({
  query = '',
  status = 'all',
  sort = 'rank',
  dir = 'desc',
  limit = 50,
  offset = 0,
} = {}) {
  const wanted = STATUS_FILTERS.has(status) ? status : 'all';
  const field = SORT_FIELDS.has(sort) ? sort : 'rank';
  const descending = String(dir || 'desc').toLowerCase() !== 'asc';
  const needle = String(query || '').trim().toLowerCase();

  let rows = preloadStore.listAll({ includeDisabled: true }).map((row) => ({
    ...row,
    enabled: Boolean(row.enabled),
    blocked: preloadStore.isBlocked(row.domain),
  }));
  if (needle) rows = rows.filter((row) => String(row.domain).includes(needle));
  if (wanted === 'enabled') rows = rows.filter((row) => row.enabled);
  else if (wanted === 'disabled') rows = rows.filter((row) => !row.enabled);
  else if (wanted === 'manual') rows = rows.filter((row) => row.enabledSource === 'manual');
  else if (wanted === 'blocked') rows = rows.filter((row) => row.blocked);
  else if (wanted === 'failing') rows = rows.filter((row) => row.failCount > 0);
  else if (wanted === 'overrides') rows = rows.filter((row) => row.alterIconUrl);

  rows.sort((a, b) => {
    const cmp = compareDomainRows(a, b, field, descending);
    if (cmp !== 0) return cmp;
    if (field === 'domain') return 0;
    return String(a.domain).localeCompare(String(b.domain), undefined, { sensitivity: 'base' });
  });

  const total = rows.length;
  const start = Math.max(0, offset);
  const page = rows.slice(start, start + Math.max(1, Math.min(500, limit)));

  return {
    total,
    offset: start,
    limit,
    sort: field,
    dir: descending ? 'desc' : 'asc',
    rows: page,
  };
}

// --- preload run ------------------------------------------------------------

const RUN_DIR = path.dirname(preloadStore.DB_PATH);
const RUN_LOCK = path.join(RUN_DIR, 'preload-run.lock');
const RUN_STATUS = path.join(RUN_DIR, 'preload-run.json');
const RUN_LOG = path.join(RUN_DIR, 'preload-run.log');
const RUN_SCRIPT = path.join(__dirname, '..', 'scripts', 'preload-top-sites.js');
const LOG_TAIL_BYTES = 64 * 1024;

function processAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonFile(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
  } catch (err) {
    console.error('Preload run status write failed:', err && err.message ? err.message : err);
  }
}

function releaseLock() {
  try {
    fs.unlinkSync(RUN_LOCK);
  } catch {
    /* already gone */
  }
}

/**
 * Take the cross-worker lock. `wx` makes the create atomic, so two workers
 * handling a double-clicked button cannot both start a run. A lock whose owner
 * no longer exists (worker killed mid-run) is reclaimed once.
 */
function acquireLock(meta, retry = true) {
  try {
    fs.mkdirSync(RUN_DIR, { recursive: true });
    const fd = fs.openSync(RUN_LOCK, 'wx');
    fs.writeFileSync(fd, JSON.stringify(meta));
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const existing = readJsonFile(RUN_LOCK);
    if (existing && processAlive(existing.pid)) return false;
    if (!retry) return false;
    releaseLock();
    return acquireLock(meta, false);
  }
}

/** Last chunk of the run log, so a long run does not ship megabytes per poll. */
function tailLog(maxBytes = LOG_TAIL_BYTES) {
  let fd = null;
  try {
    const size = fs.statSync(RUN_LOG).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return '';
    const buf = Buffer.alloc(length);
    fd = fs.openSync(RUN_LOG, 'r');
    fs.readSync(fd, buf, 0, length, start);
    const text = buf.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Current run state for any worker. A status still marked `running` whose
 * process is gone is reported as `interrupted` and the stale lock is cleared.
 */
function readRunStatus({ withLog = false } = {}) {
  const status = readJsonFile(RUN_STATUS) || { state: 'idle' };
  if (status.state === 'running' && !processAlive(status.pid)) {
    status.state = 'interrupted';
    status.finishedAt = status.finishedAt || new Date().toISOString();
    writeJsonFile(RUN_STATUS, status);
    releaseLock();
  }
  const lock = readJsonFile(RUN_LOCK);
  status.running = status.state === 'running' && processAlive(status.pid);
  if (!status.running && lock && !processAlive(lock.pid)) releaseLock();
  if (withLog) status.log = tailLog();
  return status;
}

function clampInt(raw, fallback, min, max) {
  const val = parseInt(raw, 10);
  if (!Number.isFinite(val)) return fallback;
  return Math.min(max, Math.max(min, val));
}

const RUN_SOURCES = new Set(['dataforseo', 'similarweb', 'backlinko', 'db']);
const RUN_SOURCE_ALIASES = { visited: 'similarweb', popular: 'backlinko', pagerank: 'dataforseo' };

function resolveRunSource(raw) {
  const value = String(raw || 'db').toLowerCase();
  const source = RUN_SOURCE_ALIASES[value] || value;
  return RUN_SOURCES.has(source) ? source : 'db';
}

const SOURCE_META = {
  backlinko: {
    title: 'Most popular — Backlinko / Semrush',
    url: preloadSets.BACKLINKO_URL,
  },
  similarweb: {
    title: 'Most visited — SimilarWeb',
    url: preloadSets.SIMILARWEB_URL,
  },
  dataforseo: {
    title: 'Highest keyword rank — DataForSEO',
    url: 'https://dataforseo.com/free-seo-stats/top-1000-websites',
  },
  db: {
    title: 'Preload database',
    url: null,
  },
};

function annotateDomains(domains) {
  return domains.map((domain, i) => ({
    rank: i + 1,
    domain,
    adult: isAdultDomain(domain) || preloadSets.SIMILARWEB_ADULT.has(domain),
  }));
}

/**
 * Ranked domain list for the selected source, without warming caches.
 * Used by the /admin Preload run preview so the operator can see the set.
 */
async function previewDomains(options = {}) {
  const source = resolveRunSource(options.source);
  const limit = clampInt(options.limit, 100, 1, 1000);
  const excludeAdult =
    Boolean(options.excludeAdult) || String(options.adult || '').toLowerCase() === 'exclude';
  const timeoutMs = clampInt(options.timeout, 30000, 5000, 120000);
  const meta = SOURCE_META[source] || SOURCE_META.db;

  let result;
  if (source === 'similarweb') {
    result = await preloadSets.fetchSimilarwebDomains(limit, { excludeAdult, timeoutMs });
  } else if (source === 'backlinko') {
    result = await preloadSets.fetchBacklinkoDomains(limit, { excludeAdult, timeoutMs });
  } else if (source === 'dataforseo') {
    result = await preloadSets.fetchDataforseoDomains(limit, { excludeAdult, timeoutMs });
  } else {
    const minRank = clampInt(options.minRank, preloadStore.MIN_RANK, 0, 1e9);
    const fetchLimit = excludeAdult ? Math.max(limit * 3, limit) : limit;
    const rows = preloadStore.listForPreload({ limit: fetchLimit, minRank });
    const domains = [];
    for (const row of rows) {
      if (excludeAdult && isAdultDomain(row.domain)) continue;
      domains.push(row.domain);
      if (domains.length >= limit) break;
    }
    result = { domains, live: true, filled: 0, available: rows.length };
  }

  return {
    source,
    title: meta.title,
    url: meta.url,
    live: result.live !== false,
    filled: result.filled || 0,
    available: result.available || result.domains.length,
    excludeAdult,
    limit,
    count: result.domains.length,
    domains: annotateDomains(result.domains),
  };
}

/** Build the argv for preload-top-sites.js from validated UI input. */
function buildRunArgs(options = {}, baseUrl) {
  const source = resolveRunSource(options.source);
  const args = [RUN_SCRIPT, '--source', source, '--base-url', baseUrl];
  args.push('--limit', String(clampInt(options.limit, 100, 1, 1000)));
  args.push('--concurrency', String(clampInt(options.concurrency, 4, 1, 32)));
  args.push('--timeout', String(clampInt(options.timeout, 30000, 1000, 300000)));
  if (source === 'db') args.push('--min-rank', String(clampInt(options.minRank, preloadStore.MIN_RANK, 0, 1e9)));
  const adult = String(options.adult || '').toLowerCase();
  if (options.excludeAdult || adult === 'exclude') args.push('--adult', 'exclude');
  else args.push('--adult', 'include');
  if (options.dryRun) args.push('--dry-run');
  if (options.skipStandard) args.push('--skip-standard');
  if (options.skipV1) args.push('--skip-v1');
  if (options.skipSizes) args.push('--skip-sizes');
  return args;
}

/**
 * Start a preload run in a child process, logging to RUN_LOG. Returns
 * `{ ok: false, error: 'already_running' }` when one is already in flight.
 */
function startRun(options = {}, { baseUrl, env = {} } = {}) {
  const current = readRunStatus();
  if (current.running) return { ok: false, error: 'already_running', status: current };

  const startedAt = new Date().toISOString();
  const args = buildRunArgs(options, baseUrl);
  if (!acquireLock({ pid: process.pid, startedAt })) {
    return { ok: false, error: 'already_running', status: readRunStatus() };
  }

  let logFd;
  try {
    fs.mkdirSync(RUN_DIR, { recursive: true });
    logFd = fs.openSync(RUN_LOG, 'w');
    fs.writeSync(logFd, `# preload run started ${startedAt}\n# args: ${args.slice(1).join(' ')}\n`);
  } catch (err) {
    releaseLock();
    return { ok: false, error: `Could not open the run log: ${err.message}` };
  }

  let child;
  try {
    child = spawn(process.execPath, args, {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, ...env },
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });
  } catch (err) {
    fs.closeSync(logFd);
    releaseLock();
    return { ok: false, error: `Could not start the preload script: ${err.message}` };
  }

  const status = {
    state: 'running',
    pid: child.pid,
    startedAt,
    finishedAt: null,
    exitCode: null,
    args: args.slice(1),
    startedBy: options.startedBy || 'admin',
  };
  writeJsonFile(RUN_STATUS, status);

  const finish = (exitCode, signal) => {
    try {
      fs.closeSync(logFd);
    } catch {
      /* already closed */
    }
    writeJsonFile(RUN_STATUS, {
      ...status,
      state: exitCode === 0 ? 'finished' : 'failed',
      finishedAt: new Date().toISOString(),
      exitCode,
      signal: signal || null,
    });
    releaseLock();
  };

  child.on('exit', finish);
  child.on('error', (err) => {
    try {
      fs.writeFileSync(RUN_LOG, `\nspawn error: ${err.message}\n`, { flag: 'a' });
    } catch {
      /* ignore */
    }
    finish(1, null);
  });
  // The run must not keep a worker alive on shutdown; the status file is the
  // source of truth, so a restart still reports the outcome correctly.
  child.unref();

  return { ok: true, status };
}

function stopRun() {
  const status = readRunStatus();
  if (!status.running) return { ok: false, error: 'not_running' };
  try {
    process.kill(status.pid, 'SIGTERM');
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ok: true };
}

module.exports = {
  CSV_COLUMNS,
  RUN_LOG,
  RUN_STATUS,
  normalizeDomain,
  normalizePattern,
  parseIconUrl,
  parseBoolField,
  bulkDomains,
  parseCsv,
  toCsv,
  importCsv,
  listDomains,
  readRunStatus,
  startRun,
  stopRun,
  previewDomains,
  tailLog,
};

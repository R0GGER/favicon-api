/**
 * Preload domain store.
 *
 * Tracks which domains are worth warming the favicon caches for, how often the
 * API is asked for them, and which ones you never want preloaded. The preload
 * CLI (scripts/manage-preload.js) and the preload script read/write this file;
 * the running service only appends hit counters and reads icon overrides.
 *
 * `rank` is rolling hit count for every source, so three real requests beat
 * "position 1 of a top-100 list". List order is stored separately as
 * `source_rank` (1 = first) and is only a tiebreaker. A rank you set by hand
 * is pinned with `rank_source = 'manual'` and Recalculate leaves it alone.
 * `enabled_source = 'manual'` rows keep their `enabled` value no matter what
 * any automated pass does.
 *
 * The database lives in a subdirectory of the cache volume on purpose. Loose
 * files directly under CACHE_DIR are indexed by the disk-cache scanner in
 * src/cache.js and can be evicted once CACHE_SIZE_MB is exceeded; directories
 * are skipped, so /cache/db/ is safe.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.PRELOAD_DB || '/cache/db/preload.sqlite';

function parseBool(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const val = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(val)) return true;
  if (['0', 'false', 'no', 'off'].includes(val)) return false;
  return fallback;
}

function parseInteger(raw, fallback, min = 0) {
  const val = parseInt(raw, 10);
  return Number.isFinite(val) && val >= min ? val : fallback;
}

const TRACK_HITS = parseBool(process.env.PRELOAD_TRACK_HITS, true);
const HIT_FLUSH_MS = parseInteger(process.env.PRELOAD_HIT_FLUSH_MS, 15000);
const MIN_RANK = parseInteger(process.env.PRELOAD_MIN_RANK, 3);
const AUTO_DISABLE_AFTER = parseInteger(process.env.PRELOAD_AUTO_DISABLE_AFTER, 5, 1);
const RANK_MONTHS = parseInteger(process.env.PRELOAD_RANK_MONTHS, 3, 1);
// How often a reader may re-stat the database file before trusting its cached
// copy of the blocklist / override table. Keeps CLI edits visible to long-lived
// workers without putting a query in the request path.
const RELOAD_THROTTLE_MS = parseInteger(process.env.PRELOAD_OVERRIDE_RELOAD_MS, 30000);

const SCHEMA_VERSION = 2;
const LIST_SOURCES = ['backlinko', 'similarweb', 'dataforseo', 'file'];
const LIST_SOURCES_SQL = LIST_SOURCES.map((s) => `'${s}'`).join(', ');
// Usage first; 1-based list position next (0 = not from a list, sorts last).
const PRELOAD_SORT_SQL =
  `"rank" DESC, CASE WHEN source_rank > 0 THEN source_rank ELSE 2147483647 END ASC, domain ASC`;
const DOMAIN_LIST_COLUMNS = `id, domain, enabled, enabled_source AS enabledSource, source,
       "rank" AS rank, source_rank AS sourceRank, rank_source AS rankSource,
       last_preloaded_at AS lastPreloadedAt, last_preload_result AS lastPreloadResult,
       last_error AS lastError, fail_count AS failCount, alter_icon_url AS alterIconUrl`;

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS preload_domains (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    domain              TEXT    NOT NULL COLLATE NOCASE UNIQUE,
    enabled             INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    enabled_source      TEXT    NOT NULL DEFAULT 'auto'
                                CHECK (enabled_source IN ('auto', 'manual')),
    source              TEXT    NOT NULL DEFAULT 'manual',
    "rank"              INTEGER NOT NULL DEFAULT 0,
    source_rank         INTEGER NOT NULL DEFAULT 0,
    rank_source         TEXT    NOT NULL DEFAULT 'auto'
                                CHECK (rank_source IN ('auto', 'manual')),
    last_preloaded_at   TEXT,
    last_preload_result TEXT,
    last_error          TEXT,
    fail_count          INTEGER NOT NULL DEFAULT 0,
    alter_icon_url      TEXT,
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS idx_preload_pick ON preload_domains(enabled, "rank" DESC);
  CREATE INDEX IF NOT EXISTS idx_preload_override
    ON preload_domains(domain) WHERE alter_icon_url IS NOT NULL;

  CREATE TABLE IF NOT EXISTS preload_hits_monthly (
    domain_id INTEGER NOT NULL REFERENCES preload_domains(id) ON DELETE CASCADE,
    period    TEXT    NOT NULL,
    count     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (domain_id, period)
  );

  CREATE TABLE IF NOT EXISTS preload_blocklist (
    pattern    TEXT PRIMARY KEY COLLATE NOCASE,
    reason     TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
`;

let dbInstance = null;
let dbBroken = false;

function ensureDirFor(filePath) {
  const dir = path.dirname(filePath);
  if (dir && dir !== '.' && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function migrate(d) {
  const from = d.pragma('user_version', { simple: true });
  if (from < 1) d.exec(SCHEMA_V1);
  if (from === 1) migrateV2FromV1(d);
  if (from < SCHEMA_VERSION) d.pragma(`user_version = ${SCHEMA_VERSION}`);
}

/**
 * v1 stored list order in `rank` (first of 100 = 100), so three real hits
 * could never outrank an imported top site. Move that score to `source_rank`
 * as a 1-based position and refill `rank` from the hit buckets.
 */
function migrateV2FromV1(d) {
  d.exec(`
    ALTER TABLE preload_domains ADD COLUMN source_rank INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE preload_domains ADD COLUMN rank_source TEXT NOT NULL DEFAULT 'auto';
  `);
  d.prepare(`UPDATE preload_domains SET rank_source = 'manual' WHERE source = 'manual'`).run();
  convertListRanksToSourceRank(d);
  applyHitRanks(d, { touchUpdatedAt: false });
}

function convertListRanksToSourceRank(d) {
  const rows = d
    .prepare(
      `SELECT source, MAX("rank") AS maxRank FROM preload_domains
       WHERE source IN (${LIST_SOURCES_SQL})
       GROUP BY source`
    )
    .all();
  const update = d.prepare(
    `UPDATE preload_domains
     SET source_rank = CASE WHEN :maxRank > 0 AND "rank" > 0 THEN :maxRank - "rank" + 1 ELSE 0 END,
         "rank" = 0
     WHERE source = :source AND rank_source = 'auto'`
  );
  for (const row of rows) {
    update.run({ maxRank: row.maxRank || 0, source: row.source });
  }
}

/**
 * Open (once) and return the database, or null when it cannot be used. Callers
 * must treat null as "feature unavailable" — a broken store may never break a
 * favicon request.
 */
function db() {
  if (dbInstance) return dbInstance;
  if (dbBroken) return null;
  try {
    ensureDirFor(DB_PATH);
    const d = new Database(DB_PATH);
    d.pragma('journal_mode = WAL');
    d.pragma('synchronous = NORMAL');
    d.pragma('foreign_keys = ON');
    d.pragma('busy_timeout = 5000');
    migrate(d);
    dbInstance = d;
    return d;
  } catch (err) {
    console.error('Preload store unavailable:', err && err.message ? err.message : err);
    dbBroken = true;
    return null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function currentPeriod(date = new Date()) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${yyyy}-${mm}`;
}

/** First period of an N-month rolling window ending with the current month. */
function periodMonthsAgo(months) {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - (Math.max(1, months) - 1));
  return currentPeriod(d);
}

function normalizeDomain(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const domain = raw.trim().toLowerCase();
  return domain || null;
}

/**
 * Newest mtime of the database, used to detect writes made by another process.
 * In WAL mode a commit lands in the `-wal` sidecar and leaves the main file
 * untouched until a checkpoint, so both have to be considered.
 */
function dbMtimeMs(filePath = DB_PATH) {
  let newest = null;
  for (const candidate of [filePath, `${filePath}-wal`]) {
    try {
      const { mtimeMs: stamp } = fs.statSync(candidate);
      if (newest === null || stamp > newest) newest = stamp;
    } catch {
      /* missing file: nothing to compare */
    }
  }
  return newest;
}

/**
 * Small read-through cache for tables the request path consults. Re-reads only
 * when the database file's mtime changed, and at most once per throttle window.
 */
function makeReloader(load, fallback) {
  let value = null;
  let loadedMtime = -1;
  let lastCheck = 0;
  const read = () => {
    const now = Date.now();
    if (value !== null && now - lastCheck < RELOAD_THROTTLE_MS) return value;
    lastCheck = now;
    const stamp = dbMtimeMs();
    if (value !== null && stamp === loadedMtime) return value;
    try {
      value = load();
      loadedMtime = stamp;
    } catch {
      if (value === null) value = fallback;
    }
    return value;
  };
  // Writers in this process drop the cache instead of waiting out the throttle,
  // so a block takes effect immediately for whoever just made it. Other workers
  // still pick it up on their next reload window.
  read.invalidate = () => {
    value = null;
    loadedMtime = -1;
    lastCheck = 0;
  };
  return read;
}

const blocklistPatterns = makeReloader(() => {
  const d = db();
  if (!d) return [];
  return d
    .prepare('SELECT pattern FROM preload_blocklist')
    .all()
    .map((row) => String(row.pattern || '').trim().toLowerCase())
    .filter(Boolean);
}, []);

/**
 * True when `domain` matches a blocklist entry. Patterns are either an exact
 * host (`example.com`) or a wildcard (`*.example.com`) that also covers the
 * bare parent domain.
 */
function isBlocked(domain) {
  const host = normalizeDomain(domain);
  if (!host) return false;
  return blocklistPatterns().some((pattern) => matchesPattern(host, pattern));
}

function listBlocks() {
  const d = db();
  if (!d) return [];
  return d
    .prepare('SELECT pattern, reason, created_at AS createdAt FROM preload_blocklist ORDER BY pattern ASC')
    .all();
}

/** True when `host` matches this single blocklist pattern. */
function matchesPattern(host, pattern) {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === pattern;
}

/**
 * Block a pattern and switch off any domain already in the list that matches
 * it. Blocking is otherwise only preventive (the hit counter and CSV import
 * consult it), which would leave an already-listed domain quietly preloading.
 *
 * Returns `{ added, disabled }`.
 */
function addBlock(pattern, reason = null) {
  const d = db();
  if (!d) return { added: 0, disabled: 0 };
  const value = normalizeDomain(pattern);
  if (!value) return { added: 0, disabled: 0 };

  const added = d
    .prepare(
      `INSERT INTO preload_blocklist (pattern, reason) VALUES (?, ?)
       ON CONFLICT(pattern) DO UPDATE SET reason = excluded.reason`
    )
    .run(value, reason || null).changes;

  // Marked manual so no automated pass can flip it back on while the block
  // stands. Unblocking does not re-enable: that stays a deliberate `enable`.
  const disable = d.prepare(
    `UPDATE preload_domains SET
       enabled        = 0,
       enabled_source = 'manual',
       updated_at     = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE domain = ? AND enabled = 1`
  );
  const run = d.transaction((hosts) => {
    let changed = 0;
    for (const host of hosts) changed += disable.run(host).changes;
    return changed;
  });

  const matches = d
    .prepare('SELECT domain FROM preload_domains WHERE enabled = 1')
    .all()
    .map((row) => String(row.domain || '').toLowerCase())
    .filter((host) => matchesPattern(host, value));

  const disabled = matches.length ? run(matches) : 0;
  blocklistPatterns.invalidate();
  return { added, disabled };
}

function removeBlock(pattern) {
  const d = db();
  if (!d) return 0;
  const value = normalizeDomain(pattern);
  if (!value) return 0;
  const changed = d.prepare('DELETE FROM preload_blocklist WHERE pattern = ?').run(value).changes;
  blocklistPatterns.invalidate();
  return changed;
}

/**
 * Domains the preload script should warm, best first. Usage rank wins over
 * list position, so three real hits beat "first of a top-100 list". Traffic
 * below `minRank` is skipped; list-imported rows (`source_rank > 0`) stay in
 * as filler. Blocked domains are filtered out as a safety net: `block` already
 * disables the ones it finds, so this only catches a domain that was
 * re-enabled by hand afterwards.
 */
function listForPreload({ limit = 500, minRank = MIN_RANK } = {}) {
  const d = db();
  if (!d) return [];
  return d
    .prepare(
      `SELECT id, domain, alter_icon_url AS alterIconUrl
       FROM preload_domains
       WHERE enabled = 1 AND ("rank" >= ? OR source_rank > 0)
       ORDER BY ${PRELOAD_SORT_SQL}
       LIMIT ?`
    )
    .all(minRank, limit)
    .filter((row) => !isBlocked(row.domain));
}

function listAll({ includeDisabled = false, failingOnly = false, disabledOnly = false, limit = 0 } = {}) {
  const d = db();
  if (!d) return [];
  const where = [];
  if (disabledOnly) where.push('enabled = 0');
  else if (!includeDisabled) where.push('enabled = 1');
  if (failingOnly) where.push('fail_count > 0');
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limitClause = limit > 0 ? 'LIMIT ?' : '';
  const stmt = d.prepare(
    `SELECT ${DOMAIN_LIST_COLUMNS}
     FROM preload_domains
     ${clause}
     ORDER BY ${PRELOAD_SORT_SQL}
     ${limitClause}`
  );
  return limit > 0 ? stmt.all(limit) : stmt.all();
}

function getDomain(domain) {
  const d = db();
  if (!d) return null;
  const host = normalizeDomain(domain);
  if (!host) return null;
  return (
    d
      .prepare(
        `SELECT ${DOMAIN_LIST_COLUMNS}
         FROM preload_domains WHERE domain = ?`
      )
      .get(host) || null
  );
}

/** Rows carrying a manual icon override, for src/iconOverride.js. */
function listOverrides() {
  const d = db();
  if (!d) return [];
  return d
    .prepare(
      `SELECT domain, alter_icon_url AS alterIconUrl
       FROM preload_domains WHERE alter_icon_url IS NOT NULL AND alter_icon_url <> ''`
    )
    .all();
}

/**
 * Upsert from an automated source. Never flips a row you switched off by hand:
 * `enabled` is only reset for rows still owned by the automation. Blocked hosts
 * are skipped so a ranking list cannot recreate something you blocked.
 * Returns the row id, or 0 when nothing was written.
 */
function upsertFromSource({ domain, source = 'traffic', sourceRank = 0 }) {
  const d = db();
  if (!d) return 0;
  const host = normalizeDomain(domain);
  if (!host || isBlocked(host)) return 0;
  const label = String(source || 'traffic').trim().slice(0, 32) || 'traffic';
  const position = Number.isFinite(sourceRank) && sourceRank > 0 ? Math.floor(sourceRank) : 0;
  const row = d
    .prepare(
      `INSERT INTO preload_domains (domain, source, source_rank, "rank")
       VALUES (?, ?, ?, 0)
       ON CONFLICT(domain) DO UPDATE SET
         source      = excluded.source,
         source_rank = excluded.source_rank,
         enabled     = CASE WHEN enabled_source = 'manual' THEN enabled ELSE 1 END,
         updated_at  = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       RETURNING id`
    )
    .get(host, label, position);
  return row && row.id ? row.id : 0;
}

/**
 * Persist a ranked domain list under a named source (`backlinko`, `similarweb`,
 * `dataforseo`, `file`, …). List order goes to `source_rank` (1 = first) and
 * never overwrites usage `rank`, so three real hits still beat position 1 of
 * a top-100 list. Returns `{ domain, id }[]` for writeback.
 */
function recordSourceList(domains, source) {
  if (!Array.isArray(domains) || domains.length === 0) return [];
  const d = db();
  if (!d) return [];
  const run = d.transaction((list) => {
    const out = [];
    for (let i = 0; i < list.length; i += 1) {
      const domain = normalizeDomain(list[i]);
      if (!domain) continue;
      const id = upsertFromSource({ domain, source, sourceRank: i + 1 });
      if (id) out.push({ domain, id });
    }
    return out;
  });
  try {
    return run(domains);
  } catch (err) {
    console.error('Preload source list write failed:', err && err.message ? err.message : err);
    return [];
  }
}

/**
 * Add or update a row you are managing by hand (CLI, CSV import). Only the
 * fields you pass are touched; omitted fields keep their stored value. An
 * explicit `enabled` marks the row as manually owned so no automated pass can
 * flip it back.
 */
function upsertManual({
  domain,
  rank = null,
  source = null,
  iconUrl = null,
  enabled = null,
  lockRank = false,
} = {}) {
  const d = db();
  if (!d) return 0;
  const host = normalizeDomain(domain);
  if (!host) return 0;

  const existing = getDomain(host);
  if (!existing) {
    return d
      .prepare(
        `INSERT INTO preload_domains (domain, source, "rank", rank_source, alter_icon_url, enabled, enabled_source)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        host,
        source || 'manual',
        rank === null ? 0 : rank,
        rank !== null && lockRank ? 'manual' : 'auto',
        iconUrl,
        enabled === null ? 1 : enabled ? 1 : 0,
        enabled === null ? 'auto' : 'manual'
      ).changes;
  }

  const sets = ["updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"];
  const params = { domain: host };
  if (source !== null) {
    sets.push('source = :source');
    params.source = source;
  }
  if (rank !== null) {
    sets.push('"rank" = :rank');
    params.rank = rank;
    if (lockRank) sets.push("rank_source = 'manual'");
  }
  if (iconUrl !== null) {
    sets.push('alter_icon_url = :iconUrl');
    params.iconUrl = iconUrl || null;
  }
  if (enabled !== null) {
    sets.push('enabled = :enabled', "enabled_source = 'manual'");
    params.enabled = enabled ? 1 : 0;
  }
  if (sets.length === 1) return 0;

  return d
    .prepare(`UPDATE preload_domains SET ${sets.join(', ')} WHERE domain = :domain`)
    .run(params).changes;
}

function setEnabled(domain, enabled, { manual = true } = {}) {
  const d = db();
  if (!d) return 0;
  const host = normalizeDomain(domain);
  if (!host) return 0;
  return d
    .prepare(
      `UPDATE preload_domains SET
         enabled        = :enabled,
         enabled_source = :enabledSource,
         updated_at     = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE domain = :domain`
    )
    .run({
      domain: host,
      enabled: enabled ? 1 : 0,
      enabledSource: manual ? 'manual' : 'auto',
    }).changes;
}

function setIconUrl(domain, url) {
  const d = db();
  if (!d) return 0;
  const host = normalizeDomain(domain);
  if (!host) return 0;
  return d
    .prepare(
      `UPDATE preload_domains SET
         alter_icon_url = :url,
         updated_at     = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE domain = :domain`
    )
    .run({ domain: host, url: url || null }).changes;
}

function setRank(domain, rank) {
  const d = db();
  if (!d) return 0;
  const host = normalizeDomain(domain);
  if (!host) return 0;
  return d
    .prepare(
      `UPDATE preload_domains SET
         "rank"       = :rank,
         rank_source  = 'manual',
         updated_at   = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE domain = :domain`
    )
    .run({ domain: host, rank }).changes;
}

function removeDomain(domain) {
  const d = db();
  if (!d) return 0;
  const host = normalizeDomain(domain);
  if (!host) return 0;
  // Cascade removes preload_hits_monthly rows (foreign key ON DELETE CASCADE).
  return d.prepare('DELETE FROM preload_domains WHERE domain = ?').run(host).changes;
}

function setEnabledMany(domains, enabled, { manual = true } = {}) {
  const d = db();
  if (!d || !Array.isArray(domains) || domains.length === 0) return 0;
  const stmt = d.prepare(
    `UPDATE preload_domains SET
       enabled        = :enabled,
       enabled_source = :enabledSource,
       updated_at     = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE domain = :domain`
  );
  const run = d.transaction((hosts) => {
    let changed = 0;
    for (const domain of hosts) {
      const host = normalizeDomain(domain);
      if (!host) continue;
      changed += stmt.run({
        domain: host,
        enabled: enabled ? 1 : 0,
        enabledSource: manual ? 'manual' : 'auto',
      }).changes;
    }
    return changed;
  });
  return run(domains);
}

function removeDomains(domains) {
  const d = db();
  if (!d || !Array.isArray(domains) || domains.length === 0) return 0;
  const stmt = d.prepare('DELETE FROM preload_domains WHERE domain = ?');
  const run = d.transaction((hosts) => {
    let changed = 0;
    for (const domain of hosts) {
      const host = normalizeDomain(domain);
      if (!host) continue;
      changed += stmt.run(host).changes;
    }
    return changed;
  });
  return run(domains);
}

/**
 * Persist the outcome of a preload run. The auto-disable decision lives inside
 * the UPDATE so the script never has to read-modify-write a counter the running
 * service may be touching at the same time.
 */
function recordPreloadResults(rows) {
  const d = db();
  if (!d || !Array.isArray(rows) || rows.length === 0) return 0;
  const stmt = d.prepare(
    `UPDATE preload_domains SET
       last_preloaded_at   = :at,
       last_preload_result = :result,
       last_error          = :error,
       fail_count          = CASE WHEN :ok = 1 THEN 0 ELSE fail_count + 1 END,
       enabled             = CASE
                               WHEN :ok = 0 AND enabled_source = 'auto'
                                    AND fail_count + 1 >= :autoDisable THEN 0
                               ELSE enabled
                             END,
       updated_at          = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = :id`
  );
  const at = nowIso();
  const run = d.transaction((batch) => {
    let changed = 0;
    for (const row of batch) {
      if (!row || !row.id) continue;
      changed += stmt.run({
        id: row.id,
        at,
        result: row.result || null,
        error: row.error || null,
        ok: row.ok ? 1 : 0,
        autoDisable: AUTO_DISABLE_AFTER,
      }).changes;
    }
    return changed;
  });
  try {
    return run(rows);
  } catch (err) {
    console.error('Preload result writeback failed:', err && err.message ? err.message : err);
    return 0;
  }
}

// --- hit counting -----------------------------------------------------------
// Buffered per worker: every cluster worker keeps its own Map and flushes it
// into the shared file on a timer. The flush adds to the stored count instead
// of replacing it, otherwise concurrent workers would overwrite each other.

const pending = new Map();
let flushTimer = null;

function recordHit(domain) {
  if (!TRACK_HITS) return;
  const host = normalizeDomain(domain);
  if (!host) return;
  pending.set(host, (pending.get(host) || 0) + 1);
  if (!flushTimer) {
    flushTimer = setTimeout(flushHits, HIT_FLUSH_MS);
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
  }
}

function flushHits() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pending.size === 0) return 0;

  // Swap the buffer out first so hits arriving during the write are not lost.
  const batch = [...pending.entries()];
  pending.clear();

  const d = db();
  if (!d) return 0;

  const ensureRow = d.prepare(
    `INSERT INTO preload_domains (domain, source, "rank") VALUES (?, 'traffic', 0)
     ON CONFLICT(domain) DO NOTHING`
  );
  const bump = d.prepare(
    `INSERT INTO preload_hits_monthly (domain_id, period, count)
     VALUES ((SELECT id FROM preload_domains WHERE domain = ?), ?, ?)
     ON CONFLICT(domain_id, period) DO UPDATE SET count = count + excluded.count`
  );
  const period = currentPeriod();

  const run = d.transaction((entries) => {
    let written = 0;
    for (const [domain, count] of entries) {
      if (isBlocked(domain)) continue;
      ensureRow.run(domain);
      bump.run(domain, period, count);
      written += 1;
    }
    return written;
  });

  try {
    return run(batch);
  } catch (err) {
    console.error('Preload hit flush failed:', err && err.message ? err.message : err);
    return 0;
  }
}

/**
 * Recompute `rank` from the monthly hit buckets over a rolling window, so a
 * domain that was popular years ago sinks back down. Every auto rank is
 * rewritten from hits — list-imported rows included — so usage and list
 * position are never mixed. A rank pinned by hand (`rank_source = 'manual'`)
 * stays put.
 */
function applyHitRanks(d, { months = RANK_MONTHS, touchUpdatedAt = true } = {}) {
  const since = periodMonthsAgo(months);
  const stamp = touchUpdatedAt
    ? `, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
    : '';
  return d
    .prepare(
      `UPDATE preload_domains SET
         "rank" = COALESCE((
           SELECT SUM(count) FROM preload_hits_monthly h
           WHERE h.domain_id = preload_domains.id AND h.period >= :since
         ), 0)${stamp}
       WHERE rank_source = 'auto'`
    )
    .run({ since }).changes;
}

function recalcRanks({ months = RANK_MONTHS } = {}) {
  const d = db();
  if (!d) return 0;
  return applyHitRanks(d, { months, touchUpdatedAt: true });
}

/**
 * Hit totals per month, newest first, for the admin stats panel. Reports the
 * raw buckets rather than the derived `rank` so a run of `recalc` can be judged
 * against the traffic it was computed from.
 */
function hitsByPeriod({ months = 6 } = {}) {
  const d = db();
  if (!d) return [];
  const since = periodMonthsAgo(months);
  return d
    .prepare(
      `SELECT period, SUM(count) AS hits, COUNT(DISTINCT domain_id) AS domains
       FROM preload_hits_monthly
       WHERE period >= ?
       GROUP BY period
       ORDER BY period DESC`
    )
    .all(since);
}

function stats() {
  const d = db();
  if (!d) return { total: 0, enabled: 0, overrides: 0, blocked: 0 };
  const row = d
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled,
              SUM(CASE WHEN alter_icon_url IS NOT NULL AND alter_icon_url <> '' THEN 1 ELSE 0 END) AS overrides
       FROM preload_domains`
    )
    .get();
  const blocked = d.prepare('SELECT COUNT(*) AS n FROM preload_blocklist').get();
  return {
    total: row.total || 0,
    enabled: row.enabled || 0,
    overrides: row.overrides || 0,
    blocked: blocked.n || 0,
  };
}

module.exports = {
  DB_PATH,
  TRACK_HITS,
  MIN_RANK,
  RANK_MONTHS,
  AUTO_DISABLE_AFTER,
  RELOAD_THROTTLE_MS,
  dbMtimeMs,
  currentPeriod,
  isBlocked,
  listBlocks,
  addBlock,
  removeBlock,
  listForPreload,
  listAll,
  getDomain,
  listOverrides,
  upsertFromSource,
  recordSourceList,
  upsertManual,
  setEnabled,
  setEnabledMany,
  setIconUrl,
  setRank,
  removeDomain,
  removeDomains,
  recordPreloadResults,
  recordHit,
  flushHits,
  recalcRanks,
  hitsByPeriod,
  stats,
};

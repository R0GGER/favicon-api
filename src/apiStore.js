const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.API_KEYS_DB || '/cache/api-keys.sqlite';

const PLAN_LIMITS = {
  free: parseInt(process.env.PLAN_FREE_LIMIT || '25', 10),
  pro: parseInt(process.env.PLAN_PRO_LIMIT || '2500', 10),
  enterprise: parseInt(process.env.PLAN_ENTERPRISE_LIMIT || '0', 10),
};

const KEY_PREFIX = 'fa_';
// 24 base32-ish chars = 120 bits of entropy; safe against online guessing.
const KEY_RANDOM_LEN = 24;
// Stored prefix used for display/lookup; long enough to be unique with O(N)
// keys but never reveals the secret (the rest stays in the SHA-256 hash).
const STORED_PREFIX_LEN = KEY_PREFIX.length + 8;

let dbInstance = null;

function ensureDirFor(filePath) {
  const dir = path.dirname(filePath);
  if (dir && dir !== '.' && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function db() {
  if (dbInstance) return dbInstance;
  ensureDirFor(DB_PATH);
  dbInstance = new Database(DB_PATH);
  dbInstance.pragma('journal_mode = WAL');
  dbInstance.pragma('synchronous = NORMAL');
  dbInstance.pragma('foreign_keys = ON');
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL DEFAULT '',
      plan TEXT NOT NULL DEFAULT 'free',
      monthly_limit INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);

    CREATE TABLE IF NOT EXISTS usage_monthly (
      api_key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
      period TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (api_key_id, period)
    );
  `);
  return dbInstance;
}

function hashKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

function currentPeriod() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${yyyy}-${mm}`;
}

function planLimit(plan) {
  const key = String(plan || '').toLowerCase();
  if (Object.prototype.hasOwnProperty.call(PLAN_LIMITS, key)) {
    return PLAN_LIMITS[key];
  }
  return PLAN_LIMITS.free;
}

function generateRawKey() {
  // 24 chars of url-safe base32-ish alphabet (no 0/O/1/I confusion).
  const alphabet = 'abcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(KEY_RANDOM_LEN);
  let out = '';
  for (let i = 0; i < KEY_RANDOM_LEN; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return `${KEY_PREFIX}${out}`;
}

function storedPrefix(rawKey) {
  return rawKey.slice(0, STORED_PREFIX_LEN);
}

function verifyKey(rawKey) {
  if (!rawKey || typeof rawKey !== 'string') return null;
  if (!rawKey.startsWith(KEY_PREFIX)) return null;
  const hash = hashKey(rawKey);
  const row = db()
    .prepare(
      `SELECT id, label, plan, monthly_limit AS monthlyLimit, status
       FROM api_keys WHERE key_hash = ?`
    )
    .get(hash);
  if (!row || row.status !== 'active') return null;
  return {
    id: row.id,
    label: row.label,
    plan: row.plan,
    monthlyLimit: row.monthlyLimit,
  };
}

function getMonthlyUsage(apiKeyId, period = currentPeriod()) {
  const row = db()
    .prepare('SELECT count FROM usage_monthly WHERE api_key_id = ? AND period = ?')
    .get(apiKeyId, period);
  return row ? row.count : 0;
}

function incrementUsage(apiKeyId, period = currentPeriod()) {
  const stmt = db().prepare(`
    INSERT INTO usage_monthly (api_key_id, period, count)
    VALUES (?, ?, 1)
    ON CONFLICT(api_key_id, period) DO UPDATE SET count = count + 1
  `);
  stmt.run(apiKeyId, period);
}

function createKey({ label = '', plan = 'free' } = {}) {
  const rawKey = generateRawKey();
  const hash = hashKey(rawKey);
  const prefix = storedPrefix(rawKey);
  const limit = planLimit(plan);
  const info = db()
    .prepare(
      `INSERT INTO api_keys (key_prefix, key_hash, label, plan, monthly_limit)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(prefix, hash, label, plan, limit);
  return {
    id: info.lastInsertRowid,
    rawKey,
    prefix,
    label,
    plan,
    monthlyLimit: limit,
  };
}

function listKeys({ includeRevoked = false } = {}) {
  const period = currentPeriod();
  const where = includeRevoked ? '' : "WHERE k.status = 'active'";
  return db()
    .prepare(
      `SELECT k.id, k.key_prefix AS prefix, k.label, k.plan,
              k.monthly_limit AS monthlyLimit, k.status, k.created_at AS createdAt,
              COALESCE(u.count, 0) AS usageThisMonth
       FROM api_keys k
       LEFT JOIN usage_monthly u
         ON u.api_key_id = k.id AND u.period = ?
       ${where}
       ORDER BY k.id ASC`
    )
    .all(period);
}

function revokeKey(prefix) {
  if (!prefix) return 0;
  const info = db()
    .prepare(
      `UPDATE api_keys SET status = 'revoked' WHERE key_prefix = ? AND status = 'active'`
    )
    .run(prefix);
  return info.changes;
}

function deleteKey(prefix) {
  if (!prefix) return 0;
  // Cascade removes usage_monthly rows automatically (foreign key ON DELETE CASCADE).
  const info = db()
    .prepare('DELETE FROM api_keys WHERE key_prefix = ?')
    .run(prefix);
  return info.changes;
}

module.exports = {
  verifyKey,
  getMonthlyUsage,
  incrementUsage,
  createKey,
  listKeys,
  revokeKey,
  deleteKey,
  planLimit,
  currentPeriod,
  PLAN_LIMITS,
};

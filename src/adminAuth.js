/**
 * Authentication for the /admin preload manager.
 *
 * Signing in takes a username and a password, checked against the scrypt hash
 * in ADMIN_PASSWORD_HASH (generated with scripts/manage-admin.js). A successful
 * login hands out one session token: a plain HMAC JWT (HS256 / HS512) signed
 * with ADMIN_SESSION_SECRET and kept in an httpOnly cookie. Node's crypto does
 * both jobs, so neither the hash nor the token needs a dependency.
 *
 * The session is stateless, which matters because the service runs as a cluster
 * of workers with no shared session store. It slides: every authenticated
 * request past the halfway mark re-signs the cookie, so the configured TTL is
 * an idle window rather than a hard deadline.
 *
 * Both HMAC variants are accepted on verification regardless of which one the
 * server signs with: they use the same symmetric key, so there is no algorithm
 * confusion to exploit. Anything outside the allowlist (notably "none") is
 * rejected before the signature is even computed.
 */
const crypto = require('crypto');
const { LRUCache } = require('lru-cache');

const ISSUER = 'favicon-api';
const AUDIENCE = 'favicon-admin';
const COOKIE_NAME = 'fa_admin';
const COOKIE_PATH = '/admin';

// JWT "alg" value -> node digest name. The allowlist doubles as the guard
// against alg=none and against asymmetric algorithms being forced onto an HMAC
// key, so never widen it without revisiting verifyToken().
const ALGORITHMS = { HS256: 'sha256', HS512: 'sha512' };

const MIN_SECRET_BYTES = 32;

function parseInteger(raw, fallback, min = 0) {
  const val = parseInt(raw, 10);
  return Number.isFinite(val) && val >= min ? val : fallback;
}

// Idle windows, not hard deadlines: refreshSession() extends a live session.
const SESSION_TTL = parseInteger(process.env.ADMIN_SESSION_TTL, 3600, 60);
const REMEMBER_TTL = Math.max(SESSION_TTL, parseDuration(process.env.ADMIN_REMEMBER_TTL) || 30 * 86400);
const LOGIN_MAX_ATTEMPTS = parseInteger(process.env.ADMIN_LOGIN_MAX_ATTEMPTS, 10, 1);
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

const ADMIN_USER = String(process.env.ADMIN_USER ?? '').trim() || 'admin';

// --- secret -----------------------------------------------------------------

const SECRET_VAR = 'ADMIN_SESSION_SECRET';
// Legacy name. It signed the same cookie, so it is still honoured; the
// rename only reflects that nobody hand-mints a token any more.
const LEGACY_SECRET_VAR = 'ADMIN_JWT_SECRET';

let secretCache;

/** The variable the key was actually read from, for CLI diagnostics. */
let secretVarUsed = null;

/**
 * The configured signing key, or null when the admin surface is switched off.
 * A 64 / 128 character hex string (what `manage-admin.js secret` prints) is
 * decoded to its 32 / 64 raw bytes; any other value is used as-is so an
 * operator can also supply a passphrase from a secret manager.
 */
function getSecret() {
  if (secretCache !== undefined) return secretCache;

  let name = SECRET_VAR;
  let raw = String(process.env[SECRET_VAR] ?? '').trim();
  if (!raw) {
    raw = String(process.env[LEGACY_SECRET_VAR] ?? '').trim();
    if (raw) {
      name = LEGACY_SECRET_VAR;
      console.warn(
        `${LEGACY_SECRET_VAR} is deprecated: rename it to ${SECRET_VAR} in your .env. ` +
          'The value is unchanged and every signed-in session keeps working.'
      );
    }
  }

  if (!raw) {
    secretCache = null;
    return secretCache;
  }

  const key = /^[0-9a-f]+$/i.test(raw) && raw.length % 2 === 0
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'utf8');

  if (key.length < MIN_SECRET_BYTES) {
    console.error(
      `${name} is too short (${key.length} bytes, need ${MIN_SECRET_BYTES}+). ` +
        'The /admin manager stays disabled. Generate one with: ' +
        'docker compose exec favicon-api npm run admin:secret'
    );
    secretCache = null;
    return secretCache;
  }

  secretVarUsed = name;
  secretCache = key;
  return secretCache;
}

/** Which of the two variable names supplied the key, or null when neither did. */
function secretSource() {
  getSecret();
  return secretVarUsed;
}

/**
 * Signing algorithm, from key length: the 64 bytes `admin:secret` prints sign
 * HS512, an older shorter key HS256. Both are accepted on verification, so a
 * cookie signed either way keeps working.
 */
function defaultAlg() {
  const key = getSecret();
  return key && key.length >= 64 ? 'HS512' : 'HS256';
}

let configWarned = false;

/**
 * True when both halves of the configuration are usable: a signing key for the
 * session cookie and a password to check at sign-in. /admin does not exist
 * otherwise, so a deployment with only one of the two is logged once rather
 * than left to look like a missing route.
 */
function isEnabled() {
  const key = getSecret();
  const creds = getCredentials();
  if (key && !creds && !configWarned) {
    configWarned = true;
    console.error(
      'ADMIN_PASSWORD_HASH is missing or unusable, so the /admin manager stays disabled. ' +
        'Generate one with: docker compose exec favicon-api npm run admin:password'
    );
  } else if (!key && creds && !configWarned) {
    configWarned = true;
    console.error(
      `ADMIN_PASSWORD_HASH is set but ${SECRET_VAR} is not, so the /admin manager stays ` +
        'disabled. Generate one with: docker compose exec favicon-api npm run admin:secret'
    );
  }
  return key !== null && creds !== null;
}

// --- password ---------------------------------------------------------------
// scrypt from node's crypto, stored self-describing so the parameters can be
// raised later without a migration:
//
//   scrypt:N=16384,r=8,p=1:<salt-base64url>:<hash-base64url>
//
// Colons, not the "$" of PHC strings, and base64url rather than base64: docker
// compose interpolates "$name" inside an env_file, and "+/=" invite quoting
// problems, so a PHC-shaped hash would arrive at the server mangled.
//
// N=16384, r=8 costs about 16 MB and a few tens of milliseconds per attempt,
// which the login throttle turns into a hard ceiling on guessing.

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const SCRYPT_SALT_BYTES = 16;
const SCRYPT_KEY_BYTES = 32;
// Refuse absurd parameters from a hand-edited .env instead of letting a login
// attempt allocate gigabytes.
const SCRYPT_MAX_MEMORY = 512 * 1024 * 1024;

function scryptMemory({ N, r }) {
  return 128 * N * r;
}

function derive(password, salt, params) {
  return crypto.scryptSync(String(password), salt, SCRYPT_KEY_BYTES, {
    N: params.N,
    r: params.r,
    p: params.p,
    // Node's default cap is 32 MB, which the defaults above sit right under;
    // leave room so a raised N does not fail instead of just costing more.
    maxmem: scryptMemory(params) * 2 + 1024 * 1024,
  });
}

/** Hash a password into the storage format above. */
function hashPassword(password, params = SCRYPT_PARAMS) {
  const salt = crypto.randomBytes(SCRYPT_SALT_BYTES);
  const hash = derive(password, salt, params);
  return `scrypt:N=${params.N},r=${params.r},p=${params.p}:${base64UrlEncode(salt)}:${base64UrlEncode(hash)}`;
}

/** Split a stored hash into `{ params, salt, hash }`, or null when unusable. */
function parsePasswordHash(raw) {
  const parts = String(raw ?? '').trim().split(':');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return null;

  const params = { N: 0, r: 0, p: 0 };
  for (const pair of parts[1].split(',')) {
    const eq = pair.indexOf('=');
    if (eq < 0) return null;
    const name = pair.slice(0, eq).trim();
    const value = parseInt(pair.slice(eq + 1), 10);
    if (!Object.prototype.hasOwnProperty.call(params, name)) return null;
    if (!Number.isFinite(value) || value < 1) return null;
    params[name] = value;
  }
  if (!params.N || !params.r || !params.p) return null;
  // scrypt requires N to be a power of two larger than 1.
  if (params.N < 2 || (params.N & (params.N - 1)) !== 0) return null;
  if (scryptMemory(params) > SCRYPT_MAX_MEMORY) return null;

  const salt = base64UrlDecode(parts[2]);
  const hash = base64UrlDecode(parts[3]);
  if (salt.length < 8 || hash.length < 16) return null;

  return { params, salt, hash };
}

/** Check a password against a stored hash (string or parsed form). */
function verifyPassword(password, stored) {
  const parsed = stored && typeof stored === 'object' ? stored : parsePasswordHash(stored);
  if (!parsed) return false;
  const derived = derive(password, parsed.salt, parsed.params);
  return derived.length === parsed.hash.length && crypto.timingSafeEqual(derived, parsed.hash);
}

/** Length-safe comparison: digest first so unequal lengths stay comparable. */
function constantTimeEquals(a, b) {
  const left = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const right = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(left, right);
}

let credentialCache;

/** The configured account, or null when ADMIN_PASSWORD_HASH is missing/invalid. */
function getCredentials() {
  if (credentialCache !== undefined) return credentialCache;

  const raw = String(process.env.ADMIN_PASSWORD_HASH ?? '').trim();
  if (!raw) {
    credentialCache = null;
    return credentialCache;
  }

  const parsed = parsePasswordHash(raw);
  if (!parsed) {
    console.error(
      'ADMIN_PASSWORD_HASH is not a valid scrypt hash. The /admin manager stays disabled. ' +
        'Generate one with: docker compose exec favicon-api npm run admin:password'
    );
    credentialCache = null;
    return credentialCache;
  }

  credentialCache = { user: ADMIN_USER, ...parsed };
  return credentialCache;
}

/**
 * Verify a sign-in. Returns `{ sub }` or null. The hash is always computed,
 * even for a wrong username, so the response time does not say which of the
 * two fields was wrong.
 */
function verifyCredentials(username, password) {
  const creds = getCredentials();
  if (!creds) return null;
  const userOk = constantTimeEquals(username, creds.user);
  const passwordOk = verifyPassword(password, creds);
  return userOk && passwordOk ? { sub: creds.user } : null;
}

// --- JWT --------------------------------------------------------------------

function base64UrlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str) {
  const padded = String(str).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64');
}

function sign(input, alg, key) {
  return base64UrlEncode(crypto.createHmac(ALGORITHMS[alg], key).update(input).digest());
}

/**
 * Sign a token. `expiresIn` is in seconds; `claims` supplies sub/typ and any
 * extras. Throws when no secret is configured — callers gate on isEnabled().
 */
function signToken(claims = {}, { alg = defaultAlg(), expiresIn = SESSION_TTL, key = getSecret() } = {}) {
  if (!key) throw new Error(`${SECRET_VAR} is not configured.`);
  if (!ALGORITHMS[alg]) throw new Error(`Unsupported algorithm "${alg}".`);

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: ISSUER,
    aud: AUDIENCE,
    iat: now,
    nbf: now,
    exp: now + Math.max(1, Math.floor(expiresIn)),
    jti: crypto.randomBytes(8).toString('hex'),
    ...claims,
  };

  const head = base64UrlEncode(JSON.stringify({ alg, typ: 'JWT' }));
  const body = base64UrlEncode(JSON.stringify(payload));
  return `${head}.${body}.${sign(`${head}.${body}`, alg, key)}`;
}

/**
 * Verify a token's signature and claims. Returns `{ ok, payload }` or
 * `{ ok: false, error }` — never throws, so a malformed token from a random
 * scanner cannot take a request down.
 */
function verifyToken(token, { typ = null, key = getSecret(), clockToleranceSec = 30 } = {}) {
  if (!key) return { ok: false, error: 'not_configured' };

  const parts = String(token || '').trim().split('.');
  if (parts.length !== 3) return { ok: false, error: 'malformed' };

  let header;
  try {
    header = JSON.parse(base64UrlDecode(parts[0]).toString('utf8'));
  } catch {
    return { ok: false, error: 'malformed' };
  }
  if (!header || typeof header.alg !== 'string' || !ALGORITHMS[header.alg]) {
    return { ok: false, error: 'bad_algorithm' };
  }

  const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`, header.alg, key), 'utf8');
  const given = Buffer.from(parts[2], 'utf8');
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    return { ok: false, error: 'bad_signature' };
  }

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(parts[1]).toString('utf8'));
  } catch {
    return { ok: false, error: 'malformed' };
  }
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'malformed' };

  if (payload.iss !== ISSUER) return { ok: false, error: 'bad_issuer' };
  if (payload.aud !== AUDIENCE) return { ok: false, error: 'bad_audience' };
  if (typ && payload.typ !== typ) return { ok: false, error: 'wrong_token_type' };

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number') return { ok: false, error: 'missing_exp' };
  if (now > payload.exp + clockToleranceSec) return { ok: false, error: 'expired' };
  if (typeof payload.nbf === 'number' && now + clockToleranceSec < payload.nbf) {
    return { ok: false, error: 'not_yet_valid' };
  }

  return { ok: true, payload };
}

/** "30d", "12h", "45m", "3600" (seconds) -> seconds, or null when unparsable. */
function parseDuration(raw) {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text) return null;
  const match = text.match(/^(\d+)\s*(s|m|h|d|w)?$/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[match[2] || 's'];
  return value * unit;
}

// --- cookies ----------------------------------------------------------------

function readCookie(req, name = COOKIE_NAME) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

function isSecureRequest(req) {
  return req.protocol === 'https' || req.get('x-forwarded-proto') === 'https';
}

function setSessionCookie(req, res, token, maxAgeSec) {
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    `Path=${COOKIE_PATH}`,
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(1, Math.floor(maxAgeSec))}`,
  ];
  if (isSecureRequest(req)) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(req, res) {
  const attrs = [`${COOKIE_NAME}=`, `Path=${COOKIE_PATH}`, 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (isSecureRequest(req)) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

/** Idle window for a session: the long one when "keep me signed in" was ticked. */
function sessionWindow(remember) {
  return remember ? REMEMBER_TTL : SESSION_TTL;
}

/** Issue a session cookie after a successful sign-in. */
function startSession(req, res, { sub = ADMIN_USER, remember = false } = {}) {
  const ttl = sessionWindow(remember);
  const token = signToken({ typ: 'session', sub, rem: remember ? 1 : 0 }, { expiresIn: ttl });
  setSessionCookie(req, res, token, ttl);
  return ttl;
}

/**
 * Extend a live session once it is past the halfway mark, so the TTL acts as an
 * idle timeout. Returns the new payload when the cookie was re-issued, else
 * null. Re-signing costs one HMAC, hence the halfway guard rather than doing it
 * on every request.
 */
function refreshSession(req, res, session) {
  if (!session) return null;
  const window = sessionWindow(Boolean(session.rem));
  const now = Math.floor(Date.now() / 1000);
  if ((session.exp || 0) - now > Math.floor(window / 2)) return null;

  const claims = { typ: 'session', sub: session.sub || ADMIN_USER, rem: session.rem ? 1 : 0 };
  setSessionCookie(req, res, signToken(claims, { expiresIn: window }), window);
  return { ...session, ...claims, iat: now, nbf: now, exp: now + window };
}

function currentSession(req) {
  const cookie = readCookie(req);
  if (!cookie) return null;
  const result = verifyToken(cookie, { typ: 'session' });
  return result.ok ? result.payload : null;
}

// --- login throttle ---------------------------------------------------------
// Per worker, not shared across the cluster: WORKERS attempts per window in the
// worst case. That is still a hard cap on brute force against a 256-bit HMAC,
// and it keeps the login path free of any shared state.

const loginAttempts = new LRUCache({ max: 5000, ttl: LOGIN_WINDOW_MS });

function loginBlocked(ip) {
  return (loginAttempts.get(ip) || 0) >= LOGIN_MAX_ATTEMPTS;
}

function recordLoginFailure(ip) {
  loginAttempts.set(ip, (loginAttempts.get(ip) || 0) + 1);
}

function resetLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

// --- middleware -------------------------------------------------------------

/** JSON guard for /admin/api/*: 401 when there is no valid session cookie. */
function requireAdminApi(req, res, next) {
  const session = currentSession(req);
  if (!session) {
    return res.status(401).json({ error: 'Not signed in.', code: 'unauthorized' });
  }
  // Same-origin marker. Combined with SameSite=Strict this stops a third-party
  // page from driving the admin API with the operator's cookie: a cross-site
  // form post cannot set a custom header, and fetch() would need CORS.
  if (req.method !== 'GET' && req.get('x-admin-request') !== '1') {
    return res.status(403).json({ error: 'Missing X-Admin-Request header.', code: 'csrf' });
  }
  req.adminSession = refreshSession(req, res, session) || session;
  next();
}

module.exports = {
  COOKIE_NAME,
  SESSION_TTL,
  REMEMBER_TTL,
  LOGIN_MAX_ATTEMPTS,
  ADMIN_USER,
  SCRYPT_PARAMS,
  SECRET_VAR,
  LEGACY_SECRET_VAR,
  secretSource,
  isEnabled,
  getSecret,
  defaultAlg,
  getCredentials,
  hashPassword,
  parsePasswordHash,
  verifyPassword,
  verifyCredentials,
  signToken,
  verifyToken,
  parseDuration,
  readCookie,
  setSessionCookie,
  clearSessionCookie,
  startSession,
  refreshSession,
  currentSession,
  loginBlocked,
  recordLoginFailure,
  resetLoginAttempts,
  requireAdminApi,
};

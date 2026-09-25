/**
 * Stateless, user-generated favicon "profiles".
 *
 * A profile encodes a preferred provider, up to 4 fallbacks, a preferred
 * icon size and an optional size fallback directly into a URL-safe id (no
 * database). The id is the base64url of a compact JSON array:
 *
 *   [version, preferredProvider, [fallbacks...], preferredSize, sizeFallback?]
 *
 * e.g. [1, "scraper", ["googlev2", "duckduckgo"], 128]
 *      [1, "scraper", ["googlev2"], 128, "smaller"]
 *
 * The 5th element is omitted when there is no size fallback, so ids created
 * before it existed stay valid and unchanged.
 *
 * The resolve route baseurl/{id}/{domain-or-appname} decodes the id back into
 * a profile and serves the icon following the chain. Keep the encode/decode
 * contract identical to the browser implementation in src/public/index.html.
 */

// Whitelisted providers selectable in a profile (mirrors VALID_DEFAULT_PROVIDERS
// in src/bestPick.js). logodev/brandfetch only work when their server-side
// credentials are configured, but they remain encodable so URLs stay portable.
const PROFILE_PROVIDERS = [
  'scraper',
  'google',
  'googlev2',
  'duckduckgo',
  'yandex',
  'faviconso',
  'vemetric',
  'favicondev',
  'faviconkit',
  'faviconrun',
  'twentyicons',
  'ryanjc',
  'logodev',
  'brandfetch',
  'selfhst',
  'dashboardicons',
  'lobehub',
  'svgl',
  'thesvg',
];

const PROFILE_PROVIDER_SET = new Set(PROFILE_PROVIDERS);

// Allowed preferred sizes. SVG sources are treated as unlimited (always satisfy
// the preferred size); raster sources must be >= the preferred size and are
// then served at exactly this size.
const PROFILE_SIZES = [16, 32, 64, 128];
const PROFILE_SIZE_SET = new Set(PROFILE_SIZES);

// "smaller": when no provider in the chain reaches the preferred size, serve
// the largest smaller raster found along the chain at its native size.
const PROFILE_SIZE_FALLBACKS = ['smaller'];
const PROFILE_SIZE_FALLBACK_SET = new Set(PROFILE_SIZE_FALLBACKS);

const PROFILE_VERSION = 1;
const MAX_FALLBACKS = 4;
// Profile ids are base64url of a JSON array; the shortest valid config already
// exceeds this once encoded. Enforcing a minimum length guarantees the resolve
// route never shadows the short alias routes (/d/, /sh/, ...).
const MIN_ID_LENGTH = 20;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

function base64urlEncode(str) {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlDecode(id) {
  const padLen = (4 - (id.length % 4)) % 4;
  const b64 = id.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padLen);
  return Buffer.from(b64, 'base64').toString('utf8');
}

function normalizeProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  return PROFILE_PROVIDER_SET.has(provider) ? provider : null;
}

function normalizeSize(value) {
  const size = parseInt(value, 10);
  return PROFILE_SIZE_SET.has(size) ? size : null;
}

/**
 * Encode a profile into a URL-safe id. Returns null when the input is invalid
 * (unknown provider, too many fallbacks, bad size, unknown size fallback).
 */
function encodeProfile({ preferred, fallbacks = [], size, sizeFallback = null } = {}) {
  const p = normalizeProvider(preferred);
  if (!p) return null;

  if (!Array.isArray(fallbacks) || fallbacks.length > MAX_FALLBACKS) return null;
  const f = [];
  for (const fb of fallbacks) {
    const provider = normalizeProvider(fb);
    if (!provider) return null;
    f.push(provider);
  }

  const s = normalizeSize(size);
  if (!s) return null;

  const arr = [PROFILE_VERSION, p, f, s];
  if (sizeFallback) {
    if (!PROFILE_SIZE_FALLBACK_SET.has(sizeFallback)) return null;
    arr.push(sizeFallback);
  }
  return base64urlEncode(JSON.stringify(arr));
}

/**
 * Decode a profile id back into { preferred, fallbacks, size, sizeFallback }
 * (sizeFallback is null when absent) or null when the
 * id is not a valid profile (bad length/charset/JSON/version/values). A null
 * result lets the resolve route fall through to other routes.
 */
function decodeProfile(id) {
  if (typeof id !== 'string' || id.length < MIN_ID_LENGTH) return null;
  if (!BASE64URL_RE.test(id)) return null;

  let parsed;
  try {
    parsed = JSON.parse(base64urlDecode(id));
  } catch {
    return null;
  }

  if (!Array.isArray(parsed) || (parsed.length !== 4 && parsed.length !== 5)) return null;
  const [version, rawPreferred, rawFallbacks, rawSize, rawSizeFallback] = parsed;
  if (version !== PROFILE_VERSION) return null;

  const preferred = normalizeProvider(rawPreferred);
  if (!preferred) return null;

  if (!Array.isArray(rawFallbacks) || rawFallbacks.length > MAX_FALLBACKS) return null;
  const fallbacks = [];
  for (const fb of rawFallbacks) {
    const provider = normalizeProvider(fb);
    if (!provider) return null;
    fallbacks.push(provider);
  }

  const size = normalizeSize(rawSize);
  if (!size) return null;

  let sizeFallback = null;
  if (parsed.length === 5) {
    if (!PROFILE_SIZE_FALLBACK_SET.has(rawSizeFallback)) return null;
    sizeFallback = rawSizeFallback;
  }

  return { preferred, fallbacks, size, sizeFallback };
}

module.exports = {
  PROFILE_PROVIDERS,
  PROFILE_SIZES,
  PROFILE_SIZE_FALLBACKS,
  PROFILE_VERSION,
  MAX_FALLBACKS,
  encodeProfile,
  decodeProfile,
};

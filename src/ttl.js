const SECONDS_PER_DAY = 86400;
// Values this large cannot reasonably mean "days" (≈10 years). Treat them as
// the pre-2.18 unit (seconds) so existing .env files keep working.
const LEGACY_SECONDS_THRESHOLD = 3600;

/**
 * Parse a TTL env var expressed in days and return seconds.
 * Integers ≥ 3600 are treated as legacy seconds.
 */
function parseTtlDaysToSeconds(raw, defaultDays, envName) {
  const n = parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return defaultDays * SECONDS_PER_DAY;
  if (n >= LEGACY_SECONDS_THRESHOLD) {
    if (envName) {
      const days = Math.max(1, Math.round(n / SECONDS_PER_DAY));
      console.warn(
        `${envName}=${n} looks like seconds; treating as ${n}s. ` +
          `Set this variable in days (e.g. ${days}).`
      );
    }
    return n;
  }
  return n * SECONDS_PER_DAY;
}

const DISK_CACHE_TTL_SECONDS = parseTtlDaysToSeconds(
  process.env.DISK_CACHE_TTL,
  7,
  'DISK_CACHE_TTL'
);
const API_CACHE_TTL_SECONDS = parseTtlDaysToSeconds(
  process.env.API_CACHE_TTL,
  7,
  'API_CACHE_TTL'
);

/**
 * How long past its TTL an entry stays on disk and may still be served while a
 * background refresh runs (stale-while-revalidate).
 *
 * This is deliberately much longer than the TTL: the TTL answers "when should
 * this be refreshed", the retention answers "when is this worthless". A favicon
 * that is a week past its TTL is still the right icon, and serving it costs
 * ~40ms instead of the seconds a cold provider race takes. Only past the
 * retention window is an entry actually dropped.
 *
 * Set to 0 to disable stale serving entirely: entries are then removed as soon
 * as they pass the TTL, and every expiry is paid for by a real visitor.
 */
const STALE_RETENTION_SECONDS = (() => {
  const raw = process.env.CACHE_STALE_RETENTION;
  if (String(raw ?? '').trim() === '0') return 0;
  return parseTtlDaysToSeconds(raw, 30, 'CACHE_STALE_RETENTION');
})();

const SERVE_STALE = STALE_RETENTION_SECONDS > 0;

/**
 * Minimum gap between two background refresh attempts for the same cache key.
 * A refresh that fails (or finds no icon at all) leaves the stale entry in
 * place, so without a cooldown every single request would kick off another
 * attempt against an upstream that is already failing.
 */
const REVALIDATE_COOLDOWN_SECONDS = (() => {
  const n = parseInt(process.env.CACHE_REVALIDATE_COOLDOWN ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 900;
})();

module.exports = {
  SECONDS_PER_DAY,
  parseTtlDaysToSeconds,
  DISK_CACHE_TTL_SECONDS,
  API_CACHE_TTL_SECONDS,
  STALE_RETENTION_SECONDS,
  SERVE_STALE,
  REVALIDATE_COOLDOWN_SECONDS,
};

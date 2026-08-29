/**
 * Manual per-domain icon overrides (`alter_icon_url` in the preload database).
 *
 * When a site's own favicon is unusable you can pin an exact image URL with
 * `scripts/manage-preload.js set {domain} --icon-url ...`. The override has to
 * win on every route that serves that domain's icon — the best-pick route, the
 * sized scraper routes, and the v1 API — otherwise the preload script would
 * happily cache the wrong icon for the routes that skip it.
 *
 * Lookups happen in the request path, so they must be synchronous and free:
 * the whole table (tens of rows) is held in a Map and only re-read when the
 * database file's mtime changes, at most once per throttle window.
 */
const crypto = require('crypto');
const preloadStore = require('./preloadStore');
const { fetchScraperAsset } = require('./providers');

const RELOAD_MS = preloadStore.RELOAD_THROTTLE_MS;

let overrides = new Map();
let loadedMtimeMs = -1;
let lastCheck = 0;
let loaded = false;

function reload() {
  const next = new Map();
  for (const row of preloadStore.listOverrides()) {
    const domain = String(row.domain || '').trim().toLowerCase();
    const url = String(row.alterIconUrl || '').trim();
    if (domain && url) next.set(domain, url);
  }
  overrides = next;
  loaded = true;
}

function refreshIfStale() {
  const now = Date.now();
  if (loaded && now - lastCheck < RELOAD_MS) return;
  lastCheck = now;
  const stamp = preloadStore.dbMtimeMs();
  if (loaded && stamp === loadedMtimeMs) return;
  try {
    reload();
    loadedMtimeMs = stamp;
  } catch {
    // A missing or broken store simply means "no overrides".
    if (!loaded) {
      overrides = new Map();
      loaded = true;
    }
  }
}

/** The pinned icon URL for `domain`, or null. Safe to call per request. */
function getOverrideUrl(domain) {
  if (!domain) return null;
  refreshIfStale();
  if (overrides.size === 0) return null;
  return overrides.get(String(domain).toLowerCase()) || null;
}

function hasOverride(domain) {
  return getOverrideUrl(domain) !== null;
}

/**
 * Cache key for an override. The URL hash is part of the key so that changing
 * the override through the CLI takes effect immediately: a new URL is simply a
 * new key, instead of waiting out DISK_CACHE_TTL on the old bytes.
 */
function overrideCacheKey(domain, url) {
  const stamp = crypto.createHash('sha1').update(url).digest('hex').slice(0, 8);
  return `${stamp}_${domain}`;
}

/**
 * Fetch the override icon for `domain`, or null when there is none.
 *
 * `fetchWithCache` is passed in rather than imported: src/bestPick.js owns it
 * and also calls this module, so importing it here would be a require cycle.
 * `opts` is forwarded to it unchanged — an override sits in front of the
 * best-pick cache, so it needs the same stale-while-revalidate treatment or it
 * becomes the slow step on every overridden domain.
 */
async function fetchOverrideEntry(domain, size, fetchWithCache, opts = undefined) {
  const url = getOverrideUrl(domain);
  if (!url) return null;
  try {
    const entry = await fetchWithCache('override', overrideCacheKey(domain, url), size, async () => {
      const result = await fetchScraperAsset(url);
      return result && result.buffer ? { ...result, provider: 'override', url } : null;
    }, opts);
    return entry || null;
  } catch (err) {
    console.error(`Icon override failed for ${domain}:`, err && err.message ? err.message : err);
    return null;
  }
}

/** Raw bytes of the override, for pipelines that do their own normalization. */
async function fetchOverrideAsset(domain) {
  const url = getOverrideUrl(domain);
  if (!url) return null;
  try {
    const result = await fetchScraperAsset(url);
    if (!result || !result.buffer) return null;
    return { buffer: result.buffer, contentType: result.contentType, sourceUrl: url };
  } catch (err) {
    console.error(`Icon override failed for ${domain}:`, err && err.message ? err.message : err);
    return null;
  }
}

module.exports = {
  getOverrideUrl,
  hasOverride,
  fetchOverrideEntry,
  fetchOverrideAsset,
  overrideCacheKey,
};

const { LRUCache } = require('lru-cache');
const fs = require('fs/promises');
const path = require('path');
const {
  DISK_CACHE_TTL_SECONDS,
  STALE_RETENTION_SECONDS,
  SERVE_STALE,
  REVALIDATE_COOLDOWN_SECONDS,
} = require('./ttl');

const CACHE_DIR = process.env.CACHE_DIR || './cache';
const MEMORY_MAX = parseInt(process.env.MEMORY_CACHE_MAX || '2000', 10);
const MEMORY_TTL = parseInt(process.env.MEMORY_CACHE_TTL || '3600', 10) * 1000;
const DISK_TTL = DISK_CACHE_TTL_SECONDS * 1000;
// Total age at which an entry stops being useful and is deleted. Past the TTL
// but below this, the bytes are still served while a refresh runs behind the
// request (see get()'s `allowStale`). With stale serving off this collapses to
// the TTL, which is the pre-2.19 behaviour.
const MAX_AGE_MS = SERVE_STALE ? DISK_TTL + STALE_RETENTION_SECONDS * 1000 : DISK_TTL;
const DISK_MAX_BYTES =
  Math.max(0, parseInt(process.env.CACHE_SIZE_MB || '0', 10)) * 1024 * 1024;
const DISK_RESCAN_INTERVAL_MS = 60 * 1000;

const memoryCache = new LRUCache({
  max: MEMORY_MAX,
  ttl: MEMORY_TTL,
});

// Per-worker view of the shared disk cache directory used to enforce
// CACHE_SIZE_MB. Every cluster worker writes into the same /cache volume but
// keeps its own index; a periodic rescan lets workers converge on the real
// on-disk total so any worker can trigger eviction when the directory grows
// past the configured limit.
const diskIndex = new Map();
let diskTotal = 0;
let scanPromise = null;

function cacheKey(provider, domain, size) {
  const sanitized = domain.replace(/[^a-zA-Z0-9.-]/g, '_');
  return size ? `${provider}_${size}_${sanitized}` : `${provider}_${sanitized}`;
}

function diskPath(key) {
  return path.join(CACHE_DIR, key);
}

function metaPath(key) {
  return path.join(CACHE_DIR, `${key}.meta`);
}

function originalPath(key) {
  return path.join(CACHE_DIR, `${key}.orig`);
}

function originalSvgPath(key) {
  return path.join(CACHE_DIR, `${key}.origsvg`);
}

function isSidecarName(name) {
  return (
    name.endsWith('.meta') ||
    name.endsWith('.orig') ||
    name.endsWith('.origsvg')
  );
}

// Databases and exports that other modules keep in CACHE_DIR (api-keys.sqlite,
// stats.sqlite + its -wal/-shm siblings, preload.csv, …). They are not cache
// entries, so they must stay out of diskIndex: evictIfOverLimit() unlinks
// everything it has indexed once CACHE_SIZE_MB is passed, which would delete
// the API keys along with the icons.
const NON_ENTRY_SUFFIXES = [
  '.sqlite',
  '.sqlite-wal',
  '.sqlite-shm',
  '.db',
  '.csv',
  '.json',
  '.log',
  '.lock',
];

/**
 * True when `name` is an image cache entry rather than an unrelated file that
 * happens to live in CACHE_DIR. Every key produced by cacheKey() contains at
 * least one underscore (`{provider}_{domain}`), which none of the data files
 * above do; the suffix list is a second guard because getting this wrong means
 * deleting somebody's data.
 */
function isCacheEntryName(name) {
  if (isSidecarName(name)) return false;
  if (!name.includes('_')) return false;
  const lower = name.toLowerCase();
  return !NON_ENTRY_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

async function ensureCacheDir() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
}

async function unlinkEntryFiles(key) {
  await Promise.all([
    fs.unlink(diskPath(key)).catch(() => {}),
    fs.unlink(metaPath(key)).catch(() => {}),
    fs.unlink(originalPath(key)).catch(() => {}),
    fs.unlink(originalSvgPath(key)).catch(() => {}),
  ]);
}

async function scanDiskCache() {
  if (scanPromise) return scanPromise;
  scanPromise = (async () => {
    try {
      await ensureCacheDir();
      const entries = await fs.readdir(CACHE_DIR);
      const next = new Map();
      let total = 0;
      for (const name of entries) {
        if (!isCacheEntryName(name)) continue;
        try {
          const base = path.join(CACHE_DIR, name);
          const stat = await fs.stat(base);
          if (!stat.isFile()) continue;
          let size = stat.size;
          // Sidecar originals belong to this entry's budget.
          for (const side of [metaPath(name), originalPath(name), originalSvgPath(name)]) {
            try {
              const sideStat = await fs.stat(side);
              if (sideStat.isFile()) size += sideStat.size;
            } catch {
              /* missing sidecar */
            }
          }
          next.set(name, { size, mtimeMs: stat.mtimeMs });
          total += size;
        } catch {
          // File disappeared between readdir and stat — ignore.
        }
      }
      diskIndex.clear();
      for (const [k, v] of next) diskIndex.set(k, v);
      diskTotal = total;
    } catch (err) {
      console.error('Disk cache scan failed:', err.message);
    } finally {
      scanPromise = null;
    }
  })();
  return scanPromise;
}

async function evictIfOverLimit() {
  if (!DISK_MAX_BYTES) return;
  if (diskTotal <= DISK_MAX_BYTES) return;

  // Refresh from disk so we evict against the real on-disk total rather than
  // this worker's stale local view (other workers may already have evicted).
  await scanDiskCache();
  if (diskTotal <= DISK_MAX_BYTES) return;

  const sorted = [...diskIndex.entries()].sort(
    (a, b) => a[1].mtimeMs - b[1].mtimeMs
  );

  for (const [key, info] of sorted) {
    if (diskTotal <= DISK_MAX_BYTES) break;
    diskIndex.delete(key);
    diskTotal = Math.max(0, diskTotal - info.size);
    memoryCache.delete(key);
    await unlinkEntryFiles(key);
  }
}

function trackDelete(key) {
  if (!DISK_MAX_BYTES) return;
  const indexed = diskIndex.get(key);
  if (!indexed) return;
  diskIndex.delete(key);
  diskTotal = Math.max(0, diskTotal - indexed.size);
}

/**
 * Read an entry.
 *
 * Past DISK_CACHE_TTL an entry is *stale*: the bytes are still a valid icon but
 * want refreshing. What that means is up to the caller:
 *
 *   allowStale: false (default) — report a miss so the caller fetches fresh
 *     bytes itself. The file is left alone (unless it is past MAX_AGE_MS), so a
 *     caller that can serve stale still finds it. set() overwrites it when the
 *     fetch succeeds.
 *   allowStale: true — return the bytes with `stale: true`. The caller is
 *     expected to serve them and hand the refresh to cache.revalidate(), which
 *     keeps it off the request path.
 *
 * Only past MAX_AGE_MS is an entry actually deleted.
 */
async function get(provider, domain, size, { allowStale = false } = {}) {
  const key = cacheKey(provider, domain, size);
  const serveStale = allowStale && SERVE_STALE;

  const memHit = memoryCache.get(key);
  if (memHit) {
    const memAge = Date.now() - (memHit.cachedAt ?? 0);
    if (memAge <= DISK_TTL) return memHit;
    if (serveStale) return { ...memHit, stale: true };
    // Stale in memory but the caller needs fresh bytes: fall through to disk,
    // where a cluster sibling may already have written a newer file.
  }

  try {
    const file = diskPath(key);
    const stat = await fs.stat(file);
    const age = Date.now() - stat.mtimeMs;

    if (age > MAX_AGE_MS) {
      trackDelete(key);
      memoryCache.delete(key);
      await unlinkEntryFiles(key);
      return null;
    }

    const stale = age > DISK_TTL;
    if (stale && !serveStale) return null;

    const [buffer, metaRaw, originalBuffer, originalSvgBuffer] = await Promise.all([
      fs.readFile(file),
      fs.readFile(metaPath(key), 'utf-8').catch(() => '{}'),
      fs.readFile(originalPath(key)).catch(() => null),
      fs.readFile(originalSvgPath(key)).catch(() => null),
    ]);

    const meta = JSON.parse(metaRaw);
    const entry = {
      buffer,
      contentType: meta.contentType || 'image/png',
      provider: meta.provider || provider,
      cachedAt: stat.mtimeMs,
    };
    if (meta.url) entry.url = meta.url;
    if (originalBuffer?.length) entry.originalBuffer = originalBuffer;
    if (originalSvgBuffer?.length) entry.originalSvgBuffer = originalSvgBuffer;

    memoryCache.set(key, entry);
    return stale ? { ...entry, stale: true } : entry;
  } catch {
    return null;
  }
}

// --- background revalidation -------------------------------------------------

// One in-flight refresh per cache key. Without this, every request arriving
// during a slow refresh would start its own.
const revalidating = new Set();

// Keys that were refreshed recently, successfully or not. A refresh that fails
// (or finds no icon) leaves the stale entry in place, so the next request would
// see `stale` again and retry immediately — hammering an upstream that is
// already failing. TTL-based so it cleans itself up.
const revalidateCooldown = new LRUCache({
  max: 20000,
  ttl: Math.max(1, REVALIDATE_COOLDOWN_SECONDS) * 1000,
});

/**
 * Refresh a stale entry behind the request, at most once per key per cooldown
 * window. `refresher` is expected to write through cache.set() itself; its
 * return value is ignored. Never throws: a failed refresh just means the stale
 * entry is served again next time.
 */
function revalidate(provider, domain, size, refresher) {
  if (!SERVE_STALE) return;
  const key = cacheKey(provider, domain, size);
  if (revalidating.has(key) || revalidateCooldown.has(key)) return;

  revalidating.add(key);
  Promise.resolve()
    .then(refresher)
    .catch((err) => {
      console.error(`Cache revalidation failed for ${key}:`, err.message);
    })
    .finally(() => {
      revalidating.delete(key);
      revalidateCooldown.set(key, true);
    });
}

async function set(provider, domain, size, entry) {
  if (entry?.notFound) return;

  const key = cacheKey(provider, domain, size);

  // `cachedAt` is what get() compares against DISK_CACHE_TTL, so the memory
  // copy ages on the same clock as the file. `stale` is dropped: an entry that
  // was served stale and then refreshed is fresh again.
  const { stale, ...stored } = entry;
  memoryCache.set(key, { ...stored, cachedAt: Date.now() });

  try {
    await ensureCacheDir();
    const meta = { contentType: entry.contentType, provider: entry.provider };
    if (entry.url) meta.url = entry.url;

    const writes = [
      fs.writeFile(diskPath(key), entry.buffer),
      fs.writeFile(metaPath(key), JSON.stringify(meta)),
    ];

    // Persist full-resolution / SVG sources so sized routes can rebuild after
    // MEMORY_CACHE_TTL without re-fetching upstream (disk previously only kept
    // the capped display buffer).
    const hasDistinctOriginal =
      entry.originalBuffer?.length &&
      entry.originalBuffer !== entry.buffer;
    if (hasDistinctOriginal) {
      writes.push(fs.writeFile(originalPath(key), entry.originalBuffer));
    } else {
      writes.push(fs.unlink(originalPath(key)).catch(() => {}));
    }

    if (entry.originalSvgBuffer?.length) {
      writes.push(fs.writeFile(originalSvgPath(key), entry.originalSvgBuffer));
    } else {
      writes.push(fs.unlink(originalSvgPath(key)).catch(() => {}));
    }

    await Promise.all(writes);

    if (DISK_MAX_BYTES) {
      const previous = diskIndex.get(key);
      if (previous) diskTotal = Math.max(0, diskTotal - previous.size);
      let sizeBytes = entry.buffer.length;
      if (hasDistinctOriginal) sizeBytes += entry.originalBuffer.length;
      if (entry.originalSvgBuffer?.length) sizeBytes += entry.originalSvgBuffer.length;
      diskIndex.set(key, {
        size: sizeBytes,
        mtimeMs: Date.now(),
      });
      diskTotal += sizeBytes;

      if (diskTotal > DISK_MAX_BYTES) {
        // Run eviction in the background so set() stays fast for the caller.
        evictIfOverLimit().catch((err) => {
          console.error('Disk cache eviction failed:', err.message);
        });
      }
    }
  } catch (err) {
    console.error(`Disk cache write failed for ${key}:`, err.message);
  }
}

async function del(provider, domain, size) {
  const key = cacheKey(provider, domain, size);
  memoryCache.delete(key);
  trackDelete(key);
  // A deliberate invalidation (?refresh=1, changed override, unusable icon)
  // should not be held back by a cooldown from an earlier failed refresh.
  revalidateCooldown.delete(key);
  await unlinkEntryFiles(key);
}

if (DISK_MAX_BYTES) {
  scanDiskCache()
    .then(() => evictIfOverLimit())
    .catch(() => {});
  setInterval(() => {
    scanDiskCache()
      .then(() => evictIfOverLimit())
      .catch(() => {});
  }, DISK_RESCAN_INTERVAL_MS).unref();
}

/**
 * Drop a cache entry by its on-disk key. Used by the sweeper in
 * src/cacheGc.js, which walks CACHE_DIR by filename and has no domain/provider
 * pair to rebuild a key from.
 */
async function deleteByKey(key) {
  memoryCache.delete(key);
  trackDelete(key);
  revalidateCooldown.delete(key);
  await unlinkEntryFiles(key);
}

module.exports = {
  get,
  set,
  del,
  revalidate,
  deleteByKey,
  isCacheEntryName,
  CACHE_DIR,
  DISK_TTL_MS: DISK_TTL,
  MAX_AGE_MS,
};

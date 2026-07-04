const { LRUCache } = require('lru-cache');
const fs = require('fs/promises');
const path = require('path');

const CACHE_DIR = process.env.CACHE_DIR || './cache';
const MEMORY_MAX = parseInt(process.env.MEMORY_CACHE_MAX || '2000', 10);
const MEMORY_TTL = parseInt(process.env.MEMORY_CACHE_TTL || '3600', 10) * 1000;
const DISK_TTL = parseInt(process.env.DISK_CACHE_TTL || '86400', 10) * 1000;
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

async function ensureCacheDir() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
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
        if (name.endsWith('.meta')) continue;
        try {
          const stat = await fs.stat(path.join(CACHE_DIR, name));
          if (!stat.isFile()) continue;
          next.set(name, { size: stat.size, mtimeMs: stat.mtimeMs });
          total += stat.size;
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
    await fs.unlink(diskPath(key)).catch(() => {});
    await fs.unlink(metaPath(key)).catch(() => {});
  }
}

function trackDelete(key) {
  if (!DISK_MAX_BYTES) return;
  const indexed = diskIndex.get(key);
  if (!indexed) return;
  diskIndex.delete(key);
  diskTotal = Math.max(0, diskTotal - indexed.size);
}

async function get(provider, domain, size) {
  const key = cacheKey(provider, domain, size);

  const memHit = memoryCache.get(key);
  if (memHit) return memHit;

  try {
    const file = diskPath(key);
    const stat = await fs.stat(file);
    const age = Date.now() - stat.mtimeMs;

    if (age > DISK_TTL) {
      trackDelete(key);
      await fs.unlink(file).catch(() => {});
      await fs.unlink(metaPath(key)).catch(() => {});
      return null;
    }

    const [buffer, metaRaw] = await Promise.all([
      fs.readFile(file),
      fs.readFile(metaPath(key), 'utf-8').catch(() => '{}'),
    ]);

    const meta = JSON.parse(metaRaw);
    const entry = {
      buffer,
      contentType: meta.contentType || 'image/png',
      provider: meta.provider || provider,
    };
    if (meta.url) entry.url = meta.url;

    memoryCache.set(key, entry);
    return entry;
  } catch {
    return null;
  }
}

async function set(provider, domain, size, entry) {
  if (entry?.notFound) return;

  const key = cacheKey(provider, domain, size);

  memoryCache.set(key, entry);

  try {
    await ensureCacheDir();
    const meta = { contentType: entry.contentType, provider: entry.provider };
    if (entry.url) meta.url = entry.url;
    await Promise.all([
      fs.writeFile(diskPath(key), entry.buffer),
      fs.writeFile(metaPath(key), JSON.stringify(meta)),
    ]);

    if (DISK_MAX_BYTES) {
      const previous = diskIndex.get(key);
      if (previous) diskTotal = Math.max(0, diskTotal - previous.size);
      diskIndex.set(key, {
        size: entry.buffer.length,
        mtimeMs: Date.now(),
      });
      diskTotal += entry.buffer.length;

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
  await fs.unlink(diskPath(key)).catch(() => {});
  await fs.unlink(metaPath(key)).catch(() => {});
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

module.exports = { get, set, del };

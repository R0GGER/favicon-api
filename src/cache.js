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
        if (isSidecarName(name)) continue;
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
      await unlinkEntryFiles(key);
      return null;
    }

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
    };
    if (meta.url) entry.url = meta.url;
    if (originalBuffer?.length) entry.originalBuffer = originalBuffer;
    if (originalSvgBuffer?.length) entry.originalSvgBuffer = originalSvgBuffer;

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

module.exports = { get, set, del };

/**
 * Periodic cache sweeper.
 *
 * Every cache in this service expires entries lazily: an entry is only checked,
 * and only removed, when somebody asks for that exact key. That is fine for
 * correctness but leaves the volume full of files nobody will ever read again —
 * a scraped HTML page for a domain that was looked up once keeps its bytes
 * forever. On a real deployment that was ~220 MB of long-expired discovery data
 * out of a 400 MB volume.
 *
 * Two things make eviction (CACHE_SIZE_MB in src/cache.js) an insufficient
 * answer: it only indexes loose files in CACHE_DIR, so the discovery and API
 * subdirectories are invisible to it, and it is size-driven, so it does nothing
 * at all until the limit is reached.
 *
 * Retention is deliberately separate from the TTLs. The TTL says when an entry
 * should be refreshed; stale-while-revalidate then keeps serving the old bytes
 * in the meantime, so sweeping at the TTL would throw away exactly the data
 * that makes a refresh invisible to visitors. Image and API entries are
 * therefore kept for TTL + CACHE_STALE_RETENTION. Scraper discovery is the
 * exception: it is never served stale (src/scraperDiskCache.js drops it at its
 * TTL), so past the TTL it is pure garbage and goes immediately.
 */
const fs = require('fs/promises');
const path = require('path');
const cache = require('./cache');
const scraperDiskCache = require('./scraperDiskCache');
const { API_CACHE_TTL_SECONDS, STALE_RETENTION_SECONDS } = require('./ttl');

const CACHE_DIR = cache.CACHE_DIR;
const API_CACHE_DIR = process.env.API_CACHE_DIR || '/cache/api';

// Held in CACHE_DIR but named without an underscore so cache.isCacheEntryName()
// never mistakes it for an icon (and `.lock` is on its exclusion list too).
const LOCK_FILE = path.join(CACHE_DIR, 'cache-gc.lock');

const HOUR_MS = 3600 * 1000;

function parseBool(raw, fallback) {
  const val = String(raw ?? '').trim().toLowerCase();
  if (val === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(val)) return true;
  if (['0', 'false', 'no', 'off'].includes(val)) return false;
  return fallback;
}

const ENABLED = parseBool(process.env.CACHE_GC, true);

const INTERVAL_MS = (() => {
  const n = parseInt(process.env.CACHE_GC_INTERVAL ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n * HOUR_MS : 6 * HOUR_MS;
})();

const API_MAX_AGE_MS =
  API_CACHE_TTL_SECONDS * 1000 + STALE_RETENTION_SECONDS * 1000;

async function unlinkQuiet(file) {
  try {
    await fs.unlink(file);
    return true;
  } catch {
    return false;
  }
}

/** Icon bytes in CACHE_DIR, past TTL + retention. Sidecars go with them. */
async function sweepImageCache(now) {
  let removed = 0;
  let bytes = 0;
  let names;
  try {
    names = await fs.readdir(CACHE_DIR);
  } catch {
    return { removed, bytes };
  }

  for (const name of names) {
    if (!cache.isCacheEntryName(name)) continue;
    try {
      const stat = await fs.stat(path.join(CACHE_DIR, name));
      if (!stat.isFile()) continue;
      if (now - stat.mtimeMs <= cache.MAX_AGE_MS) continue;
      // deleteByKey also drops the sidecars, the memory copy and the entry's
      // share of the CACHE_SIZE_MB budget.
      await cache.deleteByKey(name);
      removed += 1;
      bytes += stat.size;
    } catch {
      // Gone between readdir and stat, or being written — leave it.
    }
  }
  return { removed, bytes };
}

/**
 * Scraper discovery (HTML, icon lists, probes), past its bucket's TTL.
 *
 * Per bucket, because `page` holds raw HTML and is kept far shorter than the
 * derived icon lists. The grace period only covers clock skew between workers
 * and an entry being written right now.
 */
async function sweepDiscoveryCache(now) {
  let removed = 0;
  let bytes = 0;
  if (!scraperDiskCache.isEnabled()) return { removed, bytes };

  let buckets;
  try {
    buckets = await fs.readdir(scraperDiskCache.DIR, { withFileTypes: true });
  } catch {
    return { removed, bytes };
  }

  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue;
    const maxAge = scraperDiskCache.ttlForBucket(bucket.name) + HOUR_MS;
    const dir = path.join(scraperDiskCache.DIR, bucket.name);
    let names;
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        const stat = await fs.stat(full);
        if (!stat.isFile()) continue;
        if (now - stat.mtimeMs <= maxAge) continue;
        if (await unlinkQuiet(full)) {
          removed += 1;
          bytes += stat.size;
        }
      } catch {
        /* raced with a writer */
      }
    }
  }
  return { removed, bytes };
}

/** Normalized v1 PNGs in API_CACHE_DIR, past TTL + retention. */
async function sweepApiCache(now) {
  let removed = 0;
  let bytes = 0;
  let names;
  try {
    names = await fs.readdir(API_CACHE_DIR);
  } catch {
    return { removed, bytes };
  }

  for (const name of names) {
    if (!name.endsWith('.png')) continue;
    const domain = name.slice(0, -4);
    try {
      const stat = await fs.stat(path.join(API_CACHE_DIR, name));
      if (!stat.isFile()) continue;
      if (now - stat.mtimeMs <= API_MAX_AGE_MS) continue;
      await unlinkQuiet(path.join(API_CACHE_DIR, name));
      await unlinkQuiet(path.join(API_CACHE_DIR, `${domain}.meta.json`));
      removed += 1;
      bytes += stat.size;
    } catch {
      /* raced with a writer */
    }
  }
  return { removed, bytes };
}

/**
 * True when this process should run the sweep now.
 *
 * Cluster workers all share the volume, so the lock file's mtime is used as a
 * "last swept" marker instead of electing a worker (worker ids change after a
 * respawn, and a restart would forget the election anyway). Two workers can
 * still slip through together; that is harmless, since every delete here
 * tolerates the file already being gone.
 */
async function claimSweep() {
  try {
    const stat = await fs.stat(LOCK_FILE);
    if (Date.now() - stat.mtimeMs < INTERVAL_MS) return false;
  } catch {
    // No lock yet: first run on this volume.
  }
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(LOCK_FILE, new Date().toISOString());
    return true;
  } catch {
    return false;
  }
}

function fmtMb(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

async function sweepOnce({ force = false } = {}) {
  if (!force && !(await claimSweep())) return null;

  const now = Date.now();
  const [images, discovery, api] = await Promise.all([
    sweepImageCache(now),
    sweepDiscoveryCache(now),
    sweepApiCache(now),
  ]);

  const total = images.bytes + discovery.bytes + api.bytes;
  const removed = images.removed + discovery.removed + api.removed;
  if (removed > 0) {
    console.log(
      `Cache sweep: removed ${removed} expired entries, freed ${fmtMb(total)} ` +
        `(icons ${images.removed}/${fmtMb(images.bytes)}, ` +
        `discovery ${discovery.removed}/${fmtMb(discovery.bytes)}, ` +
        `api ${api.removed}/${fmtMb(api.bytes)})`
    );
  }
  return { images, discovery, api };
}

function start() {
  if (!ENABLED) return;

  const run = () => {
    sweepOnce().catch((err) => {
      console.error('Cache sweep failed:', err.message);
    });
  };

  // Not at boot: the first requests after a restart are the ones that most
  // want the CPU, and a full walk of the volume is not urgent.
  const first = setTimeout(run, 5 * 60 * 1000);
  if (typeof first.unref === 'function') first.unref();

  const timer = setInterval(run, Math.max(HOUR_MS, INTERVAL_MS / 2));
  if (typeof timer.unref === 'function') timer.unref();
}

module.exports = { start, sweepOnce };

const { LRUCache } = require('lru-cache');
const fs = require('fs/promises');
const path = require('path');

const CACHE_DIR = process.env.CACHE_DIR || './cache';
const MEMORY_MAX = parseInt(process.env.MEMORY_CACHE_MAX || '500', 10);
const MEMORY_TTL = parseInt(process.env.MEMORY_CACHE_TTL || '3600', 10) * 1000;
const DISK_TTL = parseInt(process.env.DISK_CACHE_TTL || '86400', 10) * 1000;

const memoryCache = new LRUCache({
  max: MEMORY_MAX,
  ttl: MEMORY_TTL,
});

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

async function get(provider, domain, size) {
  const key = cacheKey(provider, domain, size);

  const memHit = memoryCache.get(key);
  if (memHit) return memHit;

  try {
    const file = diskPath(key);
    const stat = await fs.stat(file);
    const age = Date.now() - stat.mtimeMs;

    if (age > DISK_TTL) {
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

    memoryCache.set(key, entry);
    return entry;
  } catch {
    return null;
  }
}

async function set(provider, domain, size, entry) {
  const key = cacheKey(provider, domain, size);

  memoryCache.set(key, entry);

  try {
    await ensureCacheDir();
    const meta = { contentType: entry.contentType, provider: entry.provider };
    await Promise.all([
      fs.writeFile(diskPath(key), entry.buffer),
      fs.writeFile(metaPath(key), JSON.stringify(meta)),
    ]);
  } catch (err) {
    console.error(`Disk cache write failed for ${key}:`, err.message);
  }
}

module.exports = { get, set };

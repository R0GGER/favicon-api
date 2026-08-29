const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { DISK_CACHE_TTL_SECONDS } = require('./ttl');

const CACHE_DIR = process.env.CACHE_DIR || './cache';
const SCRAPER_DISK_CACHE_DIR =
  process.env.SCRAPER_DISK_CACHE_DIR || path.join(CACHE_DIR, 'scraper-discovery');
// Keep discovery on disk as long as image bytes by default (DISK_CACHE_TTL).
const TTL_MS =
  parseInt(
    process.env.SCRAPER_ICONS_CACHE_TTL || String(DISK_CACHE_TTL_SECONDS),
    10
  ) * 1000;

// Raw homepage HTML gets its own, much shorter lifetime.
//
// It is only an intermediate: fetchScraperAllIcons() consults the `icons`
// bucket first and never touches `page` once a domain's icon list is known. But
// a stored page is two orders of magnitude larger than any other bucket — on a
// real volume the five buckets measured 219 MB of HTML against 0.3 MB each for
// icons, manifest, probe and besticon. Keeping HTML for as long as the derived
// list buys almost nothing and costs almost everything.
const PAGE_TTL_MS = (() => {
  const n = parseInt(process.env.SCRAPER_PAGE_CACHE_TTL ?? '', 10);
  if (Number.isFinite(n) && n > 0) return n * 1000;
  return Math.min(TTL_MS, 6 * 3600 * 1000);
})();

const BUCKET_TTL_MS = { page: PAGE_TTL_MS };

/** Entry lifetime for one discovery bucket. Also used by src/cacheGc.js. */
function ttlForBucket(bucket) {
  return BUCKET_TTL_MS[bucket] ?? TTL_MS;
}

// Default = on. Persisting scraper discovery on disk lets it survive restarts
// and be shared across cluster workers, so an unset/empty value enables it;
// only an explicit falsey value (false/0/no/off) turns it off.
function parseEnabled(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === '') return true;
  return !['false', '0', 'no', 'off'].includes(raw);
}

const ENABLED = parseEnabled(process.env.SCRAPER_DISK_CACHE);

function isEnabled() {
  return ENABLED;
}

function sanitizeDomain(domain) {
  return String(domain).replace(/[^a-zA-Z0-9.-]/g, '_');
}

function hashKey(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex');
}

function filePath(bucket, key) {
  return path.join(SCRAPER_DISK_CACHE_DIR, bucket, `${key}.json`);
}

async function ensureBucket(bucket) {
  await fs.mkdir(path.join(SCRAPER_DISK_CACHE_DIR, bucket), { recursive: true });
}

async function readEntry(bucket, key) {
  if (!ENABLED) return undefined;

  try {
    const file = filePath(bucket, key);
    const raw = await fs.readFile(file, 'utf-8');
    const envelope = JSON.parse(raw);
    if (!envelope || typeof envelope.cachedAt !== 'number') {
      await fs.unlink(file).catch(() => {});
      return undefined;
    }
    if (Date.now() - envelope.cachedAt > ttlForBucket(bucket)) {
      await fs.unlink(file).catch(() => {});
      return undefined;
    }
    return envelope.data;
  } catch {
    return undefined;
  }
}

async function writeEntry(bucket, key, data) {
  if (!ENABLED) return;

  try {
    await ensureBucket(bucket);
    const envelope = { cachedAt: Date.now(), data };
    await fs.writeFile(filePath(bucket, key), JSON.stringify(envelope));
  } catch (err) {
    console.error(`Scraper disk cache write failed (${bucket}/${key}):`, err.message);
  }
}

async function deleteEntry(bucket, key) {
  if (!ENABLED) return;
  await fs.unlink(filePath(bucket, key)).catch(() => {});
}

function getPage(domain) {
  return readEntry('page', sanitizeDomain(domain));
}

function setPage(domain, data) {
  return writeEntry('page', sanitizeDomain(domain), data);
}

/** Drop a stored page, used to clear a cached HTML-fetch failure. */
function deletePage(domain) {
  return deleteEntry('page', sanitizeDomain(domain));
}

function getIcons(domain) {
  return readEntry('icons', sanitizeDomain(domain));
}

function setIcons(domain, data) {
  return writeEntry('icons', sanitizeDomain(domain), data);
}

function getBesticon(domain) {
  return readEntry('besticon', sanitizeDomain(domain));
}

function setBesticon(domain, data) {
  return writeEntry('besticon', sanitizeDomain(domain), data);
}

function getManifest(manifestUrl) {
  return readEntry('manifest', hashKey(manifestUrl));
}

function setManifest(manifestUrl, data) {
  return writeEntry('manifest', hashKey(manifestUrl), data);
}

function getProbe(href) {
  return readEntry('probe', hashKey(href));
}

function setProbe(href, data) {
  return writeEntry('probe', hashKey(href), data);
}

async function invalidateDomain(domain) {
  if (!ENABLED) return;
  const key = sanitizeDomain(domain);
  await Promise.all([
    deleteEntry('page', key),
    deleteEntry('icons', key),
    deleteEntry('besticon', key),
  ]);
}

module.exports = {
  DIR: SCRAPER_DISK_CACHE_DIR,
  TTL_MS,
  ttlForBucket,
  isEnabled,
  getPage,
  setPage,
  deletePage,
  getIcons,
  setIcons,
  getBesticon,
  setBesticon,
  getManifest,
  setManifest,
  getProbe,
  setProbe,
  invalidateDomain,
};

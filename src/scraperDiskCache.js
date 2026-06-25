const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const CACHE_DIR = process.env.CACHE_DIR || './cache';
const SCRAPER_DISK_CACHE_DIR =
  process.env.SCRAPER_DISK_CACHE_DIR || path.join(CACHE_DIR, 'scraper-discovery');
const TTL_MS =
  parseInt(process.env.SCRAPER_ICONS_CACHE_TTL || '3600', 10) * 1000;

function parseEnabled(value) {
  if (value === undefined || value === '') return false;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
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
    if (Date.now() - envelope.cachedAt > TTL_MS) {
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
  isEnabled,
  getPage,
  setPage,
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

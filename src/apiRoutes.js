const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const apiStore = require('./apiStore');
const { fetchBySourcePriority } = require('./apiScraper');
const { toPng256, TARGET_SIZE } = require('./imageNormalize');

const API_CACHE_DIR = process.env.API_CACHE_DIR || '/cache/api';
const API_CACHE_TTL_MS =
  parseInt(process.env.API_CACHE_TTL || '604800', 10) * 1000;
const CDN_MAX_AGE = parseInt(process.env.API_CACHE_TTL || '604800', 10);

// When false, /api/v1/favicon accepts any request without an API key and
// skips quota enforcement entirely. Intended for self-hosted setups that
// want a public, anonymous API. If a key IS still provided it is ignored —
// no validation, no usage tracking. Truthy: anything other than the strings
// "false" / "0" / "no" / "off" (case-insensitive).
const REQUIRE_KEY = (() => {
  const raw = String(process.env.API_REQUIRE_KEY ?? '').trim().toLowerCase();
  if (raw === '') return true;
  return !['false', '0', 'no', 'off'].includes(raw);
})();

// Same conservative shape as src/index.js#SERVICE_SLUG_RE, but for domains —
// also has to match the on-disk filename so we can serve it back from /cdn.
const SAFE_DOMAIN_RE = /^[a-z0-9][a-z0-9.-]*$/i;

let cacheDirEnsured = false;
async function ensureCacheDir() {
  if (cacheDirEnsured) return;
  await fs.mkdir(API_CACHE_DIR, { recursive: true });
  cacheDirEnsured = true;
}

function pngPath(domain) {
  return path.join(API_CACHE_DIR, `${domain}.png`);
}

function metaPath(domain) {
  return path.join(API_CACHE_DIR, `${domain}.meta.json`);
}

function jsonError(res, status, code, message, extra = {}) {
  return res.status(status).json({ error: message, code, ...extra });
}

function extractDomainFromUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  let candidate = trimmed;
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (!host || !host.includes('.')) return null;
  if (!SAFE_DOMAIN_RE.test(host)) return null;
  return host;
}

function getRawKeyFromRequest(req) {
  const header = req.get('authorization');
  if (header && /^bearer\s+/i.test(header)) {
    return header.replace(/^bearer\s+/i, '').trim();
  }
  if (typeof req.query.key === 'string' && req.query.key.trim()) {
    return req.query.key.trim();
  }
  return null;
}

function baseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function buildCdnUrl(req, domain) {
  return `${baseUrl(req)}/cdn/favicons/${encodeURIComponent(domain)}.png`;
}

async function readCachedEntry(domain) {
  try {
    const file = pngPath(domain);
    const stat = await fs.stat(file);
    const age = Date.now() - stat.mtimeMs;
    if (age > API_CACHE_TTL_MS) return null;

    const metaRaw = await fs.readFile(metaPath(domain), 'utf8').catch(() => '{}');
    let meta = {};
    try {
      meta = JSON.parse(metaRaw);
    } catch {
      meta = {};
    }
    return {
      mtime: stat.mtimeMs,
      sourceType: meta.sourceType || 'png',
      cachedAt: meta.cachedAt || new Date(stat.mtimeMs).toISOString(),
    };
  } catch {
    return null;
  }
}

async function writeCachedEntry(domain, pngBuffer, sourceType) {
  await ensureCacheDir();
  const cachedAt = new Date().toISOString();
  await Promise.all([
    fs.writeFile(pngPath(domain), pngBuffer),
    fs.writeFile(
      metaPath(domain),
      JSON.stringify({ sourceType, cachedAt }, null, 0)
    ),
  ]);
  return cachedAt;
}

const router = express.Router();

router.get('/api/v1/favicon', async (req, res) => {
  let keyRow = null;

  if (REQUIRE_KEY) {
    const rawKey = getRawKeyFromRequest(req);
    if (!rawKey) {
      return jsonError(
        res,
        401,
        'missing_api_key',
        'Missing API key. Provide Authorization: Bearer <key> or ?key=<key>.'
      );
    }
    try {
      keyRow = apiStore.verifyKey(rawKey);
    } catch (err) {
      console.error('API key verification error:', err.message);
      return jsonError(res, 500, 'internal_error', 'Internal error.');
    }
    if (!keyRow) {
      return jsonError(res, 401, 'invalid_api_key', 'Invalid or revoked API key.');
    }
  }

  const urlParam = typeof req.query.url === 'string' ? req.query.url : '';
  if (!urlParam) {
    return jsonError(
      res,
      400,
      'missing_url',
      'Missing required "url" query parameter.'
    );
  }
  const domain = extractDomainFromUrl(urlParam);
  if (!domain) {
    return jsonError(res, 400, 'invalid_url', 'Could not parse url into a domain.');
  }

  const period = apiStore.currentPeriod();

  if (keyRow) {
    const used = apiStore.getMonthlyUsage(keyRow.id, period);
    if (keyRow.monthlyLimit > 0 && used >= keyRow.monthlyLimit) {
      return jsonError(
        res,
        429,
        'quota_exceeded',
        `Monthly quota of ${keyRow.monthlyLimit} calls exceeded.`,
        { plan: keyRow.plan, limit: keyRow.monthlyLimit, used, period }
      );
    }
  }

  try {
    const cached = await readCachedEntry(domain);
    if (cached) {
      if (keyRow) apiStore.incrementUsage(keyRow.id, period);
      return res.json({
        url: buildCdnUrl(req, domain),
        domain,
        width: TARGET_SIZE,
        height: TARGET_SIZE,
        format: 'png',
        sourceType: cached.sourceType,
        cached: true,
        cachedAt: cached.cachedAt,
      });
    }

    const hit = await fetchBySourcePriority(domain);
    if (!hit) {
      return jsonError(
        res,
        422,
        'favicon_not_found',
        'No favicon could be found for this URL.',
        { domain }
      );
    }

    let normalized;
    try {
      normalized = await toPng256(hit.buffer, { hintFormat: hit.contentType });
    } catch (err) {
      console.error(`API normalize error for ${domain}:`, err.message);
      return jsonError(
        res,
        422,
        'favicon_not_processable',
        'Found a favicon but could not decode it.',
        { domain, sourceType: hit.sourceType, sourceUrl: hit.sourceUrl }
      );
    }

    const cachedAt = await writeCachedEntry(domain, normalized.buffer, hit.sourceType);
    if (keyRow) apiStore.incrementUsage(keyRow.id, period);

    return res.json({
      url: buildCdnUrl(req, domain),
      domain,
      width: TARGET_SIZE,
      height: TARGET_SIZE,
      format: 'png',
      sourceType: hit.sourceType,
      cached: false,
      cachedAt,
    });
  } catch (err) {
    console.error('API /favicon error:', err.message);
    return jsonError(res, 500, 'internal_error', 'Internal error.');
  }
});

router.get('/cdn/favicons/:domainPng', async (req, res) => {
  const raw = req.params.domainPng || '';
  if (!raw.toLowerCase().endsWith('.png')) {
    return res.status(404).json({ error: 'Not found.' });
  }
  const domain = raw.slice(0, -4).toLowerCase();
  if (!SAFE_DOMAIN_RE.test(domain)) {
    return res.status(400).json({ error: 'Invalid domain.' });
  }

  try {
    const file = pngPath(domain);
    const buffer = await fs.readFile(file);
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', `public, max-age=${CDN_MAX_AGE}, immutable`);
    return res.send(buffer);
  } catch {
    return res.status(404).json({ error: 'Not found.' });
  }
});

module.exports = router;

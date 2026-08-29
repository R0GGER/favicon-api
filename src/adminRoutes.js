/**
 * The /admin preload manager: one HTML shell plus a JSON API over the preload
 * database. Mounted only when ADMIN_SESSION_SECRET and ADMIN_PASSWORD_HASH are both
 * configured (see src/adminAuth.js), so a deployment that never sets them up
 * keeps the exact route table it had before.
 *
 * Every write goes through src/preloadAdmin.js, the same layer the CLI uses, so
 * the two front ends cannot drift apart on validation or CSV handling.
 */
const express = require('express');
const preloadStore = require('./preloadStore');
const preloadAdmin = require('./preloadAdmin');
const adminAuth = require('./adminAuth');
const { SERVICE_DOMAINS } = require('./serviceDomains');

function jsonError(res, status, code, message) {
  return res.status(status).json({ error: message, code });
}

/**
 * Admin responses are private: no shared caches, no indexing, no framing, and
 * none of the permissive CORS headers the global middleware adds for the icon
 * routes (an admin JSON body must never be readable cross-origin).
 */
function privateResponse(req, res, next) {
  res.removeHeader('Access-Control-Allow-Origin');
  res.removeHeader('Access-Control-Allow-Private-Network');
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  next();
}

function boolField(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value;
  return preloadAdmin.parseBoolField(value);
}

function intField(value, { min = -1e9, max = 1e9 } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return NaN;
  return parsed;
}

function createAdminRouter({ renderPage, port = 3000 } = {}) {
  const router = express.Router();
  const baseUrl = `http://127.0.0.1:${port}`;

  router.use(privateResponse);
  router.use(express.json({ limit: '4mb' }));
  router.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // --- page + session -------------------------------------------------------

  router.get('/', renderPage);

  // Username + password for a session cookie. The custom header is required
  // here too: without it a cross-site form post could plant a session in the
  // operator's browser.
  router.post('/login', (req, res) => {
    if (req.get('x-admin-request') !== '1') {
      return jsonError(res, 403, 'csrf', 'Missing X-Admin-Request header.');
    }

    const ip = req.ip || 'unknown';
    if (adminAuth.loginBlocked(ip)) {
      return jsonError(res, 429, 'too_many_attempts', 'Too many failed attempts. Try again later.');
    }

    const body = req.body || {};
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const remember = preloadAdmin.parseBoolField(body.remember) === true;

    // One message for every failure, so it never says which field was wrong.
    const account = username && password ? adminAuth.verifyCredentials(username, password) : null;
    if (!account) {
      adminAuth.recordLoginFailure(ip);
      return jsonError(res, 401, 'invalid_credentials', 'Invalid username or password.');
    }

    adminAuth.resetLoginAttempts(ip);
    const ttl = adminAuth.startSession(req, res, { sub: account.sub, remember });
    res.json({ ok: true, sub: account.sub, remember, expiresIn: ttl });
  });

  router.post('/logout', (req, res) => {
    adminAuth.clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  // --- authenticated JSON API ----------------------------------------------

  const api = express.Router();
  api.use(adminAuth.requireAdminApi);

  api.get('/session', (req, res) => {
    res.json({
      authenticated: true,
      sub: req.adminSession.sub || 'admin',
      remember: Boolean(req.adminSession.rem),
      expiresAt: new Date(req.adminSession.exp * 1000).toISOString(),
    });
  });

  api.get('/domains', (req, res) => {
    const limit = intField(req.query.limit, { min: 1, max: 500 });
    const offset = intField(req.query.offset, { min: 0 });
    res.json(
      preloadAdmin.listDomains({
        query: req.query.query || '',
        status: req.query.status || 'all',
        sort: req.query.sort || 'rank',
        dir: req.query.dir || 'desc',
        limit: Number.isNaN(limit) || limit === null ? 50 : limit,
        offset: Number.isNaN(offset) || offset === null ? 0 : offset,
      })
    );
  });

  api.post('/domains', (req, res) => {
    const body = req.body || {};
    const domain = preloadAdmin.normalizeDomain(body.domain);
    if (!domain) return jsonError(res, 400, 'invalid_domain', `Not a valid domain: "${body.domain}".`);
    if (preloadStore.isBlocked(domain)) {
      return jsonError(res, 409, 'blocked', `${domain} matches a blocklist pattern. Unblock it first.`);
    }

    const rank = intField(body.rank, { min: 0 });
    if (Number.isNaN(rank)) return jsonError(res, 400, 'invalid_rank', 'Rank must be a positive number.');

    let iconUrl = null;
    if (body.iconUrl) {
      const parsed = preloadAdmin.parseIconUrl(body.iconUrl);
      if (!parsed.ok) return jsonError(res, 400, 'invalid_icon_url', parsed.error);
      iconUrl = parsed.href;
    }

    const changed = preloadStore.upsertManual({
      domain,
      rank,
      source: String(body.source || 'manual').slice(0, 32),
      iconUrl,
      enabled: boolField(body.enabled) === false ? false : true,
      lockRank: rank !== null,
    });
    if (!changed) return jsonError(res, 500, 'write_failed', `Could not add ${domain}.`);
    res.json({ ok: true, domain: preloadStore.getDomain(domain) });
  });

  api.post('/domains/bulk', (req, res) => {
    const body = req.body || {};
    const result = preloadAdmin.bulkDomains({
      action: body.action,
      domains: body.domains,
    });
    if (!result.ok) return jsonError(res, 400, result.code, result.error);
    res.json(result);
  });

  api.patch('/domains/:domain', (req, res) => {
    const domain = preloadAdmin.normalizeDomain(req.params.domain);
    if (!domain) return jsonError(res, 400, 'invalid_domain', 'Not a valid domain.');
    if (!preloadStore.getDomain(domain)) {
      return jsonError(res, 404, 'not_found', `${domain} is not in the list.`);
    }

    const body = req.body || {};
    let touched = 0;

    const enabled = boolField(body.enabled);
    if (enabled !== null) {
      if (enabled && preloadStore.isBlocked(domain)) {
        return jsonError(res, 409, 'blocked', `${domain} matches a blocklist pattern. Unblock it first.`);
      }
      touched += preloadStore.setEnabled(domain, enabled);
    }

    if (body.rank !== undefined) {
      const rank = intField(body.rank, { min: 0 });
      if (Number.isNaN(rank) || rank === null) {
        return jsonError(res, 400, 'invalid_rank', 'Rank must be a positive number.');
      }
      touched += preloadStore.setRank(domain, rank);
    }

    if (body.iconUrl !== undefined) {
      if (!body.iconUrl) {
        touched += preloadStore.setIconUrl(domain, null);
      } else {
        const parsed = preloadAdmin.parseIconUrl(body.iconUrl);
        if (!parsed.ok) return jsonError(res, 400, 'invalid_icon_url', parsed.error);
        touched += preloadStore.setIconUrl(domain, parsed.href);
      }
    }

    if (touched === 0) return jsonError(res, 400, 'nothing_to_do', 'No changes were requested.');
    res.json({ ok: true, domain: preloadStore.getDomain(domain) });
  });

  api.delete('/domains/:domain', (req, res) => {
    const domain = preloadAdmin.normalizeDomain(req.params.domain);
    if (!domain) return jsonError(res, 400, 'invalid_domain', 'Not a valid domain.');
    const changed = preloadStore.removeDomain(domain);
    if (!changed) return jsonError(res, 404, 'not_found', `${domain} is not in the list.`);
    res.json({ ok: true, removed: domain });
  });

  // --- blocklist ------------------------------------------------------------

  api.get('/blocklist', (_req, res) => {
    res.json({ rows: preloadStore.listBlocks() });
  });

  api.post('/blocklist', (req, res) => {
    const body = req.body || {};
    const pattern = preloadAdmin.normalizePattern(body.pattern);
    if (!pattern) {
      return jsonError(
        res,
        400,
        'invalid_pattern',
        'Use an exact host (example.com) or a wildcard (*.example.com).'
      );
    }
    const reason = body.reason ? String(body.reason).slice(0, 200) : null;
    const { added, disabled } = preloadStore.addBlock(pattern, reason);
    res.json({ ok: true, pattern, added, disabled });
  });

  // The pattern travels as a query parameter: a wildcard like *.example.com in
  // a path segment is awkward to encode consistently across proxies.
  api.delete('/blocklist', (req, res) => {
    const pattern = preloadAdmin.normalizePattern(req.query.pattern);
    if (!pattern) return jsonError(res, 400, 'invalid_pattern', 'Missing pattern.');
    const changed = preloadStore.removeBlock(pattern);
    if (!changed) return jsonError(res, 404, 'not_found', `No blocklist entry for ${pattern}.`);
    res.json({ ok: true, removed: pattern });
  });

  api.post('/blocklist/seed', (_req, res) => {
    let added = 0;
    let disabled = 0;
    for (const domain of SERVICE_DOMAINS) {
      const result = preloadStore.addBlock(`*.${domain}`, 'service/infra domain');
      added += result.added;
      disabled += result.disabled;
    }
    res.json({ ok: true, added, disabled });
  });

  // --- stats ----------------------------------------------------------------

  api.get('/stats', (_req, res) => {
    res.json({
      ...preloadStore.stats(),
      hits: preloadStore.hitsByPeriod({ months: preloadStore.RANK_MONTHS + 3 }),
      config: {
        dbPath: preloadStore.DB_PATH,
        trackHits: preloadStore.TRACK_HITS,
        minRank: preloadStore.MIN_RANK,
        rankMonths: preloadStore.RANK_MONTHS,
        autoDisableAfter: preloadStore.AUTO_DISABLE_AFTER,
        overrideReloadMs: preloadStore.RELOAD_THROTTLE_MS,
      },
    });
  });

  api.post('/recalc', (req, res) => {
    const months = intField((req.body || {}).months, { min: 1, max: 120 });
    if (Number.isNaN(months)) return jsonError(res, 400, 'invalid_months', 'Months must be 1 or higher.');
    const changed = preloadStore.recalcRanks({
      months: months === null ? preloadStore.RANK_MONTHS : months,
    });
    res.json({ ok: true, changed, months: months === null ? preloadStore.RANK_MONTHS : months });
  });

  // --- CSV ------------------------------------------------------------------

  api.get('/export.csv', (req, res) => {
    const rows = preloadStore.listAll({ includeDisabled: req.query.enabledOnly !== '1' });
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="preload_domains.csv"');
    res.send(preloadAdmin.toCsv(rows));
  });

  api.post('/import', (req, res) => {
    const csv = String((req.body || {}).csv || '');
    if (!csv.trim()) return jsonError(res, 400, 'empty_csv', 'Paste or upload a CSV first.');
    const result = preloadAdmin.importCsv(csv);
    if (result.total === 0) return jsonError(res, 400, 'no_rows', 'No data rows found in that CSV.');
    res.json({ ok: true, ...result });
  });

  // --- preload run ----------------------------------------------------------

  api.get('/preload/run', (_req, res) => {
    res.json(preloadAdmin.readRunStatus({ withLog: true }));
  });

  api.get('/preload/preview', async (req, res) => {
    try {
      const data = await preloadAdmin.previewDomains({
        source: req.query.source,
        limit: req.query.limit,
        minRank: req.query.minRank,
        adult: req.query.adult,
        excludeAdult: req.query.excludeAdult === '1',
      });
      res.json(data);
    } catch (err) {
      const message = err && err.message ? err.message : 'Could not load that ranking.';
      return jsonError(res, 502, 'preview_failed', message);
    }
  });

  api.post('/preload/run', (req, res) => {
    const body = req.body || {};
    const result = preloadAdmin.startRun(
      {
        source: body.source,
        limit: body.limit,
        minRank: body.minRank,
        concurrency: body.concurrency,
        timeout: body.timeout,
        adult: body.adult,
        excludeAdult: Boolean(body.excludeAdult),
        dryRun: Boolean(body.dryRun),
        skipStandard: Boolean(body.skipStandard),
        skipV1: Boolean(body.skipV1),
        skipSizes: Boolean(body.skipSizes),
        startedBy: req.adminSession.sub || 'admin',
      },
      { baseUrl }
    );
    if (!result.ok) {
      const status = result.error === 'already_running' ? 409 : 500;
      const message =
        result.error === 'already_running' ? 'A preload run is already in progress.' : result.error;
      return res.status(status).json({ error: message, code: result.error, status: result.status });
    }
    res.json({ ok: true, status: result.status });
  });

  api.post('/preload/stop', (_req, res) => {
    const result = preloadAdmin.stopRun();
    if (!result.ok) {
      const status = result.error === 'not_running' ? 409 : 500;
      return jsonError(res, status, result.error, 'No preload run is in progress.');
    }
    res.json({ ok: true });
  });

  router.use('/api', api);

  // A stray /admin/... path should not fall through to the favicon catch-all.
  router.use((req, res) => {
    if (req.path.startsWith('/api')) return jsonError(res, 404, 'not_found', 'Unknown admin endpoint.');
    res.status(404).send('Not found');
  });

  return router;
}

module.exports = { createAdminRouter };

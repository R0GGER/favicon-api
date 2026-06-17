const express = require('express');
const path = require('path');
const { fetchGoogle, fetchDuckDuckGo, fetchYandex, fetchFaviconSo, fetchVemetric, fetchFaviconDev, PROVIDERS } = require('./providers');
const { pickBest, fetchWithCache } = require('./bestPick');
const cache = require('./cache');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.set('trust proxy', true);

app.use(express.static(path.join(__dirname, 'public')));

const VALID_GOOGLE_SIZES = new Set([16, 32, 64, 128]);
const VALID_VEMETRIC_FORMATS = new Set(['png', 'jpg', 'webp']);
const CACHE_CONTROL = 'public, max-age=86400';

function sendFavicon(res, entry) {
  res.set('Content-Type', entry.contentType);
  res.set('Cache-Control', CACHE_CONTROL);
  res.set('X-Favicon-Source', entry.provider);
  res.send(entry.buffer);
}

function extractDomain(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const domain = raw.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();
  if (!domain || !domain.includes('.')) return null;
  return domain;
}

// Google favicon proxy: /g/:size/:domain
app.get('/g/:size/:domain', async (req, res) => {
  const size = parseInt(req.params.size, 10);
  if (!VALID_GOOGLE_SIZES.has(size)) {
    return res.status(400).json({ error: 'Invalid size. Use 16, 32, 64, or 128.' });
  }

  const domain = extractDomain(req.params.domain);
  if (!domain) return res.status(400).json({ error: 'Invalid domain.' });

  try {
    const entry = await fetchWithCache('google', domain, size, () => fetchGoogle(domain, size));
    if (!entry) return res.status(502).json({ error: 'Upstream fetch failed.' });
    sendFavicon(res, entry);
  } catch (err) {
    console.error('Google proxy error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
});

// DuckDuckGo favicon proxy: /d/:domain
app.get('/d/:domain', async (req, res) => {
  const domain = extractDomain(req.params.domain);
  if (!domain) return res.status(400).json({ error: 'Invalid domain.' });

  try {
    const entry = await fetchWithCache('duckduckgo', domain, null, () => fetchDuckDuckGo(domain));
    if (!entry) return res.status(502).json({ error: 'Upstream fetch failed.' });
    sendFavicon(res, entry);
  } catch (err) {
    console.error('DuckDuckGo proxy error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
});

// Yandex favicon proxy: /y/:domain
app.get('/y/:domain', async (req, res) => {
  const domain = extractDomain(req.params.domain);
  if (!domain) return res.status(400).json({ error: 'Invalid domain.' });

  try {
    const entry = await fetchWithCache('yandex', domain, null, () => fetchYandex(domain));
    if (!entry) return res.status(502).json({ error: 'Upstream fetch failed.' });
    sendFavicon(res, entry);
  } catch (err) {
    console.error('Yandex proxy error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
});

// Favicon.so proxy: /f/:domain
app.get('/f/:domain', async (req, res) => {
  const domain = extractDomain(req.params.domain);
  if (!domain) return res.status(400).json({ error: 'Invalid domain.' });

  try {
    const entry = await fetchWithCache('faviconso', domain, null, () => fetchFaviconSo(domain));
    if (!entry) return res.status(502).json({ error: 'Upstream fetch failed.' });
    sendFavicon(res, entry);
  } catch (err) {
    console.error('Favicon.so proxy error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
});

// Vemetric favicon proxy: /v/:domain
app.get('/v/:domain', async (req, res) => {
  const domain = extractDomain(req.params.domain);
  if (!domain) return res.status(400).json({ error: 'Invalid domain.' });

  const size = req.query.size ? parseInt(req.query.size, 10) : null;
  const format = req.query.format || null;

  if (format && !VALID_VEMETRIC_FORMATS.has(format)) {
    return res.status(400).json({ error: 'Invalid format. Use png, jpg, or webp.' });
  }

  try {
    const cacheSize = size || format || null;
    const entry = await fetchWithCache('vemetric', domain, cacheSize, () => fetchVemetric(domain, size, format));
    if (!entry) return res.status(502).json({ error: 'Upstream fetch failed.' });
    sendFavicon(res, entry);
  } catch (err) {
    console.error('Vemetric proxy error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
});

// Favicon-3j1 proxy: /p/:domain
app.get('/p/:domain', async (req, res) => {
  const domain = extractDomain(req.params.domain);
  if (!domain) return res.status(400).json({ error: 'Invalid domain.' });

  try {
    const entry = await fetchWithCache('favicondev', domain, null, () => fetchFaviconDev(domain));
    if (!entry) return res.status(502).json({ error: 'Upstream fetch failed.' });
    sendFavicon(res, entry);
  } catch (err) {
    console.error('Favicon-3j1 proxy error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
});

// JSON list of all favicon endpoint URLs for a domain: /:domain/json
app.get('/:domain/json', (req, res) => {
  const domain = extractDomain(req.params.domain);
  if (!domain) return res.status(400).json({ error: 'Invalid domain.' });

  const host = `${req.protocol}://${req.get('host')}`;
  const encoded = encodeURIComponent(domain);

  res.set('Cache-Control', CACHE_CONTROL);
  res.json({
    domain,
    endpoints: {
      best: {
        proxy: `${host}/${encoded}`,
        source: null,
      },
      google: {
        '16': { proxy: `${host}/g/16/${encoded}`, source: PROVIDERS.google(domain, 16) },
        '32': { proxy: `${host}/g/32/${encoded}`, source: PROVIDERS.google(domain, 32) },
        '64': { proxy: `${host}/g/64/${encoded}`, source: PROVIDERS.google(domain, 64) },
        '128': { proxy: `${host}/g/128/${encoded}`, source: PROVIDERS.google(domain, 128) },
      },
      duckduckgo: {
        proxy: `${host}/d/${encoded}`,
        source: PROVIDERS.duckduckgo(domain),
      },
      yandex: {
        proxy: `${host}/y/${encoded}`,
        source: PROVIDERS.yandex(domain),
      },
      faviconso: {
        proxy: `${host}/f/${encoded}`,
        source: PROVIDERS.faviconSo(domain),
      },
      vemetric: {
        default: { proxy: `${host}/v/${encoded}`, source: PROVIDERS.vemetric(domain) },
        sized: { proxy: `${host}/v/${encoded}?size=64`, source: PROVIDERS.vemetric(domain, 64) },
        webp: { proxy: `${host}/v/${encoded}?format=webp`, source: PROVIDERS.vemetric(domain, null, 'webp') },
      },
      favicondev: {
        proxy: `${host}/p/${encoded}`,
        source: PROVIDERS.faviconDev(domain),
      },
    },
  });
});

// Direct / best-pick favicon: /:domain
app.get('/:domain', async (req, res) => {
  const domain = extractDomain(req.params.domain);
  if (!domain) return res.status(400).json({ error: 'Invalid domain.' });

  try {
    const entry = await pickBest(domain);
    if (entry.notFound) {
      res.status(404);
    }
    sendFavicon(res, entry);
  } catch (err) {
    console.error('Best-pick error:', err.message);
    res.status(500).json({ error: 'Internal error.' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Favicon proxy listening on port ${PORT}`);
});

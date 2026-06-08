const express = require('express');
const path = require('path');
const { fetchGoogle, fetchDuckDuckGo, fetchYandex } = require('./providers');
const { pickBest, fetchWithCache } = require('./bestPick');
const cache = require('./cache');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(express.static(path.join(__dirname, 'public')));

const VALID_GOOGLE_SIZES = new Set([16, 32, 64, 128]);
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

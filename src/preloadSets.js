/**
 * Curated worldwide top-site lists for preload runs.
 *
 *   similarweb  — most visited (https://www.similarweb.com/top-websites/)
 *   backlinko   — most popular by monthly visits (https://backlinko.com/most-popular-websites,
 *                 Semrush Traffic Analytics; NSFW already removed by the publisher)
 *
 * Live HTML is scraped on each run. If the page layout changes or the request
 * fails, the July/August 2026 snapshots below are used instead.
 *
 * SimilarWeb's public ranking is the top 50. When a caller asks for more, the
 * remaining slots are filled from Backlinko (same worldwide traffic idea, no
 * extra adult sites) so `--limit 100` still produces 100 domains.
 */
const { isAdultDomain } = require('./adultDomains');
const { isServiceDomain } = require('./serviceDomains');

const SIMILARWEB_URL = 'https://www.similarweb.com/top-websites/';
const BACKLINKO_URL = 'https://backlinko.com/most-popular-websites';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/** SimilarWeb Adult-category domains in the July 2026 worldwide top 50. */
const SIMILARWEB_ADULT = new Set([
  'pornhub.com',
  'xhamster.com',
  'xvideos.com',
  'stripchat.com',
]);

/**
 * SimilarWeb worldwide top 50, July 2026 (page updated 1 Aug 2026).
 * https://www.similarweb.com/top-websites/
 */
const SNAPSHOT_SIMILARWEB = [
  'google.com', 'youtube.com', 'facebook.com', 'instagram.com', 'chatgpt.com',
  'x.com', 'reddit.com', 'bing.com', 'tiktok.com', 'whatsapp.com',
  'wikipedia.org', 'yahoo.co.jp', 'yahoo.com', 'yandex.ru', 'amazon.com',
  'gemini.google.com', 'linkedin.com', 'baidu.com', 'naver.com', 'netflix.com',
  'pinterest.com', 'bet.br', 'live.com', 'pornhub.com', 'cloud.microsoft',
  'bilibili.com', 'xhamster.com', 'dzen.ru', 'weather.com', 'twitch.tv',
  'temu.com', 'microsoft.com', 'claude.ai', 'xvideos.com', 'samsung.com',
  'fandom.com', 'canva.com', 'news.yahoo.co.jp', 'mail.ru', 'globo.com',
  'duckduckgo.com', 'booking.com', 'stripchat.com', 't.me', 'ebay.com',
  'discord.com', 'brave.com', 'imdb.com', 'bbc.co.uk', 'github.com',
];

/**
 * Backlinko / Semrush top 100 most-visited sites (list dated Apr 2026, traffic
 * figures current as of the Aug 2026 page). NSFW already stripped by Backlinko.
 * https://backlinko.com/most-popular-websites
 */
const SNAPSHOT_BACKLINKO = [
  'google.com', 'youtube.com', 'facebook.com', 'instagram.com', 'chatgpt.com',
  'reddit.com', 'wikipedia.org', 'x.com', 'whatsapp.com', 'yahoo.com',
  'amazon.com', 'tiktok.com', 'duckduckgo.com', 'bing.com', 'yahoo.co.jp',
  'linkedin.com', 'microsoftonline.com', 'netflix.com', 'temu.com', 'microsoft.com',
  'msn.com', 'live.com', 'fandom.com', 'pinterest.com', 'weather.com',
  'twitch.tv', 'yandex.ru', 'gemini.google.com', 'github.com', 'canva.com',
  'discord.com', 'spotify.com', 'naver.com', 'apple.com', 'office.com',
  'globo.com', 'paypal.com', 'brave.com', 'imdb.com', 'twitter.com',
  'claude.ai', 'roblox.com', 'aliexpress.com', 'vk.com', 'ebay.com',
  'nytimes.com', 'bbc.com', 'telegram.org', 'walmart.com', 'amazon.co.jp',
  'supercell.com', 'dailymotion.com', 'espn.com', 'usps.com', 'openai.com',
  'cnn.com', 'samsung.com', 'booking.com', 'zoom.us', 'adobe.com',
  'bbc.co.uk', 'ecosia.org', 'indeed.com', 'uol.com.br', 'amazon.de',
  'etsy.com', 'bilibili.com', 'rakuten.co.jp', 'steampowered.com', 'quora.com',
  'instructure.com', 'mail.ru', 'shopify.com', 'disneyplus.com', 'amazon.co.uk',
  'shein.com', 'theguardian.com', 'steamcommunity.com', 'deepseek.com', 'primevideo.com',
  'shop.app', 'marca.com', 'gmail.com', 'linktr.ee', 'amazon.in',
  'accuweather.com', 'ilovepdf.com', 'tradingview.com', 'threads.com', 'hbomax.com',
  'messenger.com', 'genius.com', 'chat.deepseek.com', 'trendyol.com', 'opera.com',
  'ikea.com', 'ozon.ru', 'snapchat.com', 'google.com.br', 'acesso.gov.br',
];

function normalizeHost(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const host = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');
  return host && host.includes('.') ? host : null;
}

function toRows(domains, adultSet) {
  return domains
    .map((domain) => {
      const host = normalizeHost(domain);
      if (!host) return null;
      return { domain: host, adult: !!(adultSet && adultSet.has(host)) };
    })
    .filter(Boolean);
}

async function fetchHtml(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseSimilarwebHtml(html) {
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  const rows = [];
  const seen = new Set();
  $('a[href*="/website/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const match = href.match(/\/website\/([^/?#]+)/i);
    if (!match) return;
    const domain = normalizeHost(decodeURIComponent(match[1]));
    if (!domain || seen.has(domain)) return;
    const tr = $(el).closest('tr');
    let category = '';
    tr.find('a[href*="/top-websites/"]').each((__, a) => {
      const text = $(a).text().replace(/\s+/g, ' ').trim();
      if (text && !category) category = text;
    });
    seen.add(domain);
    rows.push({
      domain,
      adult: /^adult$/i.test(category) || /(^|>)\s*adult\s*$/i.test(category),
    });
  });
  return rows;
}

function parseBacklinkoHtml(html) {
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  const rows = [];
  const seen = new Set();
  $('table tr').each((_, el) => {
    const cells = $(el)
      .find('td')
      .map((__, td) => $(td).text().replace(/\s+/g, ' ').trim())
      .get();
    if (cells.length < 2) return;
    if (!/^\d+$/.test(cells[0])) return;
    const domain = normalizeHost(cells[1]);
    if (!domain || seen.has(domain)) return;
    seen.add(domain);
    rows.push({ domain, adult: false });
  });
  return rows;
}

async function loadSimilarweb(timeoutMs) {
  try {
    const html = await fetchHtml(SIMILARWEB_URL, timeoutMs);
    const rows = parseSimilarwebHtml(html);
    if (rows.length >= 20) return { rows, live: true };
    console.warn(
      `SimilarWeb page parsed ${rows.length} rows (expected ~50); using the built-in snapshot.`,
    );
  } catch (err) {
    console.warn(`SimilarWeb fetch failed (${err.message || err}); using the built-in snapshot.`);
  }
  return { rows: toRows(SNAPSHOT_SIMILARWEB, SIMILARWEB_ADULT), live: false };
}

async function loadBacklinko(timeoutMs) {
  try {
    const html = await fetchHtml(BACKLINKO_URL, timeoutMs);
    const rows = parseBacklinkoHtml(html);
    if (rows.length >= 50) return { rows, live: true };
    console.warn(
      `Backlinko page parsed ${rows.length} rows (expected 100); using the built-in snapshot.`,
    );
  } catch (err) {
    console.warn(`Backlinko fetch failed (${err.message || err}); using the built-in snapshot.`);
  }
  return { rows: toRows(SNAPSHOT_BACKLINKO), live: false };
}

function takeRows(rows, { excludeAdult, limit }) {
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const domain = normalizeHost(row.domain);
    if (!domain || seen.has(domain)) continue;
    if (excludeAdult && (row.adult || isAdultDomain(domain))) continue;
    seen.add(domain);
    out.push(domain);
    if (out.length >= limit) break;
  }
  return out;
}

function pushFiltered(row, { excludeAdult, seen, out }) {
  const domain = normalizeHost(row.domain);
  if (!domain || seen.has(domain)) return false;
  if (excludeAdult && (row.adult || isAdultDomain(domain))) return false;
  seen.add(domain);
  out.push(domain);
  return true;
}

/**
 * Most visited: SimilarWeb worldwide ranking. Public page is top 50; extra
 * slots (and gaps from --adult exclude) are filled from Backlinko so a
 * top-100 request still returns 100.
 */
async function fetchSimilarwebDomains(limit, { excludeAdult = false, timeoutMs = 30000 } = {}) {
  const sw = await loadSimilarweb(timeoutMs);
  const seen = new Set();
  const domains = [];
  let filled = 0;
  for (const row of sw.rows) {
    if (domains.length >= limit) break;
    pushFiltered(row, { excludeAdult, seen, out: domains });
  }
  if (domains.length < limit) {
    const bl = await loadBacklinko(timeoutMs);
    for (const row of bl.rows) {
      if (domains.length >= limit) break;
      if (pushFiltered(row, { excludeAdult, seen, out: domains })) filled += 1;
    }
  }
  return {
    domains,
    live: sw.live,
    filled,
    available: sw.rows.length,
  };
}

/** Most popular: Backlinko / Semrush top 100 (NSFW already removed). */
async function fetchBacklinkoDomains(limit, { excludeAdult = false, timeoutMs = 30000 } = {}) {
  const bl = await loadBacklinko(timeoutMs);
  return {
    domains: takeRows(bl.rows, { excludeAdult, limit }),
    live: bl.live,
    filled: 0,
    available: bl.rows.length,
  };
}

const DATAFORSEO_AJAX_URL = 'https://dataforseo.com/wp-admin/admin-ajax.php';

/** Highest keyword rank: DataForSEO worldwide top-1000 (location 0). */
async function fetchDataforseoDomains(limit, { excludeAdult = false, timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let json;
  try {
    const res = await fetch(DATAFORSEO_AJAX_URL, {
      method: 'POST',
      headers: {
        'User-Agent': BROWSER_UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json',
      },
      body: 'action=dfs_ranked_domains&location=0',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`DataForSEO request failed (HTTP ${res.status}).`);
    json = await res.json();
  } finally {
    clearTimeout(timer);
  }
  if (!Array.isArray(json) || json.length === 0) {
    throw new Error('DataForSEO returned no ranked domains.');
  }
  json.sort((a, b) => (a.position || 0) - (b.position || 0));
  const seen = new Set();
  const domains = [];
  for (const row of json) {
    const domain = normalizeHost(row.domain);
    if (!domain || seen.has(domain)) continue;
    if (isServiceDomain(domain)) continue;
    if (excludeAdult && isAdultDomain(domain)) continue;
    seen.add(domain);
    domains.push(domain);
    if (domains.length >= limit) break;
  }
  return {
    domains,
    live: true,
    filled: 0,
    available: json.length,
  };
}

module.exports = {
  SIMILARWEB_URL,
  BACKLINKO_URL,
  SNAPSHOT_SIMILARWEB,
  SNAPSHOT_BACKLINKO,
  SIMILARWEB_ADULT,
  parseSimilarwebHtml,
  parseBacklinkoHtml,
  fetchSimilarwebDomains,
  fetchBacklinkoDomains,
  fetchDataforseoDomains,
};

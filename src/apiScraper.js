const {
  fetchScraperPage,
  parseIconCandidatesFromHtml,
  fetchManifestIcons,
  fetchScraperAsset,
  parseSizesAttr,
} = require('./providers');
const cheerio = require('cheerio');

// FaviconAPIs source priority. The first tier to produce a usable icon wins;
// within a tier we try the largest declared size first.
const SOURCE_TYPES = ['svg', 'manifest', 'apple-touch-icon', 'png', 'ico'];

function classifyLinkCandidate(candidate) {
  const rel = String(candidate.rel || '').toLowerCase();
  const type = String(candidate.type || '').toLowerCase();
  const href = String(candidate.href || '').toLowerCase();
  const path = href.split('?')[0];

  if (rel.includes('apple-touch-icon')) return 'apple-touch-icon';
  if (type.includes('svg') || path.endsWith('.svg')) return 'svg';
  if (path.endsWith('.ico') || type.includes('ico') || type === 'image/x-icon') {
    // Some sites declare /favicon.ico via <link rel="shortcut icon">; keep it
    // in the ico tier so it loses to a manifest/png/apple-touch-icon hit.
    return 'ico';
  }
  return 'png';
}

function sortBySizeDesc(a, b) {
  const sa = parseSizesAttr(a.sizes) || 0;
  const sb = parseSizesAttr(b.sizes) || 0;
  return sb - sa;
}

function dedupeByHref(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || !item.href) continue;
    if (seen.has(item.href)) continue;
    seen.add(item.href);
    out.push(item);
  }
  return out;
}

async function tryCandidate(href, referer) {
  const result = await fetchScraperAsset(href, referer);
  if (!result || !result.buffer || result.buffer.length === 0) return null;
  return {
    buffer: result.buffer,
    contentType: result.contentType || 'application/octet-stream',
    sourceUrl: result.url || href,
  };
}

async function findInTier(candidates, referer) {
  const sorted = dedupeByHref([...candidates]).sort(sortBySizeDesc);
  for (const candidate of sorted) {
    const hit = await tryCandidate(candidate.href, referer);
    if (hit) return hit;
  }
  return null;
}

async function gatherCandidates(domain) {
  const buckets = {
    svg: [],
    manifest: [],
    'apple-touch-icon': [],
    png: [],
    ico: [],
  };

  const { html, finalBaseUrl } = await fetchScraperPage(domain);
  const baseUrl = `https://${domain}/`;
  const referer = finalBaseUrl || baseUrl;

  if (html) {
    try {
      const { primaryCandidates, resolveBase } = parseIconCandidatesFromHtml(
        html,
        finalBaseUrl || baseUrl
      );
      for (const candidate of primaryCandidates) {
        const tier = classifyLinkCandidate(candidate);
        buckets[tier].push(candidate);
      }

      // Manifest icons are tier-2 (after svg, before apple-touch-icon).
      try {
        const $ = cheerio.load(html);
        const manifestHref = $('link[rel="manifest"]').attr('href');
        if (manifestHref) {
          const manifestUrl = new URL(manifestHref, resolveBase).toString();
          const manifestIcons = await fetchManifestIcons(
            manifestUrl,
            finalBaseUrl || baseUrl
          );
          for (const icon of manifestIcons) {
            buckets.manifest.push({
              href: icon.href,
              sizes: icon.sizes || '',
              type: icon.type || '',
              rel: 'manifest',
            });
          }
        }
      } catch {
        /* manifest parsing/fetching is best-effort */
      }
    } catch {
      /* HTML parsing failure: still try /favicon.ico below */
    }
  }

  // Lowest-priority fallback: well-known /favicon.ico at the root.
  try {
    buckets.ico.push({
      href: new URL('/favicon.ico', baseUrl).toString(),
      sizes: '',
      type: 'image/x-icon',
      rel: 'icon',
    });
  } catch {
    /* ignore */
  }

  return { buckets, referer };
}

async function fetchBySourcePriority(domain) {
  const { buckets, referer } = await gatherCandidates(domain);

  for (const sourceType of SOURCE_TYPES) {
    const tier = buckets[sourceType];
    if (!tier || tier.length === 0) continue;
    const hit = await findInTier(tier, referer);
    if (hit) {
      return {
        buffer: hit.buffer,
        contentType: hit.contentType,
        sourceUrl: hit.sourceUrl,
        sourceType,
      };
    }
  }

  return null;
}

module.exports = {
  fetchBySourcePriority,
  SOURCE_TYPES,
};

const {
  fetchScraperPage,
  parseIconCandidatesFromHtml,
  loadManifestIconCandidates,
  fetchScraperAsset,
  parseSizesAttr,
  expandSizedVariants,
  googleWorkspaceLogoFallback,
  PROVIDERS,
} = require('./providers');
const { resolveServiceSlugForProviderSync } = require('./serviceAliases');
const { serviceSlugFromDomain } = require('./serviceSlugFromDomain');

// FaviconAPIs source priority. The first tier to produce a usable icon wins;
// within a tier we try the largest declared size first.
// Prefer sources larger than 128px across all tiers; only accept exactly 128px
// when no larger source exists anywhere (see fetchBySourcePriority).
// ICO is excluded: .ico files contain small frames (16–48px) that cannot
// meet the 128px minimum source size.
const SOURCE_TYPES = [
  'svg',
  'manifest',
  'apple-touch-icon',
  'png',
  'selfhst',
  'dashboardicons',
  'lobehub',
  'svgl',
  'external',
];

const { MIN_SOURCE_SIZE, readImageDimensions } = require('./imageNormalize');

// Well-known paths most sites serve even without HTML link tags.
const STANDARD_FALLBACKS = [
  { path: '/apple-touch-icon.png', tier: 'apple-touch-icon', sizes: '180x180' },
  { path: '/apple-touch-icon-precomposed.png', tier: 'apple-touch-icon', sizes: '180x180' },
  { path: '/android-chrome-512x512.png', tier: 'png', sizes: '512x512' },
  { path: '/android-chrome-192x192.png', tier: 'png', sizes: '192x192' },
];

// Google's faviconV2 service — request 256px so we can downscale to 128 with
// better quality when this last-resort tier is the only option.
const EXTERNAL_FAVICON_SIZE = 256;
function externalFaviconUrl(domain) {
  return `https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://${domain}&size=${EXTERNAL_FAVICON_SIZE}`;
}

function classifyLinkCandidate(candidate) {
  const rel = String(candidate.rel || '').toLowerCase();
  const type = String(candidate.type || '').toLowerCase();
  const href = String(candidate.href || '').toLowerCase();
  const path = href.split('?')[0];

  if (rel.includes('apple-touch-icon')) return 'apple-touch-icon';
  if (type.includes('svg') || path.endsWith('.svg')) return 'svg';
  if (path.endsWith('.ico') || type.includes('ico') || type === 'image/x-icon') {
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

function isPreferredSource(hit) {
  if (hit.isSvg) return true;
  return Math.max(hit.sourceWidth, hit.sourceHeight) > MIN_SOURCE_SIZE;
}

async function tryCandidate(href, referer) {
  const result = await fetchScraperAsset(href, referer);
  if (!result || !result.buffer || result.buffer.length === 0) return null;

  const contentType = (result.contentType || '').toLowerCase();
  const isSvg = contentType.includes('svg') || href.toLowerCase().endsWith('.svg');
  let sourceWidth = 0;
  let sourceHeight = 0;

  if (isSvg) {
    sourceWidth = MIN_SOURCE_SIZE + 1;
    sourceHeight = MIN_SOURCE_SIZE + 1;
  } else {
    const dims = await readImageDimensions(result.buffer, {
      contentType: result.contentType,
      url: href,
    });
    if (!dims) return null;
    sourceWidth = dims.width;
    sourceHeight = dims.height;
    if (sourceWidth < MIN_SOURCE_SIZE || sourceHeight < MIN_SOURCE_SIZE) {
      return null;
    }
  }

  return {
    buffer: result.buffer,
    contentType: contentType || 'application/octet-stream',
    sourceUrl: result.url || href,
    isSvg,
    sourceWidth,
    sourceHeight,
  };
}

async function evaluateTier(candidates, referer) {
  const sorted = dedupeByHref([...candidates]).sort(sortBySizeDesc);
  let fallback = null;

  for (const candidate of sorted) {
    const hit = await tryCandidate(candidate.href, referer);
    if (!hit) continue;
    if (isPreferredSource(hit)) return { preferred: hit, fallback: null };
    if (!fallback) fallback = hit;
  }

  return { preferred: null, fallback };
}

async function findInTier(candidates, referer) {
  const { preferred, fallback } = await evaluateTier(candidates, referer);
  return preferred || fallback;
}

async function gatherCandidates(domain) {
  const buckets = {
    svg: [],
    manifest: [],
    'apple-touch-icon': [],
    png: [],
    ico: [],
    selfhst: [],
    dashboardicons: [],
    lobehub: [],
    svgl: [],
    external: [],
  };

  const { html, finalBaseUrl, linkHeader } = await fetchScraperPage(domain);
  const baseUrl = `https://${domain}/`;
  const referer = finalBaseUrl || baseUrl;

  if (html) {
    try {
      const { primaryCandidates } = parseIconCandidatesFromHtml(
        html,
        finalBaseUrl || baseUrl,
        domain
      );
      for (const candidate of primaryCandidates) {
        const tier = classifyLinkCandidate(candidate);
        buckets[tier].push(candidate);
        for (const variant of expandSizedVariants(candidate.href)) {
          buckets[tier].push({ ...candidate, ...variant });
        }
      }

      try {
        const manifestIcons = await loadManifestIconCandidates(domain, {
          html,
          finalBaseUrl,
          linkHeader,
          iconCandidates: primaryCandidates,
        });
        for (const icon of manifestIcons) {
          buckets.manifest.push({
            href: icon.href,
            sizes: icon.sizes || '',
            type: icon.type || '',
            rel: 'manifest',
          });
        }
      } catch {
        /* manifest parsing/fetching is best-effort */
      }
    } catch {
      /* HTML parsing failure */
    }
  } else {
    try {
      const manifestIcons = await loadManifestIconCandidates(domain, {
        html: null,
        finalBaseUrl,
        linkHeader,
        iconCandidates: [],
      });
      for (const icon of manifestIcons) {
        buckets.manifest.push({
          href: icon.href,
          sizes: icon.sizes || '',
          type: icon.type || '',
          rel: 'manifest',
        });
      }
    } catch {
      /* manifest discovery without HTML is best-effort */
    }
  }

  // Google product subdomains (drive, docs, …) redirect anonymous requests to
  // the login page, which exposes no product logo. Recover the current logo from
  // the product's workspace.google.com marketing page.
  try {
    const workspaceLogos = await googleWorkspaceLogoFallback(domain, html);
    for (const candidate of workspaceLogos) {
      const tier = classifyLinkCandidate(candidate);
      buckets[tier].push(candidate);
      for (const variant of expandSizedVariants(candidate.href)) {
        buckets[tier].push({ ...candidate, ...variant });
      }
    }
  } catch {
    /* workspace fallback is best-effort */
  }

  // Standard well-known paths as fallback candidates.
  for (const fb of STANDARD_FALLBACKS) {
    try {
      buckets[fb.tier].push({
        href: new URL(fb.path, baseUrl).toString(),
        sizes: fb.sizes,
        type: 'image/png',
        rel: 'fallback',
      });
    } catch {
      /* ignore */
    }
  }

  // Service-name icon packs (domain label → slug, e.g. google.com → google).
  const serviceSlug = serviceSlugFromDomain(domain);
  if (serviceSlug) {
    const selfhstSlug = resolveServiceSlugForProviderSync(serviceSlug, 'selfhst');
    const dashboardSlug = resolveServiceSlugForProviderSync(serviceSlug, 'dashboardicons');
    const lobehubSlug = resolveServiceSlugForProviderSync(serviceSlug, 'lobehub');
    const svglSlug = resolveServiceSlugForProviderSync(serviceSlug, 'svgl');
    buckets.selfhst.push({
      href: PROVIDERS.selfhst(selfhstSlug),
      sizes: '256x256',
      type: 'image/png',
      rel: 'selfhst',
    });
    buckets.dashboardicons.push({
      href: PROVIDERS.dashboardIcons(dashboardSlug),
      sizes: '256x256',
      type: 'image/png',
      rel: 'dashboardicons',
    });
    buckets.lobehub.push({
      href: PROVIDERS.lobehub(lobehubSlug),
      sizes: '256x256',
      type: 'image/svg+xml',
      rel: 'lobehub',
    });
    buckets.svgl.push({
      href: PROVIDERS.svgl(svglSlug),
      sizes: '256x256',
      type: 'image/svg+xml',
      rel: 'svgl',
    });
  }

  // External provider as last-resort tier.
  buckets.external.push({
    href: externalFaviconUrl(domain),
    sizes: `${EXTERNAL_FAVICON_SIZE}x${EXTERNAL_FAVICON_SIZE}`,
    type: 'image/png',
    rel: 'external',
  });

  return { buckets, referer };
}

async function fetchBySourcePriority(domain) {
  const result = await fetchBySourcePriorityForDomain(domain);
  if (result) return result;

  // www-fallback: if the bare domain yielded nothing, try www.domain.
  if (!domain.startsWith('www.')) {
    const wwwResult = await fetchBySourcePriorityForDomain(`www.${domain}`);
    if (wwwResult) {
      wwwResult.fallbackDomain = `www.${domain}`;
      return wwwResult;
    }
  }

  return null;
}

async function fetchBySourcePriorityForDomain(domain) {
  const { buckets, referer } = await gatherCandidates(domain);

  let minimumFallback = null;
  let minimumFallbackType = null;

  for (const sourceType of SOURCE_TYPES) {
    const tier = buckets[sourceType];
    if (!tier || tier.length === 0) continue;

    const { preferred, fallback } = await evaluateTier(tier, referer);
    if (preferred) {
      return {
        buffer: preferred.buffer,
        contentType: preferred.contentType,
        sourceUrl: preferred.sourceUrl,
        sourceType,
      };
    }
    if (fallback && !minimumFallback) {
      minimumFallback = fallback;
      minimumFallbackType = sourceType;
    }
  }

  if (minimumFallback) {
    return {
      buffer: minimumFallback.buffer,
      contentType: minimumFallback.contentType,
      sourceUrl: minimumFallback.sourceUrl,
      sourceType: minimumFallbackType,
    };
  }

  return null;
}

module.exports = {
  fetchBySourcePriority,
  SOURCE_TYPES,
};

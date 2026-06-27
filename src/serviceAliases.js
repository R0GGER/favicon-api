const { upstreamFetch } = require('./upstreamFetch');

const DASHBOARD_METADATA_URL =
  'https://raw.githubusercontent.com/homarr-labs/dashboard-icons/main/metadata.json';
const SELFHST_INDEX_URL =
  'https://raw.githubusercontent.com/selfhst/icons/main/index.json';
const LOBEHUB_TOC_URL = 'https://unpkg.com/@lobehub/icons@latest/es/toc.json';
const SVGL_INDEX_URL =
  'https://cdn.jsdelivr.net/gh/pheralb/svgl@main/src/data/svgs.ts';
const METADATA_TTL_MS = 24 * 60 * 60 * 1000;
const FUZZY_SIMILARITY_THRESHOLD = 0.8;
const FUZZY_MIN_QUERY_LEN = 4;

const STATIC_PROVIDER_ALIASES = {
  selfhst: {
    onedrive: 'microsoft-onedrive',
    kdrive: 'ksuite-kdrive',
  },
  dashboardicons: {
    onedrive: 'microsoft-onedrive',
    kdrive: 'infomaniak-kdrive',
  },
};

let dashboardCache = { loadedAt: 0, aliasToSlug: null, slugs: null, entries: null };
let selfhstCache = { loadedAt: 0, entries: null };
let lobehubCache = { loadedAt: 0, aliasToSlug: null, slugs: null, entries: null };
let svglCache = { loadedAt: 0, aliasToSlug: null, slugs: null, entries: null };

function normalizeServiceAliasKey(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildDashboardAliasIndex(metadata) {
  const aliasToSlug = new Map();
  const slugs = new Set();
  const entries = new Map();

  for (const [slug, info] of Object.entries(metadata || {})) {
    const key = normalizeServiceAliasKey(slug);
    if (!key) continue;
    slugs.add(key);
    aliasToSlug.set(key, slug);
    entries.set(slug, { slug, label: slug, aliases: info?.aliases || [] });

    for (const alias of info?.aliases || []) {
      const aliasKey = normalizeServiceAliasKey(alias);
      if (aliasKey) aliasToSlug.set(aliasKey, slug);
    }

    const parts = key.split('-');
    if (parts.length > 1) {
      const last = parts[parts.length - 1];
      if (last.length >= 3 && !aliasToSlug.has(last)) {
        aliasToSlug.set(last, slug);
      }
    }
  }

  for (const [from, to] of Object.entries(STATIC_PROVIDER_ALIASES.dashboardicons)) {
    aliasToSlug.set(from, to);
  }

  return { aliasToSlug, slugs, entries, slugKeys: [...slugs] };
}

function parseSelfhstIndex(raw) {
  const entries = [];
  for (const value of Object.values(raw || {})) {
    if (!value || typeof value !== 'object' || !value.Reference) continue;
    entries.push({
      slug: value.Reference,
      label: value.Name || value.Reference,
      tags: value.Tags || '',
      hasLight: value.Light === 'Yes',
      hasDark: value.Dark === 'Yes',
      hasSvg: value.SVG === 'Yes',
    });
  }
  return entries;
}

function ensureDashboardSyncIndex() {
  if (!dashboardCache.aliasToSlug) {
    dashboardCache = { loadedAt: 0, ...buildDashboardAliasIndex({}) };
  }
  return dashboardCache;
}

async function ensureDashboardIndex() {
  const now = Date.now();
  if (dashboardCache.aliasToSlug && now - dashboardCache.loadedAt < METADATA_TTL_MS) {
    return dashboardCache;
  }

  try {
    const res = await upstreamFetch(DASHBOARD_METADATA_URL, {
      headers: { 'User-Agent': 'FaviconProxy/1.0' },
    });
    if (res.ok) {
      const metadata = await res.json();
      dashboardCache = { loadedAt: now, ...buildDashboardAliasIndex(metadata) };
      return dashboardCache;
    }
  } catch {
    /* use stale or static fallback */
  }

  ensureDashboardSyncIndex();
  if (!dashboardCache.loadedAt) dashboardCache.loadedAt = now;
  return dashboardCache;
}

async function ensureSelfhstIndex() {
  const now = Date.now();
  if (selfhstCache.entries && now - selfhstCache.loadedAt < METADATA_TTL_MS) {
    return selfhstCache;
  }

  try {
    const res = await upstreamFetch(SELFHST_INDEX_URL, {
      headers: { 'User-Agent': 'FaviconProxy/1.0' },
    });
    if (res.ok) {
      const raw = await res.json();
      selfhstCache = { loadedAt: now, entries: parseSelfhstIndex(raw) };
      return selfhstCache;
    }
  } catch {
    /* use stale cache if available */
  }

  if (!selfhstCache.entries) selfhstCache = { loadedAt: now, entries: [] };
  return selfhstCache;
}

function buildLobehubAliasIndex(toc) {
  const aliasToSlug = new Map();
  const slugs = new Set();
  const entries = new Map();

  for (const item of toc || []) {
    const slug = normalizeServiceAliasKey(item.title || item.id);
    if (!slug) continue;

    slugs.add(slug);
    aliasToSlug.set(slug, slug);
    entries.set(slug, {
      slug,
      label: item.fullTitle || item.title || item.id,
      docsUrl: item.docsUrl || '',
      hasColor: !!item.param?.hasColor,
      hasBrandColor: !!item.param?.hasBrandColor,
      hasBrand: !!item.param?.hasBrand,
    });

    const idKey = normalizeServiceAliasKey(item.id);
    if (idKey) aliasToSlug.set(idKey, slug);

    const docsKey = normalizeServiceAliasKey(item.docsUrl);
    if (docsKey) aliasToSlug.set(docsKey, slug);

    const titleKey = normalizeServiceAliasKey(item.title);
    if (titleKey) aliasToSlug.set(titleKey, slug);

    const fullTitleKey = normalizeServiceAliasKey(item.fullTitle);
    if (fullTitleKey) aliasToSlug.set(fullTitleKey, slug);

    const parts = slug.split('-');
    if (parts.length > 1) {
      const last = parts[parts.length - 1];
      if (last.length >= 3 && !aliasToSlug.has(last)) {
        aliasToSlug.set(last, slug);
      }
    }
  }

  return { aliasToSlug, slugs, entries, slugKeys: [...slugs] };
}

function ensureLobehubSyncIndex() {
  if (!lobehubCache.aliasToSlug) {
    lobehubCache = { loadedAt: 0, ...buildLobehubAliasIndex([]) };
  }
  return lobehubCache;
}

async function ensureLobehubIndex() {
  const now = Date.now();
  if (lobehubCache.aliasToSlug && now - lobehubCache.loadedAt < METADATA_TTL_MS) {
    return lobehubCache;
  }

  try {
    const res = await upstreamFetch(LOBEHUB_TOC_URL, {
      headers: { 'User-Agent': 'FaviconProxy/1.0' },
    });
    if (res.ok) {
      const toc = await res.json();
      lobehubCache = { loadedAt: now, ...buildLobehubAliasIndex(toc) };
      return lobehubCache;
    }
  } catch {
    /* use stale or empty fallback */
  }

  ensureLobehubSyncIndex();
  if (!lobehubCache.loadedAt) lobehubCache.loadedAt = now;
  return lobehubCache;
}

function parseSvglCatalog(ts) {
  const marker = 'export const svgs: iSVG[] = ';
  const idx = ts.indexOf(marker);
  if (idx < 0) return [];
  let code = ts.slice(idx + marker.length);
  const end = code.lastIndexOf('];');
  if (end >= 0) code = code.slice(0, end + 1);
  return new Function(`return (${code})`)();
}

function buildSvglAliasIndex(svgs) {
  const aliasToSlug = new Map();
  const slugs = new Set();
  const entries = new Map();

  for (const item of svgs || []) {
    const slug = normalizeServiceAliasKey(item.title);
    if (!slug) continue;

    slugs.add(slug);
    aliasToSlug.set(slug, slug);
    entries.set(slug, {
      slug,
      label: item.title || slug,
      route: item.route,
      url: item.url || '',
    });

    const titleKey = normalizeServiceAliasKey(item.title);
    if (titleKey) aliasToSlug.set(titleKey, slug);

    const routePath =
      typeof item.route === 'string'
        ? item.route
        : item.route?.light || item.route?.dark || '';
    const baseMatch = routePath.match(/\/([^/]+)\.svg$/i);
    if (baseMatch) {
      const routeKey = normalizeServiceAliasKey(
        baseMatch[1].replace(/-(?:icon|light|dark|logo|wordmark).*$/i, '')
      );
      if (routeKey && !aliasToSlug.has(routeKey)) aliasToSlug.set(routeKey, slug);
    }

    const parts = slug.split('-');
    if (parts.length > 1) {
      const last = parts[parts.length - 1];
      if (last.length >= 3 && !aliasToSlug.has(last)) aliasToSlug.set(last, slug);
    }
  }

  return { aliasToSlug, slugs, entries, slugKeys: [...slugs] };
}

function ensureSvglSyncIndex() {
  if (!svglCache.aliasToSlug) {
    svglCache = { loadedAt: 0, ...buildSvglAliasIndex([]) };
  }
  return svglCache;
}

async function ensureSvglIndex() {
  const now = Date.now();
  if (svglCache.aliasToSlug && now - svglCache.loadedAt < METADATA_TTL_MS) {
    return svglCache;
  }

  try {
    const res = await upstreamFetch(SVGL_INDEX_URL, {
      headers: { 'User-Agent': 'FaviconProxy/1.0' },
    });
    if (res.ok) {
      const svgs = parseSvglCatalog(await res.text());
      svglCache = { loadedAt: now, ...buildSvglAliasIndex(svgs) };
      return svglCache;
    }
  } catch {
    /* use stale or empty fallback */
  }

  ensureSvglSyncIndex();
  if (!svglCache.loadedAt) svglCache.loadedAt = now;
  return svglCache;
}

function collectDashboardCandidates(key, aliasToSlug, slugs) {
  if (!key) return [];

  const candidates = [key];
  const resolved = aliasToSlug.get(key);
  if (resolved && resolved !== key) candidates.push(resolved);

  if (slugs) {
    for (const slug of slugs) {
      if (slug !== key && slug.endsWith(`-${key}`)) candidates.push(slug);
    }
  }

  return [...new Set(candidates)];
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;

  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

function stringSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length);
}

function fuzzyPartScore(part, queryKey) {
  if (!part || !queryKey || part.length < 3) return 0;

  if (part === queryKey) return 75;

  if (queryKey.length >= FUZZY_MIN_QUERY_LEN) {
    const sim = stringSimilarity(part, queryKey);
    if (sim >= FUZZY_SIMILARITY_THRESHOLD) return Math.round(sim * 80);
  }

  if (part.startsWith(queryKey) && part.length <= queryKey.length + 2) return 58;
  if (queryKey.startsWith(`${part}-`) && part.length >= 4) return 42;

  return 0;
}

function scoreDashboardSlug(slugKey, entry, queryKey) {
  if (!slugKey || !queryKey) return 0;

  let score = 0;
  if (slugKey === queryKey) return 100;
  if (slugKey.endsWith(`-${queryKey}`)) score = Math.max(score, 85);

  const parts = slugKey.split('-');
  for (let i = 0; i < parts.length; i++) {
    const partScore = fuzzyPartScore(parts[i], queryKey);
    if (partScore <= 0) continue;
    const weighted = i === parts.length - 1 ? partScore + 8 : partScore;
    score = Math.max(score, weighted);
  }

  for (const alias of entry?.aliases || []) {
    const aliasKey = normalizeServiceAliasKey(alias);
    if (!aliasKey) continue;
    if (aliasKey === queryKey) score = Math.max(score, 90);
    score = Math.max(score, fuzzyPartScore(aliasKey, queryKey));
  }

  return score;
}

function searchDashboardFuzzyMatches(queryKey, index, limit = 8) {
  const { entries } = index;
  if (!queryKey || !entries) return [];

  return [...entries.values()]
    .map((entry) => ({
      slug: entry.slug,
      label: entry.label || entry.slug,
      score: scoreDashboardSlug(normalizeServiceAliasKey(entry.slug), entry, queryKey),
    }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug))
    .slice(0, limit);
}

function scoreSelfhstEntry(entry, queryKey) {
  const refKey = normalizeServiceAliasKey(entry.slug);
  const nameKey = normalizeServiceAliasKey(entry.label);
  const tagsKey = normalizeServiceAliasKey(entry.tags);
  let score = 0;

  if (refKey === queryKey) score += 100;
  if (refKey.endsWith(`-${queryKey}`)) score += 80;
  if (nameKey === queryKey) score += 70;
  if (nameKey.includes(queryKey)) score += 35;
  if (tagsKey.includes(queryKey)) score += 15;

  const refParts = refKey.split('-');
  for (let i = 0; i < refParts.length; i++) {
    const partScore = fuzzyPartScore(refParts[i], queryKey);
    if (partScore <= 0) continue;
    score = Math.max(score, partScore + (i === refParts.length - 1 ? 8 : 0));
  }

  for (const part of nameKey.split('-')) {
    score = Math.max(score, fuzzyPartScore(part, queryKey));
  }

  const queryParts = queryKey.split('-').filter(Boolean);
  for (const part of queryParts) {
    if (part.length < 3) continue;
    if (refKey.includes(part)) score += 10;
    if (nameKey.includes(part)) score += 8;
  }

  return score;
}

function mergeSelfhstWithDashboardFallback(selfhstMatches, dashboardMatches, limit = 8) {
  const seen = new Set();
  const merged = [];

  for (const match of selfhstMatches) {
    if (!match?.slug || seen.has(match.slug)) continue;
    seen.add(match.slug);
    merged.push(match);
  }

  for (const match of dashboardMatches) {
    if (!match?.slug || seen.has(match.slug)) continue;
    seen.add(match.slug);
    merged.push({
      ...match,
      score: Math.max(1, match.score - 12),
    });
  }

  return sortMatchesByScore(merged).slice(0, limit);
}

function searchSelfhstMatches(slug, entries, limit = 8) {
  const queryKey = normalizeServiceAliasKey(slug);
  if (!queryKey) return [];

  const staticResolved = STATIC_PROVIDER_ALIASES.selfhst[queryKey];
  const scored = entries
    .map((entry) => ({ ...entry, score: scoreSelfhstEntry(entry, queryKey) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));

  const seen = new Set();
  const matches = [];

  function addMatch(entry, score) {
    if (!entry?.slug || seen.has(entry.slug)) return;
    seen.add(entry.slug);
    matches.push({
      slug: entry.slug,
      label: entry.label || entry.slug,
      score,
    });
  }

  if (staticResolved) {
    const hit = entries.find((entry) => entry.slug === staticResolved);
    addMatch(hit || { slug: staticResolved, label: staticResolved }, 1000);
  } else {
    // An exact slug match is the canonical result and must always rank first.
    // selfh.st scoring is additive (score += ...), so partial matches can
    // exceed 100 (e.g. query "plex": guardian-plex / spotify-to-plex score 133
    // via the "-plex" suffix + name-contains bonuses). Give the exact match a
    // dominant score so it can never be outranked by a fuzzy partial match.
    const exact = entries.find((entry) => entry.slug === queryKey);
    if (exact) addMatch(exact, 1000);
  }

  for (const entry of scored) {
    addMatch(entry, entry.score);
    if (matches.length >= limit) break;
  }

  return sortMatchesByScore(matches).slice(0, limit);
}

function searchDashboardMatches(slug, index, limit = 8) {
  const queryKey = normalizeServiceAliasKey(slug);
  if (!queryKey) return [];

  const staticResolved = STATIC_PROVIDER_ALIASES.dashboardicons[queryKey];
  const seen = new Set();
  const matches = [];

  function addMatch(candidate, score, label) {
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    const meta = index.entries?.get(candidate);
    matches.push({
      slug: candidate,
      label: label || meta?.label || candidate,
      score,
    });
  }

  if (staticResolved) addMatch(staticResolved, 1000);

  for (const match of searchDashboardFuzzyMatches(queryKey, index, limit)) {
    addMatch(match.slug, match.score, match.label);
  }

  return matches.sort((a, b) => b.score - a.score).slice(0, limit);
}

function scoreLobehubSlug(slugKey, entry, queryKey) {
  if (!slugKey || !queryKey) return 0;

  let score = 0;
  if (slugKey === queryKey) return 100;
  if (slugKey.endsWith(`-${queryKey}`)) score = Math.max(score, 85);

  const parts = slugKey.split('-');
  for (let i = 0; i < parts.length; i++) {
    const partScore = fuzzyPartScore(parts[i], queryKey);
    if (partScore <= 0) continue;
    score = Math.max(score, partScore + (i === parts.length - 1 ? 8 : 0));
  }

  const labelKey = normalizeServiceAliasKey(entry?.label);
  if (labelKey === queryKey) score = Math.max(score, 90);
  if (labelKey.includes(queryKey)) score = Math.max(score, 35);

  const docsKey = normalizeServiceAliasKey(entry?.docsUrl);
  if (docsKey === queryKey) score = Math.max(score, 88);
  score = Math.max(score, fuzzyPartScore(docsKey, queryKey));

  return score;
}

function searchLobehubFuzzyMatches(queryKey, index, limit = 8) {
  const { entries } = index;
  if (!queryKey || !entries) return [];

  return [...entries.values()]
    .map((entry) => ({
      slug: entry.slug,
      label: entry.label || entry.slug,
      score: scoreLobehubSlug(normalizeServiceAliasKey(entry.slug), entry, queryKey),
    }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug))
    .slice(0, limit);
}

function searchLobehubMatches(slug, index, limit = 8) {
  const queryKey = normalizeServiceAliasKey(slug);
  if (!queryKey) return [];

  const seen = new Set();
  const matches = [];

  function addMatch(candidate, score, label) {
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    const meta = index.entries?.get(candidate);
    matches.push({
      slug: candidate,
      label: label || meta?.label || candidate,
      score,
    });
  }

  const resolved = index.aliasToSlug?.get(queryKey);
  if (resolved) addMatch(resolved, 1000);

  for (const match of searchLobehubFuzzyMatches(queryKey, index, limit)) {
    addMatch(match.slug, match.score, match.label);
  }

  return matches.sort((a, b) => b.score - a.score).slice(0, limit);
}

function scoreSvglSlug(slugKey, entry, queryKey) {
  if (!slugKey || !queryKey) return 0;

  let score = 0;
  if (slugKey === queryKey) return 100;
  if (slugKey.endsWith(`-${queryKey}`)) score = Math.max(score, 85);
  if (slugKey.startsWith(`${queryKey}-`)) score = Math.max(score, 85);

  const parts = slugKey.split('-');
  for (let i = 0; i < parts.length; i++) {
    const partScore = fuzzyPartScore(parts[i], queryKey);
    if (partScore <= 0) continue;
    score = Math.max(score, partScore + (i === parts.length - 1 ? 8 : 0));
  }

  const labelKey = normalizeServiceAliasKey(entry?.label);
  if (labelKey === queryKey) score = Math.max(score, 90);
  if (labelKey.includes(queryKey)) score = Math.max(score, 35);

  return score;
}

function searchSvglFuzzyMatches(queryKey, index, limit = 8) {
  const { entries } = index;
  if (!queryKey || !entries) return [];

  return [...entries.values()]
    .map((entry) => ({
      slug: entry.slug,
      label: entry.label || entry.slug,
      score: scoreSvglSlug(normalizeServiceAliasKey(entry.slug), entry, queryKey),
    }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug))
    .slice(0, limit);
}

function searchSvglMatches(slug, index, limit = 8) {
  const queryKey = normalizeServiceAliasKey(slug);
  if (!queryKey) return [];

  const seen = new Set();
  const matches = [];

  function addMatch(candidate, score, label) {
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    const meta = index.entries?.get(candidate);
    matches.push({
      slug: candidate,
      label: label || meta?.label || candidate,
      score,
    });
  }

  const resolved = index.aliasToSlug?.get(queryKey);
  if (resolved) addMatch(resolved, 1000);

  for (const match of searchSvglFuzzyMatches(queryKey, index, limit)) {
    addMatch(match.slug, match.score, match.label);
  }

  return matches.sort((a, b) => b.score - a.score).slice(0, limit);
}

function sortMatchesByScore(matches) {
  return [...matches].sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
}

function pickResolvedSlug(matches) {
  return sortMatchesByScore(matches)[0]?.slug || null;
}

function pickAnyResolvedSlug(...matchLists) {
  for (const matches of matchLists) {
    const slug = pickResolvedSlug(matches);
    if (slug) return slug;
  }
  return null;
}

// Strict resolution: exact catalog slug or a curated/static/real alias only —
// never a Levenshtein/fuzzy match. Used for slugs derived automatically from a
// domain (e.g. maflplus.eu → "maflplus"), where an approximate match such as
// maflplus → mailplus would serve a completely different product's icon. Fuzzy
// matching stays enabled for service names the user actually typed.
async function getSelfhstSlugCandidates(slug, { strict = false } = {}) {
  const { entries } = await ensureSelfhstIndex();
  const queryKey = normalizeServiceAliasKey(slug);

  if (strict) {
    if (!queryKey) return [];
    const staticResolved = STATIC_PROVIDER_ALIASES.selfhst[queryKey];
    if (staticResolved) return [staticResolved];
    return entries.some((entry) => entry.slug === queryKey) ? [queryKey] : [];
  }

  if (entries.some((entry) => entry.slug === queryKey)) {
    return [queryKey];
  }

  // Hyphenated slug not in the selfhst catalog (e.g. dashboard-only "eu-drive"):
  // try that slug only — never substitute a fuzzy "drive" match like drive-synology.
  if (queryKey.includes('-')) {
    return [queryKey];
  }

  const matches = searchSelfhstMatches(slug, entries);
  if (matches.length > 0) {
    return matches.map((match) => match.slug);
  }

  return queryKey ? [queryKey] : [];
}

async function getDashboardIconsSlugCandidates(slug, { strict = false } = {}) {
  const index = await ensureDashboardIndex();

  if (strict) {
    const queryKey = normalizeServiceAliasKey(slug);
    if (!queryKey) return [];
    const staticResolved = STATIC_PROVIDER_ALIASES.dashboardicons[queryKey];
    if (staticResolved) return [staticResolved];
    if (index.aliasToSlug?.has(queryKey)) {
      const resolved = index.aliasToSlug.get(queryKey);
      if (index.slugs?.has(resolved)) return [resolved];
    }
    return index.slugs?.has(queryKey) ? [queryKey] : [];
  }

  return searchDashboardMatches(slug, index).map((match) => match.slug);
}

async function getLobehubSlugCandidates(slug, { strict = false } = {}) {
  const index = await ensureLobehubIndex();

  if (strict) {
    const queryKey = normalizeServiceAliasKey(slug);
    if (!queryKey) return [];
    if (index.aliasToSlug?.has(queryKey)) {
      const resolved = index.aliasToSlug.get(queryKey);
      if (index.slugs?.has(resolved)) return [resolved];
    }
    return index.slugs?.has(queryKey) ? [queryKey] : [];
  }

  return searchLobehubMatches(slug, index).map((match) => match.slug);
}

async function getSvglSlugCandidates(slug, { strict = false } = {}) {
  const index = await ensureSvglIndex();

  if (strict) {
    const queryKey = normalizeServiceAliasKey(slug);
    if (!queryKey) return [];
    if (index.aliasToSlug?.has(queryKey)) {
      const resolved = index.aliasToSlug.get(queryKey);
      if (index.slugs?.has(resolved)) return [resolved];
    }
    return index.slugs?.has(queryKey) ? [queryKey] : [];
  }

  return searchSvglMatches(slug, index).map((match) => match.slug);
}

async function getServiceSlugCandidates(slug) {
  const [selfhst, dashboardicons, lobehub, svgl] = await Promise.all([
    getSelfhstSlugCandidates(slug),
    getDashboardIconsSlugCandidates(slug),
    getLobehubSlugCandidates(slug),
    getSvglSlugCandidates(slug),
  ]);
  return [...new Set([...selfhst, ...dashboardicons, ...lobehub, ...svgl])];
}

async function resolveServiceSlug(slug) {
  const queryKey = normalizeServiceAliasKey(slug);
  if (!queryKey) return '';
  const index = await ensureDashboardIndex();
  return index.aliasToSlug.get(queryKey) || queryKey;
}

function resolveServiceSlugSync(slug) {
  const queryKey = normalizeServiceAliasKey(slug);
  if (!queryKey) return '';
  const { aliasToSlug, slugs } = ensureDashboardSyncIndex();
  if (aliasToSlug.has(queryKey)) return aliasToSlug.get(queryKey);
  if (slugs.has(queryKey)) return queryKey;
  return '';
}

function resolveSelfhstSlugSync(slug) {
  const queryKey = normalizeServiceAliasKey(slug);
  if (!queryKey) return '';

  const staticHit = STATIC_PROVIDER_ALIASES.selfhst[queryKey];
  if (staticHit) return staticHit;

  const entries = selfhstCache.entries;
  if (!entries || entries.length === 0) return '';

  if (entries.some((entry) => entry.slug === queryKey)) return queryKey;

  return pickResolvedSlug(searchSelfhstMatches(slug, entries)) || '';
}

function resolveLobehubSlugSync(slug) {
  const queryKey = normalizeServiceAliasKey(slug);
  if (!queryKey) return '';

  const index = lobehubCache.entries?.size ? lobehubCache : ensureLobehubSyncIndex();
  if (index.aliasToSlug?.has(queryKey)) {
    const resolved = index.aliasToSlug.get(queryKey);
    if (index.slugs?.has(resolved)) return resolved;
  }
  if (index.slugs?.has(queryKey)) return queryKey;

  if (index.entries?.size > 0) {
    return pickResolvedSlug(searchLobehubMatches(slug, index)) || '';
  }

  return '';
}

function getServiceSlugCandidatesSync(slug) {
  const queryKey = normalizeServiceAliasKey(slug);
  const { aliasToSlug, slugs } = ensureDashboardSyncIndex();
  return collectDashboardCandidates(queryKey, aliasToSlug, slugs);
}

async function resolveServiceMatches(slug, { strict = false } = {}) {
  const input = normalizeServiceAliasKey(slug);
  const [selfhstIndex, dashboardIndex, lobehubIndex, svglIndex] = await Promise.all([
    ensureSelfhstIndex(),
    ensureDashboardIndex(),
    ensureLobehubIndex(),
    ensureSvglIndex(),
  ]);

  // Strict mode (domain-derived slugs): only exact/alias matches, no fuzzy.
  // A score is synthesized so the shared selection logic below still works.
  const selfhstCandidates = strict
    ? (await getSelfhstSlugCandidates(input, { strict: true })).map((s) => ({ slug: s, label: s, score: 100 }))
    : searchSelfhstMatches(input, selfhstIndex.entries);
  const dashboardCandidates = strict
    ? (await getDashboardIconsSlugCandidates(input, { strict: true })).map((s) => ({ slug: s, label: s, score: 100 }))
    : searchDashboardMatches(input, dashboardIndex);
  const lobehubCandidates = strict
    ? (await getLobehubSlugCandidates(input, { strict: true })).map((s) => ({ slug: s, label: s, score: 100 }))
    : searchLobehubMatches(input, lobehubIndex);
  const svglCandidates = strict
    ? (await getSvglSlugCandidates(input, { strict: true })).map((s) => ({ slug: s, label: s, score: 100 }))
    : searchSvglMatches(input, svglIndex);
  const allCandidates = [
    ...new Set([
      input,
      ...selfhstCandidates.map((match) => match.slug),
      ...dashboardCandidates.map((match) => match.slug),
      ...lobehubCandidates.map((match) => match.slug),
      ...svglCandidates.map((match) => match.slug),
    ]),
  ];

  return {
    input,
    resolved: pickAnyResolvedSlug(
      dashboardCandidates,
      selfhstCandidates,
      lobehubCandidates,
      svglCandidates
    ),
    candidates: allCandidates,
    providers: {
      selfhst: {
        resolved: pickResolvedSlug(selfhstCandidates),
        candidates: selfhstCandidates,
      },
      dashboardicons: {
        resolved: pickResolvedSlug(dashboardCandidates),
        candidates: dashboardCandidates,
      },
      lobehub: {
        resolved: pickResolvedSlug(lobehubCandidates),
        candidates: lobehubCandidates,
      },
      svgl: {
        resolved: pickResolvedSlug(svglCandidates),
        candidates: svglCandidates,
      },
    },
  };
}

function getLobehubVariantAvailability(slug) {
  if (!slug) return null;
  const index = lobehubCache.entries?.size ? lobehubCache : ensureLobehubSyncIndex();
  if (!index.entries?.has(slug)) return null;
  return { color: true, light: true, dark: true };
}

function getSvglEntrySync(slug) {
  const queryKey = normalizeServiceAliasKey(slug);
  if (!queryKey) return null;
  const index = svglCache.entries?.size ? svglCache : ensureSvglSyncIndex();
  const resolved = index.aliasToSlug?.get(queryKey) || (index.slugs?.has(queryKey) ? queryKey : null);
  if (!resolved) return null;
  return index.entries?.get(resolved) || null;
}

function getSvglVariantAvailability(slug) {
  const entry = getSvglEntrySync(slug);
  if (!entry) return null;
  const route = entry.route;
  if (typeof route === 'string') {
    return { color: true, light: false, dark: false };
  }
  return {
    color: !!(route?.light || route?.dark),
    light: !!route?.light,
    dark: !!route?.dark,
  };
}

function resolveSelfhstSlugStrict(slug) {
  const queryKey = normalizeServiceAliasKey(slug);
  if (!queryKey) return '';
  const staticHit = STATIC_PROVIDER_ALIASES.selfhst[queryKey];
  if (staticHit) return staticHit;
  const entries = selfhstCache.entries;
  if (!entries || entries.length === 0) return '';
  return entries.some((entry) => entry.slug === queryKey) ? queryKey : '';
}

function resolveLobehubSlugStrict(slug) {
  const queryKey = normalizeServiceAliasKey(slug);
  if (!queryKey) return '';
  const index = lobehubCache.entries?.size ? lobehubCache : ensureLobehubSyncIndex();
  if (index.aliasToSlug?.has(queryKey)) {
    const resolved = index.aliasToSlug.get(queryKey);
    if (index.slugs?.has(resolved)) return resolved;
  }
  return index.slugs?.has(queryKey) ? queryKey : '';
}

function resolveSvglSlugStrict(slug) {
  const queryKey = normalizeServiceAliasKey(slug);
  if (!queryKey) return '';
  const index = svglCache.entries?.size ? svglCache : ensureSvglSyncIndex();
  if (index.aliasToSlug?.has(queryKey)) {
    const resolved = index.aliasToSlug.get(queryKey);
    if (index.slugs?.has(resolved)) return resolved;
  }
  return index.slugs?.has(queryKey) ? queryKey : '';
}

// Resolves a domain-derived slug to a provider catalog slug for the HTML
// scraper's service-icon buckets. Domain labels are arbitrary brand names, so
// resolution is strict (exact slug / curated alias only) — never a fuzzy match,
// which previously let e.g. maflplus.eu pull in the unrelated "mailplus" icon.
function resolveServiceSlugForProviderSync(slug, provider) {
  const queryKey = normalizeServiceAliasKey(slug);
  if (!queryKey) return '';
  const staticHit = STATIC_PROVIDER_ALIASES[provider]?.[queryKey];
  if (staticHit) return staticHit;
  if (provider === 'dashboardicons') return resolveServiceSlugSync(slug);
  if (provider === 'lobehub') return resolveLobehubSlugStrict(slug);
  if (provider === 'svgl') return resolveSvglSlugStrict(slug);
  if (provider === 'selfhst') return resolveSelfhstSlugStrict(slug);
  return '';
}

module.exports = {
  normalizeServiceAliasKey,
  resolveServiceSlug,
  resolveServiceSlugSync,
  resolveServiceSlugForProviderSync,
  resolveSelfhstSlugSync,
  resolveServiceMatches,
  getServiceSlugCandidates,
  getServiceSlugCandidatesSync,
  getSelfhstSlugCandidates,
  getDashboardIconsSlugCandidates,
  getLobehubSlugCandidates,
  getSvglSlugCandidates,
  ensureDashboardIndex,
  ensureSelfhstIndex,
  ensureLobehubIndex,
  ensureSvglIndex,
  getLobehubVariantAvailability,
  getSvglVariantAvailability,
  getSvglEntrySync,
};

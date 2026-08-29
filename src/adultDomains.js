/**
 * Adult / porn domains that commonly appear in worldwide top-site rankings.
 *
 * Used by scripts/preload-top-sites.js so a preload set can drop (or keep)
 * adult sites. Matching is hostname-based: dedicated adult TLDs, a curated
 * eTLD+1 list, exact DNS labels, and a few unambiguous substrings (porn, xxx,
 * hentai). Deliberately does not treat "adult" or "sex" as substrings —
 * those false-positive on sites such as adultswim.com and sussex.gov.uk.
 */
const ADULT_TLDS = new Set(['xxx', 'porn', 'sex', 'adult', 'sexy']);

const ADULT_DOMAINS = new Set([
  'pornhub.com', 'pornhub.org', 'pornhubpremium.com', 'pornhub.net',
  'xvideos.com', 'xvideos.es', 'xvideos2.com', 'xvideos3.com',
  'xnxx.com', 'xnxx.es', 'xnxx.tv', 'xnxx2.com',
  'xhamster.com', 'xhamster.desi', 'xhamster2.com', 'xhamster3.com',
  'xhamsterlive.com', 'xhopen.com', 'xhwide1.com', 'xhwide2.com',
  'chaturbate.com', 'stripchat.com', 'livejasmin.com', 'bongacams.com',
  'myfreecams.com', 'camsoda.com', 'cam4.com', 'streamate.com',
  'onlyfans.com', 'fansly.com', 'justfor.fans',
  'spankbang.com', 'youporn.com', 'redtube.com', 'tube8.com', 'pornhd.com',
  'brazzers.com', 'realitykings.com', 'bangbros.com', 'digitalplayground.com',
  'txxx.com', 'hclips.com', 'upornia.com', 'sxyprn.com', 'thisvid.com',
  'missav.com', 'missav.ws', 'missav.live', 'jable.tv', 'avgle.com',
  'hanime.tv', 'nhentai.net', 'rule34.xxx', 'gelbooru.com', 'e621.net',
  'fapello.com', 'motherless.com', 'xvideos-cdn.com',
  'dmm.co.jp', 'fanza.jp',
  'javhub.net', 'javmost.com', 'javlibrary.com', 'javtrailers.com',
  'javwow.com', 'javdb.com', 'javguru.com',
  '5movierulz.vote', '5movierulz.limited',
]);

const ADULT_LABELS = new Set([
  'porn', 'pornhub', 'pornhubpremium', 'xvideos', 'xvideos2', 'xvideos3',
  'xnxx', 'xnxx2', 'xhamster', 'xhamster2', 'xhamster3', 'xhamsterlive',
  'xxx', 'sex', 'chaturbate', 'youporn', 'redtube', 'spankbang', 'brazzers',
  'stripchat', 'livejasmin', 'onlyfans', 'fansly', 'missav', 'hanime',
  'nhentai', 'hentai', 'fapello', 'motherless', 'jable', 'avgle', 'rule34',
  'txxx', 'hclips', 'upornia', 'sxyprn', 'bongacams', 'myfreecams',
  'camsoda', 'cam4', 'streamate', 'pornhd', 'xhopen', 'tube8',
  'javhub', 'javmost', 'javlibrary', 'javtrailers', 'javwow', 'javdb',
  'javguru', 'fanza',
]);

function isAdultDomain(host) {
  if (!host || typeof host !== 'string') return false;
  const labels = host.toLowerCase().split('.').filter(Boolean);
  if (labels.length < 2) return false;
  if (ADULT_TLDS.has(labels[labels.length - 1])) return true;
  for (let i = 0; i < labels.length - 1; i += 1) {
    if (ADULT_DOMAINS.has(labels.slice(i).join('.'))) return true;
  }
  for (const label of labels) {
    if (ADULT_LABELS.has(label)) return true;
    if (label.includes('porn') || label.includes('xxx') || label.includes('hentai')) return true;
    if (label.startsWith('xnxx') || label.startsWith('xvideos') || label.startsWith('xhamster')) return true;
    if (label.startsWith('jav') && !label.startsWith('java')) return true;
  }
  return false;
}

module.exports = { ADULT_TLDS, ADULT_DOMAINS, ADULT_LABELS, isAdultDomain };

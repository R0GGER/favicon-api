/**
 * Pure service/infrastructure domains that have no user-facing website or
 * favicon (CDN, DNS/registry, cloud backends, ad/tracking endpoints). These
 * occasionally still surface in ranking lists; we drop them so the preload set
 * only contains real, browsable websites. Company sites that happen to also run
 * infra (e.g. cloudflare.com, appsflyer.com, criteo.com) are deliberately NOT
 * listed here. Matching also covers subdomains (foo.gstatic.com).
 *
 * Used as the built-in filter in scripts/preload-top-sites.js and as the seed
 * for the preload blocklist (scripts/manage-preload.js seed-blocklist).
 */
const SERVICE_DOMAINS = new Set([
  // Google infrastructure / CDN / ads / tracking
  'gstatic.com', 'googleapis.com', 'googleusercontent.com', 'googlevideo.com',
  'ggpht.com', 'gvt1.com', 'gvt2.com', 'googlesyndication.com', 'googletagmanager.com',
  'googletagservices.com', 'googleadservices.com', 'google-analytics.com',
  'doubleclick.net', 'app-measurement.com', 'usercontent.goog', '2mdn.net',
  // Apple infrastructure
  'aaplimg.com', 'apple-dns.net', 'mzstatic.com', 'cdn-apple.com',
  // Microsoft infrastructure
  'microsoftonline.com', 'windowsupdate.com', 'trafficmanager.net', 'azureedge.net',
  'windows.net', 'msedge.net', 'cloudapp.net', 's-microsoft.com',
  // Meta / Facebook infrastructure
  'fbcdn.net', 'cdninstagram.com', 'whatsapp.net', 'fbsbx.com',
  // Amazon / AWS infrastructure
  'amazonaws.com', 'cloudfront.net', 'media-amazon.com', 'ssl-images-amazon.com',
  // CDNs
  'akamai.net', 'akamaiedge.net', 'akamaihd.net', 'akadns.net', 'akam.net',
  'edgekey.net', 'edgesuite.net', 'fastly.net', 'fastlylb.net', 'llnwd.net',
  // DNS / registry infrastructure
  'gtld-servers.net', 'root-servers.net', 'nstld.com', 'domaincontrol.com',
  'ripn.net', 'registrar-servers.com',
  // Ad / tracking endpoints (no browsable site)
  'adnxs.com', 'adsrvr.org', 'criteo.net', 'scorecardresearch.com',
  'appsflyersdk.com', 'demdex.net', 'rubiconproject.com', 'pubmatic.com',
  'casalemedia.com',
  // TikTok / ByteDance infrastructure
  'tiktokcdn.com', 'tiktokv.com', 'bytefcdn.com', 'byteoversea.com', 'ibyteimg.com',
]);

function isServiceDomain(host) {
  if (SERVICE_DOMAINS.has(host)) return true;
  for (const svc of SERVICE_DOMAINS) {
    if (host.endsWith(`.${svc}`)) return true;
  }
  return false;
}

module.exports = { SERVICE_DOMAINS, isServiceDomain };

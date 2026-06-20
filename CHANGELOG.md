# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **FaviconAPIs-compatible JSON API** (`/api/v1/favicon` + `/cdn/favicons/{domain}.png`)
  - New `GET /api/v1/favicon?url={website}` endpoint returns a JSON object — `{ url, domain, width, height, format, sourceType, cached, cachedAt }` — instead of the image bytes, modelled on [faviconapis.com/docs](https://www.faviconapis.com/docs). The PNG itself is fetched separately from the returned CDN URL.
  - **Source priority** for icon discovery is `svg` > `manifest` > `apple-touch-icon` > `png` > `ico`. The first source that yields a decodable image wins, and the tag is reported in the `sourceType` response field. Implemented in new `src/apiScraper.js`, reusing existing scraper helpers (`fetchScraperPage`, `parseIconCandidatesFromHtml`, `fetchManifestIcons`, `fetchScraperAsset`) rather than duplicating HTML/manifest fetch logic.
  - **All output is normalized to a 256×256 PNG** via new `src/imageNormalize.js`. SVGs are rasterized at `density=384` (4×96 dpi) for a crisp 256-pixel render; multi-frame ICO files are decoded via the new `decode-ico` dependency with the largest frame selected; everything else goes through `sharp` with `fit: contain` and a transparent background.
  - **7-day CDN cache.** The generated PNG is written to `API_CACHE_DIR` (default `/cache/api`) with a sibling `.meta.json` (`{ sourceType, cachedAt }`), and re-served via the new public `GET /cdn/favicons/{domain}.png` route with `Content-Type: image/png` and `Cache-Control: public, max-age=604800, immutable`. Subsequent calls within the TTL window return `cached: true` and the original `cachedAt` timestamp; `cdn/favicons/...` returns `404` until `/api/v1/favicon` has been called at least once for that domain (safe to expose publicly).
  - **Error responses match the FaviconAPIs spec** and are always JSON with `error` and `code` fields: `400 missing_url` / `400 invalid_url`, `401 missing_api_key` / `401 invalid_api_key`, `422 favicon_not_found` / `422 favicon_not_processable` (with `sourceType` + `sourceUrl` for diagnostics), `429 quota_exceeded` (with `plan` / `limit` / `used` / `period`), `500 internal_error`.
  - New environment variables: `API_KEYS_DB` (default `/cache/api-keys.sqlite`), `API_CACHE_DIR` (default `/cache/api`), `API_CACHE_TTL` (default `604800` = 7 days, used both for cache freshness and the CDN `Cache-Control: max-age`).
  - Mounted in `src/index.js` (`app.use(apiRoutes)`) directly after the static-assets handler and before the catch-all `/:domain` provider route so `/api/...` and `/cdn/...` paths take precedence. Existing routes (`/g/...`, `/g2/...`, `/d/...`, `/y/...`, `/f/...`, `/v/...`, `/p/...`, `/k/...`, `/l/...`, `/s/...`, `/sh/...`, `/di/...`, `/{domain}`, `/{domain}/json`) are unaffected.

- **API key authentication with per-key monthly quotas** (SQLite-backed)
  - New `src/apiStore.js` persists API keys and per-key monthly usage in a SQLite file at `API_KEYS_DB` (default `/cache/api-keys.sqlite`, inside the existing cache volume so it survives container restarts and is shared between cluster workers via WAL mode + `synchronous=NORMAL` + `foreign_keys=ON`). Only the SHA-256 hash of each raw key is stored server-side; the raw key is shown exactly once at creation time.
  - Keys are passed either as `Authorization: Bearer <key>` or `?key=<key>`. Keys use the prefix `fa_` followed by 24 base32-style characters drawn from an `abcdefghijkmnopqrstuvwxyz23456789` alphabet (no `0/O/1/I` confusion), giving roughly 120 bits of entropy per key.
  - Three plans configurable via env vars, defaults mirror FaviconAPIs: `PLAN_FREE_LIMIT=25`, `PLAN_PRO_LIMIT=2500`, `PLAN_ENTERPRISE_LIMIT=0` (where `0 = unlimited`). The plan assigned at key creation determines the monthly cap; that cap is snapshotted into `api_keys.monthly_limit` so changing the env var afterwards does not retroactively change existing keys.
  - Quotas reset per calendar month UTC (`period = YYYY-MM`). A request only counts toward the quota when the API returns `200`, matching FaviconAPIs' "successful HTTP response" rule — `4xx`/`5xx` calls do not consume quota. `cached: true` responses do count (the API still authenticated you and returned a valid result).
  - When the cap is reached, subsequent calls return `429 quota_exceeded` with `{ plan, limit, used, period }` in the response body.
  - Two tables: `api_keys` (`id`, `key_prefix`, `key_hash`, `label`, `plan`, `monthly_limit`, `status`, `created_at`) and `usage_monthly` (`api_key_id`, `period`, `count`, PK = `(api_key_id, period)`, with `ON DELETE CASCADE` so deleting a key wipes its history). Increment uses `INSERT ... ON CONFLICT DO UPDATE SET count = count + 1`.

- **`API_REQUIRE_KEY` environment variable** to disable auth and quotas entirely
  - Default `true` (current behaviour: key required, quota enforced).
  - Set to `false` to make `/api/v1/favicon` a fully public endpoint — no `Authorization` header or `?key=` required, and per-key plans/quotas are not enforced. A provided key is silently ignored in this mode (not validated, not tracked). Useful for self-hosted deployments behind their own auth layer or for fully open instances.
  - Accepts `false` / `0` / `no` / `off` (case-insensitive) as off-values; an empty or unset value falls back to the default `true`.
  - Plan-related env vars (`PLAN_FREE_LIMIT`, `PLAN_PRO_LIMIT`, `PLAN_ENTERPRISE_LIMIT`) are only applied when `API_REQUIRE_KEY=true`.
  - Documented in `README.md`, `.env.example` and `docker-compose.yml`.

- **CLI for API key management** (`scripts/manage-keys.js`, wired as npm scripts)
  - `npm run keys:create -- --label "customer A" --plan free|pro|enterprise` — prints the raw `fa_<24 chars>` key exactly once (only its SHA-256 hash is persisted) along with the plan and monthly limit. The displayed prefix in `keys:list` is the first 11 characters (`fa_` + 8 random) — long enough to revoke unambiguously without leaking the secret.
  - `npm run keys:list` shows active keys with this month's usage counter; `npm run keys:list -- --all` also includes revoked keys (kept for audit history).
  - `npm run keys:revoke -- --prefix fa_abcd1234` flips `status` to `revoked` so the key stops validating immediately, but keeps the row in the DB and excludes it from the default `keys:list` output.
  - `npm run keys:delete -- --prefix fa_abcd1234` permanently removes the key row and (via `ON DELETE CASCADE`) its usage counters.
  - Inside Docker, invoke via `docker compose exec maflplus-favicon-api npm run keys:create -- --label "..." --plan pro` so the script writes to the same SQLite file the running server reads from.

- **`api.html` - interactive API documentation and playground** for the new v1 API, served at `/api` and `/api.html`.
  - New user-facing page (`src/public/api.html`) styled to match the homepage (same `#faf6f1` background, `#5b2e7e` purple accents, Georgia serif headings) and registered via `app.get(['/api', '/api.html'], renderTemplate(API_HTML_TEMPLATE))` in `src/index.js`.
  - Templated rendering shared with the homepage: `src/index.js` factored the per-request `__BASE_URL__` substitution into a `renderTemplate(template)` helper now mounted on both `['/', '/index.html']` and `['/api', '/api.html']`. Canonical link, Open Graph, Twitter Card and JSON-LD (`@type: TechArticle`, `isPartOf: WebApplication`) tags are populated with the request's absolute origin without baking the hostname into the image. `express.static` still runs with `{ index: false }` so `/api.html` always goes through the templated route.
  - **Quick start** with a copy-able `GET` example and tabbed code samples for `curl`, `JavaScript` (browser `fetch`), `Node.js` (undici `request`), `Python` (`requests`), `PHP` and `PowerShell` (`Invoke-RestMethod`). Each sample is regenerated client-side from `location.origin` so it shows the exact URL the visitor is on (no `your-host` placeholders).
  - **Interactive playground** ("Try it") that sends a real request from the browser:
    - Free-text URL input plus optional API key field with an `Authorization: Bearer` / `?key=` toggle for how the key is sent.
    - Live response panel showing a status pill (`200`, `400`, `401`, `422`, `429`, `500`) in mode-appropriate colors, the request URL, elapsed time in ms, and the formatted JSON body.
    - Side preview frame that renders the resulting `/cdn/favicons/{domain}.png` plus dimensions and `cached` / `sourceType` notes when the call succeeds; "Request did not return an image" placeholder on error.
    - Quick-domain chips, `Copy JSON` button, `Clear` button, and `localStorage` persistence of the entered key across page loads.
  - **Endpoint reference** with query-parameter and response-field tables; **Errors table** with colored status pills per code (400, 401, 422, 429, 500); **Authentication** section (Bearer header + `?key=` examples + bundled `scripts/manage-keys.js` CLI usage); **Plans & quotas table** populated at runtime from `/providers`; **CDN route** documentation.
  - **Adaptive UI based on the server's `API_REQUIRE_KEY` setting** - the page fetches `/providers` on load and:
    - Toggles a green "Public / anonymous" vs. orange "API keys required" badge in the header.
    - Hides the playground key input, the **Authentication** section and the **Plans & quotas** section when this instance does not require a key.
    - Re-renders the Quick start code samples so the `Authorization: Bearer fa_your_key_here` header (or `?key=...`) is dropped when not relevant - the samples become valid copy-paste calls for the actual running instance.
  - All env-var names (`API_REQUIRE_KEY`, `API_CACHE_TTL`, `PLAN_*_LIMIT`) are kept out of the user-facing copy; runtime/config documentation lives in `README.md` and `.env.example`.
  - **`/providers` extended with `api.{ requireKey, cacheTtl, plans }`** so the docs page can adapt without a separate endpoint. `requireKey` mirrors the `API_REQUIRE_KEY` parsing in `src/apiRoutes.js` (truthy unless the env var equals `false` / `0` / `no` / `off`), `cacheTtl` reflects `API_CACHE_TTL` (default 604800), `plans` exposes `apiStore.PLAN_LIMITS` (`free` / `pro` / `enterprise`).
  - **`/robots.txt`** allow-list extended with `/api` and `/api.html`; **`/sitemap.xml`** includes a new `<url>` entry for `/api` (`<priority>0.8</priority>`, `<changefreq>monthly</changefreq>`) so search engines can index the docs page.
  - **Homepage `top-nav`** gains an **API** link pointing at `/api`, sitting between the **Tools** offcanvas button and the **MAFL+** external link.

- **Consistent top navigation across pages** — `api.html` now has the same top-nav as `index.html`: **Tools** offcanvas (bookmarklet + browser search-engine setup modal), **Home**, **API**, **MAFL+**, **Favicon API** and **Wiki** links. A **Home** menu item (`/`) has been added to both pages, with the current page highlighted via an `active` style.
- **Page footer on `index.html`** — the homepage now displays the same footer as `api.html` (links to GitHub and Wiki, separated by a subtle top border).
- **Browser custom search engine** (`/search?q=...` + `/opensearch.xml`)
  - New `GET /search?q={query}` route redirects to `/?q={query}` so the homepage loads favicon results for the typed domain or service name. Intended URL for browser search-engine settings: `https://your-host/search?q=%s`.
  - New `GET /opensearch.xml` OpenSearch descriptor (linked from the homepage `<head>`) for one-click "Add search engine" in Firefox, Chrome and other OpenSearch-aware browsers.
  - The homepage reads `?q=` on load and auto-runs a lookup.
  - **Web UI — "Search from browser" modal**: step-by-step setup instructions per browser (Chrome, Edge, Firefox, Safari) with the search-engine URL shown prominently (click-to-copy and as clickable links per section). The URL is derived from `location.origin` at runtime.
  - **Web UI — "Tools" offcanvas**: the browser-search and bookmarklet actions moved out of the main page flow into a slide-in panel opened from a **Tools** button in the top navigation. Keeps the homepage uncluttered while both shortcuts remain one click away. Closes on backdrop click or Escape; opening the search modal closes the offcanvas first.
- **homarr-labs/dashboard-icons lookup** (`/di/{service}`)
  - New service-name lookup against the [homarr-labs/dashboard-icons](https://github.com/homarr-labs/dashboard-icons) catalog via `cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/...`.
  - Supports `?variant=color|light|dark` with the same `-light` / `-dark` suffix convention used for `/sh/`. Color variant uses the bare slug (`/di/jellyfin` → `png/jellyfin.png`); light/dark map to `png/{slug}-light.png` and `png/{slug}-dark.png`.
  - Service slug validation reused from `/sh/`: lowercase alphanumerics with `.`, `_`, `-`.
  - Returns HTTP 404 when the upstream icon does not exist (caches the negative result through the existing on-disk cache layer).
  - New `dashboardicons` cache provider key + `fetchDashboardIcons(service, variant)` exported from `src/providers.js`; `PROVIDERS.dashboardIcons(service, variant)` builds the upstream URL.
  - `/{domain}/json` now exposes the new source alongside `selfhst` under `endpoints.dashboardicons` (same shape: `service`, `proxy`, `source`, `variants.{color,light,dark}.{proxy,source}`). `null`-valued fields when the domain has no usable slug (i.e. no first label).
  - **Best-pick cascade** (`/{domain}`): `dashboardicons` is added to the candidate set when a domain has a derivable service slug, and is a valid value for `DEFAULT_PROVIDER`. `.env.example`, `README.md` and the Environment Variables table updated to list the new value.
  - **Web UI**: new "Dashboard Icons (homarr)" card rendered side-by-side with the selfh.st card under the same `data-card-type="service"` group and the same color/light/dark variant probe pipeline (variant buttons auto-hide when the upstream variant does not exist). The existing search-options checkbox now controls both service-icon lookups (relabelled to "Also include service icon lookups (selfh.st & Dashboard Icons)") and the meta description / Open Graph / Twitter Card / JSON-LD description / keywords in `<head>` mention both catalogs for SEO.
- **SEO: `/robots.txt`, `/sitemap.xml` and a templated homepage**
  - New `GET /robots.txt` route serves an allow-list: only the homepage and the three static assets (`/favicon.png`, `/logo.png`, `/sitemap.xml`) are indexable; everything else (the `/g/...`, `/g2/...`, `/d/...`, `/y/...`, `/f/...`, `/v/...`, `/p/...`, `/k/...`, `/l/...`, `/s/...`, `/sh/...`, `/s-asset`, `/providers`, `/{domain}` and `/{domain}/json` endpoints) is disallowed so search engines don't enumerate the unbounded favicon URL space. The `Sitemap:` directive is auto-built from `${req.protocol}://${req.get('host')}`.
  - New `GET /sitemap.xml` route returns a single-URL sitemap pointing at the homepage, with `<loc>` derived from the request host (so it picks up the public origin behind any reverse proxy via the existing `trust proxy` setting; no env var required).
  - The homepage (`/` and `/index.html`) is now served by a small `renderIndex` route that loads `src/public/index.html` once at startup and substitutes `__BASE_URL__` tokens with the request's absolute origin before sending. This populates `<link rel="canonical">`, Open Graph (`og:url`, `og:image`), Twitter Card (`twitter:image`) and JSON-LD (`schema.org/WebApplication`) absolute URLs automatically, without baking the hostname into the image.
  - `express.static` is now mounted with `{ index: false }` so requests for `/` and the raw `/index.html` always go through the templated route — preventing the unrendered `__BASE_URL__` placeholders from ever leaking to the browser. All other static assets (`/favicon.png`, `/logo.png`) continue to be served by `express.static`.
- **SEO meta in `src/public/index.html` `<head>`**
  - Descriptive `<title>` (`MAFL+ Favicon API – Get high-resolution favicons for any domain`) and meta `description`, `keywords`, `author`, `robots`, `theme-color`, `color-scheme`, `application-name`.
  - `<link rel="canonical">`, `<link rel="apple-touch-icon">` and `<link rel="sitemap">` for auto-discovery.
  - Full Open Graph card (`og:type`, `og:site_name`, `og:title`, `og:description`, `og:url`, `og:image` + `og:image:type/width/height/alt`, `og:locale`) for Facebook / LinkedIn / Discord / Slack unfurls.
  - Twitter Card (`summary` with `twitter:title/description/image/image:alt`).
  - JSON-LD structured data (`@type: WebApplication`, with `name`, `description`, `url`, `image`, `applicationCategory: DeveloperApplication`, free `Offer`, `author`, `isPartOf: MAFL+` and `sameAs` to the GitHub repos and the MAFL+ wiki).
  - Documented in `README.md` under a new "SEO" section and the API table rows for `/robots.txt` and `/sitemap.xml`.
- **`CACHE_SIZE_MB` environment variable** caps the total size of the disk cache (`CACHE_DIR`) in megabytes. When the directory exceeds the configured limit, the oldest entries (by `mtime`) are evicted — both the data file and its `.meta` sibling — until the cache is back under the cap. Each cluster worker keeps a lightweight in-memory index of disk files and rescans the shared cache directory every 60 seconds (and on every set that pushes its local view over the limit) so writes from sibling workers converge into a single accurate view before eviction runs. Set to `0` (default in code) to disable the size cap and fall back to the original TTL-only behaviour. Bundled `docker-compose.yml` and `.env.example` ship `CACHE_SIZE_MB=512` as a sensible upper bound for a typical deployment. Documented in `README.md`.
- **besticon integration for the HTML scraper**
  - New `BESTICON_URL` environment variable points at a sidecar [besticon](https://github.com/mat/besticon) instance (e.g. `http://besticon:8080`).
  - When set, `/s/{domain}` first asks besticon's `/allicons.json?url={domain}` for the icon list, then runs the candidates through the existing `sharp`-validated probe pipeline (`fetchBesticonCandidates` → `rankCandidates` → `probeScraperCandidates`). Falls back to the built-in HTML scraper (`fetchScraperPage` + `buildScraperCandidates`) when besticon is unreachable or returns no usable candidates.
  - The resulting entry keeps `provider: 'scraper'` so the `X-Favicon-Source` header, the scraper cache key (`?refresh=1` flow) and the `/{domain}/json` listing all stay backward-compatible.
  - **`/{domain}/json` now exposes the full discovered icon list** under `endpoints.scraper.icons` (each entry has `url`, `width`, `height`, `format`, `bytes`); empty array when `BESTICON_URL` is unset or besticon errors out.
  - **New asset proxy `/s-asset?url=...`** that fetches arbitrary upstream icon URLs server-side using the scraper's existing header retry strategy (bare → minimal → Sec-Fetch chrome headers). Cached on disk + LRU keyed by SHA-1 of the URL; SSRF-guarded against localhost / `127.`, `10.`, `192.168.`, `169.254.`, `::1`, link-local and ULA IPv6 ranges; max URL length 2048; only `http(s)`. Used by the UI so CDN Referer/hotlink protection on hosts like `redditstatic.com` or `redgifs` cannot break direct browser `<img>` loads.
  - **HTML Scraper card in the web UI** now renders a row of size-selector buttons (same `.size-btn` styling as Google/Faviconkit), populated from `endpoints.scraper.icons` and sorted descending by `width × height`. Clicking a size:
    - Idx 0 (largest) keeps loading via the canonical `/s/{domain}` proxy so click-to-copy on the image still yields the embeddable scraper URL.
    - Idx > 0 loads via `/s-asset?url=...`, with the meta row showing `{w}×{h}` and the upstream source URL plus a copy button (consistent with Google's behaviour).
    - Race-protected via a `currentScraperIdx` guard so a slow variant load cannot overwrite a newer selection.
  - **Bundled `docker-compose.yml` ships besticon as an internal-only service**: no `ports:` mapping (the besticon frontend at `/` is not publicly reachable), health-checked on `/up`, joined to a shared `besticon` bridge network so `maflplus-favicon-api` can resolve it on hostname `besticon`. `maflplus-favicon-api` declares `depends_on: besticon: { condition: service_healthy }` and is configured with `BESTICON_URL=http://besticon:8080` by default.
  - Documented in `README.md` and `.env.example`:
    - API table row for `/s-asset?url=...` covering the SSRF guard (localhost / private IPv4 ranges, link-local / ULA IPv6, `http(s)` only, max URL length 2048) and that the route is used by the UI for upstream icons whose CDN blocks direct browser `<img>` loads.
    - `/s/{domain}` row updated to mention besticon delegation via `/allicons.json?url=...` and the built-in scraper fallback.
    - `/{domain}/json` example documenting the new `endpoints.scraper.icons` array.
    - Docker section rewritten to show the actual two-service compose file (incl. the besticon sidecar with healthcheck, the shared `besticon` bridge network and `depends_on: { condition: service_healthy }`) plus a note on swapping `image:` for `build: .` and how to run the stack without besticon (built-in scraper fallback).
    - Environment Variables table entry for `BESTICON_URL`.
- **HTML scraper provider** (`/s/{domain}`)
  - Parses the target site's HTML for `<link rel="icon">`, `shortcut icon`, `apple-touch-icon`, `apple-touch-icon-precomposed`, and `fluid-icon`.
  - Reads the web app manifest (`<link rel="manifest">`) and merges its declared icons into the candidate list.
  - Honours `<base href>` and follows redirects to resolve relative URLs against the final document URL.
  - Adds standard fallbacks: `/apple-touch-icon.png`, `/apple-touch-icon-precomposed.png`, `/android-chrome-512x512.png`.
  - Probes well-known larger size variants on CDN paths that follow an `NxN` naming pattern (e.g. `64x64.png` → `128x128.png`, `256x256.png`, `512x512.png`) to recover hi-res icons that SPAs only inject client-side.
  - Score-ranks candidates by declared `sizes` attribute and format (SVG > PNG > WebP > ICO), then verifies real image dimensions via `sharp` and picks the largest valid result.
  - Skips non-display icon types when ranking: Safari `mask-icon` / pinned-tab SVGs, and web-app-manifest icons with `purpose: monochrome` (or matching URL patterns).
  - New `cheerio` dependency for HTML parsing.
  - Scraper cache bypass: `/s/{domain}?refresh=1` (or `?nocache=1`) clears the cached entry and re-scrapes.
- **Google v2 provider** (`/g2/{size}/{domain}`)
  - Uses `t0.gstatic.com/faviconV2` for higher-resolution Google icons.
  - Supported sizes: 16, 32, 64, 128, 256.
- **Faviconkit provider** (`/k/{size}/{domain}`)
  - Uses `ico.faviconkit.net`. Supported sizes: 16, 32, 64, 128, 256.
- **logo.dev provider** (`/l/{domain}`)
  - Optional, gated by the new `LOGODEV_TOKEN` environment variable.
  - Returns HTTP 503 when the token is not configured.
- **selfhst icons lookup** (`/sh/{service}`)
  - Service-name lookup against the [selfhst icons](https://github.com/selfhst/icons) catalog via `cdn.jsdelivr.net`.
  - Supports `?variant=color|light|dark`.
  - Service slug validation: lowercase alphanumerics with `.`, `_`, `-`.
- **Provider configuration endpoint** (`/providers`)
  - Reports which optional providers are enabled (currently `logoDev`) and exposes the publishable logo.dev token to the UI for direct image references.
  - Reports `upstreamIpv4: true` when upstream fetches are forced over IPv4 (datacenter/VPS compatibility).
  - Reports `defaultProvider` when `DEFAULT_PROVIDER` is configured.
- **`/{domain}/json` endpoint expansion**
  - Now includes Google v2, Faviconkit (sized variants), Vemetric (default + sized + format variants), logo.dev, HTML scraper and selfhst entries (with `color`/`light`/`dark` variants).
  - Each endpoint exposes both a `proxy` URL (this server) and a `source` URL (upstream provider) for transparency.
- **Best-pick cascade** (`/{domain}`) updated to include the new providers
  - New default fallback order: scraper → Google v2 → DuckDuckGo → Google → Faviconkit → Favicon.so → Vemetric → Favicon-3j1 → Yandex.
  - When `LOGODEV_TOKEN` is set, logo.dev is inserted near the top of the cascade.
- **Web UI**
  - New cards for HTML Scraper, Faviconkit (with size buttons 16–256), logo.dev (only shown when the server reports it as configured) and selfhst icons (with color/light/dark variant buttons).
  - Search input now accepts both a domain (e.g. `example.com`) and a bare service name without a TLD (e.g. `radarr`, `sonarr`); when no dot is present the input is treated as a selfhst service name and only the selfhst card is shown.
  - "Also include selfhst icon lookup when searching a domain" toggle to additionally probe a derived service slug for any domain query.
  - Quick-link suggestions extended with self-hosted service examples (`firefox`, `immich`, `jellyfin`).
  - Front-end fetches `/providers` on load to conditionally show or hide the logo.dev card.
  - Favicon preview images append a cache-busting query parameter so browser cache does not show stale scraper results after redeploy.
  - HTML Scraper card shows the **proxy URL** (`/s/{domain}`) under the icon — the URL to use in apps — not the scraped site's homepage.
- **`upstreamFetch` module** (`src/upstreamFetch.js`)
  - Shared IPv4-only undici `fetch` wrapper with an optional HTTP/1.1 dispatcher (`allowH2: false`) for scraper retries against origins that reject HTTP/2 from datacenter IPs.
- **Cluster mode** (`src/cluster.js`)
  - New entrypoint that forks one worker per CPU core using Node's built-in `cluster` module; the Docker `CMD` now boots `src/cluster.js` instead of `src/index.js`.
  - Crashed workers are automatically respawned with a log line.
  - Configurable via the new `WORKERS` environment variable; defaults to `os.cpus().length`. Set `WORKERS=1` to run as a single process (clustering disabled). Note: in Docker, `os.cpus()` reports the host's core count rather than the container's CPU limit — set `WORKERS` explicitly when constraining CPU.
- **Performance / concurrency configuration**
  - New `UV_THREADPOOL_SIZE` (default `16` in `docker-compose.yml` and `.env.example`) raises Node's libuv thread pool above the built-in default of `4`, giving more headroom for parallel disk I/O (cache reads/writes) and DNS lookups under load.
  - New `PICK_HEAD_START_MS` (default `150` ms) controls the head-start given to the preferred provider in the new parallel `/{domain}` race (see "Changed" below).
  - New `SCRAPER_PROBE_BATCH_SIZE` (default `4`) controls how many HTML scraper icon candidates are probed in parallel per batch.
- **Configuration**
  - New `DEFAULT_PROVIDER` environment variable to set the preferred provider for `/{domain}` requests. Valid values: `scraper`, `google`, `googlev2`, `duckduckgo`, `yandex`, `faviconso`, `vemetric`, `favicondev`, `faviconkit`, `logodev`, `selfhst`. Other providers race in parallel after the head-start window. Logs a warning at startup when an invalid value is supplied.
  - New `LOGODEV_TOKEN` environment variable, documented in `README.md`, `.env.example` and `docker-compose.yml`.
- **Documentation**
  - `README.md` rewritten to cover all new endpoints, the size matrix per provider, the selfhst lookup, the `/providers` endpoint, and the `LOGODEV_TOKEN` variable.
  - Endpoint table consolidated to use parameterised paths (e.g. `/g/{size}/{domain}`) instead of one row per size.
  - Documented scraper cache bypass: `/s/{domain}?refresh=1` (alias `?nocache=1`).
- **Response headers**
  - Favicon responses may include `X-Favicon-Url` with the upstream asset URL when known (e.g. after HTML scraper fetch).

### Changed

- **`parseIconCandidatesFromHtml` (`src/providers.js`)** now also reports the `rel` attribute per candidate (`{ href, sizes, type, rel }`), enabling the new `apiScraper.js` to classify candidates by source type (`svg` / `manifest` / `apple-touch-icon` / `png` / `ico`). Existing callers (`buildScraperCandidates` in `fetchScraper`) ignore the new field and are not affected.
- **`src/providers.js` exports** expanded with `fetchScraperPage`, `parseIconCandidatesFromHtml`, `fetchManifestIcons` and `parseSizesAttr` so the new `apiScraper.js` can reuse the existing HTML/manifest fetch pipeline without duplication. Pre-existing exports are unchanged.
- **`Dockerfile`** updates for the v1 API:
  - Deps stage installs `python3 make g++` as a virtual `.build-deps` apk package and removes them again after `npm ci`, so native modules like `better-sqlite3` can compile from source on Alpine/musl when no prebuilt binary is available for the target arch; the runtime image is unaffected.
  - Runtime stage now also copies `scripts/` so the `npm run keys:*` CLI is available inside the container (`docker compose exec maflplus-favicon-api npm run keys:create -- ...`).
- `docker-compose.yml` supports local development via `build: .` (comment out for the published `ghcr.io/r0gger/maflplus-favicon-api:latest` image).
- Best-pick (`/{domain}`) now scrapes the source site first, falling back to network providers only when scraping does not yield a usable icon — typically improving icon quality and resilience for self-hosted/private domains.
- **Best-pick (`/{domain}`) races providers in parallel** instead of trying them strictly sequentially.
  - The preferred provider (first in priority order, typically `DEFAULT_PROVIDER`) is started immediately; the remaining providers start after `PICK_HEAD_START_MS` (default 150 ms) — or sooner if the preferred provider has already failed.
  - The first successful response wins via `Promise.any`. Cache-miss latency for `/{domain}` drops from "worst-case ~5–10 s across providers" to "roughly the fastest provider's response time".
  - `DEFAULT_PROVIDER` is still honoured under good network conditions thanks to the head-start, but a slow or failing favorite no longer blocks the response.
- **HTML scraper probes candidates in parallel** (`probeScraperCandidates` in `src/providers.js`).
  - Variant groups (sorted `NxN` CDN paths) are processed concurrently, while the sequential size-jump heuristic inside each group is preserved.
  - Loose candidates are probed in parallel batches (default 4 at a time, via `SCRAPER_PROBE_BATCH_SIZE`).
- **`MEMORY_CACHE_MAX` default raised from `500` to `2000`** entries per worker — higher in-memory cache hit ratio for deployments serving many distinct domains. Memory cost is per-worker (each cluster worker has its own LRU).
- Node process sets `dns.setDefaultResultOrder('ipv4first')` at startup; Docker image passes `--dns-result-order=ipv4first` for additional IPv4 preference on upstream DNS resolution.
- **`/{domain}/json` scraper `source` field** — reports the cached upstream asset URL when available, instead of always `https://{domain}/`.
- Static `index.html` is served with `Cache-Control: no-cache` so UI fixes apply immediately after redeploy without a hard browser refresh.

### Fixed

- **HTML Scraper resolution mismatch on first load** — the web UI no longer runs `loadFavicon()` in parallel with the `/{domain}/json` icon-list fetch. Previously the size-button strip could render with the largest variant selected (e.g. **512**) while the meta row still showed the dimensions from an earlier `/s/{domain}` image load (e.g. **192×192**), because `loadScraperSizes()` rendered the buttons but never called `loadScraperVariant(0)` to sync the image and footer. The scraper card now waits for the JSON icon list, then loads variant 0 via `loadScraperVariant()` so the active button, displayed image and `{w}×{h}` meta always come from the same entry; falls back to the legacy `loadFavicon()` path when the JSON fetch fails or returns no icons. The primary (largest) variant's meta row again shows and copies the proxy URL (`{origin}/s/{domain}`).
- **HTML Scraper size-button strip on production / datacenter hosts** — `/{domain}/json` now augments besticon's discoveries with the existing `STATIC_CDN_HINTS` + `expandSizedVariants` ladder before returning `endpoints.scraper.icons`, and `fetchScraper` does the same when picking the "best" icon for `/s/{domain}`. Previously, when the sidecar besticon was blocked by an origin's datacenter-IP filter (Reddit serves a JS-challenge interstitial to cloud IPs), besticon would only surface the 3 standard fallback URLs (`favicon.ico`, `apple-touch-icon.png`, `apple-touch-icon-precomposed.png`), so the UI's size-button strip rendered just `32 / 57 / 128` — even though our own node process could reach the CDN-hosted hi-res variants directly. The merged probe now lifts that to the full ladder (e.g. `64 / 76 / 120 / 128 / 152 / 180 / 192 / 256 / 384 / 512` for `reddit.com`, depending on which variants the CDN actually serves) regardless of whether besticon could see them. Implemented via new `deriveHintCandidates` + `fetchScraperAllIcons` helpers in `src/providers.js`; results are LRU-cached in-memory (configurable via `SCRAPER_ICONS_CACHE_TTL`, default 3600 s, and `SCRAPER_ICONS_CACHE_MAX`, default 500 domains) so the UI does not re-probe 8+ candidate URLs on every page load.
- **HTML scraper Reddit regression** — `<link rel="icon">`, `rel="shortcut"` (incl. combined `rel="icon shortcut"`) and `rel="fluid-icon"` are recognised again, alongside `apple-touch-icon` / `-precomposed`. `NxN` CDN paths are once again expanded to larger size variants (e.g. `64x64.png` → 128/152/180/192/256/384/512). Reddit's datacenter-IP interstitial only declares a single `rel="icon shortcut" sizes="64x64"`, so the previous tightening caused `/s/reddit.com` to fall back to the old low-res `apple-touch-icon.png` instead of the modern 192×192 chat-bubble logo. The `MAX_FAVICON_SIZE_JUMP = 2.5` guard still prevents Reddit's 512×512 marketing PNG from winning over the real 192×192 favicon. `STATIC_CDN_HINTS` for `reddit.com` / `www.reddit.com` is restored as a defensive fallback when the interstitial drops the icon link entirely.
- **HTML scraper on VPS/datacenter hosts** — upstream fetches now use a dedicated IPv4-only undici dispatcher (`src/upstreamFetch.js`), fixing broken IPv6 egress that caused CDN assets (e.g. `redditstatic.com`) to fail while same-origin fallbacks still worked.
- **HTML scraper icon probing** — CDN/cross-origin icon URLs are fetched with a bare `upstreamFetch` (no extra headers) before retrying with browser-like headers; extra headers were rejected by some CDNs from datacenter IPs.
- **HTML scraper homepage fetch** — retries across `https://{domain}/` and `https://www.{domain}/` with bare, HTTP/1.1, curl and Chrome user-agents when the initial HTML request fails or returns an empty body.
- **HTML scraper fallback ordering** — standard `/apple-touch-icon-precomposed.png` fallbacks are only used when all HTML/CDN candidates fail, preventing a wrong 128×128 icon from winning over a reachable CDN hi-res variant.
- **HTML scraper static CDN hints** — when homepage HTML is blocked entirely (e.g. `reddit.com` from datacenter IPs), known CDN entry points are probed and expanded to larger `NxN` variants (`STATIC_CDN_HINTS` in `providers.js`).
- **HTML scraper variant probing** — when probing `NxN` CDN paths, stops before a sharp size jump (e.g. Reddit serves a full-body marketing PNG at 512×512 while 64–192 are the actual logo favicons).
- **HTML scraper mask-icon exclusion** — ignores Safari `rel="mask-icon"` / `safari-pinned-tab.svg` assets; these are monochrome pinned-tab silhouettes, not display favicons (e.g. `proton.me` showed a solid black "P" instead of the purple gradient logo).
- **HTML scraper manifest monochrome icons** — skips web-app-manifest icons with `purpose: monochrome` (and known monochrome URL patterns); sites like YouTube expose a white logo at 512×512 alongside the red favicon set.
- **HTML scraper manifest size threshold** — only manifest icons with a declared size of `512×512` or larger are considered, avoiding low-res manifest entries winning over a higher-quality `apple-touch-icon`.
- **Web UI HTML Scraper URL** — card no longer showed `https://{domain}/` under the icon; it now always displays and copies the proxy URL (`{origin}/s/{domain}`), matching how other providers expose usable API URLs.

### Internal

- New dependencies: `better-sqlite3` (synchronous SQLite driver in WAL mode so the API key store is safe across cluster workers writing into the same `/cache/api-keys.sqlite` file) and `decode-ico` (multi-frame ICO decoder used by the 256×256 PNG normaliser to extract the largest frame from `/favicon.ico` responses).
- The v1 API cache is **namespaced separately** from the existing provider-based cache (`src/cache.js`): PNGs live at `${API_CACHE_DIR}/{domain}.png` with a sibling `.meta.json` (`{ sourceType, cachedAt }`) so the two schemes can coexist in `/cache` without key collisions. The existing `CACHE_SIZE_MB` LRU rescan picks up `${API_CACHE_DIR}/...` files alongside the rest of the cache directory, so the global disk-size cap also covers the v1 API output.
- New `fetchScraperAllIcons(domain)` exported from `src/providers.js` is the single source of truth for the merged scraper icon list (besticon + static CDN hints + sized variants, deduped + sorted by area). Backed by an in-memory `LRUCache` (`SCRAPER_ICONS_CACHE_MAX` / `SCRAPER_ICONS_CACHE_TTL`). Consumed by `/{domain}/json` (`endpoints.scraper.icons`); `fetchScraper` uses the same `deriveHintCandidates` helper to enrich its candidate pool before `probeScraperCandidates` so the chosen "best" icon matches the largest entry the UI displays. `probeScraperCandidates` is invoked with `limit=32` in the besticon path so the augmented pool is not truncated at the previous default of 16. The earlier `fetchBesticonAllIcons` export is now an internal implementation detail.
- `fetchScraperAsset` is exported from `src/providers.js`; the asset fetcher is reused by the `/s-asset` route.
- New `besticonIconsToCandidates` helper bridges besticon's raw `/allicons.json` response to the existing `{ href, sizes, type }` candidate format consumed by `rankCandidates` / `probeScraperCandidates`.
- `BESTICON_URL` is read once at module load (`process.env.BESTICON_URL`) and trailing slashes are stripped so both `http://besticon:8080` and `http://besticon:8080/` work.
- `services.txt` added to `.gitignore` (local notes file).
- `cache.del()` added for per-entry cache invalidation (used by `/s/{domain}?refresh=1`).
- HTML scraper upstream requests routed through `src/upstreamFetch.js` instead of global `fetch`.
- Disk cache metadata now persists the upstream `url` for scraper entries (used by `X-Favicon-Url` and `/{domain}/json`).
- New `runInBatches` helper in `src/providers.js` for bounded-parallel iteration with `Promise.allSettled` semantics.
- Disk cache directory (`/cache`) is shared across cluster workers; each worker keeps its own in-process LRU memory cache.

---

## [1.0.0] — Initial public release

### Added

- Express-based favicon proxy with two-tier (memory + disk) caching.
- Domain-based providers:
  - Google (`/g/{size}/{domain}`) — sizes 16, 32, 64, 128.
  - DuckDuckGo (`/d/{domain}`).
  - Yandex (`/y/{domain}`).
  - Favicon.so (`/f/{domain}`).
  - Vemetric (`/v/{domain}`) with optional `?size=` and `?format=png|jpg|webp`.
  - Favicon-3j1 (`/p/{domain}`).
- Best-pick endpoint (`/{domain}`) cascading through all providers and scoring results with `sharp`.
- `/{domain}/json` endpoint listing every favicon URL for a given domain.
- Web UI (`src/public/index.html`):
  - Per-provider cards with click-to-copy URL behaviour.
  - Top navigation bar linking to MAFL+, the Favicon API repo and the Wiki.
  - Bookmarklet ("Mafl+ Favicon Copy") that copies the favicon URL of the current page.
  - "Show source" indicator displaying which upstream provider returned the favicon.
- Configuration via environment variables: `PORT`, `CACHE_DIR`, `MEMORY_CACHE_MAX`, `MEMORY_CACHE_TTL`, `DISK_CACHE_TTL`, `UPSTREAM_TIMEOUT`.
- Dockerfile, `docker-entrypoint.sh` and `docker-compose.yml` for container deployment, plus a GitHub Actions workflow that publishes images to `ghcr.io/r0gger/maflplus-favicon-api`.
- `.gitattributes` enforcing LF line endings.

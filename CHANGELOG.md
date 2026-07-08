# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.9.2] — 2026-07-08

### Changed

- **Web UI — HTML Scraper remembers discovery per domain** — the size-discovery result from `GET /{domain}/json` is now cached in-page (keyed by domain). Repeat searches for a domain already looked up in the same session render **instantly from memory**: no `GET /{domain}/json` round-trip and no "Discovering other icon sizes…" loader. The scraper **Refresh** button (and `?refresh=1`) bypasses the cache and re-runs discovery, overwriting the stored result.
- **HTML Scraper — discovery disk cache on by default** — `SCRAPER_DISK_CACHE` now defaults to **true** (unset/empty enables it; only an explicit `false`/`0`/`no`/`off` disables it). Scraper discovery (homepage HTML, merged icon list, besticon JSON, manifest parses, icon-probe metadata) is persisted under `SCRAPER_DISK_CACHE_DIR` (`/cache/scraper-discovery`), so `GET /{domain}/json` and `GET /scraper/{domain}` read from disk instead of re-scraping on every request. The cache now **survives container restarts** and is **shared across cluster workers** (each worker previously re-scraped a domain the first time it saw it). Updated `.env.example`.
- **Favicon `Cache-Control` gains `immutable`** — proxy favicon responses now send `public, max-age=86400, immutable` so browsers reuse the cached icon on repeat views without a revalidation round-trip.

### Fixed

- **Web UI — Firefox loaded every icon twice** — provider image loaders created a detached `new Image()` with `crossOrigin = 'anonymous'` and then copied its `src` onto the visible `<img>` (which had no `crossOrigin`). Firefox partitions its HTTP cache by CORS mode, so the visible `<img>` missed the bytes the loader had just fetched and **re-downloaded every icon** — roughly doubling scraper/provider requests (worse than Chrome, which reused them). `crossOrigin` was unnecessary here — all icons are served from the same-origin proxy, there is no `<canvas>` use, and downloads go through `fetch()` — so it was removed from all image loaders. Each icon is now fetched once and repeat searches reuse the browser cache.

## [2.9.1] — 2026-07-08

### Fixed

- **Web UI — app-icon catalog controls** — **SVGL** card format/variant buttons now share the same `size-buttons-toolbar` wrapper as the other service-icon cards, so PNG/SVG and Color stay on one row.
- **Web UI — catalog size buttons ignored clicks** — with the default size filter active, `applySizeFilter()` reset catalog PNG sizes to the auto-picked raster step (e.g. 256) after every preview load, so manual 128/64/32/16 selections appeared dead. Manual sizes within the active filter are now preserved (`catalogHasStableRasterSize`).
- **Light/dark service-icon variants** — API/UI variants again match the preview semantics (**Light** = pale icon on a dark background, **Dark** = dark icon on a light background). Corrected `pngVariantSuffix()` for **selfh.st** and **dashboardicons.com**, LobeHub theme folder mapping, and SVGL route selection. Web UI preview backgrounds were already correct; only the upstream asset choice was wrong.
- **selfh.st light/dark PNG previews** — upstream `-light`/`-dark` PNGs often bake in mismatched circular backgrounds (e.g. `github-light.png`). Light/dark requests now prefer the monochrome **SVG** variant and rasterize server-side; variant availability probes and `/{service}/json` source URLs follow the SVG assets. Cache keys bumped (`light_v5` / `dark_v5`).
- **Web UI — Light/Dark buttons missing on catalog cards** — variant probes appended `?probe=` to proxy URLs that already carried `?variant=…`, producing invalid URLs (HTTP 400) so Light/Dark toggles never appeared even when the API listed the variants. Probes and catalog image loads now append cache-busting params with `&` when a query string is already present.

## [2.9.0] — 2026-07-08

### Added

- **`scraperMaxIconSize` on `GET /providers`** — exposes `SCRAPER_MAX_ICON_SIZE` to the Web UI so the HTML Scraper fast-proxy size button (e.g. 128) can render before `/{domain}/json` finishes.

### Changed

- **Web UI — HTML Scraper parallel preview** — `GET /scraper/{domain}` starts alongside `/{domain}/json` instead of waiting for the discovery response. Repeat visits can use browser HTTP cache: scraper image URLs are stable on normal searches; `?_=timestamp` cache busting applies only on explicit refresh (`refreshScraper()` / `?refresh=1`).
- **Web UI — HTML Scraper progressive size strip** — when `SCRAPER_MAX_ICON_SIZE` is set, the fast-proxy button appears immediately next to a “Discovering other icon sizes…” loader (spinner + skeleton pills) while JSON discovery runs. The preview uses soft-load so the capped proxy icon can appear without hiding it behind the main favicon spinner.

### Fixed

- **HTML Scraper — icon probes bypassed disk cache** — `fetchScraperAsset` (used when the scraper probes candidate icon URLs during discovery) always fetched from the internet, even when the same bytes were already on disk from `/s-asset`, sized scraper routes, or an earlier probe. It now reads `asset-raw_*` and `asset-v2_*` entries from `CACHE_DIR` before going upstream, and writes new fetches back as `asset-raw_*`. Repeat scrapes and container restarts with a persistent `/cache` volume no longer re-download every candidate icon.

## [2.8.14] — 2026-07-08

### Changed

- **Web UI — size filter default** — the dual-range slider now starts at **16–512px** on first visit (no saved preference in `localStorage`).
- **Web UI — size filter on tablets** — the dual-range slider and download-size buttons (`.download-toolbar-left`) are visible on **tablets** (≥800px). The left toolbar cluster is hidden at **≤799px** (was ≤700px); smartphones and narrow tablets no longer show the size filter or download-size strip.

### Fixed

- **HTML Scraper — SVG-only sites (e.g. hosthatch.com)** — domains with only an SVG `<link rel="icon">` were missing from `/{domain}/json` icons and sized routes (`/scraper/256/png/…`, `/scraper/512/png/…`) could return blurry upscaled PNGs when `SCRAPER_MAX_ICON_SIZE` capped the default cache at 128px. The scraper now probes HTML page link candidates (including sized variants), treats SVG sources as **512×512** for discovery/ranking, rasterizes SVG **directly at the requested size**, and only downscales raster icons when the source is larger than the target. Empty icon lists are no longer treated as a valid disk/memory cache hit.

- **Web UI — HTML Scraper card hidden with size filter** — with the default **16–256px** filter active, the scraper card could vanish from the grid for SVG-only domains: `writeCardMeta` ignored `isVector: false` when the source URL ended in `.svg`, so the card was classified as vector and hidden whenever a maximum size was set. Explicit `isVector: false` is now respected; scraper cards are never treated as vector; the scraper card **stays visible** in the grid while size buttons outside the filter range are disabled. The **Fast proxy** button (`/{domain}`, e.g. 128px with `SCRAPER_MAX_ICON_SIZE=128`) stays clickable; proxy and proxy-size selections are preserved when the size slider changes.

## [2.8.13] — 2026-07-08

### Fixed

- **Web UI — size filter disabled out-of-range size buttons** — with an active size filter (e.g. the default **16–256px**), clicking a provider size button **outside** the range (e.g. **512** on the HTML Scraper, or **64** when the minimum is **128**) loaded that size and the card was hidden by the filter (`size-filter-hidden`), which looked like the preview frame jumping away or vanishing. Size buttons on **HTML Scraper** (proxy and discovered sizes), **Google**, **FaviconKit**, **favicon.run**, **Twenty-icons**, **Brandfetch**, and app-icon catalogs (**selfh.st**, **dashboardicons.com**, **LobeHub**, **SVGL**) are now **disabled** when they fall outside the active min/max; `switch*Size` handlers ignore those sizes as a safeguard. Buttons re-enable when the slider range includes them again.

## [2.8.12] — 2026-07-07

### Fixed

- **Best-pick — stale `best` cache ignored `DEFAULT_PROVIDER`** — after upgrading to 2.8.11, `GET /{domain}` could keep serving an old CDN fallback (e.g. DuckDuckGo's generic Google **G** for `calendar.google.com`) while `GET /scraper/{domain}` showed the correct product icon. The `best` cache layer stores whichever provider won an earlier race; CDN icons are valid raster/ICO responses, so they were not invalidated by placeholder detection. When `DEFAULT_PROVIDER` is set, a cached `best` entry from a **different** provider is now discarded and the default provider is fetched again. Fixes the frontend vs `/{domain}` mismatch when the HTML Scraper card preview (scraper) and the short embed URL (best-pick) diverged.

## [2.8.11] — 2026-07-07

### Changed

- **`DEFAULT_PROVIDER` on `/{domain}`** — when set, that provider now runs **exclusively first**; the fallback race only starts after it fails (null, empty, or placeholder). Previously it only received a head-start (`PICK_HEAD_START_MS`, default 150ms), so fast CDN placeholders (e.g. ryanjc's generic globe SVG) could still win over a slower scraper even with `DEFAULT_PROVIDER=scraper`. `PICK_HEAD_START_MS` now applies only when `DEFAULT_PROVIDER` is unset, or to the first fallback after the default fails. Docs updated in `.env.example`, [Getting Started](/docs/getting-started), and [Tweaks §7](/docs/tweaks#7-pick-a-fast-default-provider-for-domain).

### Fixed

- **Best-pick — ryanjc placeholder on private / unreachable hosts**  — `GET /{domain}` could return favicon.ryanjc.com's generic tabler **earth** SVG (often rendered as a black globe) while `GET /scraper/{domain}` correctly served the site's own icon. The placeholder is now detected in `isUnusableIcon` (same pattern as favicon.so and Vemetric placeholders) and rejected in the best-pick race and per-provider caches. Stale `best` cache entries that hold the placeholder are invalidated on the next request.

## [2.8.10] — 2026-07-07

### Added

- **Preload CLI — Tranco top sites** — `scripts/preload-top-sites.js` warms the favicon cache for the world's most visited websites. By default it downloads the latest [Tranco](https://tranco-list.eu/) top **500** and, per domain, calls **`GET /{domain}`** (best-pick provider cache) and **`GET /api/v1/favicon?url=…`** (normalized 128×128 PNG under `API_CACHE_DIR`). Options: `--limit`, `--concurrency`, `--api-key`, `--domains-file`, `--skip-standard`, `--skip-v1`, `--timeout`, `--dry-run`. Exposed as `npm run preload:top-sites` (script is included in the Docker image under `scripts/`).

- **Selfhosted docs — preload guide** — [Tweaks §10 Preload popular sites after deploy](/docs/tweaks#10-preload-popular-sites-after-deploy): Tranco source, Docker-only usage (`docker compose exec favicon-api …`), options table, and expectations (duration, failures, load). [API v1](/docs/api-v1) CDN section links to the same guide.

## [2.8.9] — 2026-07-07

### Added

- **Web UI — results table view** — switch between the existing card grid and a compact **table layout** from the download toolbar (grid / table toggle). The choice is **remembered in `localStorage`** (`faviconapi-results-view`). Columns: **Icon**, **Provider**, **Extension** (PNG/SVG toggle for catalog providers that support both), **Size**, **Link**, **Source**, and **Download**. The table stays in sync with the grid: size filter, loading skeletons, app-icons section divider, extension switches, and per-row download all mirror card behaviour. **Copy URL** from the icon, **Size**, **Link** (dedicated copy button), or **Source** column; the link text itself still opens in a new tab.

### Changed

- **Web UI — download toolbar on small screens** — the **size filter** (dual-range slider and label) is **desktop-only** (hidden below 1210px, smartphones and tablets). On **smartphones** (≤700px), the **grid/table toggle**, **Build custom URL** button, and the left toolbar cluster are hidden; results always use **grid view** on that breakpoint (table preference in `localStorage` is kept for wider screens).
- **Web UI — table Download column** — download buttons are **centered** in the column.
- **Web UI — placeholder results grid once per browser** — the skeleton preview is remembered in **`localStorage`** (`faviconapi-placeholder-seen`) instead of `sessionStorage`, so reopening a closed tab or refreshing no longer shows the skeleton again. Legacy `sessionStorage` flags are migrated on first load.

### Fixed

- **Web UI — placeholder on tab restore** — restoring a closed tab from the back-forward cache no longer leaves the skeleton grid visible when the preview was already shown; a `pageshow` handler clears stale placeholder state.
- **Web UI — placeholder vanishing on first load** — the skeleton preview disappeared as soon as `GET /providers` finished because the follow-up refresh treated the grid as stale; the second `showPlaceholderResults()` call now only updates provider visibility instead of hiding the grid.

## [2.8.8] — 2026-07-07

### Added

- **Web UI — size filter** — filter the results grid by icon dimensions with a **dual-range slider** (left thumb = minimum, right thumb = maximum; snap to 16–512px). **SVG icons always pass the minimum** (vector, unlimited resolution) but are **hidden when a maximum is set**. App-icon catalogs that offer SVG (selfh.st, dashboardicons.com, LobeHub, SVGL) **load as SVG when only a minimum is set**, or **as PNG at the largest fitting size when a maximum applies**; the filter also re-applies if a catalog initially loads the wrong format. Filter choices are **remembered in `localStorage`** for the next visit. Download-all, the no-icon notice, and the app-icons divider respect the active filter.

### Changed

- **Web UI — size filter default** — the dual-range slider now starts at **16–256px** on first visit (no saved preference in `localStorage`).

### Fixed

- **Web UI — size filter hid SVG catalog providers** — selfh.st, dashboardicons.com, LobeHub, and **SVGL** could disappear when a size filter was active: minimum-only filters left catalogs on 128px PNG instead of SVG; maximum filters (e.g. ≤512px) requested unsupported 512px PNG (HTTP 400) or kept SVGL on SVG (hidden because SVG exceeds any max); **min+max ranges above native PNG size** (e.g. 512–512px) left catalogs on too-small PNG with no SVG fallback. Catalog cards now **re-sync format and reload when the slider changes**, **switch to SVG when a minimum is set** (including combined min+max when no native raster fits), **switch to PNG at the largest native raster size when only a maximum applies**, and no longer re-apply the PNG size control after preparing SVG on a fresh search. **HTML Scraper** and **native-sized provider cards** (Google, FaviconKit, etc.) now **auto-select the largest size that fits the active filter** instead of always defaulting to 128px — including scraper-discovered icons (e.g. GitHub's 512px app icon) and SVG-only sites rasterized via proxy sizes.

## [2.8.7] — 2026-07-06

### Added

- **favicon.ryanjc.com provider** — new domain favicon provider backed by [api.favicon.ryanjc.com](https://api.favicon.ryanjc.com). Upstream accepts a domain via `?url=`. Canonical route: `/ryanjc/{size}/{domain}`, short alias: `/rj/{size}/{domain}`. Resized server-side. Included in `/{domain}/json` discovery, the best-pick race (`GET /:domain`), `DEFAULT_PROVIDER` options, custom profile URLs, and the Web UI.

- **twenty-icons.com provider** — new domain favicon provider backed by [twenty-icons.com](https://twenty-icons.com). Upstream supports native sizes (16, 32, 64, 128, 180, 192) via `/{domain}/{size}` path. Canonical route: `/twentyicons/{size}/{domain}`, short alias: `/ti/{size}/{domain}`. Included in `/{domain}/json` discovery, the best-pick race (`GET /:domain`), `DEFAULT_PROVIDER` options, custom profile URLs, and the Web UI with size-button strip. Size buttons are hidden when the upstream does not return an icon at that native resolution; upscaled responses (correct dimensions but no extra detail vs. the next smaller size, e.g. reddit.com/128 ≈ soft 64px) are rejected server-side so only genuinely sharper sizes are offered.

### Fixed

- **Upstream fetch — Cloudflare multi-A fallback** — forced-IPv4 upstream requests used only the first DNS A record (`dns.lookup` with `all: false`). Some Cloudflare anycast nodes refuse connections on certain routes while a sibling address works, which broke providers such as favicon.ryanjc.com (`ECONNREFUSED`). `upstreamFetch` now retries with the system resolver when the pinned IPv4 attempt fails to connect (`ECONNREFUSED`, `ETIMEDOUT`, `ENETUNREACH`, `EHOSTUNREACH`).

## [2.8.6] — 2026-07-05

### Added

- **Selfhosted docs — Changelog** — root `CHANGELOG.md` rendered at `/docs/changelog` with a sidebar nav entry (`src/docsRender.js`); single source of truth with the repo changelog (Keep a Changelog). The **CHANGELOG** link on Getting Started navigates to that page.

### Changed

- **Selfhosted docs — Getting Started source links** — GitHub repo and version/changelog grouped under a **Source** section; version shown as `FaviconAPI v{version}` via `__VERSION__` placeholder substituted from `package.json`.
- **Docker image** — `CHANGELOG.md` included in the build (`.dockerignore` exception + `Dockerfile` COPY) so `/docs/changelog` works in containers.
- **GitHub repository renamed** — `R0GGER/maflplus-favicon-api` is now `R0GGER/favicon-api`; selfhosted docs and README links updated accordingly.
- **GHCR image** — published images are now `ghcr.io/r0gger/favicon-api:latest` (was `ghcr.io/r0gger/maflplus-favicon-api:latest`). The Docker Publish workflow still uses `${{ github.repository }}`, so no workflow edit is required after a rename.
- **Docker Compose service** — compose service and `container_name` renamed from `maflplus-favicon-api` to `favicon-api`; update `docker compose exec` commands and any external references that used the old service name.

## [2.8.5] — 2026-07-05

### Added

- **Web UI — About on small screens** — on viewports below 1210px (smartphones and tablets), the top nav shows **About** instead of **Docs**. Tapping it opens a modal with the *Why FaviconAPI?* intro from the getting-started guide. On `/docs/*` at the same breakpoint, the full documentation layout is hidden and only that About text is shown, with a note that full docs are best read on a desktop.

### Changed

- **Web UI — Docs nav desktop-only** — the **Docs** link is visible from 1210px upward only; **About** is hidden on desktop.

## [2.8.4] — 2026-07-05

### Changed

- **Web UI — placeholder results grid only on first visit** — the skeleton preview appears once per browser session on the first homepage load; after a search or reset it stays hidden, including on refresh (`sessionStorage`). Reset clears the grid instead of restoring the skeleton.

### Fixed

- **Web UI — app icon skeletons in placeholder mode** — when **Also include app icon lookups** is enabled (via server config), the App Icons divider and service-icon skeleton cards now appear correctly after `GET /providers` loads; fixed a race where the placeholder rendered before the checkbox state was applied.

## [2.8.3] — 2026-07-05

### Fixed

- **logo.dev monogram placeholders rejected** — upstream requests now use Logo.dev's `fallback=404` parameter so unknown domains return 404 instead of a generated letter monogram. The `/logodev/{size}/{domain}` route and Web UI card return **502** / hide the card when no real logo exists; cache keys were bumped so stale monogram entries are not reused.

## [2.8.2] — 2026-07-05

### Added

- **Web UI — "No icon found" notice** — when every provider (and app-icon catalog, if enabled) fails to load an icon, a banner appears above the results grid stating that no favicon was found, with a preview of the black placeholder and the direct `/{domain}` URL.

### Fixed

- **Web UI — stale icons after a new search** — provider cards are reset at the start of each domain lookup, and a failed load no longer keeps the previous domain's image (e.g. GitHub icons after searching `hibbit.net`). The "size not available" fallback still applies only when switching sizes within the same domain.

## [2.8.1] — 2026-07-05

### Added

- **Not-found placeholder icon** — when all providers fail (`GET /{domain}`, custom profile URLs, service lookups), a solid black PNG placeholder is returned (HTTP 404) instead of a transparent 1×1 pixel. Sized to the profile minimum or 32px for best-pick. Asset: `src/assets/not-found.png`; helper: `src/notFoundPlaceholder.js`.

### Fixed

- **Favicon.so / Vemetric generic placeholders rejected** — Favicon.so's SVG code-bracket icon and Vemetric's "world-question" fallback are no longer treated as real favicons in best-pick, profile resolve, or dedicated provider routes; the chain continues to the next source or the not-found placeholder.
- **Not-found responses are not cached** — placeholder results (`notFound: true`) are never written to the disk/memory cache; stale `provider: none` entries are evicted on read. HTTP responses use `Cache-Control: no-store` so browsers and CDNs do not cache 404 placeholders (found icons still use `max-age=86400`).

## [2.8.0] — 2026-07-04

### Added

- **Selfhosted docs (`/docs`)** — markdown guides from `src/docs-content/` rendered at runtime via `marked` (`src/docsRender.js`, `src/public/docs.html`). Pages: Getting Started, Tweaks, API reference, API v1, Proxy, and Tools. Three-column layout with sidebar nav, per-page table of contents, code copy buttons, and responsive tables. `/docs` redirects (301) to `/docs/getting-started`. Toggle with `UI_ENABLE_DOCS` (default on); when off, routes return 404 and the **Docs** nav link is hidden on `/` and `/api`. `GET /providers` exposes `docsEnabled`.
- **Configurable analytics** — optional Umami-compatible tracking snippet injected on `/`, `/api`, and `/docs` via `UI_ANALYTICS_SCRIPT_SRC`, `UI_ANALYTICS_WEBSITE_ID`, and optional `UI_ANALYTICS_DOMAINS`. Both script src and website ID must be set; empty by default so self-hosters are not tracked unless they opt in. Replaces the hardcoded faviconapi.com analytics script in the HTML templates.
- **API docs & selfhosted docs — Tools offcanvas** — `/api` and `/docs` include the same **Tools** panel as the homepage (browser search engine setup, custom URL builder, FaviconAPI Copy bookmarklet), including `/#tools` deep-link support.

### Changed

- **Homepage SEO** — `<title>`, meta description, keywords, Open Graph, Twitter Card, and JSON-LD aligned with visible body copy (full provider list, app-icon catalogs, custom URL builder). Title wording updated to “highest resolution favicon”.
- **Docs SEO** — per-page meta description (first markdown paragraph), keywords, Open Graph, Twitter Card, and `TechArticle` + `BreadcrumbList` JSON-LD. All doc slugs listed in `/sitemap.xml` (`<priority>0.7</priority>`). `/robots.txt` allows `/docs` when enabled. Homepage JSON-LD `sameAs` includes the docs URL.
- **README** — expanded into a full getting-started guide (why FaviconAPI, how it works, routes, Docker quick start, configuration tables, API v1, performance tuning) mirroring the selfhosted docs content.
- **Web UI navigation** — **Docs** link added to the homepage and API docs top nav (hidden when `UI_ENABLE_DOCS=false`).
- **Docker image** — `src/docs-content/` included in the build (`.dockerignore` exception for markdown under that path).
- **`.env.example`** — documents `UI_ENABLE_DOCS` and optional Umami analytics vars (`UI_ANALYTICS_SCRIPT_SRC`, `UI_ANALYTICS_WEBSITE_ID`, `UI_ANALYTICS_DOMAINS`).
- **Dependencies** — `marked` for server-side markdown rendering.

## [2.7.6] — 2026-07-04

### Fixed

- **Web UI — sized provider cards no longer vanish on failed size switch** — switching Google, FaviconKit, or Favicon.run to a size that fails (upstream 502/500) no longer hides the whole card; the previous icon stays visible with a “size not available” notice instead.
- **Web UI — Favicon.run size buttons match upstream** — each offered size is probed on load so buttons for sizes the provider cannot serve (e.g. 16, 32, and 256 for `hosthatch.com`) are hidden automatically.
- **Web UI — Google size buttons and routing** — size availability is probed per size using the correct Google v1/v2 proxy paths (`/google/` for ≤128, `/googlev2/` for 180/256), so working sizes like 180 stay visible when v2 succeeds even if 256 fails.
- **Web UI — small non-square favicons stay visible** — provider preview frames use a fixed 140px-tall box with icons scaled up to 128×128 via `object-fit: contain`, so tiny wide icons (e.g. Google 11×16 or 22×32 for `hosthatch.com`) no longer look blank or collapse the layout when switching between 32 and 16.

## [2.7.5] — 2026-07-04

### Added

- **Web UI — placeholder results grid** — on first load (and after reset), the homepage shows a skeleton preview of the provider cards so visitors see the layout before searching. Blurred icon shapes, muted size buttons, and skeleton metadata mimic real results; card interactions are disabled. **Download all** stays disabled until a search runs; **Build custom URL** remains available.
- **Web UI — CTA attention on Tools and Build custom URL** — subtle wiggle, glow pulse, and pointing-hand hint on the top **Tools** button and **Build custom URL** toolbar button. Animations stop on hover or after the user opens either panel (remembered for the session via `sessionStorage`); respects `prefers-reduced-motion`.

### Changed

- **Web UI — placeholder app icons follow checkbox** — **Also include app icon lookups** now toggles the App Icons divider and service-icon cards in placeholder mode, matching behaviour after a domain search.
- **Web UI — optional providers in placeholder** — Brandfetch.io and logo.dev skeleton cards appear only when `BRANDFETCH_CLIENT_ID` or `LOGODEV_TOKEN` is configured (via `GET /providers`), same as live results.
- **Web UI — HTML Scraper title link** — the HTML Scraper card title links to the [maflplus-favicon-api](https://github.com/R0GGER/maflplus-favicon-api) repository.

## [2.7.4] — 2026-07-02

### Changed

- **SVGL — SVG as default** — SVGL upstream assets are native SVG; the Web UI now defaults to SVG (`/svgl/0/svg/{service}`) instead of rasterizing to PNG. A **PNG | SVG** toggle is added to the SVGL card (size buttons hide when SVG is selected), matching selfh.st, dashboardicons.com, and LobeHub. JSON discovery (`/{service}/json`) lists SVG as the primary `proxy` for SVGL, with a top-level `png` entry for raster URLs.

## [2.7.3] — 2026-06-30

### Changed

- **Styled tooltips site-wide** — all native browser tooltips are replaced by a Bootstrap-style CSS tooltip (`data-tip`), giving a consistent dark, rounded look with a pointer arrow and fade-in. Long URLs wrap inside the tooltip, and an optional top placement (`data-tip-pos="top"`) keeps the bookmarklet tip from being clipped in the scrollable Tools panel. Accessible names are preserved via `aria-label`.

### Removed

- **Download-icon tooltip** — the per-card **Download icon** button no longer shows a tooltip (the `aria-label` is kept for screen readers).

## [2.7.2] — 2026-06-30

### Changed

- **Custom URL builder — generated URL layout** — the generated URL box now stacks vertically: the URL spans the full width and wraps cleanly (smaller font), with the **Copy URL** button beneath it, right-aligned. Prevents the long URL and button from crowding onto one line. Scoped to the custom-URL box; the search-engine modal is unchanged.

## [2.7.1] — 2026-06-30

### Changed

- **Custom URL builder — clearer fallback order** — the four fallback selectors now show numbered badges (1-4) so the apply order is unambiguous (preferred → 1 → 2 → 3 → 4; empty slots are skipped).

### Fixed

- **Custom URL builder — crisp preview** — the icon preview no longer forces every image to 48×48 (which upscaled and blurred small icons). It now renders at the icon's natural size inside a fixed thumbnail box, so small sizes (e.g. 16px) stay sharp.

## [2.7.0] — 2026-06-30

### Added

- **Custom profile URLs** — users can build a shareable URL `/{id}/{domain-or-appname}` where `{id}` is a base64url string that *encodes* a preferred provider, up to four ordered fallbacks, and a minimum icon size (no database). On request the chain is tried in order: an **SVG** source satisfies any minimum and is served as-is; a **raster** source must be ≥ the minimum size and is then served as PNG at exactly that size; otherwise the next fallback is tried (transparent `404` when the chain fails). Minimum sizes: `16, 32, 64, 128`. Generate one via **Tools → Build custom URL** on the homepage (live URL, preview, and copy). New modules `src/customProfile.js` (encode/decode + validation) and `src/profileResolve.js` (chain resolver).

## [2.6.3] — 2026-06-29

### Fixed

- **Web UI — light/dark preview contrast** — light icon variants now preview on a dark background and dark variants on a light background (Brandfetch, selfh.st, dashboardicons.com, LobeHub, SVGL).

## [2.6.2] — 2026-06-29

### Fixed

- **Catalog SVG proxy URLs — size 0 in path** — SVG routes for selfh.st, dashboardicons.com, LobeHub, and SVGL now use `/0/svg/` in generated proxy URLs (e.g. `/selfhst/0/svg/github` instead of `/selfhst/256/svg/github`). Route handlers accept `0` as the canonical SVG path size; legacy URLs with a pixel size remain valid. JSON discovery and the Web UI emit the `0` segment.

## [2.6.1] — 2026-06-29

### Added

- **Web UI — icon downloads** — each favicon card has a download button in the header row (aligned with source/refresh). **Download all** above the results grid fetches every loaded icon and delivers a ZIP (`{query}-favicons.zip`); when only one icon is available, a single file is downloaded instead. JSZip is loaded on demand for multi-file archives. Filenames use `{domain-or-app}-{provider}.{ext}`.

### Changed

- **Web UI — provider card titles link to upstream sites** — each provider/app-icon card title (Google, DuckDuckGo, Yandex, Favicon.so, Vemetric, Faviconextractor, Faviconkit, Favicon.run, Brandfetch, logo.dev, selfh.st, dashboardicons.com, LobeHub, SVGL) opens the provider's website in a new tab.

## [2.6.0] — 2026-06-29

### Changed

- **Proxy URL scheme — format in path** — domain providers now use `/{provider}/{size}/{ext}/{domain}` (e.g. `/google/128/png/github.com`, `/duckduckgo/32/png/github.com`). Catalog providers (selfh.st, dashboardicons, LobeHub, SVGL) use `/{provider}/{size}/{format}/{service}` with `png` or `svg` instead of `?format=`. SVG routes use size **0** in the path (e.g. `/selfhst/0/svg/github`, `/brandfetch/0/svg/github.com`); PNG routes keep pixel sizes (e.g. `/svgl/256/png/github`, `/brandfetch/128/png/github.com`). Vemetric accepts `png`, `jpg`, or `webp` in the path (`?format=` still works). Brandfetch accepts `svg`, `png`, `webp`, or `jpg` in the path; `?type=` and `?theme=` stay as query params. Legacy three-segment routes (`/{provider}/{size}/{domain}`) remain aliases; logo.dev is unchanged.
- **`/{domain}/json` discovery** — `proxy` and per-size entries now include the `/png/` path segment for all providers that use the new scheme.
- **Web UI — PNG | SVG on catalog cards** — selfh.st, dashboardicons.com, and LobeHub cards gain a **PNG | SVG** toggle; size buttons hide when SVG is selected.
- **LobeHub light/dark variants** — availability is probed against `@lobehub/icons-static-png` theme assets (`/light/{slug}.png`, `/dark/{slug}.png`) instead of the color SVG URL, so Light/Dark buttons only appear when those PNGs exist. Light/dark requests serve the upstream theme PNGs; SVG format remains color-only.
- **Web UI — service icon controls** — extension (PNG/SVG or SVG badge) and color (Color/Light/Dark) toggles on selfh.st, dashboardicons.com, LobeHub, SVGL, and Brandfetch cards are compact Bootstrap-style button groups on one row. Size buttons (256, 128, 64, …) remain separate rounded buttons with spacing.

### Fixed

- **ICO upstreams served on `/png/` routes** (e.g. DuckDuckGo's `…/github.com.ico` on `/duckduckgo/32/png/github.com`) — upstream `image/x-icon` bytes are now decoded to PNG via `normalizeEntryForPng()` before resize and on legacy sizeless routes (`/d/{domain}`, `/y/{domain}`, etc.). BMP ICO frames are converted BGRA→RGBA before rasterization. Failed ICO conversion no longer falls back to serving raw ICO with a PNG content-type.

## [2.5.15] — 2026-06-28

### Changed

- **Web UI — no source/proxy toggle on tokenized providers** — removed the alternate URL link from the Brandfetch.io and logo.dev cards (upstream URLs embed API tokens).

## [2.5.14] — 2026-06-28

### Fixed

- **Brandfetch — detect actual response format** — when Brandfetch serves WebP/PNG at a `.svg` URL (e.g. `ah.nl`), the proxy now rejects the mismatched attempt and falls through to the correct raster format. `X-Brandfetch-Format` and the Web UI reflect the real type, so size buttons appear for WebP/PNG.

## [2.5.13] — 2026-06-28

### Changed

- **Brandfetch Web UI — hide dimensions for SVG** — metadata no longer shows `WxH` when the resolved format is SVG (only for PNG/WebP/JPG raster fallbacks).

## [2.5.12] — 2026-06-28

### Changed

- **Brandfetch — SVG vs raster UI** — SVG responses show a single **SVG** badge (no size buttons); the proxy URL uses a fixed path size and omits meaningless `h/w` upstream. PNG/WebP/JPG fallbacks show size buttons (16–512) with real pixel dimensions in metadata. Upstream SVG URLs no longer include `h/w` segments.

## [2.5.11] — 2026-06-28

### Fixed

- **Brandfetch Web UI — fixed preview frame and theme buttons** — preview area stays 140×128px regardless of selected API size (size buttons only change the proxy URL/metadata). Color/Light/Dark row is hidden unless Light or Dark variants exist (probed with `?strict=1`); explicit theme requests no longer fall back to the color variant, so theme switches actually change the logo.

## [2.5.10] — 2026-06-28

### Changed

- **Brandfetch — format fallback** — when `format` is omitted or `svg`, the proxy tries **svg → png → webp** for each type/theme variant before returning 502. An explicit `?format=png` (or `webp`, `jpg`) skips format fallback. Response header `X-Brandfetch-Format` indicates which format was served.

## [2.5.9] — 2026-06-28

### Fixed

- **Brandfetch — coverage and size buttons** — upstream URLs always include `h/{size}/w/{size}` (including SVG). When `symbol` or a theme variant is missing, the proxy falls back through `icon` and `logo` (and color variants) before returning 502. Size buttons now scale the displayed icon via CSS and update the proxy URL without reloading the same SVG.

## [2.5.8] — 2026-06-28

### Changed

- **Brandfetch — transparent SVG symbols** — default upstream is now `symbol.svg` with a transparent background instead of a raster `icon`. Optional query params on `/brandfetch/{size}/{domain}`: `type=icon|symbol|logo`, `format=svg|png|webp|jpg`, `theme=light|dark`. Web UI defaults to **Dark** theme with Color/Light/Dark toggles; size buttons control display only for SVG.

## [2.5.7] — 2026-06-28

### Added

- **Web UI alternate URL link** — every favicon card except HTML Scraper now has a dashed-border link in the top-right corner that copies the *opposite* URL from `UI_CARD_URL`: when cards show proxy URLs the link is labelled **source** and copies the upstream URL; when cards show source URLs the link is labelled **proxy** and copies the local proxy URL. Hidden for logo.dev and Brandfetch (no safe upstream URL). The homepage waits for `GET /providers` before fetching so the label matches the server's `urlMode`.

## [2.5.6] — 2026-06-28

### Added

- **`UI_CARD_URL` environment variable** (default `proxy`) — controls which URL every favicon card shows and copies (metadata link, copy button, and click-on-icon). `proxy` = local proxy URL (`https://your-host/google/128/example.com`); `source` = upstream provider URL. Exposed to the Web UI via `urlMode` on `GET /providers`. logo.dev and Brandfetch always stay on proxy (upstream URLs embed API tokens). Documented in `.env.example`.

### Fixed

- **Web UI proxy URL size did not match displayed dimensions** — providers that never upscale (e.g. Yandex's fixed 16×16) still showed `/yandex/64/{domain}` while the card read `16×16`. The displayed and copied proxy URL now uses the smallest valid path size that matches the native image (e.g. `/yandex/16/{domain}`).

## [2.5.5] — 2026-06-28

### Fixed

- **SVGL Web UI showed proxy URL instead of source URL** — the **svgl.app** card metadata link and copy button pointed at the local proxy (`/svgl/{size}/{service}`) rather than the upstream SVGL asset on jsDelivr. The displayed URL is now resolved from `/{service}/json` (`endpoints.svgl.source` / per-variant `source`), consistent with selfh.st, dashboardicons.com, and LobeHub.

## [2.5.4] — 2026-06-28

### Changed

- **Brandfetch — `fallback/404` and no placeholder icons** — upstream URL now uses Brandfetch's documented `…/h/{size}/w/{size}/fallback/404/icon?c=…` form so unknown domains return 404 instead of the Brandfetch "B" mark or other generated fallbacks. Responses that are not `image/*`, fully transparent, or the known 128px placeholder hash are rejected; the proxy returns **502** and the Web UI hides the card. Upstream requests send a domain `Referer` header. Valid sizes: **16, 32, 64, 128, 256, 512**.

### Fixed

- **Brandfetch Web UI shown on service lookups** — searching by app name (e.g. `google`) no longer leaves the Brandfetch card visible alongside selfh.st / dashboardicons / LobeHub; the card is domain-only, reset on service searches, and placed with the other favicon providers above the "App Icons" divider.

## [2.5.3] — 2026-06-28

### Changed

- **Brandfetch — native upstream sizing** — `/brandfetch/{size}/{domain}` now requests the icon at the requested size directly from Brandfetch (`https://cdn.brandfetch.io/{domain}/h/{size}/w/{size}/icon.png?c=…`) instead of fetching a default icon and resizing server-side. Valid sizes: **32, 64, 128, 256, 512**. The Web UI card gains a size-button strip; `/{domain}/json` advertises the updated size set. Legacy `/bf/{domain}` defaults to 128px.

## [2.5.2] — 2026-06-28

### Changed

- **Web UI — four provider cards per row** — the results grid now uses four columns (container widened to 1280px) so more favicon cards fit on one screen without changing individual card width. The header block (logo, title, tip, search bar, API endpoint link, and footer) stays centered at three columns wide (75% / max 960px). Responsive breakpoints: two columns below 1050px, one column below 700px.

## [2.5.1] — 2026-06-28

### Fixed

- **SVGL Web UI size buttons always linked to 128px** — selecting 64 or 256 on the **svgl.app** card still showed and copied `/svgl/128/{service}` in the metadata link because `svglSourceUrl` hardcoded size 128. The displayed URL and copy button now follow the active size button (`/svgl/64/...`, `/svgl/256/...`, etc.).

## [2.5.0] — 2026-06-28

### Added

- **Brandfetch provider** — new domain favicon provider backed by the [Brandfetch Logo API](https://docs.brandfetch.com/logo-api/overview). Disabled until `BRANDFETCH_CLIENT_ID` (a free client ID from the [Brandfetch developer portal](https://developers.brandfetch.com/register)) is set; without it the route returns 503. Source URL: `https://cdn.brandfetch.io/{domain}?c={client-id}`, resized server-side to 16, 32, 64, 128, 256. Canonical route: `/brandfetch/{size}/{domain}`, short alias: `/bf/{size}/{domain}` (plus the sizeless legacy `/bf/{domain}`). Advertised through `/providers` (`brandfetch: true|false`), listed in `/{domain}/json` discovery, added to `DEFAULT_PROVIDER` options, and shown in the Web UI (the card and its proxy URL only appear when configured, so the client ID never leaks). Like logo.dev, Brandfetch is intentionally excluded from the best-pick race (`GET /:domain`) because its lettermark fallbacks would always return a generated placeholder and beat the slower scraper that finds the site's real favicon.
- **SVGL provider** — new service-icon catalog backed by the [SVGL](https://github.com/pheralb/svgl) SVG logo library ([svgl.app](https://svgl.app)). The catalog (~660 entries) is loaded from jsDelivr (`pheralb/svgl` `src/data/svgs.ts`, 24 h TTL) and SVG assets are fetched from `cdn.jsdelivr.net/gh/pheralb/svgl/static/...` (the public `api.svgl.app` endpoints were not used as the primary source). Canonical route: `/svgl/{size}/{service}[?variant=color|light|dark]`, short alias: `/sv/{size}/{service}` (plus the legacy `/sv/{service}[?size=][&variant=]`). Native sizes 64, 128, 256; SVG sources are rasterized server-side to a crisp size×size PNG. Included in `/services/resolve/:service` (`providers.svgl`), `/{service}/json` and `/{domain}/json` (`endpoints.svgl`), the best-pick race for service names and domain-derived slugs, the v1 API scraper source priority (tier after `lobehub`), `DEFAULT_PROVIDER=svgl`, and the Web UI (new **svgl.app** card alongside selfh.st, dashboardicons.com, and LobeHub, with color/light/dark variant buttons, size buttons, and an "Alternative matches" panel). Theme-aware SVGL entries (separate light/dark SVG routes) expose light/dark variants when available.

### Fixed

- **SVGL "Alternative matches" listed unrelated icons for `github`** (e.g. dotenv, Esbuild, Home Assistant, Jasmine) — many SVGL catalog entries link to `github.com/...` repos or `*.github.io` pages; the matcher treated the extracted hostname key `github` as a strong match (score 95) for any query `github`, so unrelated projects hosted on GitHub appeared as alternatives. Hostname-based scoring was removed; alternatives now match on slug/title (exact, prefix/suffix such as `github-copilot`, and existing fuzzy slug rules) only.

## [2.4.0] — 2026-06-26

### Added

- **Google v2 — 180px size** — the `faviconV2` upstream also serves a 180px raster (the common `apple-touch-icon` size) that was previously usable upstream but not exposed. `/googlev2/{size}/{domain}` (alias `/g2/`) now accepts `180` alongside `16, 32, 64, 128, 256`, the `/{domain}/json` listing advertises `/googlev2/180/{domain}`, and the Web UI's **Google** card gains a `180` size button (routed through faviconV2, like 256). The Vemetric handler — which previously shared Google v2's valid-size set but does not serve 180 — now uses its own `VALID_VEMETRIC_SIZES` set (`16, 32, 64, 128, 256`).

## [2.3.3] — 2026-06-26

### Fixed

- **Catalog logo served instead of a site's own high-res icon** (e.g. the sizeless `/scraper/github.com` returned the selfh.st **github** catalog logo even though github.com exposes its own 512×512 `app-icon`, so the Web UI's default proxy button — `/scraper/{domain}` when `SCRAPER_MAX_ICON_SIZE` is set — showed the catalog icon rather than GitHub's own favicon downscaled) — `fetchScraper` ran `fetchScraperCatalogFallback` **before** the direct HTML scrape whenever the domain mapped to a known service slug, overriding a perfectly good on-site icon. The direct scrape now runs **first**, and the curated catalogs (selfh.st, dashboardicons) are only preferred when the site's own best icon is below `MIN_SOURCE_SIZE` (128px) — preserving the catalog upgrade for low-quality cases like `facebook.com` (60×60 favicon) while keeping the real icon for sites that publish a large one. `probeScraperCandidates` now exposes the chosen source's `sourceWidth` so `fetchScraper` can make this decision; SVG sources (effective ≥512px) always count as large enough. The sized routes (`/scraper/{size}/{domain}`) were already unaffected because they resolve through `serveSizedScraperIcon` against the discovered `icons` list. After deploying, refresh cached entries (`?refresh=1`) so previously cached catalog icons are replaced; `X-Favicon-Source` returns to `scraper` instead of `scraper-fallback:selfhst`.

## [2.3.2] — 2026-06-26

### Fixed

- **Wrong fallback icon for unknown brand domains** (e.g. `maflplus.eu` served the unrelated **`mailplus`** envelope icon instead of the site's own logo) — slugs derived automatically from a domain label were resolved against the selfh.st / dashboard-icons / LobeHub catalogs using Levenshtein **fuzzy** matching, so a brand name one character away from a catalog entry (`maflplus` vs `mailplus`, similarity 0.875 > 0.8 threshold) hijacked the result before the site's real favicon was ever scraped. Domain-derived catalog lookups are now **strict** (exact slug or curated/static alias only) across the scraper catalog fallback (`fetchScraperCatalogFallback`), the best-pick race (`buildFallbackFetchers`), the HTML-scraper service buckets (`resolveServiceSlugForProviderSync`), and the `/{domain}/json` provider list (`resolveServiceMatches(slug, { strict })`). Fuzzy matching is unchanged for service names a user actually types (`/{service}`, `/sh/`, `/di/`, `/lb/`). New `strict` option added to `getSelfhstSlugCandidates` / `getDashboardIconsSlugCandidates` / `getLobehubSlugCandidates` and threaded through `fetchSelfhst` / `fetchDashboardIcons` / `fetchLobehub`.
- **selfh.st exact slug match ranked below fuzzy partials** (e.g. searching `plex` / `plex.tv` showed **Guardian (Plex)** as the primary selfh.st icon instead of plain **Plex**) — `searchSelfhstMatches` gave an exact catalog-slug match a fixed score of `100`, but selfh.st scoring is *additive*, so partial matches accumulated higher totals (`guardian-plex` and `spotify-to-plex` scored `133` via the `-plex` suffix + name-contains bonuses) and were sorted above the exact match. Exact slug matches now receive a dominant score so they always rank first; fuzzy candidates remain as ordered "alternative matches". (Dashboard-icons / LobeHub were unaffected — their scoring uses `Math.max`, not addition.)
- **Sized scraper route upscaled tiny icons instead of using the fallback** (e.g. `facebook.com` only exposes a 60×60 `favicon.ico` to scrapers, so `/scraper/128/facebook.com` served a blurry 60→128 upscale while the auto proxy `/scraper/facebook.com` correctly returned the high-res selfh.st icon) — `serveSizedScraperIcon` now returns `null` when no discovered icon can natively satisfy the requested size, letting the handler fall through to `fetchScraper()` (catalog / Google fallback) and resize that instead. Sizes the scraped icon *can* satisfy (≤ its native resolution) still use the scraped source; only sizes that would require upscaling defer to the fallback. No effect on domains whose scraped icons are already large enough.

## [2.3.1] — 2026-06-26

### Added

- **favicon.run provider** — new domain favicon provider backed by [favicon.run](https://favicon.run). Upstream supports native sizes (16, 32, 64, 128, 256) via `?sz=` parameter. Canonical route: `/faviconrun/{size}/{domain}`, short alias: `/fr/{size}/{domain}`. Included in `/{domain}/json` discovery, the best-pick race (`GET /:domain`), `DEFAULT_PROVIDER` options, and the Web UI with size-button strip.

### Fixed

- **Empty Favicon.so & Faviconextractor.com cards** — these providers often return SVG favicons that use CSS custom properties (`var(--primary-fill)`, `var(--secondary-fill)`) with `prefers-color-scheme` rules. Sharp cannot resolve those variables, so rasterization produced a fully transparent PNG and the Web UI showed a blank frame while metadata still listed a size/URL. SVGs are now preprocessed with light-mode colour defaults before rasterization, and the resize proxy handlers use `renderIconToSize` (proper SVG/ICO handling) instead of raw `downscaleEntryToSize`.
- **Yandex empty/transparent placeholder icons** — Yandex can return a 16×16 fully transparent PNG (not just the known 1×1 case). `fetchYandex` and `fetchWithCache` now reject any raster icon with no visible pixels (`isBlankFavicon`), evict stale blank cache entries, and return 502 so the Web UI hides the card.
- **ICO sources on resize provider routes** — when an upstream provider returns ICO bytes (e.g. Favicon.so content negotiation), resize handlers now convert to PNG via `toDisplayPng` before downscaling so Sharp never receives an undecodable buffer.

### Changed

- **Upstream favicon fetch headers** — provider fetches now use the same browser-like `User-Agent` and raster-preferring `Accept` header as the HTML scraper instead of `FaviconProxy/1.0`, reducing cases where CDNs return SVG-only responses to bot-like clients.
- **favicondev upstream — Favicon Extractor** — the `/favicondev/` provider (alias `/p/`) now proxies `https://www.faviconextractor.com/favicon/{domain}` instead of `https://favicon-3j1.pages.dev/favicon/{domain}`. README, `.env.example`, and the Web UI direct-link were updated accordingly.

## [2.3.0] — 2026-06-26

### Changed

- **Uniform proxy-URL scheme `/{provider}/{size}/{domain}`** — every provider route now follows the same consistent shape with a leading full provider name and a size path segment: `/google/{size}/{domain}`, `/googlev2/{size}/{domain}`, `/duckduckgo/{size}/{domain}`, `/yandex/{size}/{domain}`, `/faviconso/{size}/{domain}`, `/vemetric/{size}/{domain}`, `/favicondev/{size}/{domain}`, `/faviconkit/{size}/{domain}`, `/logodev/{size}/{domain}`, `/scraper/{size}/{domain}`, and the catalog routes `/selfhst/{size}/{service}`, `/dashboardicons/{size}/{service}`, `/lobehub/{size}/{service}`. Previously size was sometimes a path segment (`/g/{size}/`), sometimes a query (`?size=`), and sometimes absent.
- **`/{domain}/json` — uniform endpoint shape** — every provider entry now exposes a consistent `{ proxy, source, sizes }` structure with `proxy` pointing at the default size and `sizes` listing all offered sizes using the new scheme. Provider-specific extras (`vemetric.formats`, `scraper.icons[]/sizes/maxIconSize/fallback/wwwFallback`, catalog `service/query/variants`, `logodev.configured`) are preserved.
- **Web UI proxy/embed URLs** — the homepage now builds and displays the new canonical URLs (e.g. `/scraper/{domain}`, `/google/{size}/{domain}`, `/selfhst/{size}/{service}`).

### Added

- **Server-side resizing for sizeless providers** — `duckduckgo`, `yandex`, `faviconso`, `favicondev`, `logodev` (and the `selfhst`/`dashboardicons` catalogs) now accept the size path segment and **downscale** the upstream icon server-side (never upscale), so the uniform `/{provider}/{size}/{...}` scheme is meaningful for every provider.
- **Backward-compatible aliases** — the original short routes (`/g/`, `/g2/`, `/d/`, `/y/`, `/f/`, `/v/`, `/p/`, `/k/`, `/l/`, `/s/`, `/sh/`, `/di/`, `/lb/`) keep working unchanged, including their legacy sizeless forms.
- **Web UI — native size detection for Google & FaviconKit cards** — these providers don't actually have an icon at every offered size; they just return the largest one they have (e.g. github.com tops out at 32×32). The card now probes the proxy at its largest size to read the real native resolution and **hides size buttons that exceed it**, so only sizes that genuinely exist are shown (github → 32/16, apple → 64/32/16, microsoft → 128/64/32/16, notion → all). If the active size becomes unavailable, the card automatically switches to the largest available size.

### Fixed

- **Scraper no longer prefers catalog icons over its own** — `fetchScraper` now runs the direct HTML scrape first and returns the largest discovered icon (downscaled to `SCRAPER_MAX_ICON_SIZE` when set). The curated catalogs (selfhst, dashboardicons) and Google faviconV2 are used only as a true fallback when scraping finds nothing. Previously, when a domain mapped to a known service slug, the catalog icon was returned before the site was scraped at all.
- **Blurry resized icons for small-source providers** (e.g. Yandex's fixed 16×16) — the resize providers no longer upscale: when the upstream icon is smaller than the requested size, the native bytes are served unchanged instead of a blurry enlarged version.
- **Blurry Vemetric icons** — Vemetric always returns a small intrinsic SVG (~24-32px), which previously rendered tiny/soft in the UI. The SVG is now rasterized server-side to the requested size (crisp size×size PNG) so it fills the card like the other providers. Explicit `?format=png|jpg|webp` requests are still served unchanged.
- **`SCRAPER_MAX_ICON_SIZE` now enforced at serve time** — `GET /scraper/{domain}` previously only capped the icon when it was first fetched and cached. A cache entry written before the cap was configured (e.g. a full 512×512 source like github.com's `app-icon-512`) kept being served at full resolution until its TTL expired, which the browser then squeezed into the display card and rendered soft. The proxy now re-applies the cap on every response (`capScraperProxyOutput`), so oversized cached icons are downscaled to `SCRAPER_MAX_ICON_SIZE` before sending — no cache refresh required. The cap is a no-op when the icon is already within the limit or when `SCRAPER_MAX_ICON_SIZE=0`.

## [2.2.0] — 2026-06-26

### Added

- **SVG rasterization for scraped icons** — when the HTML scraper finds an SVG favicon (e.g. hosthatch.com), it is now rasterized to PNG instead of being served as raw SVG. Previously raw SVGs were passed through to the browser, causing them to render at an arbitrary (screen-filling) size with no fixed dimensions.
- **`/s/{domain}?size=N` — scraper size parameter** — the scraper proxy endpoint now accepts a `?size=` query parameter with standard icon sizes (16, 32, 64, 128, 256, 512). Each size is rendered directly from the original SVG source (when available) for maximum sharpness, or downscaled from the cached raster base for non-SVG icons.
- **`/{domain}/json` — scraper sizes in JSON** — the JSON endpoint now advertises `endpoints.scraper.sizes` with proxy URLs for all six standard sizes (e.g. `/s/example.com?size=128`).
- **Scraper icon proxy URLs per discovered size** — `/{domain}/json` now includes a `proxy` field on every icon in `endpoints.scraper.icons[]` and `endpoints.scraper.wwwFallback.icons[]`, using the format `/s/{domain}?size={width}` (e.g. `/s/github.com?size=512`). This gives every discovered icon resolution a clean, embeddable proxy URL.
- **`/{domain}/json` — scraper fallback metadata** — `endpoints.scraper.fallback` mirrors the `SCRAPER_FALLBACK` setting; `endpoints.scraper.fallbackProvider` reports which alternative source served the cached `/s/{domain}` icon (`selfhst`, `dashboardicons`, `googlev2`, or `null` when the icon came from direct HTML scraping).
- **Web UI — scraper proxy size buttons from JSON** — the HTML Scraper card now dynamically renders proxy size buttons for all sizes advertised in the JSON `sizes` object (e.g. 16, 32, 64, 128), alongside the scraped icon sizes. Sizes larger than `maxIconSize` are omitted to prevent blurry upscaled versions. The static fallback row (512–16) is still shown when no scraped icons are found.

### Changed

- **SVG ranking boost in scraper** — SVGs are now treated as having an effective resolution of at least 512px for candidate ranking, so they are preferred over small raster icons. Previously a 105×150 SVG viewBox would lose to a 128×128 PNG.
- **SVG render density increased** — `rasterizeSvgToSize` now uses `density = size × 4` (previously `size × 1.5`), producing a much larger internal canvas for crisp downscaling of vector content.
- **SVG per-size direct rasterization** — when the scraped icon was originally an SVG, each `?size=N` request rasterizes directly from the preserved original SVG buffer instead of resizing from an intermediate PNG. This eliminates double-rasterization quality loss.
- **`/s/{domain}?size=N` — flexible size parameter** — the `?size` query parameter now accepts any integer between 1 and 1024 (previously restricted to the fixed set 16, 32, 64, 128, 256, 512). This allows the proxy to serve icons at the exact resolutions discovered by the scraper (e.g. 152, 180, 192, 384).
- **`/s/{domain}?size=N` — full-resolution source selection** — sized requests no longer resize from the SCRAPER_MAX_ICON_SIZE-capped cached icon. Instead, `serveSizedScraperIcon` queries `fetchScraperAllIcons` (cached) to find the smallest source icon that is ≥ the requested size, fetches it at full resolution via the asset cache, and resizes from that crisp source. This eliminates blurry upscaling when the cached default icon was capped (e.g. requesting `?size=512` no longer upscales a 128px cached image).
- **Web UI — scraper size buttons show proxy URLs** — clicking a discovered icon size button now loads and displays the proxy URL (`/s/{domain}?size=N`) instead of the raw upstream source URL. The copy-to-clipboard action copies the proxy URL. Tooltips on size buttons also show the proxy URL.
- **Web UI — no more flashing proxy-size row** — the static 512/256/128/64/32/16 proxy-size button row (`scraper-proxy-sizes`) is now hidden by default and only shown when no scraped icons are found (fallback). Previously it flashed briefly before being replaced by the discovered icon sizes.

### Fixed

- **`GET /s/{domain}` low-quality icons for well-known services** (e.g. `facebook.com` with `SCRAPER_MAX_ICON_SIZE=128`) — when `SCRAPER_FALLBACK=true` and the domain maps to a service slug, curated catalog icons (selfh.st SVG/PNG, dashboardicons) are now preferred **before** HTML scraping, then rasterized and capped to the configured max size. Previously the scraper could return a small website apple-touch-icon even when a sharper catalog icon existed. `X-Favicon-Source` reports the actual provider (e.g. `scraper-fallback:selfhst`).

### Internal

- **`serveSizedScraperIcon`** (`src/index.js`) — handles `GET /s/{domain}?size=N` by picking the smallest discovered source icon ≥ the requested size from `fetchScraperAllIcons`, fetching it at full resolution via `/s-asset` cache, and downscaling with `resizeIcon`.
- **Scraper fallback helpers** (`src/providers.js`) — `fetchScraperCatalogFallback`, `fetchScraperGoogleFallback`, `normalizeFallbackResult`, `getScraperFallback`; catalog lookup runs before HTML scraping when `SCRAPER_FALLBACK=true`, Google faviconV2 runs only after scraping fails entirely.

## [2.1.0] — 2026-06-25

### Added

- **HTML scraper provider fallback** (`SCRAPER_FALLBACK`, default `true`) — the scraper now prefers curated service-icon catalogs over direct HTML scraping for domains that map to a known service slug. Fallback chain:
  1. **Service-icon catalogs** (selfh.st/icons, dashboardicons.com) — tried **before** HTML scraping when the domain maps to a slug via `serviceSlugFromDomain` (e.g. `facebook.com` → `facebook`). Catalog icons are typically higher resolution and visually consistent.
  2. **Google faviconV2** — universal last-resort tried **after** HTML scraping fails completely; rejects 1×1 placeholder images.
  When the domain has no slug or no catalog match, normal HTML scraping runs as before. Fallback results are processed through `toDisplayPng` and `capScraperProxyOutput` for consistent PNG output, cached under the same scraper cache key, and tagged with a descriptive `X-Favicon-Source` header (e.g. `scraper-fallback:selfhst`, `scraper-fallback:dashboardicons`, `scraper-fallback:googlev2`). Set `SCRAPER_FALLBACK=false` to disable and use only HTML scraping. Documented in `.env.example`.
- **HTML scraper www-fallback** — when scraping a bare domain (e.g. `nu.nl`) finds no usable icons, automatically retries on `www.{domain}` before giving up. Implemented in `fetchScraper` (`src/providers.js`) and `fetchBySourcePriority` (`src/apiScraper.js`); applies transparently to `GET /s/{domain}` and `GET /api/v1/favicon`. `/{domain}/json` exposes `endpoints.scraper.wwwFallback` (`{ domain, icons, proxy }`) when the bare domain has an empty icon list but the www variant has icons.
- **Web UI — HTML Scraper www-fallback notice** (`index.html`) — when icons are loaded from the www variant, shows a compact amber banner (`No icons on {domain}: {www.domain}`) with a clickable link to search the www hostname directly.
- **`UI_INCLUDE_APP_ICONS` environment variable** (default `true`) — controls whether the homepage checkbox “Also include app icon lookups” is checked on load. Set to `false` (or `0` / `no` / `off`) to leave it unchecked. Documented in `.env.example`; exposed to the UI via `includeAppIcons` on `GET /providers`.

- **Optional scraper discovery disk cache** (`SCRAPER_DISK_CACHE`, `SCRAPER_DISK_CACHE_DIR` in `.env.example`)
  - When `SCRAPER_DISK_CACHE=true`, homepage HTML, enriched icon lists (`/{domain}/json`), besticon JSON, parsed web manifests and icon-probe metadata are persisted as JSON under `{CACHE_DIR}/scraper-discovery/` (default `/cache/scraper-discovery` in Docker). Entries survive container restarts and are shared across cluster workers.
  - TTL follows `SCRAPER_ICONS_CACHE_TTL` (default 1 hour). New module `src/scraperDiskCache.js`; wired from `src/providers.js` on read/write alongside the existing in-memory LRU caches.
  - Documented in `README.md` environment table.

- **In-memory scraper discovery caches** (`src/providers.js`)
  - `fetchScraperPage` now caches homepage HTML (with in-flight deduplication so parallel `/{domain}/json` + `/s/{domain}` requests share one upstream fetch), `fetchBesticonAllIcons` caches besticon JSON, `fetchManifestIcons` caches per-manifest URL results, and `probeIconMetadata` caches per-icon probe metadata. Reuses `SCRAPER_ICONS_CACHE_TTL` / `SCRAPER_ICONS_CACHE_MAX`.

### Changed

- **Web UI — HTML Scraper default selection when `SCRAPER_MAX_ICON_SIZE` is set** (`index.html`) — the scraper size strip now defaults to the fast-proxy button (e.g. 128) instead of the largest discovered source icon. The `/s/{domain}` proxy image starts loading immediately with the results, so users no longer have to wait when selecting the capped size. When `SCRAPER_MAX_ICON_SIZE` is `0` (disabled), behaviour is unchanged: the largest variant is selected by default.

### Fixed

- **HTML scraper re-fetched discovery data on every request** — only the final favicon PNG (`scraper_{domain}` in `CACHE_DIR`) and the enriched icon list (`scraperIconsCache`) were cached before; HTML, manifests and probe results were fetched anew on each cache miss or after restart. Discovery layers are now cached in memory and optionally on disk.
- **`GET /s/{domain}?refresh=1` only cleared the favicon disk cache** — now also calls `invalidateScraperDomainCaches()` to drop in-memory scraper discovery state and domain-keyed disk discovery files (`page/`, `icons/`, `besticon/` under `scraper-discovery/`).

## [2.0.0] — 2026-06-25

### Added

- **`SCRAPER_MAX_ICON_SIZE` environment variable** — optional cap on the largest side (in pixels) returned by `GET /s/{domain}`. The scraper still selects the largest available source; when it exceeds the limit, the response is downscaled with `fit: contain` and re-encoded as PNG before caching. `0` (default) serves native resolution. Does not affect `/{domain}/json` icon lists or `/s-asset`. Documented in `.env.example`; `docker-compose.yml` may ship a non-zero example (e.g. `128`).
- **`MANIFEST_PROBE_MAX` environment variable** (default `12`) — limits how many candidate web-manifest URLs the HTML scraper fetches per domain when probing for icons outside a direct `<link rel="manifest">` (ordered list built from HTML hints, `Link` headers, well-known paths, icon-directory heuristics and `STATIC_MANIFEST_HINTS`). Stops at the first manifest that yields icons.
- **Deep manifest discovery** (`discoverManifestUrls`, `loadManifestIconCandidates`, `resolveManifestIcons` in `src/providers.js`)
  - Parses `rel="manifest"` from HTML (including combined `rel` tokens), HTTP `Link: </manifest.json>; rel="manifest"` headers, manifest URLs inferred from icon `<link>` directories, and well-known paths under each origin (`/manifest.webmanifest`, `/site.webmanifest`, `/favicon/manifest.json`, …).
  - **`STATIC_MANIFEST_HINTS`** — direct manifest URLs for domains whose homepage is an SPA shell or bot interstitial without a discoverable manifest link (initial entry: `ah.nl` / `www.ah.nl` → Albert Heijn `site.webmanifest`).
  - Exported as `loadManifestIconCandidates` and consumed by both the HTML scraper (`buildScraperCandidates`) and the v1 API (`src/apiScraper.js`), so manifest-tier discovery is shared instead of duplicated with cheerio in `apiScraper.js`.
- **`endpoints.scraper.maxIconSize` in `/{domain}/json`** — reports the configured `SCRAPER_MAX_ICON_SIZE` cap (or `0` when disabled) so the web UI can offer a fast-proxy embed button alongside full-resolution source variants.
- **Web UI — HTML Scraper fast-proxy button** (`index.html`) — when `maxIconSize > 0`, a dashed lavender size button (`.size-btn-proxy`) loads `/s/{domain}`; source sizes use `/s-asset`. Custom tooltip with Framework7 **hare** icon (`f7:hare-fill` via Iconify) explains the downscale-for-speed trade-off.
- **besticon sidecar settings in `.env.example`** — `BESTICON_TZ`, `BESTICON_CACHE_SIZE_MB`, `BESTICON_HOST_ONLY_DOMAINS`, `BESTICON_HTTP_CLIENT_TIMEOUT`, `BESTICON_HTTP_MAX_AGE_DURATION`, `BESTICON_HTTP_USER_AGENT`, `BESTICON_PORT`, `BESTICON_SERVER_MODE` (and `BESTICON_ADDRESS`) with a `BESTICON_` prefix so they do not collide with `PORT` / `CACHE_SIZE_MB` on `maflplus-favicon-api`. `docker-compose.yml` maps them via `${BESTICON_…:-default}`; compose reads `.env` for substitution without passing the whole file into the besticon container.
- **Documentation refresh**
  - **`README.md`** streamlined: provider tables with upstream links, service-icon catalogs (incl. LobeHub `/lb/`), minimal `docker-compose.yml` using `env_file: .env`, environment settings delegated to `.env.example`, API overview, scraper `?refresh=1`, API v1 auth/errors, and Docker CLI key-management examples.
  - **`docs/docker.md`** — host cache volume ownership/permissions (`chown 100:101`, `chmod 755`), and how `BESTICON_URL` relates to the optional besticon sidecar.

- **App-name lookup on the best-pick route** (`GET /{app-name}`)
  - Paths without a dot (e.g. `/jellyfin`, `/firefox`, `/immich`) are treated as **service names**, not domains. Races selfh.st, dashboardicons and lobehub in parallel via new `pickBestService()` in `src/bestPick.js` (same head-start / `DEFAULT_PROVIDER` behaviour as `/{domain}`).
  - **`GET /{app-name}/json`** — discovery JSON for service names (same catalog shape as domain JSON: `best`, `resolve`, `selfhst`, `dashboardicons`, `lobehub`). Example: `/jellyfin/json`.
  - Domain lookups are unchanged: `GET /github.com` still races website favicon providers.

- **Domain → icon-tag table** (`src/domainIconTags.js`)
  - Editable list of explicit `{ domain, iconTag }` rows (e.g. `drive.google.com` → `google-drive`) used when v1 API scraper fallbacks and best-pick service-icon providers need a catalog slug. Lookup runs **before** automatic rules in `serviceSlugFromDomain.js`; extend the array to override or pin mappings without code changes elsewhere.
  - `GET /domain-icon-tags` returns `{ entries: [{ domain, iconTag }, ...] }` for programmatic inspection. Not linked from the web UI.

- **Shared domain slug derivation** (`src/serviceSlugFromDomain.js`)
  - Centralises `serviceSlugFromDomain()` consumed by `src/apiScraper.js`, `src/bestPick.js`, `/{domain}/json` and `/services/resolve/:service`.
  - **Apex domains** (`github.com`) → first label (`github`).
  - **Suite subdomains** (`drive.google.com`, `teams.microsoft.com`, …) → `{parent}-{subdomain}` when the parent label is in a built-in allow-list (`google`, `microsoft`, `amazon`, `apple`, `office`, `live`, `azure`).
  - **Other subdomains** (`www.github.com`) → `null` (no service-icon lookup), avoiding ambiguous single-word slugs such as `drive` → dashboardicons `eu-drive`.

- **`?refresh=1` on `/api/v1/favicon`** — skips the 7-day disk cache and regenerates the PNG (also accepts `true` / `yes`). Useful after slug-mapping or source-priority changes.

- **Service slug alias resolution** (`src/serviceAliases.js`, `/services/resolve/:service`)
  - New `GET /services/resolve/:service` endpoint resolves a search term to canonical icon slugs per catalog. Response shape: `{ input, resolved, candidates, providers: { selfhst: { resolved, candidates[] }, dashboardicons: { resolved, candidates[] }, lobehub: { resolved, candidates[] } } }` where each candidate includes `slug`, `label` and a relevance `score`.
  - **Provider-specific catalogs** — selfh.st, dashboardicons.com and lobehub.com use different slug names for the same product (e.g. `kdrive` → selfh.st `ksuite-kdrive`, dashboardicons `infomaniak-kdrive`; `onedrive` → `microsoft-onedrive`; a vague term like `drive` may resolve to `google-drive` on selfh.st, `eu-drive` on dashboardicons and `drive` on lobehub). Resolution is no longer shared across providers.
  - **selfh.st index lookup** — loads and caches [selfhst/icons `index.json`](https://github.com/selfhst/icons/blob/main/index.json) (24 h TTL) and matches on `Reference`, display `Name` and `Tags`.
  - **dashboardicons metadata lookup** — loads and caches [homarr-labs/dashboard-icons `metadata.json`](https://github.com/homarr-labs/dashboard-icons/blob/main/metadata.json) (24 h TTL) and matches on slug keys, `aliases` and trailing slug segments (e.g. `onedrive` → `microsoft-onedrive`).
  - **lobehub index lookup** — loads and caches [`@lobehub/icons` `toc.json`](https://unpkg.com/@lobehub/icons@latest/es/toc.json) (24 h TTL) and matches on slug keys, `title` / `fullTitle`, `id`, `docsUrl` and trailing slug segments.
  - **Static fallbacks** when metadata has not loaded yet: `onedrive` → `microsoft-onedrive`; `kdrive` → `ksuite-kdrive` (selfh.st) / `infomaniak-kdrive` (dashboardicons).
  - **`/sh/:service`, `/di/:service` and `/lb/:service`** now iterate provider-specific slug candidates and, when `variant=color` is requested, fall back to `light` then `dark` if the color asset does not exist upstream.
  - **Fuzzy slug matching (all service-icon catalogs)** — slug segments and aliases that are ≥80% similar to the search term (Levenshtein ratio, min. query length 4) are treated as matches across selfh.st, dashboardicons and lobehub, so e.g. `sheet` and `sheets` both resolve to `google-sheets` via the `sheets` segment (~83% similar). Tied scores break alphabetically by slug.
  - **Highest-score resolution** — per-provider `resolved` is the top-scoring candidate, not the raw search term. The input slug is only kept as a selfh.st candidate when it exists verbatim in [selfhst/icons `index.json`](https://github.com/selfhst/icons/blob/main/index.json); otherwise resolution skips to scored matches (avoiding phantom slugs like `sheet` or `sheets` that do not exist as PNG filenames).
  - **selfh.st name/tag matching** — in addition to fuzzy slug segments, selfh.st scores substring hits on display `Name` and `Tags` from its index (e.g. `sheets` → `google-sheets` via "Google **Sheets**").
  - **Hyphenated slug guard (selfh.st)** — when the input slug contains a hyphen but is not in the selfh.st catalog (e.g. dashboard-only `eu-drive`), only that exact slug is tried; fuzzy partial matches like `drive-synology` are not substituted.
  - **Variant toggles follow upstream assets** — Color/Light/Dark buttons on each service card are shown only after a probe confirms the variant exists upstream. Catalogs differ: dashboardicons often ships color-only PNGs (e.g. `microsoft-onedrive.png` with no `-light`/`-dark` siblings), while selfh.st may publish separate `-light`/`-dark` files and list legacy slugs such as `microsoft-onedrive-2018` under Alternative matches.
  - **Web UI — "Alternative matches" panel** on all three service-icon cards: when multiple slug candidates exist for a provider, a grid of clickable tiles (thumbnail, label, slug) is shown below the main preview so users can switch between matches (e.g. pick `ksuite-kdrive` on selfh.st after searching `kdrive`, or `microsoft-onedrive-2018` after searching `onedrive`). The search-options hint lists per-provider resolved slugs when they differ (e.g. `selfh.st: "google-drive", dashboardicons: "eu-drive", lobehub: "drive"`). Service-icon cards load via the resolved slug (`/sh/{resolved}`, `/di/{resolved}`, `/lb/{resolved}`); cards hide when the color variant fails to load during domain or service searches (`hideOnError`).
  - **`/{domain}/json`** — `endpoints.selfhst`, `endpoints.dashboardicons` and `endpoints.lobehub` now expose the provider-specific resolved slug in `service`, the raw domain label in `query`, and build proxy/source URLs from the resolved slug. v1 scraper fallback tiers and the best-pick cascade use the same per-provider resolution.

- **FaviconAPIs-compatible JSON API** (`/api/v1/favicon` + `/cdn/favicons/{domain}.png`)
  - New `GET /api/v1/favicon?url={website}` endpoint returns a JSON object — `{ url, domain, width, height, format, sourceType, cached, cachedAt }` — instead of the image bytes, modelled on [faviconapis.com/docs](https://www.faviconapis.com/docs). The PNG itself is fetched separately from the returned CDN URL.
  - **Source priority** for icon discovery is `svg` > `manifest` > `apple-touch-icon` > `png` > `selfhst` > `dashboardicons` > `lobehub` > `external`. The first source that yields a decodable image wins, and the tag is reported in the `sourceType` response field. Implemented in new `src/apiScraper.js`, reusing existing scraper helpers (`fetchScraperPage`, `parseIconCandidatesFromHtml`, `fetchManifestIcons`, `fetchScraperAsset`) rather than duplicating HTML/manifest fetch logic. Root `/favicon.ico` and other ICO sources are excluded — they contain small frames that upscaled poorly.
  - **All output is normalized to a uniform 128×128 PNG** via new `src/imageNormalize.js`. SVGs are rasterized at `density=192` (4×96 dpi) for a crisp 128-pixel render; raster sources must be at least 128×128 and are downscaled with `fit: contain` and a transparent background. Sources larger than 128px are preferred; exactly-128px sources are only used when nothing larger is available.
  - **7-day CDN cache.** The generated PNG is written to `API_CACHE_DIR` (default `/cache/api`) with a sibling `.meta.json` (`{ sourceType, width, height, cachedAt }`), and re-served via the new public `GET /cdn/favicons/{domain}.png` route with `Content-Type: image/png` and `Cache-Control: public, max-age=604800, immutable`. Subsequent calls within the TTL window return `cached: true` and the original `cachedAt` timestamp; `cdn/favicons/...` returns `404` until `/api/v1/favicon` has been called at least once for that domain (safe to expose publicly). Cache entries whose PNG or metadata dimensions are not 128×128 are treated as stale and regenerated on the next request.
  - **Error responses match the FaviconAPIs spec** and are always JSON with `error` and `code` fields: `400 missing_url` / `400 invalid_url`, `401 missing_api_key` / `401 invalid_api_key`, `422 favicon_not_found` / `422 favicon_not_processable` (with `sourceType` + `sourceUrl` for diagnostics), `429 quota_exceeded` (with `plan` / `limit` / `used` / `period`), `500 internal_error`.
  - New environment variables: `API_KEYS_DB` (default `/cache/api-keys.sqlite`), `API_CACHE_DIR` (default `/cache/api`), `API_CACHE_TTL` (default `604800` = 7 days, used both for cache freshness and the CDN `Cache-Control: max-age`).
  - Mounted in `src/index.js` (`app.use(apiRoutes)`) directly after the static-assets handler and before the catch-all `/:domain` provider route so `/api/...` and `/cdn/...` paths take precedence. Existing routes (`/g/...`, `/g2/...`, `/d/...`, `/y/...`, `/f/...`, `/v/...`, `/p/...`, `/k/...`, `/l/...`, `/s/...`, `/sh/...`, `/di/...`, `/lb/...`, `/{domain}`, `/{domain}/json`) are unaffected.

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
  - Documented in `README.md` and `.env.example`.

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
    - Shows an orange "API keys required" badge in the header when keys are enforced; hides the banner entirely when this instance runs without required keys.
    - Hides the playground key input, the **Authentication** section, the **Plans & quotas** section, and the Errors-section note that only `200` responses count toward the monthly quota when this instance does not require a key.
    - Re-renders the Quick start code samples so the `Authorization: Bearer fa_your_key_here` header (or `?key=...`) is dropped when not relevant - the samples become valid copy-paste calls for the actual running instance.
  - All env-var names (`API_REQUIRE_KEY`, `API_CACHE_TTL`, `PLAN_*_LIMIT`) are kept out of the user-facing copy; runtime/config documentation lives in `README.md` and `.env.example`.
  - **`/providers` extended with `api.{ requireKey, cacheTtl, plans }`** so the docs page can adapt without a separate endpoint. `requireKey` mirrors the `API_REQUIRE_KEY` parsing in `src/apiRoutes.js` (truthy unless the env var equals `false` / `0` / `no` / `off`), `cacheTtl` reflects `API_CACHE_TTL` (default 604800), `plans` exposes `apiStore.PLAN_LIMITS` (`free` / `pro` / `enterprise`).
  - **`/robots.txt`** allow-list extended with `/api` and `/api.html`; **`/sitemap.xml`** includes a new `<url>` entry for `/api` (`<priority>0.8</priority>`, `<changefreq>monthly</changefreq>`) so search engines can index the docs page.
  - **Homepage `top-nav`** gains an **API** link pointing at `/api`, sitting between the **Tools** offcanvas button and the **Wiki** external link.

- **Consistent top navigation across pages** — `api.html` now has the same top-nav as `index.html`: **Tools** offcanvas (bookmarklet + browser search-engine setup modal), **Home**, **API** and **Wiki** links. A **Home** menu item (`/`) has been added to both pages, with the current page highlighted via an `active` style.
- **Page footer on `index.html` and `api.html`** — both pages share a footer with a **FaviconAPI** brand label and GitHub links to the MAFL+ and FaviconAPI repositories, separated from the main content by a subtle light-gray top border.
- **Site favicon pack** (`src/public/favicons/`)
  - Full multi-size favicon set: `favicon.ico`, PNGs at 16/32/48/96 px, `apple-touch-icon.png` (180×180), Android Chrome icons (192/512), `ms-icon-144x144.png`, and a `manifest.json` for PWA install tiles.
  - Wired into the `<head>` of both `index.html` and `api.html`: sized `rel="icon"` links, shortcut icon, apple-touch-icon, web app manifest link, and `msapplication-TileColor` (`#5b2e7e`) / `msapplication-TileImage` meta tags.
- **`logo.svg`** — vector site logo for the page header (`<img class="site-logo">`).
- **v1 API fallback sources** (`src/apiScraper.js`)
  - **Standard well-known paths** — probes `/apple-touch-icon.png`, `/apple-touch-icon-precomposed.png`, `/android-chrome-512x512.png` and `/android-chrome-192x192.png` when HTML does not declare them.
  - **`NxN` size-variant expansion** — HTML candidates matching `…/{N}x{N}.png` (e.g. Reddit's `64x64.png`) are expanded to larger CDN variants (128–512) before probing, reusing `expandSizedVariants` from `src/providers.js`.
  - **selfhst, dashboardicons & lobehub** — when scraping finds nothing usable, looks up the domain's first label as a service slug (e.g. `google.com` → `google`) against [selfhst/icons](https://github.com/selfhst/icons), [homarr-labs/dashboard-icons](https://github.com/homarr-labs/dashboard-icons) and [@lobehub/icons-static-svg](https://www.npmjs.com/package/@lobehub/icons-static-svg) via jsDelivr/unpkg.
  - **Google faviconV2** (`sourceType: external`) — last-resort fallback requesting a 256px icon from `t0.gstatic.com/faviconV2` and downscaling to 128×128.
- **Browser custom search engine** (`/search?q=...` + `/opensearch.xml`)
  - New `GET /search?q={query}` route redirects to `/?q={query}` so the homepage loads favicon results for the typed domain or service name. Intended URL for browser search-engine settings: `https://your-host/search?q=%s`.
  - New `GET /opensearch.xml` OpenSearch descriptor (linked from the homepage `<head>`) for one-click "Add search engine" in Firefox, Chrome and other OpenSearch-aware browsers.
  - The homepage reads `?q=` on load and auto-runs a lookup.
  - **Web UI — "Search from browser" modal**: step-by-step setup instructions per browser (Chrome, Edge, Firefox, Safari) with the search-engine URL shown prominently (click-to-copy and as clickable links per section). The URL is derived from `location.origin` at runtime.
  - **Web UI — "Tools" offcanvas**: the browser-search and bookmarklet actions moved out of the main page flow into a slide-in panel opened from a **Tools** button in the top navigation. Keeps the homepage uncluttered while both shortcuts remain one click away. Closes on backdrop click or Escape; opening the search modal closes the offcanvas first.
  - **`/#tools` deep link** — visiting `/#tools` on the homepage or API docs page (`index.html`, `api.html`) opens the Tools offcanvas automatically (also on `hashchange`), enabling shareable links such as `https://faviconapi.com/#tools`.
- **homarr-labs/dashboard-icons lookup** (`/di/{service}`)
  - New service-name lookup against the [homarr-labs/dashboard-icons](https://github.com/homarr-labs/dashboard-icons) catalog via `cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/...`.
  - Supports `?variant=color|light|dark` with the same `-light` / `-dark` suffix convention used for `/sh/`. Color variant uses the bare slug (`/di/jellyfin` → `png/jellyfin.png`); light/dark map to `png/{slug}-light.png` and `png/{slug}-dark.png`.
  - Service slug validation reused from `/sh/`: lowercase alphanumerics with `.`, `_`, `-`.
  - Returns HTTP 404 when the upstream icon does not exist (caches the negative result through the existing on-disk cache layer).
  - New `dashboardicons` cache provider key + `fetchDashboardIcons(service, variant)` exported from `src/providers.js`; `PROVIDERS.dashboardIcons(service, variant)` builds the upstream URL.
  - `/{domain}/json` now exposes the new source alongside `selfhst` under `endpoints.dashboardicons` (same shape: `service`, `proxy`, `source`, `variants.{color,light,dark}.{proxy,source}`). `null`-valued fields when the domain has no usable slug (i.e. no first label).
  - **Best-pick cascade** (`/{domain}`): `dashboardicons` is added to the candidate set when a domain has a derivable service slug, and is a valid value for `DEFAULT_PROVIDER`. `.env.example`, `README.md` and the Environment Variables table updated to list the new value.
  - **Web UI**: new "Dashboard Icons (homarr)" card rendered side-by-side with the selfh.st card under the same `data-card-type="service"` group and the same color/light/dark variant probe pipeline (variant buttons auto-hide when the upstream variant does not exist). The existing search-options checkbox now controls all three service-icon lookups (relabelled to "Also include service icon lookups") and the meta description / Open Graph / Twitter Card / JSON-LD description / keywords in `<head>` mention all three catalogs for SEO.
- **LobeHub icons lookup** (`/lb/{service}`)
  - New service-name lookup against the [@lobehub/icons-static-svg](https://www.npmjs.com/package/@lobehub/icons-static-svg) catalog via `cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/...`.
  - Supports `?variant=color|light|dark` and `?size=64|128|256` (default 128). Upstream assets are SVG; the proxy rasterizes them to PNG via `rasterizeSvgToSize` from `src/imageNormalize.js`. Light/dark variants are synthesized by recoloring non-transparent pixels to white/black after rasterization (LobeHub ships a single SVG per icon, not separate light/dark files).
  - Icon URL priority for the color variant: `{slug}-color.svg` → `{slug}-brand-color.svg` → `{slug}.svg` → `{slug}-brand.svg`, guided by flags in the cached `@lobehub/icons` toc (`hasColor`, `hasBrandColor`, `hasBrand`).
  - Service slug validation reused from `/sh/`: lowercase alphanumerics with `.`, `_`, `-`.
  - Returns HTTP 404 when no upstream SVG exists (cached as a negative result through the existing on-disk cache layer).
  - New `lobehub` cache provider key + `fetchLobehub(service, variant, size)` exported from `src/providers.js`; `PROVIDERS.lobehub(service, variant)` builds the upstream URL.
  - `/{domain}/json` now exposes the new source under `endpoints.lobehub` (same shape as selfhst/dashboardicons, plus a `sizes` array for 64/128/256 proxy URLs).
  - **Best-pick cascade** (`/{domain}`): `lobehub` is added to the candidate set when a domain has a derivable service slug, and is a valid value for `DEFAULT_PROVIDER`. `.env.example` updated to list the new value.
  - **Web UI**: new "lobehub.com" card alongside selfh.st and dashboardicons under the same `data-card-type="service"` group, with color/light/dark variant buttons (light/dark auto-hide when unavailable), size buttons (64/128/256) and the same "Alternative matches" panel. The search-options hint lists per-provider resolved slugs for all three catalogs.
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
- **`CACHE_SIZE_MB` environment variable** caps the total size of the disk cache (`CACHE_DIR`) in megabytes. When the directory exceeds the configured limit, the oldest entries (by `mtime`) are evicted — both the data file and its `.meta` sibling — until the cache is back under the cap. Each cluster worker keeps a lightweight in-memory index of disk files and rescans the shared cache directory every 60 seconds (and on every set that pushes its local view over the limit) so writes from sibling workers converge into a single accurate view before eviction runs. Set to `0` (default in code) to disable the size cap and fall back to the original TTL-only behaviour. Documented in `README.md` and `.env.example`.
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
  - *(Superseded when `SCRAPER_MAX_ICON_SIZE` is set — see **Changed** below: source variants load via `/s-asset`; a separate fast-proxy button serves `/s/{domain}`.)*
  - **Bundled `docker-compose.yml` ships besticon as an internal-only service**: no `ports:` mapping (the besticon frontend at `/` is not publicly reachable), health-checked on `/up`, joined to a shared `besticon` bridge network so `maflplus-favicon-api` can resolve it on hostname `besticon`. `maflplus-favicon-api` declares `depends_on: besticon: { condition: service_healthy }`. Set `BESTICON_URL=http://besticon:8080` in `.env` (see `.env.example`) to enable the sidecar.
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
  - Search input now accepts both a domain (e.g. `example.com`) and a bare service name without a TLD (e.g. `radarr`, `sonarr`); when no dot is present the input is treated as a service-icon name and all three service-icon cards (selfh.st, dashboardicons.com, lobehub.com) are shown.
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
  - New `UV_THREADPOOL_SIZE` (default `16` in `.env.example`) raises Node's libuv thread pool above the built-in default of `4`, giving more headroom for parallel disk I/O (cache reads/writes) and DNS lookups under load.
  - New `PICK_HEAD_START_MS` (default `150` ms) controls the head-start given to the preferred provider in the new parallel `/{domain}` race (see "Changed" below).
  - New `SCRAPER_PROBE_BATCH_SIZE` (default `4`) controls how many HTML scraper icon candidates are probed in parallel per batch.
- **Configuration**
  - New `DEFAULT_PROVIDER` environment variable to set the preferred provider for `/{domain}` requests. Valid values: `scraper`, `google`, `googlev2`, `duckduckgo`, `yandex`, `faviconso`, `vemetric`, `favicondev`, `faviconkit`, `logodev`, `selfhst`, `dashboardicons`, `lobehub`. Other providers race in parallel after the head-start window. Logs a warning at startup when an invalid value is supplied.
  - New `LOGODEV_TOKEN` environment variable, documented in `README.md` and `.env.example`.
- **Documentation**
  - `README.md` rewritten to cover all new endpoints, the size matrix per provider, the selfhst lookup, the `/providers` endpoint, and the `LOGODEV_TOKEN` variable.
  - Endpoint table consolidated to use parameterised paths (e.g. `/g/{size}/{domain}`) instead of one row per size.
  - Documented scraper cache bypass: `/s/{domain}?refresh=1` (alias `?nocache=1`).
- **Response headers**
  - Favicon responses may include `X-Favicon-Url` with the upstream asset URL when known (e.g. after HTML scraper fetch).

### Changed

- **`README.md` intro** — replaces the one-line tagline with a fuller project summary, a **What it does** section, links to the live demo ([faviconapi.com](https://faviconapi.com)) and browser tools ([faviconapi.com/#tools](https://faviconapi.com/#tools)), and short descriptions of the custom search engine and **FaviconAPI Copy** bookmarklet; favicon-provider table heading simplified.

- **`/{domain}/json` and `/{app-name}/json` — reliable catalog entries**
  - Service-icon blocks are built only when a provider actually resolves a slug (`resolveServiceMatches` on domain JSON; no more guessing the raw search term as `selfhst` / `lobehub` slug).
  - **`variants` lists only upstream assets that exist** — selfh.st and dashboardicons light/dark URLs are included only after a CDN probe confirms the PNG (24 h in-memory cache per slug). Fixes phantom entries such as dashboardicons `reddit-light.png` / `reddit-dark.png` when only the color PNG exists.
  - Domain JSON now uses the same async `resolveServiceMatches()` path as service-name JSON (replacing per-provider sync resolve).
  - JSON discovery responses use **`Cache-Control: no-cache`** instead of `max-age=86400`, so variant lists and provider fixes are not stuck in the browser for a day after deploy.

- **Web UI — copy feedback and example URLs** (`index.html`)
  - Tip / example URL documents `{domain}` **or** `{app-name}`; clicking the example copies via the **global bottom-right toast** (same as image copy), not an inline message in the green tip box.
  - Service-name searches show the short best-pick URL (`/{app-name}`) and re-enable the **View JSON** link (`/{app-name}/json`).
  - Service-icon cards are omitted when `/services/resolve` returns no candidates for that provider (instead of probing a guessed slug and failing).
  - **Search reset** — a clear (`×`) button beside the search field appears after a lookup; `resetSearch()` clears the query, hides all provider cards and restores the empty state.

- **Web UI — HTML Scraper size strip** (`index.html`) — reworked when `SCRAPER_MAX_ICON_SIZE` is set and `/{domain}/json` exposes `endpoints.scraper.maxIconSize`:
  - On load, selects the **largest discovered source** (`/s-asset`) instead of auto-selecting the downscaled fast-proxy (`/s/{domain}`).
  - Adds a **hare** fast-proxy button (Iconify `f7:hare-fill`) for the embeddable `/s/{domain}` URL at `maxIconSize`, with a custom tooltip explaining faster loads via downscaling; source and proxy buttons are de-duplicated when they share the same declared size (source listed first).
  - Fast-proxy meta row always shows `maxIconSize×maxIconSize` (not loaded pixel dimensions); retries once with `?refresh=1` when a stale `/s/` disk cache still serves an oversized image.
  - Race-safe loading via `scraperLoadToken`; meta row distinguishes proxy URL vs upstream source URL for copy.
  - When `SCRAPER_MAX_ICON_SIZE` is `0`, behaviour unchanged: largest variant uses `/s/{domain}` directly.

- **`docker-compose.yml` configuration via `.env`** — `maflplus-favicon-api` loads settings from `env_file: .env.example` (copy to `.env` and edit for local overrides) instead of a long inline `environment:` block. Besticon receives only the `BESTICON_*` variables mapped in its `environment:` section via `${BESTICON_…:-default}` substitution from the same `.env` file. Defaults to `build: .` for local development; published `ghcr.io` image line commented out.
- **`.env.example`** — every application and API v1 variable documented with inline comments; `BESTICON_URL` comment clarifies that an unset value ignores the sidecar (built-in scraper only) while the bundled compose stack expects `http://besticon:8080`.
- **v1 API manifest gathering** (`src/apiScraper.js`) — uses shared `loadManifestIconCandidates` (including manifest discovery when homepage HTML is empty); removes inline cheerio manifest parsing.
- **API docs header** (`api.html`) — site logo is now a link to `/` (homepage); minor copy tweak ("cached for 7 days" vs "cached on disk for 7 days").

- **`/services/resolve/:service`** — when the path looks like a hostname (contains `.`), runs `serviceSlugFromDomain` before catalog matching so domain searches resolve the same slug the v1 API uses (e.g. `drive.google.com` → `google-drive`).
- **Web UI domain service-slug derivation** (`index.html`) — `deriveServiceSlug()` mirrors the server rules (`deriveServiceSlugFromDomain` + suite-parent compound slugs) instead of always taking the first domain label.

- **Product renamed to FaviconAPI** (was "MAFL+ Favicon API")
  - User-facing branding updated across `index.html`, `api.html`, `src/index.js` (`/opensearch.xml` `ShortName`, `/robots.txt` comment), `README.md` and the `docs/` guides.
  - `<title>`, meta `application-name`, Open Graph / Twitter Card tags and JSON-LD `name` now use **FaviconAPI**; `alternateName` is **Favicon API**.
  - Browser shortcuts renamed: custom search engine **FaviconAPI** (was "MAFL+ Favicon"); bookmarklet **FaviconAPI Copy** (was "Mafl+ Favicon Copy"); Tools offcanvas / search-engine modal copy refers to FaviconAPI instead of MAFL+.
  - External **MAFL+** project links, Docker service names (`maflplus-favicon-api`) and GitHub repo URLs are unchanged.
  - Root `favicon.png` and `logo.png` removed from `src/public/`; tab/bookmark icons load from `/favicons/...`. Open Graph / Twitter Card / JSON-LD `image` fields, `/robots.txt` allow-list and `/opensearch.xml` still reference `/logo.png` and `/favicon.png`.

- **Web UI — logo and footer** (`index.html`, `api.html`)
  - Header logo switched from `/logo.png` to `/logo.svg`.
  - Footer redesigned: light-gray **FaviconAPI** brand label (Georgia serif, matching the page title) above two subtle GitHub text links — **MAFL+** (`R0GGER/maflplus`) and **FaviconAPI** (`R0GGER/maflplus-favicon-api`) — each with a small GitHub icon. The brand label links to [faviconapi.com](https://faviconapi.com) (opens in a new tab). Replaces the earlier "MAFL+ Favicon API · GitHub · Wiki" line.
  - Top navigation: **MAFL+** and **Favicon API** GitHub links removed from both pages; **Tools**, **Home**, **API** and **Wiki** remain.
  - Service icon card titles: `selfh.st/icons (cdn)` → `selfh.st/icons`; `dashboardicons.com (cdn)` → `dashboardicons.com`; new third card titled `lobehub.com`.
  - **selfh.st SVG-first fetch** — when the selfhst catalog marks an icon as `SVG=Yes`, `/sh/:service` now tries the jsDelivr SVG before the PNG and rasterizes it to 128×128 PNG for consistent output (fixes stale/wrong PNGs such as `twake-drive`, where the PNG still showed a Synology-style icon while the SVG has the correct Twake branding).

- **Web UI — mobile layout refinements** (`index.html`, `api.html`)
  - Top navigation at ≤700px shows only **Home**, **API** and **Wiki**; the **Tools** offcanvas button is hidden so the header stays readable on narrow screens.
  - Homepage **Try:** quick links reduced on mobile to `github.com`, `proton.me`, `immich`, `jellyfin` (`reddit.com` and `firefox` remain visible on desktop).
  - API docs page: the mode banner (`#api-mode-banner`) is hidden on mobile (≤700px) via CSS; when `API_REQUIRE_KEY=false` it is also hidden on desktop.
  - API playground **Try:** chips reduced on mobile to `github.com`, `proton.me`, `hosthatch.com` (`reddit.com` and `netflix.com` remain visible on desktop).

- **Web UI — service icons section divider** (`index.html`) — when searching a domain with **Also include service icon lookups** enabled, a subtle light-gray horizontal rule with centred **Service icons** label now separates the favicon provider cards from the selfh.st / dashboardicons.com / lobehub.com cards. The divider appears only after at least one service-icon card has loaded a result; it stays hidden while spinners are active and when all three providers return no icon (cards are hidden via `hideOnError`). Also hidden for pure service-name searches and when the checkbox is off.

- **API docs — public mode banner** (`api.html`) — when `API_REQUIRE_KEY=false`, the header no longer shows a green "Public / anonymous" badge; `renderApiMode()` hides the entire `#api-mode-banner` so the docs page does not advertise anonymous access on instances that simply do not require keys.

- **`parseIconCandidatesFromHtml` (`src/providers.js`)** now also reports the `rel` attribute per candidate (`{ href, sizes, type, rel }`), enabling the new `apiScraper.js` to classify candidates by source type (`svg` / `manifest` / `apple-touch-icon` / `png` / `ico`). Existing callers (`buildScraperCandidates` in `fetchScraper`) ignore the new field and are not affected.
- **`src/providers.js` exports** expanded with `fetchScraperPage`, `parseIconCandidatesFromHtml`, `fetchManifestIcons` and `parseSizesAttr` so the new `apiScraper.js` can reuse the existing HTML/manifest fetch pipeline without duplication. Pre-existing exports are unchanged.
- **`Dockerfile`** updates for the v1 API:
  - Deps stage installs `python3 make g++` as a virtual `.build-deps` apk package and removes them again after `npm ci`, so native modules like `better-sqlite3` can compile from source on Alpine/musl when no prebuilt binary is available for the target arch; the runtime image is unaffected.
  - Runtime stage now also copies `scripts/` so the `npm run keys:*` CLI is available inside the container (`docker compose exec maflplus-favicon-api npm run keys:create -- ...`).
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

### Changed

- **v1 API output size: 256×256 → uniform 128×128** (`src/imageNormalize.js`, `src/apiRoutes.js`)
  - `TARGET_SIZE` and `MIN_SOURCE_SIZE` are both `128`. Every successful `/api/v1/favicon` response and cached CDN PNG is exactly 128×128; the JSON `width` / `height` fields are always `128`.
  - `ensureExactSize()` verifies the normalised buffer before caching; `fit: contain` with a transparent background preserves aspect ratio inside the 128×128 canvas.
  - SVG rasterisation density lowered from `384` to `192` to match the 128px target.
  - **`rasterizeSvgToSize(buffer, size)` exported** for reuse by service-icon providers (selfh.st, lobehub) that rasterize upstream SVGs at arbitrary sizes.
- **v1 API source selection** (`src/apiScraper.js`)
  - **ICO tier removed** — root `/favicon.ico` and `<link rel="icon" href="…ico">` candidates are no longer used; they typically contain 16–48px frames that produced blurry upscales.
  - **Minimum source size enforced at fetch time** — raster candidates smaller than 128×128 are skipped in `tryCandidate` so the tier loop can continue to larger variants or the next tier.
  - **Prefer sources > 128px** — walks all tiers looking for a source whose largest dimension exceeds 128px before accepting an exactly-128px fallback anywhere in the pipeline.
  - **Manifest icon threshold** — `fetchManifestIcons` accepts icons with no declared `sizes` (probed later) and only skips entries that explicitly declare a size below 128px (was ≥ 512 only, then ≥ 128).
- **v1 API cache invalidation** (`src/apiRoutes.js`) — entries whose `.meta.json` or on-disk PNG dimensions are not 128×128 are ignored (treated as a cache miss) so older 256×256 or variable-size outputs are regenerated automatically after deploy, without manual cache clearing.

### Fixed

- **Bot scanner paths polluting the disk cache** — the catch-all `GET /{domain}` route (and all `/{provider}/…` domain routes) previously accepted any string containing a dot as a hostname, so internet scanners probing paths like `/wp-login.php`, `/phpinfo.php`, `/.env` or `/README.md` triggered upstream favicon fetches and wrote thousands of junk entries under `/cache`. New shared module `src/domainValidation.js` centralises hostname checks for `src/index.js` and `src/apiRoutes.js`: hostnames must match `SAFE_DOMAIN_RE` **and** must not end in a known file/config extension (`.php`, `.env`, `.md`, `.json`, `.html`, `.ini`, `.yaml`, `.sql`, `.bak`, `.properties`, `.amplifyrc`, …; any suffix starting with `php` is also rejected). Invalid inputs now return `400 Invalid domain` / `400 invalid_url` immediately — no upstream work, no cache write. **Note:** existing junk files on disk are not removed automatically; clear them manually or rely on `CACHE_SIZE_MB` eviction.

- **HTML scraper missed manifest icons on SPA / bot-interstitial homepages** (e.g. `ah.nl`) — when HTML lacks a `<link rel="manifest">`, the scraper now walks `Link` headers, well-known manifest paths, icon-directory heuristics and `STATIC_MANIFEST_HINTS` before giving up. The v1 API manifest tier benefits from the same pipeline via `loadManifestIconCandidates`.
- **HTML scraper `NxN` variant ladder on `/favicon/` paths** — `faviconVariantGroupAllowsLargeJump()` keeps probing consecutive sizes under `/favicon/` or `/favicons/` (e.g. Reddit 192 → 512 in the same folder) while the existing `MAX_FAVICON_SIZE_JUMP` guard still blocks unrelated marketing art on other URL patterns.

- **Light and dark service-icon variants were swapped** — selfh.st and dashboardicons name upstream PNGs by **icon tone** (`-light` = pale icon, `-dark` = dark icon) while the API and web UI variants name the **target background theme** (light = darker icon for light backgrounds; dark = lighter icon for dark backgrounds). `pngVariantSuffix()` in `src/providers.js` now maps API `light` → `-dark` and `dark` → `-light` for `/sh` and `/di`; LobeHub synthesized variants recolor to black for `light` and white for `dark`. Web UI preview backgrounds follow the theme (light = white, dark = charcoal). Cache keys bumped so stale mis-mapped PNGs are not reused (`{variant}_v3` on `/sh` and `/di`; `{size}_{variant}_v3` on `/lb`).

- **`/{app-name}/json` and `/{domain}/json` listed providers and variants that do not exist upstream** — e.g. `albert-heijn` only in dashboardicons still produced selfh.st / lobehub blocks with bogus slugs; dashboardicons / selfh.st listed `light` and `dark` proxy/source pairs when the CDN has no `-light` / `-dark` PNG. Resolution no longer falls back to the raw input slug when a catalog has zero matches (`pickResolvedSlug` in `src/serviceAliases.js`); `resolveServiceSlugForProviderSync` validates slugs against each catalog before returning them. Variant availability for selfh.st and dashboardicons is confirmed via CDN probe (`getSelfhstVariantAvailability` / `getDashboardIconsVariantAvailability` in `src/providers.js`).

- **HTML Scraper empty preview on ICO fallbacks (e.g. `word.office.com`, Play Store favicons)** — many upstream `.ico` files use BMP frames that **sharp** cannot decode (`Input buffer contains unsupported image format`). Besticon still reported them in `/{domain}/json` → `endpoints.scraper.icons` (e.g. 128×128), but `probeScraperCandidates` rejected every candidate, so `/s/{domain}` returned **502** and the web UI showed an empty beige placeholder with dimensions but no image. `/s-asset` returned the raw `image/x-icon` bytes, which browsers often refuse to paint in `<img>`. New helpers in `src/imageNormalize.js`: `readImageDimensions` (sharp first, `decode-ico` fallback) and `toDisplayPng` (largest ICO frame → PNG at native size, no 128px minimum). Used by scraper probing (`probeOne`, `probeIconMetadata`), `/s/{domain}` output, `/s-asset` (cached under provider key `asset-v2` so stale raw-ICO entries are not reused), and v1 `tryCandidate` in `src/apiScraper.js`. The HTML Scraper card now falls back to `/s-asset?url=…` when the primary `/s/{domain}` load fails.
- **Wrong service icon for Google Workspace subdomains (e.g. `drive.google.com`)** — v1 API, best-pick and service-icon cards previously derived the slug from only the first domain label (`drive`), which matched dashboardicons' generic `eu-drive` folder icon instead of Google Drive. Slug derivation now maps suite subdomains to `{parent}-{service}` (with explicit rows in `domainIconTags.js`). **Note:** existing v1 API disk-cache entries are not invalidated automatically — use `?refresh=1` or `/_internal/cache/purge` after deploy.
- **Fuzzy slug prefix false positives (dashboardicons / all catalogs)** — `fuzzyPartScore` no longer treats a query as matching a slug segment merely because the query *starts with* that segment (e.g. `baseten` → `base` in `pvy-base`). Prefix matches now require a hyphen boundary after the segment (`gitlab-ce` → `gitlab` still matches). Prevents unrelated dashboardicons hits when a search term merely shares a substring with a slug part.
- **selfh.st wrong icon for dashboard-only slugs (e.g. `eu-drive`)** — the selfh.st "Alternative matches" panel no longer merges dashboardicons slugs into its candidate list, so entries like `eu-drive` and `synology-drive` only appear under dashboardicons.com. `/sh/eu-drive` no longer falls back to `drive-synology` when the upstream PNG is missing (404) — combined with the hyphenated-slug guard, unknown selfh.st slugs return "icon not available" instead of a substituted icon.
- **lobehub.com tiny icons and light/dark preview** — upstream SVGs declare a 16×16 intrinsic size; `/lb/:service` now rasterizes them to PNG at `?size=64|128|256` (default 128). Light/dark variants are synthesized by recoloring non-transparent pixels after rasterization. Cache keys bumped (`{size}_{variant}_v2`, later `_v3` after light/dark semantics fix) so stale pre-fix PNGs are not reused.
- **Yandex 1×1 placeholder icons** — When Yandex has no favicon for a domain it returns a 1×1 transparent PNG. `fetchYandex` (`src/providers.js`) now rejects images ≤1×1 via `sharp` metadata so `/y/{domain}` returns 502 and the provider is skipped in best-pick. The web UI Yandex card is hidden when the loaded image is ≤1×1 (covers stale cache entries that predate the backend check).
- **HTML Scraper resolution mismatch on first load** — the web UI no longer runs `loadFavicon()` in parallel with the `/{domain}/json` icon-list fetch. Previously the size-button strip could render with the largest variant selected (e.g. **512**) while the meta row still showed the dimensions from an earlier `/s/{domain}` image load (e.g. **192×192**), because `loadScraperSizes()` rendered the buttons but never called `loadScraperVariant(0)` to sync the image and footer. The scraper card now waits for the JSON icon list, then loads variant 0 via `loadScraperVariant()` so the active button, displayed image and `{w}×{h}` meta always come from the same entry; falls back to the legacy `loadFavicon()` path when the JSON fetch fails or returns no icons. The primary (largest) variant's meta row again shows and copies the proxy URL (`{origin}/s/{domain}`).
- **HTML Scraper size-button strip on production / datacenter hosts** — `/{domain}/json` now augments besticon's discoveries with the existing `STATIC_CDN_HINTS` + `expandSizedVariants` ladder before returning `endpoints.scraper.icons`, and `fetchScraper` does the same when picking the "best" icon for `/s/{domain}`. Previously, when the sidecar besticon was blocked by an origin's datacenter-IP filter (Reddit serves a JS-challenge interstitial to cloud IPs), besticon would only surface the 3 standard fallback URLs (`favicon.ico`, `apple-touch-icon.png`, `apple-touch-icon-precomposed.png`), so the UI's size-button strip rendered just `32 / 57 / 128` — even though our own node process could reach the CDN-hosted hi-res variants directly. The merged probe now lifts that to the full ladder (e.g. `64 / 76 / 120 / 128 / 152 / 180 / 192 / 256 / 384 / 512` for `reddit.com`, depending on which variants the CDN actually serves) regardless of whether besticon could see them. Implemented via new `deriveHintCandidates` + `fetchScraperAllIcons` helpers in `src/providers.js`; results are LRU-cached in-memory (configurable via `SCRAPER_ICONS_CACHE_TTL`, default 3600 s, and `SCRAPER_ICONS_CACHE_MAX`, default 500 domains) so the UI does not re-probe 8+ candidate URLs on every page load.
- **HTML scraper Reddit regression** — `<link rel="icon">`, `rel="shortcut"` (incl. combined `rel="icon shortcut"`) and `rel="fluid-icon"` are recognised again, alongside `apple-touch-icon` / `-precomposed`. `NxN` CDN paths are once again expanded to larger size variants (e.g. `64x64.png` → 128/152/180/192/256/384/512). Reddit's datacenter-IP interstitial only declares a single `rel="icon shortcut" sizes="64x64"`, so the previous tightening caused `/s/reddit.com` to fall back to the old low-res `apple-touch-icon.png` instead of the modern 192×192 chat-bubble logo. The `MAX_FAVICON_SIZE_JUMP = 2.5` guard still prevents Reddit's 512×512 marketing PNG from winning over the real 192×192 favicon. `STATIC_CDN_HINTS` for `reddit.com` / `www.reddit.com` is restored as a defensive fallback when the interstitial drops the icon link entirely.
- **HTML scraper on VPS/datacenter hosts** — upstream fetches now use a dedicated IPv4-only undici dispatcher (`src/upstreamFetch.js`), fixing broken IPv6 egress that caused CDN assets (e.g. `redditstatic.com`) to fail while same-origin fallbacks still worked.
- **HTML scraper icon probing** — CDN/cross-origin icon URLs are fetched with a bare `upstreamFetch` (no extra headers) before retrying with browser-like headers; extra headers were rejected by some CDNs from datacenter IPs.
- **HTML scraper homepage fetch** — retries across `https://{domain}/` and `https://www.{domain}/` with bare, HTTP/1.1, curl and Chrome user-agents when the initial HTML request fails or returns an empty body.
- **HTML scraper fallback ordering** — standard `/apple-touch-icon-precomposed.png` fallbacks are only used when all HTML/CDN candidates fail, preventing a wrong 128×128 icon from winning over a reachable CDN hi-res variant.
- **HTML scraper static CDN hints** — when homepage HTML is blocked entirely (e.g. `reddit.com` from datacenter IPs), known CDN entry points are probed and expanded to larger `NxN` variants (`STATIC_CDN_HINTS` in `providers.js`).
- **HTML scraper variant probing** — when probing `NxN` CDN paths, stops before a sharp size jump (e.g. Reddit serves a full-body marketing PNG at 512×512 while 64–192 are the actual logo favicons). **Revised:** the largest hit in a variant group is no longer dropped when its URL is under `/favicon/` or `/favicons/` — so legitimate hi-res favicon folders (e.g. Reddit 512×512) appear in `endpoints.scraper.icons` and the size-button strip.
- **HTML scraper mask-icon exclusion** — ignores Safari `rel="mask-icon"` / `safari-pinned-tab.svg` assets; these are monochrome pinned-tab silhouettes, not display favicons (e.g. `proton.me` showed a solid black "P" instead of the purple gradient logo).
- **HTML scraper manifest monochrome icons** — skips web-app-manifest icons with `purpose: monochrome` (and known monochrome URL patterns); sites like YouTube expose a white logo at 512×512 alongside the red favicon set.
- **HTML scraper manifest size threshold** — only manifest icons with a declared size of `512×512` or larger are considered, avoiding low-res manifest entries winning over a higher-quality `apple-touch-icon`. **Superseded:** layered manifest discovery + monochrome filtering now allow declared sizes **≥ 128** while still skipping tiny manifest entries when a size is explicitly declared below 128.
- **HTML Scraper fast-proxy meta dimensions** — selecting the lavender proxy button could show `256×256` (or other native sizes) in the footer when `/s/` disk cache predated a lower `SCRAPER_MAX_ICON_SIZE`; meta now reports the configured cap and auto-retries with `?refresh=1` once when the loaded image is still larger.
- **Web UI HTML Scraper URL** — card no longer showed `https://{domain}/` under the icon; it now always displays and copies the proxy URL (`{origin}/s/{domain}`) when the fast-proxy variant is active, matching how other providers expose usable API URLs.

### Internal

- `src/domainValidation.js` — shared `extractDomainFromInput`, `extractDomainFromUrl`, `isValidHostname` and `BLOCKED_FILE_EXTENSIONS` blocklist; consumed by `src/index.js` (`extractDomain`) and `src/apiRoutes.js` (`/api/v1/favicon`, `/cdn/favicons/{domain}.png`).
- `src/providers.js` exports `invalidateScraperDomainCaches(domain)` — evicts the in-memory scraper page/icons/besticon LRU entries for one domain and drops the corresponding disk discovery files when `SCRAPER_DISK_CACHE` is enabled.
- New dependencies: `better-sqlite3` (synchronous SQLite driver in WAL mode so the API key store is safe across cluster workers writing into the same `/cache/api-keys.sqlite` file) and `decode-ico` (multi-frame ICO decoder retained for legacy code paths; the v1 API no longer selects ICO sources).
- The v1 API cache is **namespaced separately** from the existing provider-based cache (`src/cache.js`): PNGs live at `${API_CACHE_DIR}/{domain}.png` with a sibling `.meta.json` (`{ sourceType, width, height, cachedAt }`) so the two schemes can coexist in `/cache` without key collisions. The existing `CACHE_SIZE_MB` LRU rescan picks up `${API_CACHE_DIR}/...` files alongside the rest of the cache directory, so the global disk-size cap also covers the v1 API output.
- New `fetchScraperAllIcons(domain)` exported from `src/providers.js` is the single source of truth for the merged scraper icon list (besticon + static CDN hints + sized variants, deduped + sorted by area). Backed by an in-memory `LRUCache` (`SCRAPER_ICONS_CACHE_MAX` / `SCRAPER_ICONS_CACHE_TTL`). Consumed by `/{domain}/json` (`endpoints.scraper.icons`); `fetchScraper` uses the same `deriveHintCandidates` helper to enrich its candidate pool before `probeScraperCandidates` so the chosen "best" icon matches the largest entry the UI displays. `probeScraperCandidates` is invoked with `limit=32` in the besticon path so the augmented pool is not truncated at the previous default of 16. `fetchBesticonAllIcons` remains a public export for external callers.
- `discoverManifestUrls`, `loadManifestIconCandidates` and `getScraperMaxIconSize` exported from `src/providers.js`; `fetchScraperPage` now also returns the raw HTTP `Link` header for manifest discovery.
- `fetchScraperAsset` is exported from `src/providers.js`; the asset fetcher is reused by the `/s-asset` route.
- `resolveSelfhstSlugSync` re-exported from `src/serviceAliases.js`.
- `readImageDimensions`, `toDisplayPng` and `looksLikeIco` exported from `src/imageNormalize.js` for ICO-aware probing and browser-safe PNG serving.
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
- Dockerfile, `docker-entrypoint.sh` and `docker-compose.yml` for container deployment, plus a GitHub Actions workflow that publishes images to `ghcr.io/r0gger/favicon-api:latest`.
- `.gitattributes` enforcing LF line endings.

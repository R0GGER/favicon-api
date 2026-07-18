# Getting Started

FaviconAPI is a self-hosted favicon proxy with a browser-based UI that fetches website and service icons from multiple upstream sources (10+), caches results, and exposes them through simple HTTP routes.

---

## Website: [faviconapi.com](https://faviconapi.com)

**Browser tools: [faviconapi.com/#tools](https://faviconapi.com/#tools)**

- **Browser search** - add `/search?q=%s` as a custom search engine (Chrome, Edge, Firefox)
- **Custom URL** - Build a shareable URL with your own preferred provider, fallbacks and minimum icon size. 
- **Bookmarklet** - drag **FaviconAPI Copy** to your bookmarks bar to copy a site's favicon URL

## Source
* Github: [R0GGER/favicon-api](https://github.com/R0GGER/favicon-api)
* FaviconAPI v__VERSION__ - [CHANGELOG](/docs/changelog)

---

## Table of contents

- [Why FaviconAPI?](#why-faviconapi)
- [How it works](#how-it-works)
- [Quick start (Docker)](#quick-start-docker)
- [Routes](#routes)
  - [Favicon providers](#favicon-providers)
  - [Service-icon catalogs](#service-icon-catalogs)
  - [Sizes](#sizes)
- [Custom profile URLs](#custom-profile-urls)
- [API v1](#api-v1)
- [Managing API keys (CLI)](#managing-api-keys-cli)
- [Configuration](#configuration)
- [Performance tuning](/performance-tuning)

---

## Why FaviconAPI?

FaviconAPI started out of a very practical need. While building my own dashboards with [Mafl+ (`R0GGER/maflplus`)](https://github.com/R0GGER/maflplus), I wanted a hassle-free way to fetch favicons and logos and link them to the services on my dashboard - without manually downloading and hosting an image for every single tile.

In practice that turned out to be surprisingly painful. To get decent coverage I always ended up combining **multiple sources**, and time and again I noticed that the "different" tools I was using were really just reaching for the **same underlying providers** behind the scenes - mostly Google and DuckDuckGo. When one of those came back with a blank, low-resolution, or generic placeholder icon, I had no fallback and was stuck.

What I was missing was a single tool that treats favicon lookup as a **first-class problem**: one that knows about many independent sources, queries them together, and intelligently picks the best result instead of betting everything on one upstream. No tool offered that kind of complete, source-aware solution where different providers are connected and complement each other.

So I built it. FaviconAPI brings 10+ favicon providers and four service-icon catalogs together behind one consistent API. It **races providers in parallel**, **normalizes and caches** the results, and returns the highest-quality icon it can find - with the others available as explicit fallbacks. It grew from a helper for my own dashboards into a self-hosted favicon proxy that anyone can run.

---

## How it works

1. **Fetches favicons** from multiple upstream sources (10+) or by scraping a site's HTML.
2. **Races providers in parallel** on `/{domain}` (website favicons) and `/{app-name}` (service icons when the path has no dot).
3. **Caches responses** in memory (LRU) and on disk to reduce upstream load and improve latency.
4. **Normalizes icons** for the v1 JSON API into 128×128 PNG files served from a CDN route.
5. **Looks up service icons** from the [selfh.st icons](https://github.com/selfhst/icons), [homarr dashboard-icons](https://github.com/homarr-labs/dashboard-icons), [LobeHub icons](https://www.npmjs.com/package/@lobehub/icons-static-svg), [SVGL](https://github.com/pheralb/svgl), and [theSVG](https://thesvg.org/) catalogs by service name.
6. **Generates custom profile URLs** that encode a preferred provider, fallbacks, and a minimum size directly in the path — no account or storage required.

> Interactive API docs and a live playground are available at `/api` on a running instance.

---

## Quick start (Docker)

### Docker image:
```bash
docker pull ghcr.io/r0gger/favicon-api:latest
```

### .env
Copy to `.env`, adjust the values, then start the stack:

```yaml
# TCP port the HTTP server listens on. Default = 3000.
PORT=3000

# --- Web UI (homepage) ---
# When true (1/yes/on) or unset, the homepage checkbox "Also include CDN icon
# lookups" is checked by default. Set to false (or 0/no/off) to leave it
# unchecked. Default = true.
UI_INCLUDE_APP_ICONS=true

# Comma-separated favicon / CDN icon cards on the homepage (empty = all).
# UI_FAVICON_PROVIDERS=scraper,google,ddg,yandex,faviconso,vemetric,favicondev,faviconkit,faviconrun,twentyicons,ryanjc,logodev,brandfetch
# UI_APP_ICON_PROVIDERS=selfhst,dashboardicons,lobehub,svgl,thesvg

# URL shown and copied in every favicon card (meta row + click on icon).
# proxy = local proxy URL (default); source = upstream provider URL.
UI_CARD_URL=proxy

# When true (1/yes/on) or unset, the /docs pages and Docs nav link are
# available. Set to false (or 0/no/off) to hide documentation routes and
# remove the Docs link from the Web UI. Default = true.
UI_ENABLE_DOCS=true

# Optional Umami-compatible analytics on /, /api, and /docs. Both vars must be
# set; leave empty to disable (recommended default for self-hosters).
# UI_ANALYTICS_SCRIPT_SRC=https://analytics.example.com/script.js
# UI_ANALYTICS_WEBSITE_ID=your-website-uuid
# Optional: restrict tracking to specific hostnames (Umami data-domains).
# UI_ANALYTICS_DOMAINS=favicon.example.com

# Base directory for on-disk favicon cache files. Default = ./cache (or /cache in Docker).
CACHE_DIR=/cache

# Max number of favicons kept in the in-memory LRU cache. Default = 2000.
MEMORY_CACHE_MAX=2000

# In-memory cache entry lifetime (seconds). Default = 3600 (1 hour).
MEMORY_CACHE_TTL=3600

# On-disk cache entry lifetime (seconds). Default = 86400 (24 hours).
DISK_CACHE_TTL=86400

# Maximum total size of the disk cache in MB. When exceeded, the oldest
# entries (by mtime) are evicted. Set to 0 to disable the size cap (code default). Recommended value: 256.
CACHE_SIZE_MB=256

# Upstream HTTP request timeout (milliseconds). Favicon providers, besticon,
# and scrape targets are aborted after this duration. Default = 5000.
UPSTREAM_TIMEOUT=5000

# Size of Node's libuv thread pool for blocking work (disk I/O, DNS, etc.).
# Node's built-in default is 4; recommended = 16. Must be set before process start.
UV_THREADPOOL_SIZE=16

# Number of cluster workers. Leave empty to default to the number of CPU cores.
WORKERS=

# Number of HTML scraper icon candidates probed in parallel per batch (/scraper/:domain
# and as part of /:domain). Higher = faster on sites with many <link rel="icon">
# entries but more concurrent upstream load. Default = 4.
SCRAPER_PROBE_BATCH_SIZE=4

# Head-start (ms) for the built-in first provider on /:domain when DEFAULT_PROVIDER
# is unset. When DEFAULT_PROVIDER is set, that provider runs exclusively first;
# fallbacks only race after it fails. Default = 150.
PICK_HEAD_START_MS=150

# Optional: enables the logo.dev provider (/logodev/:size/:domain) when set to a valid publishable key.
# Get a key at https://www.logo.dev/
LOGODEV_TOKEN=

# Optional: enables the Brandfetch Logo API provider (/brandfetch/:size/:domain)
# when set to a valid client ID. Register for free at https://developers.brandfetch.com/register
# Docs: https://docs.brandfetch.com/logo-api/overview
BRANDFETCH_CLIENT_ID=

# Optional: set the default (first-tried) provider for /:domain requests.
# If omitted, the built-in fallback order is used (scraper first). Default = scraper.
# Valid values: scraper, google, googlev2, duckduckgo, yandex,
#               faviconso, vemetric, favicondev, faviconkit, faviconrun, twentyicons, ryanjc, logodev,
#               brandfetch, selfhst, dashboardicons, lobehub, svgl, thesvg
# Note: logodev requires LOGODEV_TOKEN; brandfetch requires BRANDFETCH_CLIENT_ID.
DEFAULT_PROVIDER=scraper

# Optional: base URL of a sidecar besticon (https://github.com/mat/besticon)
# instance. When set, /scraper/:domain asks besticon's /allicons.json?url=... for
# icon candidates and falls back to the built-in HTML scraper if besticon is
# unreachable or returns nothing.
#
# Unset (code default): built-in HTML scraper only — the besticon container in
# docker-compose is not used (you can remove that service to save resources).
# Bundled docker-compose stack: set to http://besticon:8080 so the API talks to
# the sidecar on the compose network (must match BESTICON_PORT, default 8080).
BESTICON_URL=http://besticon:8080

# --- besticon sidecar (docker-compose service `besticon` only) ---
# These variables are read by docker-compose.yml for the besticon container.
# They use a BESTICON_ prefix because PORT and CACHE_SIZE_MB also exist for
# maflplus-favicon-api with different values — do not pass env_file: .env
# unfiltered to both services.
# See https://github.com/mat/besticon for upstream option reference.
BESTICON_TZ=Europe/Amsterdam

# Listen address inside the container. Empty = all interfaces.
BESTICON_ADDRESS=

# On-disk cache cap for the besticon process (MB).
BESTICON_CACHE_SIZE_MB=1024

# Restrict which hosts besticon may fetch. "*" = any host.
BESTICON_HOST_ONLY_DOMAINS=*

# Upstream HTTP timeout (Go duration syntax, e.g. 5s).
BESTICON_HTTP_CLIENT_TIMEOUT=5s

# Cache-Control max-age for cached upstream responses (e.g. 720h).
BESTICON_HTTP_MAX_AGE_DURATION=720h

# Custom User-Agent for upstream requests. Empty = besticon default.
BESTICON_HTTP_USER_AGENT=

# TCP port besticon listens on inside the container (compose network).
BESTICON_PORT=8080

# redirect = return 302 to upstream icon URL; all = proxy bytes through besticon.
BESTICON_SERVER_MODE=redirect

# Optional: in-memory cache for the enriched scraper icons list returned by
# /:domain/json. Each entry holds the merged besticon + static-hint + variant
# probe result for one domain. Avoids reprobing 8+ candidate URLs on every
# page load of the UI's size-button strip. Default = 3600 (seconds).
SCRAPER_ICONS_CACHE_TTL=3600

# Max number of domains whose icon lists are kept in that scraper-icons cache
# (LRU). When full, the least recently used domain entry is evicted. Default = 500.
SCRAPER_ICONS_CACHE_MAX=500

# When true (1/yes/on), also persist scraper discovery data on disk under
# SCRAPER_DISK_CACHE_DIR: homepage HTML, icon lists, besticon JSON, manifest
# parses and icon-probe metadata. Survives container restarts and is shared
# across cluster workers. Uses SCRAPER_ICONS_CACHE_TTL for entry lifetime.
# Default = true (also persist on disk). Set to false for in-memory only.
SCRAPER_DISK_CACHE=true

# Directory for scraper discovery disk cache. Default = {CACHE_DIR}/scraper-discovery
# (e.g. /cache/scraper-discovery in Docker). Only used when SCRAPER_DISK_CACHE=true.
# SCRAPER_DISK_CACHE_DIR=/cache/scraper-discovery

# How many candidate web-manifest URLs the HTML scraper may fetch per domain
# when the homepage does not expose a working <link rel="manifest">. The scraper
# builds an ordered list (HTML hints, Link headers, /manifest.json-style paths,
# STATIC_MANIFEST_HINTS, etc.) and tries them one by one until a manifest
# returns icons — then it stops. Raise this when sites hide manifests in
# uncommon locations; lower it to cap upstream requests and latency. Default = 12.
MANIFEST_PROBE_MAX=12

# Max width/height (px) for images returned by GET /scraper/:domain only. The scraper
# still picks the largest source icon; if that image exceeds this limit it is
# downscaled with "contain" and re-encoded as PNG before caching/sending.
# Does not change /:domain/json — the UI size strip still lists every variant
# at full resolution (via /s-asset or upstream URLs). Set to 0 to disable the
# cap and serve native resolution (default). Example: 128 keeps /scraper/ responses
# small for dashboards while the JSON API still exposes larger sources.
SCRAPER_MAX_ICON_SIZE=128

# When true, the scraper prefers curated service-icon catalogs over direct
# HTML scraping for domains that map to a known service slug (e.g.
# facebook.com → "facebook" in selfh.st/icons or dashboardicons.com). Catalog
# icons are typically higher resolution and visually consistent. When the
# domain has no slug or no catalog match, normal scraping runs as before. If
# scraping also fails, Google faviconV2 is tried as a universal last resort.
# The result is still subject to SCRAPER_MAX_ICON_SIZE and cached under the
# same scraper cache key. X-Favicon-Source reports the actual source (e.g.
# scraper-fallback:selfhst, scraper-fallback:googlev2). Default = true.
SCRAPER_FALLBACK=true

# --- FaviconAPIs-style v1 API (GET /api/v1/favicon) ---
# Path to the SQLite file that stores hashed API keys and per-key monthly
# usage counters. Place it inside the same volume as CACHE_DIR so cluster
# workers and restarts share state.
API_KEYS_DB=/cache/api-keys.sqlite

# Directory where the normalized 128x128 PNGs returned by /api/v1/favicon
# are written. Served back over /cdn/favicons/{domain}.png. Default = /cache/api.
API_CACHE_DIR=/cache/api

# How long a generated PNG counts as "cached" (seconds). Default = 604800 (7 days),
# matching FaviconAPIs.com. Also used as Cache-Control max-age on the CDN route.
API_CACHE_TTL=604800

# When set to "false" (or 0/no/off), /api/v1/favicon becomes a public endpoint:
# no Authorization header or ?key= is required, and per-key monthly quotas are
# not enforced. Useful for self-hosted deployments behind your own auth layer
# or for fully open APIs. Default = true.
# A provided key is silently ignored when this is false (it is not
# validated and its usage counter is not incremented).
API_REQUIRE_KEY=false

# Monthly call quotas per plan. 0 = unlimited. Defaults mirror
# FaviconAPIs.com's published Free/Pro/Enterprise tiers. Only applied
# when API_REQUIRE_KEY=true.
PLAN_FREE_LIMIT=25
PLAN_PRO_LIMIT=2500
PLAN_ENTERPRISE_LIMIT=0
```

### docker-compose.yml`

```yaml
services:
  favicon-api:
    #build: .
    image: ghcr.io/r0gger/favicon-api:latest
    container_name: favicon-api
    restart: unless-stopped
    ports:
      - "3100:3000"
    volumes:
      - favicon-cache:/cache
    env_file: .env
    depends_on:
      besticon:
        condition: service_healthy
    networks:
      - besticon

  besticon:
    image: matthiasluedtke/iconserver:latest
    container_name: besticon
    restart: unless-stopped
    environment:
      TZ: ${BESTICON_TZ:-Europe/Amsterdam}
      ADDRESS: ${BESTICON_ADDRESS:-}
      CACHE_SIZE_MB: ${BESTICON_CACHE_SIZE_MB:-1024}
      HOST_ONLY_DOMAINS: ${BESTICON_HOST_ONLY_DOMAINS:-*}
      HTTP_CLIENT_TIMEOUT: ${BESTICON_HTTP_CLIENT_TIMEOUT:-5s}
      HTTP_MAX_AGE_DURATION: ${BESTICON_HTTP_MAX_AGE_DURATION:-720h}
      HTTP_USER_AGENT: ${BESTICON_HTTP_USER_AGENT:-}
      PORT: ${BESTICON_PORT:-8080}
      SERVER_MODE: ${BESTICON_SERVER_MODE:-redirect}
    healthcheck:
      test:
        - CMD
        - wget
        - --quiet
        - --tries=1
        - --spider
        - http://localhost:8080/up
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    networks:
      - besticon

networks:
  besticon:
    name: besticon
    driver: bridge

volumes:
  favicon-cache:
```

```bash
docker compose up -d
```

**Notes**

- **besticon** has no `ports:` mapping — only `maflplus-favicon-api` can reach it on `http://besticon:8080`. Set `BESTICON_URL=http://besticon:8080` in `.env`.
- **Without besticon:** remove the `besticon` service, `depends_on`, `networks`, and `BESTICON_URL`. The built-in HTML scraper is used instead.
- **Host cache path:** use `- /path/to/cache:/cache` instead of the named volume; run `chown 100:101 /path/to/cache` and `chmod 755 /path/to/cache` so the container user can write.

---

## Routes

Domain providers use `/{provider}/{size}/{ext}/{domain}` (e.g. `/google/128/png/github.com`). Catalog providers use `/{provider}/{size}/{format}/{service}` — SVG with size **`0`** (e.g. `/svgl/0/svg/github`). Legacy three-segment routes and short aliases (`/g/`, `/d/`, `/sh/`, …) remain valid.

```
/{provider}/{size}/{domain}          # legacy; PNG assumed
/{provider}/{size}/{ext}/{domain}    # canonical for domain providers
```

Providers without a native upstream size accept the size segment and are resized server-side.

**Quick examples**

```
https://your-host/github.com
https://your-host/scraper/github.com
https://your-host/google/64/png/github.com
https://your-host/selfhst/128/png/jellyfin
https://your-host/svgl/0/svg/github
https://your-host/thesvg/0/svg/github
```

Full endpoint list, JSON discovery, and caching headers: [API reference](api-reference.md).

### Favicon providers

All providers run in parallel on `/{domain}`; each also has its own route.


| Provider                                                                            | Route                         | Alias  | Notes                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------- | ----------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTML scraper                                                                        | `/scraper/{size}/{domain}`    | `/s/`  | `/scraper/{domain}` serves the largest available icon; parses `<link rel="icon">`, manifest, and fallbacks; optional [besticon](https://github.com/mat/besticon) sidecar via `BESTICON_URL` |
| [Google](https://www.google.com/s2/favicons)                                        | `/google/{size}/{domain}`     | `/g/`  | Sizes 16, 32, 64, 128                                                                                                                                                                       |
| [Google v2](https://developers.google.com/search/faviconapi/appearance/favicon-in-search) | `/googlev2/{size}/{domain}`   | `/g2/` | `faviconV2`; sizes 16, 32, 64, 128, 180, 256                                                                                                                                                |
| [DuckDuckGo](https://icons.duckduckgo.com/)                                         | `/duckduckgo/{size}/{domain}` | `/d/`  | Resized server-side                                                                                                                                                                         |
| [Yandex](https://favicon.yandex.net/)                                               | `/yandex/{size}/{domain}`     | `/y/`  | Resized server-side                                                                                                                                                                         |
| [Favicon.so](https://favicon.so/)                                                   | `/faviconso/{size}/{domain}`  | `/f/`  | Resized server-side                                                                                                                                                                         |
| [Vemetric](https://favicon.vemetric.com/)                                           | `/vemetric/{size}/{domain}`   | `/v/`  | `?format=webp`, `png`, or `jpg`; or `/{size}/{ext}/` in path |
| [Favicon Extractor](https://www.faviconextractor.com/)                              | `/favicondev/{size}/{domain}` | `/p/`  | Resized server-side                                                                                                                                                                         |
| [Faviconkit](https://faviconkit.net/)                                               | `/faviconkit/{size}/{domain}` | `/k/`  | Sizes 16, 32, 64, 128, 256                                                                                                                                                                  |
| [Favicon.run](https://favicon.run/)                                                 | `/faviconrun/{size}/{domain}` | `/fr/` | Sizes 16, 32, 64, 128, 256                                                                                                                                                                  |
| [twenty-icons.com](https://twenty-icons.com/)                                       | `/twentyicons/{size}/{domain}` | `/ti/` | Sizes 16, 32, 64, 128, 180, 192                                                                                                                                                             |
| [favicon.ryanjc.com](https://api.favicon.ryanjc.com/)                               | `/ryanjc/{size}/{domain}`     | `/rj/` | Resized server-side                                                                                                                                                                         |
| [logo.dev](https://www.logo.dev/)                                                   | `/logodev/{size}/{domain}`    | `/l/`  | Requires `LOGODEV_TOKEN`; resized server-side                                                                                                                                               |
| [Brandfetch](https://brandfetch.com/developers/logo-api)                            | `/brandfetch/{size}/{ext}/{domain}` | `/bf/` | Requires `BRANDFETCH_CLIENT_ID`; canonical SVG route uses size **0** (e.g. `/brandfetch/0/svg/github.com`); raster sizes 16–512 for `png`/`webp`/`jpg` in the path; auto-fallback **svg → png → webp** when format is not pinned in the path; `?type=icon\|symbol\|logo&theme=light\|dark`; legacy `/brandfetch/{size}/{domain}` still works |


### App/Service-icon catalogs

Look up an icon by app/service name (e.g. `jellyfin`). All support `?variant=color\|light\|dark` where applicable.


| Catalog                                                           | Route                              | Alias  |
| ----------------------------------------------------------------- | ---------------------------------- | ------ |
| [selfhst icons](https://github.com/selfhst/icons)                 | `/selfhst/{size}/{service}`        | `/sh/` |
| [Dashboard Icons](https://github.com/homarr-labs/dashboard-icons) | `/dashboardicons/{size}/{service}` | `/di/` |
| [LobeHub icons](https://github.com/lobehub/lobe-icons)            | `/lobehub/{size}/{service}`        | `/lb/` |
| [SVGL](https://github.com/pheralb/svgl)                           | `/svgl/{size}/{service}`           | `/sv/` |
| [theSVG](https://thesvg.org/)                                     | `/thesvg/{size}/{service}`         | `/ts/` |


### Sizes

- **128×128 is the site default** — the Web UI, service-icon catalogs, LobeHub, SVGL, theSVG, and the API v1 CDN all standardize on **128** when no size is specified. It sits in the middle of the supported range: large enough to stay sharp on dashboards, bookmark tiles, and password-manager entries (including on retina displays when shown smaller), yet small enough to keep responses fast and cache-friendly. **128** is also a safe minimum icon size when you need a guaranteed baseline that most providers can satisfy without upscaling a tiny source into a blurry icon.
- **Resized server-side** providers and catalogs accept sizes **16, 32, 64, 128, 256**.
- **Brandfetch** SVG routes use size **0** in the path; raster routes use native upstream sizes **16, 32, 64, 128, 256, 512** (via Brandfetch's `/h/{size}/w/{size}/icon.png` path).
- **LobeHub**, **SVGL**, and **theSVG** use sizes **64, 128, 256** (default **128**).
- A few resize-only domain providers (DuckDuckGo, Yandex, Favicon.so, Favicon Extractor) default their sizeless proxy URLs to **64** instead — their upstream icons are often small, and 64 avoids serving an upscaled, soft image when you omit the size segment.
- Legacy short aliases also accept the original sizeless form (e.g. `/sh/{service}`, `/d/{domain}`).

### Utility routes


| Endpoint                     | Description                                            |
| ---------------------------- | ------------------------------------------------------ |
| `/{domain}`                  | Best favicon (parallel provider race)                  |
| `/{id}/{domain-or-appname}`  | Custom profile favicon |
| `/{domain}/json`             | JSON list of all endpoint URLs for a domain            |
| `/api/v1/favicon?url=`       | FaviconAPI-compatible JSON API — see [API v1](#api-v1) |
| `/cdn/favicons/{domain}.png` | Public CDN route for cached API v1 PNGs                |
| `/providers`                 | JSON: which optional providers are enabled             |
| `/services/resolve/{service}` | JSON: per-catalog slug matches for a service name     |
| `/search?q=`                 | Custom search engine redirect to the homepage          |


#### Scraper cache bypass

```
https://your-host/scraper/{domain}?refresh=1
```

Forces a fresh scrape by clearing the cached scraper entry (memory and disk) before fetching again. Use when a site changed its favicon, after scraper fixes, or when debugging stale results. `?nocache=1` is an alias for `?refresh=1`.

---

## Custom profile URLs

Build a shareable URL that pins your own **preferred provider**, an ordered list of up to **four fallbacks**, and a **minimum icon size** — without an account or any server-side storage:

```
https://your-host/{id}/{domain-or-appname}
```

The `{id}` is a URL-safe (base64url) string that *encodes* the whole configuration; there is no database. Generate one from **Tools → Build custom URL** on the homepage, then append any domain (`github.com`) or app name (`immich`).

**How the icon is resolved**

The chain `[preferred, ...fallbacks]` is tried in order and the first usable icon wins:

- A provider that returns an **SVG** satisfies any minimum (vector) and is served as-is (`image/svg+xml`).
- A provider that returns a **raster** icon must have a source whose smaller side is **≥** the minimum size; it is then served as PNG at **exactly** that size.
- If a provider returns nothing usable or a raster below the minimum, the next fallback is tried. If the whole chain fails, a transparent placeholder is returned with `404`.

**Encoding**

The id is the base64url of a compact JSON array — keep this contract identical on both ends:

```js
// [version, preferredProvider, [fallbacks...], minSize]
[1, "scraper", ["googlev2", "duckduckgo"], 128]
```

Providers are any from the [favicon providers](#favicon-providers) / [catalogs](#appservice-icon-catalogs) tables; minimum sizes are `16, 32, 64, 128`. `logodev`/`brandfetch` only resolve when their credentials are configured (otherwise that step is skipped). Domain-only providers (scraper, raster providers, brandfetch) are skipped for app-name targets.

---

## API v1

`GET /api/v1/favicon?url=<website>` returns JSON (not image bytes) with a CDN URL to a normalized **128×128** PNG, a `sourceType`, and cache metadata. Clients fetch the image from the returned `url` via `/cdn/favicons/{domain}.png`.

### Authentication

When `API_REQUIRE_KEY=true` (default), pass the key as a Bearer header or `?key=`:

```bash
curl "https://your-host/api/v1/favicon?url=https://github.com" \
  -H "Authorization: Bearer fa_your_key_here"
```

```bash
curl "https://your-host/api/v1/favicon?url=https://github.com&key=fa_your_key_here"
```

On Windows PowerShell, use `curl.exe` or:

```powershell
Invoke-RestMethod "https://your-host/api/v1/favicon?url=https://github.com" `
  -Headers @{ Authorization = "Bearer fa_your_key_here" }
```

Set `API_REQUIRE_KEY=false` for a fully public endpoint (no key, no quotas).

### Response

```json
{
  "url":        "https://your-host/cdn/favicons/github.com.png",
  "domain":     "github.com",
  "width":      128,
  "height":     128,
  "format":     "png",
  "sourceType": "svg",
  "cached":     true,
  "cachedAt":   "2026-06-20T08:00:00.000Z"
}
```

### Errors


| Status | Code                                            | Meaning                                                           |
| ------ | ----------------------------------------------- | ----------------------------------------------------------------- |
| 400    | `missing_url` / `invalid_url`                   | Missing or invalid `url` parameter                                |
| 401    | `missing_api_key` / `invalid_api_key`           | No key, or key not recognised / revoked                           |
| 422    | `favicon_not_found` / `favicon_not_processable` | No usable icon, or decode failed                                  |
| 429    | `quota_exceeded`                                | Monthly quota reached (`plan`, `limit`, `used`, `period` in body) |
| 500    | `internal_error`                                | Internal error                                                    |


Only `200` responses count toward the monthly quota. Quotas reset each calendar month (UTC).

Full reference — source priority, CDN route, plans, PowerShell notes: [API v1](/api-v1.md).

---

## Managing API keys (CLI)

Keys are stored in SQLite at `API_KEYS_DB` (default `/cache/api-keys.sqlite` on the cache volume). Only the SHA-256 hash is persisted; the raw key is shown once at creation.

Run the commands inside the running container so the CLI uses the same database as the server:

```bash
# Create a key (raw key printed once)
docker compose exec maflplus-favicon-api npm run keys:create -- --label "customer A" --plan pro

# List active keys with this month's usage
docker compose exec maflplus-favicon-api npm run keys:list

# Include revoked keys
docker compose exec maflplus-favicon-api npm run keys:list -- --all

# Revoke (stops validating immediately; row kept for audit)
docker compose exec maflplus-favicon-api npm run keys:revoke -- --prefix fa_abcdefgh

# Permanently delete key and usage history
docker compose exec maflplus-favicon-api npm run keys:delete -- --prefix fa_abcdefgh
```

Plans: `free`, `pro`, `enterprise`. Monthly limits are set via `PLAN_*_LIMIT` env vars. Outside Docker, the same commands work via `npm run keys:create`, `keys:list`, `keys:revoke`, and `keys:delete`.

See also [API v1 — Managing API keys](/api-v1.md).

---

## Configuration

All settings are documented in [.env](#env). Copy it to `.env` and pass it via `env_file: .env` in Compose (or set `environment:` entries manually).

The tables below cover the most-used variables. For the complete list — including `UI_CARD_URL`, `UI_INCLUDE_APP_ICONS`, `SCRAPER_FALLBACK`, and tuning notes — see [Configuration](/configuration.md).

### Server & cache


| Variable             | Default                        | Description                                                                                                      |
| -------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `PORT`               | `3000`                         | TCP port the HTTP server listens on.                                                                             |
| `CACHE_DIR`          | `./cache` (`/cache` in Docker) | Base directory for on-disk favicon cache files.                                                                  |
| `MEMORY_CACHE_MAX`   | `2000`                         | Max favicons in the per-worker in-memory LRU cache.                                                              |
| `MEMORY_CACHE_TTL`   | `3600`                         | In-memory cache entry lifetime (seconds).                                                                        |
| `DISK_CACHE_TTL`     | `86400`                        | On-disk cache entry lifetime (seconds).                                                                          |
| `CACHE_SIZE_MB`      | `0`                            | Max total disk cache size (MB). Oldest entries are evicted when exceeded. `0` = no size cap (TTL eviction only). |
| `UPSTREAM_TIMEOUT`   | `5000`                         | Upstream HTTP timeout (ms) for providers, besticon, and scrape targets.                                          |
| `UV_THREADPOOL_SIZE` | `16`                           | Node libuv thread pool size for disk I/O, DNS, etc. Must be set before process start.                            |
| `WORKERS`            | CPU core count                 | Number of cluster workers. Set explicitly in Docker when CPU is limited. `1` disables clustering.                |


### Providers & scraper


| Variable                   | Default                         | Description                                                                                                                                                                                                                                                                          |
| -------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DEFAULT_PROVIDER`         | `scraper`                       | Preferred provider for `/{domain}`. When set, it runs exclusively first; fallbacks only race after it fails. Values: `scraper`, `google`, `googlev2`, `duckduckgo`, `yandex`, `faviconso`, `vemetric`, `favicondev`, `faviconkit`, `faviconrun`, `twentyicons`, `ryanjc`, `logodev`, `brandfetch`, `selfhst`, `dashboardicons`, `lobehub`, `svgl`, `thesvg`. `logodev` requires `LOGODEV_TOKEN`; `brandfetch` requires `BRANDFETCH_CLIENT_ID`. |
| `PICK_HEAD_START_MS`       | `150`                           | Head-start (ms) for the built-in first provider on `/{domain}` when `DEFAULT_PROVIDER` is unset.                                                                                                                                                                                                  |
| `LOGODEV_TOKEN`            | *(unset)*                       | [logo.dev](https://www.logo.dev/) publishable key. Enables `/logodev/{size}/{domain}`; without it the route returns 503.                                                                                                                                                             |
| `BRANDFETCH_CLIENT_ID`     | *(unset)*                       | [Brandfetch](https://docs.brandfetch.com/logo-api/overview) Logo API client ID. Enables `/brandfetch/{size}/{ext}/{domain}`; without it the route returns 503.                                                                                                                             |
| `BESTICON_URL`             | *(unset)*                       | Base URL of a sidecar [besticon](https://github.com/mat/besticon) instance (e.g. `http://besticon:8080`). `/scraper/{domain}` asks besticon first, then falls back to the built-in scraper.                                                                                          |
| `SCRAPER_PROBE_BATCH_SIZE` | `4`                             | HTML scraper icon candidates probed in parallel per batch (`/scraper/{domain}` and `/{domain}`).                                                                                                                                                                                     |
| `SCRAPER_ICONS_CACHE_TTL`  | `3600`                          | TTL (seconds) for the in-memory cache of enriched scraper icon lists (`/{domain}/json`). Also used for scraper discovery disk cache entries when `SCRAPER_DISK_CACHE` is enabled.                                                                                                    |
| `SCRAPER_ICONS_CACHE_MAX`  | `500`                           | Max domains in that scraper-icons LRU cache.                                                                                                                                                                                                                                         |
| `SCRAPER_DISK_CACHE`       | `false`                         | When `true`, persist scraper discovery (HTML, icon lists, besticon JSON, manifests, probes) under `{CACHE_DIR}/scraper-discovery`. Survives restarts; shared across workers.                                                                                                         |
| `SCRAPER_DISK_CACHE_DIR`   | `{CACHE_DIR}/scraper-discovery` | Directory for that discovery cache. Only used when `SCRAPER_DISK_CACHE=true`.                                                                                                                                                                                                        |
| `MANIFEST_PROBE_MAX`       | `12`                            | Max manifest URLs to probe per domain when HTML does not link one directly.                                                                                                                                                                                                          |
| `SCRAPER_MAX_ICON_SIZE`    | `0`                             | Max output dimension for `/scraper/{domain}`. Larger sources are downscaled; `0` = native resolution.                                                                                                                                                                                |


### API v1 & quotas


| Variable                | Default                  | Description                                                                                                         |
| ----------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `API_KEYS_DB`           | `/cache/api-keys.sqlite` | SQLite file for hashed API keys and monthly usage counters. Keep on the same volume as `CACHE_DIR`.                 |
| `API_CACHE_DIR`         | `/cache/api`             | Directory for normalized 128×128 PNGs from `/api/v1/favicon`. Served via `/cdn/favicons/{domain}.png`.              |
| `API_CACHE_TTL`         | `604800`                 | How long a generated PNG counts as cached (seconds, 7 days). Also used as `Cache-Control` max-age on the CDN route. |
| `API_REQUIRE_KEY`       | `true`                   | `false` makes `/api/v1/favicon` public: no key required, quotas not enforced. A provided key is silently ignored.   |
| `PLAN_FREE_LIMIT`       | `25`                     | Monthly call quota for `free` plan keys. `0` = unlimited.                                                           |
| `PLAN_PRO_LIMIT`        | `2500`                   | Monthly call quota for `pro` plan keys. `0` = unlimited.                                                            |
| `PLAN_ENTERPRISE_LIMIT` | `0`                      | Monthly call quota for `enterprise` plan keys. `0` = unlimited.                                                     |


---

## Performance tuning and Tweaks

See [Performance tuning](https://faviconapi.com/docs/tweaks) for cache TTL recommendations, scraper latency, and worker sizing.

---


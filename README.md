# FaviconAPI

FaviconAPI is a self-hosted favicon proxy with a browser-based UI that fetches website and service icons from multiple upstream sources (10+), caches results, and exposes them through simple HTTP routes.

---

**Live demo: [faviconapi.com](https://faviconapi.com)**

---

**Browser tools: [faviconapi.com/#tools](https://faviconapi.com/#tools)**

- **Browser search** - add `/search?q=%s` as a custom search engine (Chrome, Edge, Firefox)
- **Bookmarklet** - drag **FaviconAPI Copy** to your bookmarks bar to copy a site's favicon URL

---

## Table of contents

- [Why FaviconAPI?](#why-faviconapi)
- [How it works](#how-it-works)
- [Fallback chain & source order](docs/fallback-chain.md)
- [Quick start (Docker)](#quick-start-docker)
- [Routes](#routes)
  - [Favicon providers](#favicon-providers)
  - [Service-icon catalogs](#service-icon-catalogs)
  - [Sizes](#sizes)
- [API v1](#api-v1)
  - [Authentication](#authentication)
  - [Response](#response)
  - [Errors](#errors)
- [Managing API keys (CLI)](#managing-api-keys-cli)
- [Configuration](#configuration)
- [Performance tuning](#performance-tuning)

---

## Why FaviconAPI?

FaviconAPI started out of a very practical need. While building my own dashboards with [Mafl+ (](https://github.com/R0GGER/maflplus)`R0GGER/maflplus`[)](https://github.com/R0GGER/maflplus), I wanted a simple, low-friction way to fetch favicons and logos and link them to the services on my dashboard - without manually downloading and hosting an image for every single tile.

In practice that turned out to be surprisingly painful. To get decent coverage I always ended up combining **multiple sources**, and time and again I noticed that the "different" tools I was using were really just reaching for the **same underlying providers** behind the scenes - mostly Google and DuckDuckGo. When one of those came back with a blank, low-resolution, or generic placeholder icon, I had no fallback and was stuck.

What I was missing was a single tool that treats favicon lookup as a **first-class problem**: one that knows about many independent sources, queries them together, and intelligently picks the best result instead of betting everything on one upstream. No tool offered that kind of complete, source-aware solution where different providers are connected and complement each other.

So I built it. FaviconAPI brings 10+ favicon providers and four service-icon catalogs together behind one consistent API. It **races providers in parallel**, **normalizes and caches** the results, and returns the highest-quality icon it can find - with the others available as explicit fallbacks. It grew from a helper for my own dashboards into a self-hosted favicon proxy that anyone can run.

---

## How it works

1. **Fetches favicons** from multiple upstream sources (10+) or by scraping a site's HTML.
2. **Races providers in parallel** on `/{domain}` (website favicons) and `/{app-name}` (service icons when the path has no dot).
3. **Caches responses** in memory (LRU) and on disk to reduce upstream load and improve latency.
4. **Normalizes icons** for the v1 JSON API into 128×128 PNG files served from a CDN route.
5. **Looks up service icons** from the [selfh.st icons](https://github.com/selfhst/icons), [homarr dashboard-icons](https://github.com/homarr-labs/dashboard-icons), [LobeHub icons](https://www.npmjs.com/package/@lobehub/icons-static-svg), and [SVGL](https://github.com/pheralb/svgl) catalogs by service name.

> Interactive API docs and a live playground are available at `/api` on a running instance.

For the exact provider order, head-start logic, and the scraper's strictly-ordered fallback steps, see [docs/fallback-chain.md](docs/fallback-chain.md).

---

## Quick start (Docker)

Copy [.env.example](.env.example) to `.env`, adjust the values, then start the stack:

```bash
docker compose up -d
```

**Example** `docker-compose.yml`

```yaml
services:
  maflplus-favicon-api:
    #build: .
    image: ghcr.io/r0gger/maflplus-favicon-api:latest
    container_name: maflplus-favicon-api
    restart: unless-stopped
    ports:
      - "3100:3000"
    volumes:
      - favicon-cache:/cache
    env_file: .env.example
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

**Notes**

- **besticon** has no `ports:` mapping — only `maflplus-favicon-api` can reach it on `http://besticon:8080`. Set `BESTICON_URL=http://besticon:8080` in `.env`.
- **Without besticon:** remove the `besticon` service, `depends_on`, `networks`, and `BESTICON_URL`. The built-in HTML scraper is used instead.
- **Host cache path:** use `- /path/to/cache:/cache` instead of the named volume; run `chown 100:101 /path/to/cache` and `chmod 755 /path/to/cache` so the container user can write.

---

## Routes

Every provider route follows one uniform scheme:

```
/{provider}/{size}/{domain}
```

The short single-letter routes from earlier versions are kept as aliases. Providers without a native upstream size accept the size segment and are resized server-side.

**Quick examples**

```
https://your-host/github.com
https://your-host/scraper/github.com
https://your-host/google/64/github.com
https://your-host/selfhst/128/jellyfin
https://your-host/svgl/128/reddit
```

### Favicon providers

All providers run in parallel on `/{domain}`; each also has its own route.


| Provider                                                                            | Route                         | Alias  | Notes                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------- | ----------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTML scraper                                                                        | `/scraper/{size}/{domain}`    | `/s/`  | `/scraper/{domain}` serves the largest available icon; parses `<link rel="icon">`, manifest, and fallbacks; optional [besticon](https://github.com/mat/besticon) sidecar via `BESTICON_URL` |
| [Google](https://www.google.com/s2/favicons)                                        | `/google/{size}/{domain}`     | `/g/`  | Sizes 16, 32, 64, 128                                                                                                                                                                       |
| [Google v2](https://developers.google.com/search/docs/appearance/favicon-in-search) | `/googlev2/{size}/{domain}`   | `/g2/` | `faviconV2`; sizes 16, 32, 64, 128, 180, 256                                                                                                                                                |
| [DuckDuckGo](https://icons.duckduckgo.com/)                                         | `/duckduckgo/{size}/{domain}` | `/d/`  | Resized server-side                                                                                                                                                                         |
| [Yandex](https://favicon.yandex.net/)                                               | `/yandex/{size}/{domain}`     | `/y/`  | Resized server-side                                                                                                                                                                         |
| [Favicon.so](https://favicon.so/)                                                   | `/faviconso/{size}/{domain}`  | `/f/`  | Resized server-side                                                                                                                                                                         |
| [Vemetric](https://favicon.vemetric.com/)                                           | `/vemetric/{size}/{domain}`   | `/v/`  | `?format=png                                                                                                                                                                                |
| [Favicon Extractor](https://www.faviconextractor.com/)                              | `/favicondev/{size}/{domain}` | `/p/`  | Resized server-side                                                                                                                                                                         |
| [Faviconkit](https://faviconkit.net/)                                               | `/faviconkit/{size}/{domain}` | `/k/`  | Sizes 16, 32, 64, 128, 256                                                                                                                                                                  |
| [Favicon.run](https://favicon.run/)                                                 | `/faviconrun/{size}/{domain}` | `/fr/` | Sizes 16, 32, 64, 128, 256                                                                                                                                                                  |
| [logo.dev](https://www.logo.dev/)                                                   | `/logodev/{size}/{domain}`    | `/l/`  | Requires `LOGODEV_TOKEN`; resized server-side                                                                                                                                               |
| [Brandfetch](https://brandfetch.com/developers/logo-api)                            | `/brandfetch/{size}/{domain}` | `/bf/` | Requires `BRANDFETCH_CLIENT_ID`; SVG default (transparent, fixed proxy path, no size buttons in UI); raster sizes 16–512 for PNG/WebP fallback (`?format=png`); auto-fallback **svg → png → webp**; `?type=icon\|symbol\|logo&theme=light\|dark`; `fallback/404` |


### App/Service-icon catalogs

Look up an icon by app/service name (e.g. `jellyfin`). All support `?variant=color\|light\|dark` where applicable.


| Catalog                                                           | Route                              | Alias  |
| ----------------------------------------------------------------- | ---------------------------------- | ------ |
| [selfhst icons](https://github.com/selfhst/icons)                 | `/selfhst/{size}/{service}`        | `/sh/` |
| [Dashboard Icons](https://github.com/homarr-labs/dashboard-icons) | `/dashboardicons/{size}/{service}` | `/di/` |
| [LobeHub icons](https://github.com/lobehub/lobe-icons)            | `/lobehub/{size}/{service}`        | `/lb/` |
| [SVGL](https://github.com/pheralb/svgl)                           | `/svgl/{size}/{service}`           | `/sv/` |


### Sizes

- **Resized server-side** providers and catalogs accept sizes **16, 32, 64, 128, 256**.
- **Brandfetch** uses native upstream sizes **16, 32, 64, 128, 256, 512** (via Brandfetch's `/h/{size}/w/{size}/icon.png` path).
- **LobeHub** and **SVGL** use sizes **64, 128, 256**.
- Legacy short aliases also accept the original sizeless form (e.g. `/sh/{service}`, `/d/{domain}`).

### Utility routes


| Endpoint                     | Description                                            |
| ---------------------------- | ------------------------------------------------------ |
| `/{domain}`                  | Best favicon (parallel provider race)                  |
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

## API v1

`GET /api/v1/favicon?url=<website>` returns JSON (not image bytes) with a CDN URL to a normalized 256×256 PNG, a `sourceType` (`svg` > `manifest` > `apple-touch-icon` > `png` > `ico`), and cache metadata. Clients fetch the image from the returned `url` via `/cdn/favicons/{domain}.png`.

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
  "width":      256,
  "height":     256,
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

---

## Configuration

All settings are documented in `[.env.example](.env.example)`. Copy it to `.env` and pass it via `env_file: .env` in Compose (or set `environment:` entries manually).

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
| `DEFAULT_PROVIDER`         | `scraper`                       | Preferred provider for `/{domain}` (gets the head-start). Values: `scraper`, `google`, `googlev2`, `duckduckgo`, `yandex`, `faviconso`, `vemetric`, `favicondev`, `faviconkit`, `faviconrun`, `logodev`, `brandfetch`, `selfhst`, `dashboardicons`, `lobehub`, `svgl`. `logodev` requires `LOGODEV_TOKEN`; `brandfetch` requires `BRANDFETCH_CLIENT_ID`. |
| `PICK_HEAD_START_MS`       | `150`                           | Head-start (ms) for `DEFAULT_PROVIDER` on `/{domain}` before other providers start.                                                                                                                                                                                                  |
| `LOGODEV_TOKEN`            | *(unset)*                       | [logo.dev](https://www.logo.dev/) publishable key. Enables `/logodev/{size}/{domain}`; without it the route returns 503.                                                                                                                                                             |
| `BRANDFETCH_CLIENT_ID`     | *(unset)*                       | [Brandfetch](https://docs.brandfetch.com/logo-api/overview) Logo API client ID. Enables `/brandfetch/{size}/{domain}`; without it the route returns 503.                                                                                                                             |
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
| `API_CACHE_DIR`         | `/cache/api`             | Directory for normalized 256×256 PNGs from `/api/v1/favicon`. Served via `/cdn/favicons/{domain}.png`.              |
| `API_CACHE_TTL`         | `604800`                 | How long a generated PNG counts as cached (seconds, 7 days). Also used as `Cache-Control` max-age on the CDN route. |
| `API_REQUIRE_KEY`       | `true`                   | `false` makes `/api/v1/favicon` public: no key required, quotas not enforced. A provided key is silently ignored.   |
| `PLAN_FREE_LIMIT`       | `25`                     | Monthly call quota for `free` plan keys. `0` = unlimited.                                                           |
| `PLAN_PRO_LIMIT`        | `2500`                   | Monthly call quota for `pro` plan keys. `0` = unlimited.                                                            |
| `PLAN_ENTERPRISE_LIMIT` | `0`                      | Monthly call quota for `enterprise` plan keys. `0` = unlimited.                                                     |


---

## Performance tuning

Wiki — soon

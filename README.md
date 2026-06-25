# FaviconAPI

FaviconAPI is a self-hosted favicon proxy with a browser-based UI that fetches website and service icons from multiple upstream sources (10+), caches results, and exposes them through simple HTTP routes.

Live demo: [faviconapi.com](https://faviconapi.com) 

Browser tools: [faviconapi.com/#tools](https://faviconapi.com/#tools)

- **Browser search** - add `/search?q=%s` as a custom search engine (Chrome, Edge, Firefox)
- **Bookmarklet** - drag **FaviconAPI Copy** to your bookmarks bar to copy a site's favicon URL

## What it does

1. **Fetches favicons** - from third-party providers (Google, DuckDuckGo, Yandex, and others) or by scraping a site's HTML.
2. **Races providers in parallel** - on `/{domain}` (website favicons) and `/{app-name}` (service icons when the path has no dot).
3. **Caches responses** - in memory (LRU) and on disk to reduce upstream load and improve latency.
4. **Normalizes icons** - for the v1 JSON API into 128×128 PNG files served from a CDN route.
5. **Looks up service icons** - from the [selfh.st icons](https://github.com/selfhst/icons), [homarr dashboard-icons](https://github.com/homarr-labs/dashboard-icons) and [LobeHub icons](https://www.npmjs.com/package/@lobehub/icons-static-svg) catalogs by service name.

### Favicon providers - all run in parallel on `/{domain}`; each has its own route:

| Provider | Route | Notes |
|---|---|---|
| HTML scraper | `/s/{domain}` | Parses `<link rel="icon">`, manifest, and fallbacks; optional [besticon](https://github.com/mat/besticon) sidecar via `BESTICON_URL` |
| [Google](https://www.google.com/s2/favicons) | `/g/{size}/{domain}` | Sizes 16, 32, 64, 128 |
| [Google v2](https://developers.google.com/search/docs/appearance/favicon-in-search) | `/g2/{size}/{domain}` | `faviconV2`; sizes 16, 32, 64, 128, 256 |
| [DuckDuckGo](https://icons.duckduckgo.com/) | `/d/{domain}` | |
| [Yandex](https://favicon.yandex.net/) | `/y/{domain}` | |
| [Favicon.so](https://favicon.so/) | `/f/{domain}` | |
| [Vemetric](https://favicon.vemetric.com/) | `/v/{domain}` | `?size=`, `?format=` |
| [Favicon-3j1](https://favicon-3j1.pages.dev/) | `/p/{domain}` | |
| [Faviconkit](https://faviconkit.net/) | `/k/{size}/{domain}` | Sizes 16, 32, 64, 128, 256 |
| [logo.dev](https://www.logo.dev/) | `/l/{domain}` | Requires `LOGODEV_TOKEN` |

**Service-icon catalogs** (lookup by service name, e.g. `jellyfin`):

| Catalog | Route |
|---|---|
| [selfhst icons](https://github.com/selfhst/icons) | `/sh/{service}` |
| [Dashboard Icons](https://github.com/homarr-labs/dashboard-icons) | `/di/{service}` |
| [LobeHub icons](https://github.com/lobehub/lobe-icons) | `/lb/{service}` |

Service routes support `?variant=color|light|dark` where applicable.

Interactive API docs and a live playground: `/api` on a running instance.

## Docker

Minimal `docker-compose.yml` - copy [`.env.example`](.env.example) to `.env`, adjust values, then:

```bash
docker compose up -d
```

```yaml
services:
  maflplus-favicon-api:
    image: ghcr.io/r0gger/maflplus-favicon-api:latest
    # build: .   # use instead of image: to build locally
    container_name: maflplus-favicon-api
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
      TZ: Europe/Amsterdam
      CACHE_SIZE_MB: 1024
      HOST_ONLY_DOMAINS: "*"
      HTTP_CLIENT_TIMEOUT: 5s
      HTTP_MAX_AGE_DURATION: 720h
      PORT: 8080
      SERVER_MODE: redirect
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:8080/up"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    networks:
      - besticon

networks:
  besticon:
    driver: bridge

volumes:
  favicon-cache:
```

**Notes**

- **besticon** has no `ports:` mapping - only `maflplus-favicon-api` can reach it on `http://besticon:8080`. Set `BESTICON_URL=http://besticon:8080` in `.env`.
- **Without besticon:** remove the `besticon` service, `depends_on`, `networks`, and `BESTICON_URL`. The built-in HTML scraper is used instead.
- **Host cache path:** use `- /path/to/cache:/cache` instead of the named volume; run `chown 100:101 /path/to/cache`and `chmod 755 /path/to/cache` so the container user can write.

## Environment variables

All settings are documented in [`.env.example`](.env.example). Copy it to `.env` and pass it via `env_file: .env` in Compose (or set `environment:` entries manually).

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | TCP port the HTTP server listens on. |
| `CACHE_DIR` | `./cache` (`/cache` in Docker) | Base directory for on-disk favicon cache files. |
| `MEMORY_CACHE_MAX` | `2000` | Max favicons in the per-worker in-memory LRU cache. |
| `MEMORY_CACHE_TTL` | `3600` | In-memory cache entry lifetime (seconds). |
| `DISK_CACHE_TTL` | `86400` | On-disk cache entry lifetime (seconds). |
| `CACHE_SIZE_MB` | `0` | Max total disk cache size (MB). Oldest entries are evicted when exceeded. `0` = no size cap (TTL eviction only). |
| `UPSTREAM_TIMEOUT` | `5000` | Upstream HTTP timeout (ms) for providers, besticon, and scrape targets. |
| `UV_THREADPOOL_SIZE` | `16` | Node libuv thread pool size for disk I/O, DNS, etc. Must be set before process start. |
| `WORKERS` | CPU core count | Number of cluster workers. Set explicitly in Docker when CPU is limited. `1` disables clustering. |
| `SCRAPER_PROBE_BATCH_SIZE` | `4` | HTML scraper icon candidates probed in parallel per batch (`/s/{domain}` and `/{domain}`). |
| `PICK_HEAD_START_MS` | `150` | Head-start (ms) for `DEFAULT_PROVIDER` on `/{domain}` before other providers start. |
| `LOGODEV_TOKEN` | _(unset)_ | [logo.dev](https://www.logo.dev/) publishable key. Enables `/l/{domain}`; without it the route returns 503. |
| `DEFAULT_PROVIDER` | `scraper` | Preferred provider for `/{domain}` (gets the head-start). Values: `scraper`, `google`, `googlev2`, `duckduckgo`, `yandex`, `faviconso`, `vemetric`, `favicondev`, `faviconkit`, `logodev`, `selfhst`, `dashboardicons`, `lobehub`. `logodev` requires `LOGODEV_TOKEN`. |
| `BESTICON_URL` | _(unset)_ | Base URL of a sidecar [besticon](https://github.com/mat/besticon) instance (e.g. `http://besticon:8080`). `/s/{domain}` asks besticon first, then falls back to the built-in scraper. |
| `SCRAPER_ICONS_CACHE_TTL` | `3600` | TTL (seconds) for the in-memory cache of enriched scraper icon lists (`/{domain}/json`). |
| `SCRAPER_ICONS_CACHE_MAX` | `500` | Max domains in that scraper-icons LRU cache. |
| `MANIFEST_PROBE_MAX` | `12` | Max manifest URLs to probe per domain when HTML does not link one directly. |
| `SCRAPER_MAX_ICON_SIZE` | `0` | Max output dimension for `/s/{domain}`. Larger sources are downscaled; `0` = native resolution. |
| `API_KEYS_DB` | `/cache/api-keys.sqlite` | SQLite file for hashed API keys and monthly usage counters. Keep on the same volume as `CACHE_DIR`. |
| `API_CACHE_DIR` | `/cache/api` | Directory for normalized 256×256 PNGs from `/api/v1/favicon`. Served via `/cdn/favicons/{domain}.png`. |
| `API_CACHE_TTL` | `604800` | How long a generated PNG counts as cached (seconds, 7 days). Also used as `Cache-Control` max-age on the CDN route. |
| `API_REQUIRE_KEY` | `true` | `false` makes `/api/v1/favicon` public: no key required, quotas not enforced. A provided key is silently ignored. |
| `PLAN_FREE_LIMIT` | `25` | Monthly call quota for `free` plan keys. `0` = unlimited. |
| `PLAN_PRO_LIMIT` | `2500` | Monthly call quota for `pro` plan keys. `0` = unlimited. |
| `PLAN_ENTERPRISE_LIMIT` | `0` | Monthly call quota for `enterprise` plan keys. `0` = unlimited. |

## API overview

| Endpoint | Description |
|---|---|
| `/{domain}` | Best favicon (parallel provider race) |
| `/s/{domain}` | HTML scraper (or besticon when `BESTICON_URL` is set) |
| `/g/{size}/{domain}` | Google favicon (16, 32, 64, 128) |
| `/g2/{size}/{domain}` | Google v2 favicon (16, 32, 64, 128, 256) |
| `/d/{domain}` | DuckDuckGo |
| `/y/{domain}` | Yandex |
| `/f/{domain}` | Favicon.so |
| `/v/{domain}` | Vemetric (`?size=`, `?format=`) |
| `/p/{domain}` | Favicon-3j1 |
| `/k/{size}/{domain}` | Faviconkit (16, 32, 64, 128, 256) |
| `/l/{domain}` | logo.dev (requires `LOGODEV_TOKEN`) |
| `/sh/{service}` | selfhst icons (`?variant=color\|light\|dark`) |
| `/di/{service}` | Dashboard Icons (`?variant=color\|light\|dark`) |
| `/lb/{service}` | LobeHub icons (`?variant=color\|light\|dark`) |
| `/{domain}/json` | JSON list of all endpoint URLs for a domain |
| `/api/v1/favicon?url=` | FaviconAPIs-compatible JSON API — see below |
| `/cdn/favicons/{domain}.png` | Public CDN route for cached API v1 PNGs |
| `/providers` | JSON: which optional providers are enabled |
| `/search?q=` | Custom search engine redirect to the homepage |

**Examples:** `https://your-host/github.com` · `https://your-host/s/github.com` · `https://your-host/sh/jellyfin`

### Scraper cache bypass

```
https://your-host/s/{domain}?refresh=1
```

Forces a fresh scrape by clearing the cached scraper entry (memory and disk) before fetching again. Use when a site changed its favicon, after scraper fixes, or when debugging stale results. `?nocache=1` is an alias for `?refresh=1`.

## API v1

`GET /api/v1/favicon?url=<website>` returns JSON (not image bytes) with a CDN URL to a normalized 256×256 PNG, `sourceType` (`svg` > `manifest` > `apple-touch-icon` > `png` > `ico`), and cache metadata. Clients fetch the image from the returned `url` via `/cdn/favicons/{domain}.png`.

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

### Successful response

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

| Status | Code | Meaning |
|---|---|---|
| 400 | `missing_url` / `invalid_url` | Missing or invalid `url` parameter |
| 401 | `missing_api_key` / `invalid_api_key` | No key, or key not recognised / revoked |
| 422 | `favicon_not_found` / `favicon_not_processable` | No usable icon, or decode failed |
| 429 | `quota_exceeded` | Monthly quota reached (`plan`, `limit`, `used`, `period` in body) |
| 500 | `internal_error` | Internal error |

Only `200` responses count toward the monthly quota. Quotas reset each calendar month (UTC).

## CLI: managing API keys (Docker)

Keys are stored in SQLite at `API_KEYS_DB` (default `/cache/api-keys.sqlite` on the cache volume). Only the SHA-256 hash is persisted; the raw key is shown once at creation.

Run inside the running container so the CLI uses the same database as the server:

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

Plans: `free`, `pro`, `enterprise`. Monthly limits are set via `PLAN_*_LIMIT` env vars.

Outside Docker, the same commands work via `npm run keys:create`, `keys:list`, `keys:revoke`, and `keys:delete`.

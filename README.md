# FaviconAPI

FaviconAPI is a self-hosted favicon proxy with a browser-based UI that fetches website and service icons from multiple upstream sources (10+), caches results, and exposes them through simple HTTP routes.

---

## Website: [faviconapi.com](https://faviconapi.com)

**Browser tools: [faviconapi.com/#tools](https://faviconapi.com/#tools)**

- **Browser search** - add `/search?q=%s` as a custom search engine (Chrome, Edge, Firefox)
- **Custom URL** - Build a shareable URL with your own preferred provider, fallbacks and minimum icon size. 
- **Bookmarklet** - drag **FaviconAPI Copy** to your bookmarks bar to copy a site's favicon URL
- **Offline search page** - download a self-contained HTML file to look up favicons from your own computer

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
- [Preload manager (/admin)](#preload-manager-admin)
- [Configuration](#configuration)
- [Performance](src/docs-content/performance.md)

---

## Why FaviconAPI?

FaviconAPI started out of a very practical need. While building my own dashboards with [Mafl+ (`R0GGER/maflplus`)](https://github.com/R0GGER/maflplus), I wanted a hassle-free way to fetch favicons and logos and link them to the services on my dashboard - without manually downloading and hosting an image for every single tile.

In practice that turned out to be surprisingly painful. To get decent coverage I always ended up combining multiple sources, and time and again I noticed that the "different" tools I was using were really just reaching for the same underlying providers behind the scenes - mostly Google and DuckDuckGo. When one of those came back with a blank, low-resolution, or generic placeholder icon, I had no fallback and was stuck.

What I was missing was a tool dedicated entirely to favicon lookup-one that aggregates independent sources, queries them together, and intelligently picks the best result instead of betting on a single upstream. Existing tools simply didn't offer that kind of integrated, multi-source solution.

So I built it. FaviconAPI brings 10+ favicon providers and 5 CDN-icon catalogs together behind one consistent API. It races providers in parallel, normalizes and caches the results, and returns the highest-quality icon it can find - with the others available as explicit fallbacks. It grew from a helper for my own dashboards into a self-hosted favicon proxy that anyone can run.

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

Clone the repository and start the stack. The bundled `docker-compose.yml` builds locally (`build: .`) and reads its settings from `.env.example`, with an optional `.env` on top for secrets.

```bash
docker compose up -d
```

The UI is at `http://localhost:3100` (host **3100** → container **3000**).

### Published image

To run the GHCR image instead of a local build:

```bash
docker pull ghcr.io/r0gger/favicon-api:latest
```

Then comment `build: .` and uncomment `image: ghcr.io/r0gger/favicon-api:latest` in `docker-compose.yml`.

### .env.example and .env

The `favicon-api` service reads two files, in this order:

1. [`.env.example`](.env.example) — the defaults, tracked in git. Every variable is documented with comments here; the tables under [Configuration](#configuration) cover the most-used ones.
2. `.env` — gitignored, optional, read second and therefore wins.

Anything secret belongs in `.env`: `ADMIN_SESSION_SECRET`, `ADMIN_PASSWORD_HASH`, `LOGODEV_TOKEN`, `BRANDFETCH_CLIENT_ID`. That keeps them out of a file you might push.

```bash
# Minimal .env — only the keys you actually want to override
ADMIN_SESSION_SECRET=9f2c…
ADMIN_PASSWORD_HASH=scrypt:N=16384,r=8,p=1:…:…
```

List only the keys you want to change. An **empty** value in `.env` still overrides a filled one in `.env.example`, so a stray `ADMIN_SESSION_SECRET=` there switches `/admin` off.

`env_file` is read when the container is created, so after editing either file run `docker compose up -d` (which recreates it). A plain `docker compose restart` keeps the old environment.

The `besticon` sidecar does not use `env_file`. Compose interpolates its `BESTICON_*` values from a project `.env` or from the defaults in `docker-compose.yml`.

### [docker-compose.yml](docker-compose.yml)

```yaml
services:
  favicon-api:
    build: .
    #image: ghcr.io/r0gger/favicon-api:latest
    container_name: favicon-api
    restart: unless-stopped
    ports:
      - "3100:3000"
    volumes:
      - favicon-cache:/cache
    env_file:
      - .env.example
      - path: .env
        required: false
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

- **besticon** has no `ports:` mapping — only the `favicon-api` service can reach it on `http://besticon:8080`. Set `BESTICON_URL=http://besticon:8080` in `.env.example`.
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

Full endpoint list, JSON discovery, and caching headers: [API](src/docs-content/api.md).

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

Full reference — source priority, CDN route, plans, PowerShell notes: [API v1](/docs/api#api-v1).

---

## Managing API keys (CLI)

Keys are stored in SQLite at `API_KEYS_DB` (default `/cache/api-keys.sqlite` on the cache volume). Only the SHA-256 hash is persisted; the raw key is shown once at creation.

Run the commands inside the running container so the CLI uses the same database as the server:

```bash
# Create a key (raw key printed once)
docker compose exec favicon-api npm run keys:create -- --label "customer A" --plan pro

# List active keys with this month's usage
docker compose exec favicon-api npm run keys:list

# Include revoked keys
docker compose exec favicon-api npm run keys:list -- --all

# Revoke (stops validating immediately; row kept for audit)
docker compose exec favicon-api npm run keys:revoke -- --prefix fa_abcdefgh

# Permanently delete key and usage history
docker compose exec favicon-api npm run keys:delete -- --prefix fa_abcdefgh
```

Plans: `free`, `pro`, `enterprise`. Monthly limits are set via `PLAN_*_LIMIT` env vars. Outside Docker, the same commands work via `npm run keys:create`, `keys:list`, `keys:revoke`, and `keys:delete`.

See also [API v1 — Managing API keys](/docs/api#managing-api-keys).

---

## Preload manager (/admin)

A web interface for the preload database — domains, icon overrides, blocklist, popularity stats, CSV import/export and preload runs — behind a username and password you set yourself.

It is disabled until you configure both a secret and a password: without `ADMIN_SESSION_SECRET` and `ADMIN_PASSWORD_HASH`, `/admin` returns 404 and management stays CLI-only.

```bash
# 1. Generate the 512-bit signing key for the session cookie
docker compose exec favicon-api npm run admin:secret

# 2. Set the login password (asks twice, prints ADMIN_USER + ADMIN_PASSWORD_HASH)
docker compose exec favicon-api npm run admin:password -- --user yourname

# 3. Put both lines in .env, recreate the container, then sign in at /admin
docker compose up -d
```

The key is always 512 bits and signs HS512. Only the scrypt hash of the password lands in `.env`. Sign-in issues an `HttpOnly`, `SameSite=Strict` session cookie whose TTL is an idle timeout — every action extends it — and **Keep me signed in** switches that window to `ADMIN_REMEMBER_TTL`. Rotating `ADMIN_SESSION_SECRET` signs everyone out at once.

| Variable                   | Default              | Description                                                                       |
| -------------------------- | -------------------- | --------------------------------------------------------------------------------- |
| `ADMIN_SESSION_SECRET`     | *(unset)*            | Signing key for the session cookie. Unset or shorter than 32 bytes keeps `/admin` at 404. Legacy name `ADMIN_JWT_SECRET` still works. |
| `ADMIN_PASSWORD_HASH`      | *(unset)*            | scrypt hash of the login password. Unset or malformed keeps `/admin` at 404.       |
| `ADMIN_USER`               | `admin`              | Login name.                                                                       |
| `ADMIN_SESSION_TTL`        | `3600`               | Idle timeout (seconds) of a normal session.                                       |
| `ADMIN_REMEMBER_TTL`       | `30d`                | Idle timeout when "Keep me signed in" was ticked.                                 |
| `ADMIN_LOGIN_MAX_ATTEMPTS` | `10`                 | Failed sign-ins per IP per 15 minutes, counted per worker.                        |

Full walkthrough: [Preload manager](/preload-manager.md).

---

## Configuration

All settings are documented in [`.env.example`](.env.example). Copy that file to `.env` and edit it (or set `environment:` entries in Compose).

The tables below cover the most-used variables. For the complete list — including `UI_CARD_URL`, `UI_INCLUDE_APP_ICONS`, `SCRAPER_FALLBACK`, and tuning notes — see [`.env.example`](.env.example) and [Performance](src/docs-content/performance.md).

### Server & cache


| Variable             | Default                        | Description                                                                                                      |
| -------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `PORT`               | `3000`                         | TCP port the HTTP server listens on.                                                                             |
| `CACHE_DIR`          | `./cache` (`/cache` in Docker) | Base directory for on-disk favicon cache files.                                                                  |
| `MEMORY_CACHE_MAX`   | `2000`                         | Max favicons in the per-worker in-memory LRU cache.                                                              |
| `MEMORY_CACHE_TTL`   | `3600`                         | In-memory cache entry lifetime (seconds).                                                                        |
| `DISK_CACHE_TTL`     | `1`                            | On-disk cache entry lifetime (days).                                                                             |
| `CACHE_SIZE_MB`      | `0`                            | Max total disk cache size (MB). Oldest entries are evicted when exceeded. `0` = no size cap (TTL eviction only). |
| `UPSTREAM_TIMEOUT`   | `5000`                         | Upstream HTTP timeout (ms) for providers, besticon, and scrape targets.                                          |
| `UV_THREADPOOL_SIZE` | `16`                           | Node libuv thread pool size for disk I/O, DNS, etc. Must be set before process start.                            |
| `WORKERS`            | CPU core count                 | Number of cluster workers. Set explicitly in Docker when CPU is limited. `1` disables clustering.                |


### Providers & scraper


| Variable                   | Default                         | Description                                                                                                                                                                                                                                                                          |
| -------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DEFAULT_PROVIDER`         | `scraper`                       | Preferred provider for `/{domain}` (gets the head-start). Values: `scraper`, `google`, `googlev2`, `duckduckgo`, `yandex`, `faviconso`, `vemetric`, `favicondev`, `faviconkit`, `faviconrun`, `twentyicons`, `ryanjc`, `logodev`, `brandfetch`, `selfhst`, `dashboardicons`, `lobehub`, `svgl`, `thesvg`. `logodev` requires `LOGODEV_TOKEN`; `brandfetch` requires `BRANDFETCH_CLIENT_ID`. |
| `PICK_HEAD_START_MS`       | `150`                           | Head-start (ms) for `DEFAULT_PROVIDER` on `/{domain}` before other providers start.                                                                                                                                                                                                  |
| `LOGODEV_TOKEN`            | *(unset)*                       | [logo.dev](https://www.logo.dev/) publishable key. Enables `/logodev/{size}/{domain}`; without it the route returns 503.                                                                                                                                                             |
| `BRANDFETCH_CLIENT_ID`     | *(unset)*                       | [Brandfetch](https://docs.brandfetch.com/logo-api/overview) Logo API client ID. Enables `/brandfetch/{size}/{ext}/{domain}`; without it the route returns 503.                                                                                                                             |
| `BESTICON_URL`             | *(unset)*                       | Base URL of a sidecar [besticon](https://github.com/mat/besticon) instance (e.g. `http://besticon:8080`). `/scraper/{domain}` asks besticon first, then falls back to the built-in scraper.                                                                                          |
| `SCRAPER_PROBE_BATCH_SIZE` | `4`                             | HTML scraper icon candidates probed in parallel per batch (`/scraper/{domain}` and `/{domain}`).                                                                                                                                                                                     |
| `SCRAPER_ICONS_CACHE_TTL`  | `3600`                          | TTL (seconds) for the in-memory cache of enriched scraper icon lists (`/{domain}/json`). Also used for scraper discovery disk cache entries when `SCRAPER_DISK_CACHE` is enabled.                                                                                                    |
| `SCRAPER_ICONS_CACHE_MAX`  | `500`                           | Max domains in that scraper-icons LRU cache.                                                                                                                                                                                                                                         |
| `SCRAPER_DISK_CACHE`       | `false`                         | When `true`, persist scraper discovery (HTML, icon lists, besticon JSON, manifests, probes) under `{CACHE_DIR}/scraper-discovery`. Survives restarts; shared across workers.                                                                                                         |
| `SCRAPER_DISK_CACHE_DIR`   | `{CACHE_DIR}/scraper-discovery` | Directory for that discovery cache. Only used when `SCRAPER_DISK_CACHE=true`.                                                                                                                                                                                                        |
| `MANIFEST_PROBE_MAX`       | `12`                            | Max manifest URLs to probe per domain when HTML does not link one directly.                                                                                                                                                                                                          |
| `SCRAPER_MAX_ICON_SIZE`    | `0`                             | Max output dimension for `/scraper/{domain}`. Larger sources are downscaled; when set, output is also lossless PNG-compressed (alpha preserved). `0` = native resolution.                                                                                                               |


### API v1 & quotas


| Variable                | Default                  | Description                                                                                                         |
| ----------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `API_KEYS_DB`           | `/cache/api-keys.sqlite` | SQLite file for hashed API keys and monthly usage counters. Keep on the same volume as `CACHE_DIR`.                 |
| `API_CACHE_DIR`         | `/cache/api`             | Directory for normalized 128×128 PNGs from `/api/v1/favicon`. Served via `/cdn/favicons/{domain}.png`.              |
| `API_CACHE_TTL`         | `7`                      | How long a generated PNG counts as cached (days). Converted to seconds for `Cache-Control` max-age on the CDN route. |
| `API_REQUIRE_KEY`       | `true`                   | `false` makes `/api/v1/favicon` public: no key required, quotas not enforced. A provided key is silently ignored.   |
| `PLAN_FREE_LIMIT`       | `25`                     | Monthly call quota for `free` plan keys. `0` = unlimited.                                                           |
| `PLAN_PRO_LIMIT`        | `2500`                   | Monthly call quota for `pro` plan keys. `0` = unlimited.                                                            |
| `PLAN_ENTERPRISE_LIMIT` | `0`                      | Monthly call quota for `enterprise` plan keys. `0` = unlimited.                                                     |


### Preload database

| Variable                     | Default                    | Description                                                                                                                         |
| ---------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `PRELOAD_DB`                 | `/cache/db/preload.sqlite` | SQLite file with the preload domain list, popularity counters and icon overrides. Keep it in a subdirectory: loose files in `CACHE_DIR` can be evicted by the disk-cache size cap. |
| `PRELOAD_TRACK_HITS`         | `true`                     | Count successful domain lookups so `rank` reflects real usage. Preload-script requests are never counted. `false` disables all counting. |
| `PRELOAD_HIT_FLUSH_MS`       | `15000`                    | How long each worker buffers hits before writing them. Counting never writes per request.                                           |
| `PRELOAD_HIT_DEDUPE_MS`      | `60000`                    | Window in which the same visitor asking for the same domain counts once. Keeps one web-UI search from outweighing real usage. `0` counts every request. |
| `PRELOAD_MIN_RANK`           | `3`                        | Minimum usage rank (hit count) for traffic-only domains in `preload-top-sites.js --source db`. List-imported domains still fill remaining slots, after real traffic. |
| `PRELOAD_AUTO_DISABLE_AFTER` | `5`                        | Consecutive failed preload runs after which an automatically managed domain is switched off.                                        |
| `PRELOAD_RANK_MONTHS`        | `3`                        | Rolling window (months) used by `manage-preload.js recalc` to recompute usage rank from monthly hit buckets.                      |
| `PRELOAD_OVERRIDE_RELOAD_MS` | `30000`                    | How often a worker re-checks the database for changed icon overrides and blocklist patterns.                                        |

Manage the list with `scripts/manage-preload.js` (`npm run preload:list`,
`preload:add`, `preload:disable`, `preload:import`, `preload:export`,
`preload:recalc`), or from the browser with the [preload manager](#preload-manager-admin).
See [Performance §10](src/docs-content/performance.md#10-preload-popular-sites-after-deploy) for the full workflow.


---

## Performance

See [Performance](src/docs-content/performance.md) for cache TTL recommendations, scraper latency, and worker sizing.

---


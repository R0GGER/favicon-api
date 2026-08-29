# FaviconAPI

FaviconAPI is a self-hosted favicon proxy with a browser-based UI that fetches website and service icons from multiple upstream sources (10+), caches results, and exposes them through simple HTTP routes.

---

## Website: [faviconapi.com](https://faviconapi.com)

**Browser tools: [faviconapi.com/#tools](https://faviconapi.com/#tools)**

- **Browser search** - add `/search?q=%s` as a custom search engine (Chrome, Edge, Firefox)
- **Custom URL** - Build a shareable URL with your own preferred provider, fallbacks and minimum icon size.
- **Bookmarklet** - drag **FaviconAPI Copy** to your bookmarks bar to copy a site's favicon URL

## Source

* Github: [R0GGER/favicon-api](https://github.com/R0GGER/favicon-api)
* FaviconAPI - [CHANGELOG](CHANGELOG.md)

---

## Documentation

This README is the getting-started guide. The full documentation set lives in
[`src/docs-content`](https://github.com/R0GGER/favicon-api/tree/main/src/docs-content) and is also served at `/docs` on a running instance.

| Document                                                                                     | Contents                                                                        |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [Getting started](https://github.com/R0GGER/favicon-api/blob/main/src/docs-content/getting-started.md)   | Install, configure, and run FaviconAPI (this README)                            |
| [API](https://github.com/R0GGER/favicon-api/blob/main/src/docs-content/api.md)                           | Full endpoint reference, API v1 JSON, API keys, quotas, caching headers         |
| [Performance](https://github.com/R0GGER/favicon-api/blob/main/src/docs-content/performance.md)           | Cache TTL tuning, scraper latency, worker sizing, preloading popular sites      |
| [Preload manager](https://github.com/R0GGER/favicon-api/blob/main/src/docs-content/preload-manager.md)   | Walkthrough of the `/admin` web interface                                       |
| [Browser tools](https://github.com/R0GGER/favicon-api/blob/main/src/docs-content/tools.md)               | Custom search engine, custom URL builder, bookmarklet, offline search page      |
| [Reverse proxy](https://github.com/R0GGER/favicon-api/blob/main/src/docs-content/proxy.md)               | nginx, Caddy, and Traefik setups, HTTPS headers, canonical URLs                 |

---

## Table of contents

- [Why FaviconAPI?](#why-faviconapi)
- [How it works](#how-it-works)
- [Quick start (Docker)](#quick-start-docker)
- [Configuration (.env)](#configuration-env)
- [Preload manager (/admin)](#preload-manager-admin)
- [Browser tools](#browser-tools)
- [Routes](#routes)
  - [Favicon providers](#favicon-providers)
  - [Service-icon catalogs](#appservice-icon-catalogs)
  - [Sizes](#sizes)
- [Custom profile URLs](#custom-profile-urls)
- [License](#license)

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

Clone the repository and start the stack. The bundled `docker-compose.yml` pulls the published image and reads its settings from [`.env.example`](.env.example).

```bash
docker compose up -d
```

The UI is at `http://localhost:3100` (host **3100** → container **3000**).

### Local build

To build the image from this repository instead of pulling it, swap the two lines in `docker-compose.yml`: uncomment `build: .` and comment out `image: ghcr.io/r0gger/favicon-api:latest`.

```bash
docker pull ghcr.io/r0gger/favicon-api:latest
```

### .env.example and .env

[`.env.example`](.env.example) is a documented example of every setting, tracked in git — the shipped `docker-compose.yml` reads it directly, so the stack starts with working defaults. Every variable is documented with comments in that file; the tables under [Configuration (.env)](#configuration-env) cover the most-used ones.

For your own settings — and for anything secret, such as `ADMIN_SESSION_SECRET`, `ADMIN_PASSWORD_HASH`, `LOGODEV_TOKEN`, and `BRANDFETCH_CLIENT_ID` — copy it to `.env` (gitignored) and point `env_file:` at that copy:

```bash
cp .env.example .env
```

```yaml
    env_file: .env
```

`env_file` is read when the container is created, so after editing it run `docker compose up -d` (which recreates the container). A plain `docker compose restart` keeps the old environment.

The `besticon` sidecar does not use `env_file`. Compose interpolates its `BESTICON_*` values from a project `.env` or from the defaults in `docker-compose.yml`.

### [docker-compose.yml](docker-compose.yml)

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

- **besticon** has no `ports:` mapping — only the `favicon-api` service can reach it on `http://besticon:8080`. Set `BESTICON_URL=http://besticon:8080` in your env file.
- **Without besticon:** remove the `besticon` service, `depends_on`, `networks`, and `BESTICON_URL`. The built-in HTML scraper is used instead.
- **Host cache path:** use `- /path/to/cache:/cache` instead of the named volume; run `chown 100:101 /path/to/cache` and `chmod 755 /path/to/cache` so the container user can write.
- **Behind a reverse proxy:** point nginx, Caddy, or Traefik at host port **3100** — see [Reverse proxy](https://github.com/R0GGER/favicon-api/blob/main/src/docs-content/proxy.md).

---

## Configuration (.env)

All settings are documented in [`.env.example`](.env.example). Copy that file to `.env` and edit it (or set `environment:` entries in Compose).

The tables below cover the most-used variables. For the complete list — including `UI_CARD_URL`, `UI_INCLUDE_APP_ICONS`, `SCRAPER_FALLBACK`, and tuning notes — see [`.env.example`](.env.example) and [Performance](https://github.com/R0GGER/favicon-api/blob/main/src/docs-content/performance.md).

### Server & cache


| Variable             | Default                        | Description                                                                                                      |
| -------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `PORT`               | `3000`                         | TCP port the HTTP server listens on.                                                                             |
| `CACHE_DIR`          | `./cache` (`/cache` in Docker) | Base directory for on-disk favicon cache files.                                                                  |
| `MEMORY_CACHE_MAX`   | `2000`                         | Max favicons in the per-worker in-memory LRU cache.                                                              |
| `MEMORY_CACHE_TTL`   | `86400`                        | In-memory cache entry lifetime (seconds). `.env.example` ships 1 day; the code fallback if unset is `3600`. |
| `DISK_CACHE_TTL`     | `7`                            | On-disk cache entry lifetime (days).                                                                     |
| `CACHE_STALE_RETENTION` | `30`                        | Days past `DISK_CACHE_TTL` an icon may still be served while it is refreshed in the background. `0` = hard expiry. |
| `CACHE_SIZE_MB`      | `1024`                         | Max total disk cache size (MB). Oldest entries are evicted when exceeded. Code fallback `0` = no size cap (TTL eviction only). |
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
| `SCRAPER_ICONS_CACHE_TTL`  | `604800`                        | TTL (seconds) for the in-memory cache of enriched scraper icon lists (`/{domain}/json`). Also used for scraper discovery disk cache entries when `SCRAPER_DISK_CACHE` is enabled. Unset → same as `DISK_CACHE_TTL`.                                                                 |
| `SCRAPER_ICONS_CACHE_MAX`  | `500`                           | Max domains in that scraper-icons LRU cache.                                                                                                                                                                                                                                         |
| `SCRAPER_DISK_CACHE`       | `true`                          | When `true`, persist scraper discovery (HTML, icon lists, besticon JSON, manifests, probes) under `{CACHE_DIR}/scraper-discovery`. Survives restarts; shared across workers.                                                                                                         |
| `SCRAPER_DISK_CACHE_DIR`   | `{CACHE_DIR}/scraper-discovery` | Directory for that discovery cache. Only used when `SCRAPER_DISK_CACHE=true`.                                                                                                                                                                                                        |
| `MANIFEST_PROBE_MAX`       | `12`                            | Max manifest URLs to probe per domain when HTML does not link one directly.                                                                                                                                                                                                          |
| `SCRAPER_MAX_ICON_SIZE`    | `0`                             | Max output dimension for `/scraper/{domain}`. Larger sources are downscaled; when set, output is also PNG-recompressed (truecolor vs. palette — whichever is smaller, see `SCRAPER_PNG_*`). `0` = native resolution.                                                                    |
| `SCRAPER_PNG_PALETTE`      | `true`                          | Enable the near-lossless indexed/palette PNG pass for capped scraper output (typically 25-55% smaller). `false` forces strict truecolor PNG.                                                                                                                                         |
| `SCRAPER_PNG_MIN_PSNR`     | `40`                            | Minimum perceptual PSNR (dB, alpha-premultiplied) the palette PNG must reach to be used over truecolor. Higher = closer to lossless; `0` = always take the smaller file. Ignored when `SCRAPER_PNG_PALETTE=false`.                                                                    |


### API v1 & quotas


| Variable                | Default                  | Description                                                                                                         |
| ----------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `API_KEYS_DB`           | `/cache/api-keys.sqlite` | SQLite file for hashed API keys and monthly usage counters. Keep on the same volume as `CACHE_DIR`.                 |
| `API_CACHE_DIR`         | `/cache/api`             | Directory for normalized 128×128 PNGs from `/api/v1/favicon`. Served via `/cdn/favicons/{domain}.png`.              |
| `API_CACHE_TTL`         | `7`                      | How long a generated PNG counts as cached (days). Converted to seconds for `Cache-Control` max-age on the CDN route. |
| `API_REQUIRE_KEY`       | `false`                  | `.env.example` makes `/api/v1/favicon` public. Code fallback if unset is `true` (key required, quotas enforced). A provided key is silently ignored when this is `false`. |
| `PLAN_FREE_LIMIT`       | `25`                     | Monthly call quota for `free` plan keys. `0` = unlimited.                                                           |
| `PLAN_PRO_LIMIT`        | `2500`                   | Monthly call quota for `pro` plan keys. `0` = unlimited.                                                            |
| `PLAN_ENTERPRISE_LIMIT` | `0`                      | Monthly call quota for `enterprise` plan keys. `0` = unlimited.                                                     |

Endpoint reference, authentication, error codes, and the API-key CLI: [API](https://github.com/R0GGER/favicon-api/blob/main/src/docs-content/api.md).

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
See [Performance §10](https://github.com/R0GGER/favicon-api/blob/main/src/docs-content/performance.md#10-preload-popular-sites-after-deploy) for the full workflow.

### Preload manager

| Variable                   | Default         | Description                                                                     |
| -------------------------- | --------------- | --------------------------------------------------------------------------------- |
| `ADMIN_SESSION_SECRET`     | *(unset)*       | Signing key for the `/admin` session cookie. Unset or shorter than 32 bytes keeps the page at 404. Legacy name `ADMIN_JWT_SECRET` still works. |
| `ADMIN_PASSWORD_HASH`      | *(unset)*       | scrypt hash of the login password. Unset or malformed keeps the page at 404.     |
| `ADMIN_USER`               | `admin`         | Login name.                                                                     |
| `ADMIN_SESSION_TTL`        | `3600`          | Idle timeout (seconds) of a normal session; every action extends it.            |
| `ADMIN_REMEMBER_TTL`       | `30d`           | Idle timeout when "Keep me signed in" was ticked.                               |
| `ADMIN_LOGIN_MAX_ATTEMPTS` | `10`            | Failed sign-ins per IP per 15 minutes, counted per worker.                      |


---

## Preload manager (/admin)

The first request for a domain is slow: FaviconAPI still has to discover icons and fetch them from upstream. **Preload** warms that cache in advance — for well-known sites, for domains your users actually look up, or for a list you curate — so later requests hit disk instead of the network.

The **preload manager** is the password-protected web UI for that workflow, at `/admin`. It talks to the same SQLite database as the CLI (`scripts/manage-preload.js`): which domains are on the list, how often they are requested, which image to force for a given site, which hosts to block, and when to run a preload pass. From the browser you can import or export CSV, start a run and watch the log, or generate a crontab line — without a shell on the server.

The page is off until you configure both a signing secret and a password. Without `ADMIN_SESSION_SECRET` and `ADMIN_PASSWORD_HASH`, `/admin` returns 404 and management stays CLI-only.

```bash
# 1. Generate the 512-bit signing key for the session cookie
docker compose exec favicon-api npm run admin:secret

# 2. Set the login password (asks twice, prints ADMIN_USER + ADMIN_PASSWORD_HASH)
docker compose exec favicon-api npm run admin:password -- --user yourname

# 3. Put both lines in .env, recreate the container, then sign in at /admin
docker compose up -d
```

The key is always 512 bits and signs HS512. Only the scrypt hash of the password lands in `.env`. Sign-in issues an `HttpOnly`, `SameSite=Strict` session cookie whose TTL is an idle timeout — every action extends it — and **Keep me signed in** switches that window to `ADMIN_REMEMBER_TTL`. Rotating `ADMIN_SESSION_SECRET` signs everyone out at once.

Full walkthrough: [Preload manager](https://github.com/R0GGER/favicon-api/blob/main/src/docs-content/preload-manager.md).

---

## Browser tools

The **Tools** button on the homepage (and on `/api` and `/docs`) opens a side panel of browser helpers. You set a profile once — preferred provider, optional fallbacks, and a minimum icon size — and that profile powers every tool in the panel. The settings are encoded in the URL: no account, nothing stored on the server.

From the panel you can:

- Add FaviconAPI as a **custom search engine** (`/search?q=%s`) so typing a domain or app name in the address bar opens the homepage with results already loaded.
- **Build a custom URL** that pins that provider chain for dashboards, password managers, and `<img>` tags (`/{id}/{domain}`).
- Drag the **FaviconAPI Copy** bookmarklet to your bookmarks bar and copy a site's favicon URL from any page you visit.
- **Download an HTML file** that searches using the same profile, from your own computer.

Open it via **Tools** in the top navigation, or `https://your-host/#tools`.

Full walkthrough: [Browser tools](https://github.com/R0GGER/favicon-api/blob/main/src/docs-content/tools.md).

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

Full endpoint list, JSON discovery, and caching headers: [API](https://github.com/R0GGER/favicon-api/blob/main/src/docs-content/api.md).

### Favicon providers

All providers run in parallel on `/{domain}`; each also has its own route.


| Provider                                                                            | Route                         | Alias  | Notes                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------- | ----------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTML scraper                                                                        | `/scraper/{size}/{domain}`    | `/s/`  | `/scraper/{domain}` serves the largest available icon; parses `<link rel="icon">`, `og:image` / `twitter:image` meta (near-square only), manifest, and fallbacks; optional [besticon](https://github.com/mat/besticon) sidecar via `BESTICON_URL` |
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
| `/api/v1/favicon?url=`       | FaviconAPI-compatible JSON API — see [API v1](https://github.com/R0GGER/favicon-api/blob/main/src/docs-content/api.md#api-v1) |
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

The `{id}` is a URL-safe (base64url) string that *encodes* the whole configuration; there is no database. Generate one from **Tools → Build custom URL** on the homepage, then append any domain (`github.com`) or app name (`immich`). See [Browser tools](https://github.com/R0GGER/favicon-api/blob/main/src/docs-content/tools.md).

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

## More documentation

[API](https://github.com/R0GGER/favicon-api/blob/main/src/docs-content/api.md) ·
[Performance](https://github.com/R0GGER/favicon-api/blob/main/src/docs-content/performance.md) ·
[Preload manager](https://github.com/R0GGER/favicon-api/blob/main/src/docs-content/preload-manager.md) ·
[Browser tools](https://github.com/R0GGER/favicon-api/blob/main/src/docs-content/tools.md) ·
[Reverse proxy](https://github.com/R0GGER/favicon-api/blob/main/src/docs-content/proxy.md) —
all in [`src/docs-content`](https://github.com/R0GGER/favicon-api/tree/main/src/docs-content).

---

## License

FaviconAPI is released under the [MIT License](LICENSE).

**Name and branding.** The MIT License covers the source code only. The name *FaviconAPI*, the logo, and the `faviconapi.com` domain are not part of the license — if you publish a fork or run a modified public instance, please give it its own name so users can tell the two apart.

**Third-party icons.** FaviconAPI fetches icons from upstream providers and catalogs at runtime; it does not ship them. Those icons, logos, and brand marks remain the property of their respective owners and are covered by the terms of the source they come from — [selfh.st icons](https://github.com/selfhst/icons), [homarr dashboard-icons](https://github.com/homarr-labs/dashboard-icons), [LobeHub icons](https://www.npmjs.com/package/@lobehub/icons-static-svg), [SVGL](https://github.com/pheralb/svgl), [theSVG](https://thesvg.org/), and the favicon providers. Check those terms before using the results commercially.

# FaviconAPI

A lightweight favicon proxy that fetches favicons from multiple providers (HTML scraper, Google, Google v2, DuckDuckGo, Yandex, Favicon.so, Vemetric, Favicon-3j1, Faviconkit, logo.dev) plus service-name lookups against the [selfhst icons](https://github.com/selfhst/icons) and [homarr-labs/dashboard-icons](https://github.com/homarr-labs/dashboard-icons) catalogs. Includes a web UI and a simple API to grab any website's favicon.

## Documentation

Soon..!

Interactive API docs and a live playground are also available at `/api` on a running instance.

## API

| Endpoint | Description |
|---|---|
| `/{domain}` | Best favicon (parallel provider race; optional head-start for `DEFAULT_PROVIDER`) |
| `/s/{domain}` | HTML scraper: parses the site's `<link rel="icon">`, web manifest and standard fallbacks. When `BESTICON_URL` is set, candidate discovery is delegated to a sidecar [besticon](https://github.com/mat/besticon) instance via `/allicons.json?url=...` and falls back to the built-in scraper if besticon yields nothing. Append `?refresh=1` to bypass the cache and re-scrape (see below). |
| `/g/{size}/{domain}` | Google favicon (sizes 16, 32, 64, 128) |
| `/g2/{size}/{domain}` | Google v2 (`faviconV2`) favicon (sizes 16, 32, 64, 128, 256) |
| `/d/{domain}` | DuckDuckGo favicon |
| `/y/{domain}` | Yandex favicon |
| `/f/{domain}` | Favicon.so favicon |
| `/v/{domain}` | Vemetric favicon |
| `/v/{domain}?size=64` | Vemetric favicon resized |
| `/v/{domain}?format=webp` | Vemetric favicon in webp/png/jpg |
| `/p/{domain}` | Favicon-3j1 favicon |
| `/k/{size}/{domain}` | Faviconkit favicon (sizes 16, 32, 64, 128, 256) |
| `/l/{domain}` | logo.dev logo (requires `LOGODEV_TOKEN`, otherwise returns 503) |
| `/sh/{service}` | [selfhst icons](https://github.com/selfhst/icons) lookup by service name (e.g. `/sh/jellyfin`). Supports `?variant=color\|light\|dark`. |
| `/di/{service}` | [homarr-labs/dashboard-icons](https://github.com/homarr-labs/dashboard-icons) lookup by service name (e.g. `/di/jellyfin`). Supports `?variant=color\|light\|dark`. |
| `/s-asset?url=...` | Server-side asset proxy used by the web UI to render every icon discovered by the scraper/besticon. Cached on disk + LRU keyed by SHA-1 of the URL; SSRF-guarded against localhost / private IPv4 ranges and link-local / ULA IPv6; only `http(s)` and a max URL length of 2048. Useful for upstream icons whose CDN blocks direct browser `<img>` loads via Referer/UA filtering. |
| `/search?q={query}` | Browser custom search engine entry point. Redirects to the homepage with the query pre-filled and favicon results loaded (e.g. `/search?q=github.com`). Use `https://your-host/search?q=%s` when adding a search engine in Chrome, Firefox or Edge. |
| `/opensearch.xml` | OpenSearch descriptor for one-click "Add search engine" in supported browsers. Linked from the homepage `<head>`. |
| `/providers` | JSON config indicating which optional providers are enabled |
| `/{domain}/json` | JSON list of every endpoint URL for the domain |
| `/api/v1/favicon?url=...` | **FaviconAPIs-compatible JSON endpoint.** Returns a JSON response (not the image bytes) with a CDN URL to a normalized 256x256 PNG, the detected `sourceType` (`svg` > `manifest` > `apple-touch-icon` > `png` > `ico`), and cache metadata. Requires an API key (Bearer or `?key=`). See [API v1](#api-v1-faviconapis-style) below. |
| `/cdn/favicons/{domain}.png` | Public CDN route that serves the 256x256 PNG cached by `/api/v1/favicon`. Sends `Cache-Control: public, max-age=604800, immutable`. |
| `/robots.txt` | Search-engine crawl directives. Allows indexing of the homepage, API docs (`/api`), and static assets (`/favicon.png`, `/logo.png`, `/sitemap.xml`); disallows every favicon endpoint so crawlers don't waste budget on the unbounded `/{domain}` URL space. The `Sitemap:` line is auto-built from the request host. |
| `/sitemap.xml` | Sitemap for the homepage and API docs page. The `<loc>` is auto-built from `req.protocol`/`req.get('host')`, so the correct public origin is used behind any reverse proxy (relies on Express `trust proxy`). |

**Example:** `https://your-host/github.com`

**Scraper example:** `https://your-host/s/github.com`

**Scraper cache bypass:** `https://your-host/s/{domain}?refresh=1`

Forces a fresh scrape for that domain by clearing the cached scraper entry (memory and disk) before fetching again. Use this when a site has changed its favicon, after deploying scraper fixes, or when debugging stale results. `?nocache=1` is accepted as an alias for `?refresh=1`.

**JSON example:** `https://your-host/github.com/json`

When `BESTICON_URL` is set, the JSON output also exposes every icon besticon found for the domain under `endpoints.scraper.icons` (each entry has `url`, `width`, `height`, `format`, `bytes`).

**selfhst example:** `https://your-host/sh/jellyfin`

**Dashboard Icons example:** `https://your-host/di/jellyfin`

The web UI accepts both a domain (e.g. `example.com`) and a bare service name without a TLD (e.g. `radarr`, `sonarr`); when no dot is present the input is treated as a service-icon name and the selfh.st and Dashboard Icons (homarr) cards are shown side-by-side. The "Also include service icon lookups" toggle controls whether they are also probed for domain searches (derived slug = first label of the domain).

## API v1 (FaviconAPIs-style)

`GET /api/v1/favicon?url=<website>` is a JSON-returning endpoint modeled on [faviconapis.com](https://www.faviconapis.com/docs). It runs the HTML scraper, picks the best source in priority order (`svg` > `manifest` > `apple-touch-icon` > `png` > root `/favicon.ico`), normalizes the result to a 256x256 PNG, caches that PNG on disk for 7 days and returns a CDN URL plus metadata. The image is **not** sent in the response body; clients fetch it from the returned `url` via `/cdn/favicons/{domain}.png`.

### Authentication

By default API keys are required. For self-hosted setups that want a fully public, anonymous endpoint, set `API_REQUIRE_KEY=false` in the environment (see [docker-compose.yml](docker-compose.yml)). In that mode the route accepts any request without an `Authorization` header or `?key=`, and per-key plans/quotas are not enforced. A provided key is silently ignored — it is not validated and its usage counter is not incremented.

When `API_REQUIRE_KEY=true` (default), pass the key in one of two ways:

```bash
curl "https://your-host/api/v1/favicon?url=https://github.com" \
  -H "Authorization: Bearer fa_your_key_here"
```

```bash
curl "https://your-host/api/v1/favicon?url=https://github.com&key=fa_your_key_here"
```

On Windows PowerShell, `curl` is an alias for `Invoke-WebRequest` and will not accept `-H "Authorization: ..."` as a string. Use `curl.exe` (the real curl binary that ships with Windows 10+), or use native PowerShell:

```powershell
Invoke-RestMethod "https://your-host/api/v1/favicon?url=https://github.com" `
  -Headers @{ Authorization = "Bearer fa_your_key_here" }
```

Only the SHA-256 hash of each key is stored. The raw key is shown exactly once at creation time.

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

`sourceType` is one of `svg`, `manifest`, `apple-touch-icon`, `png`, `ico`. `cached` is `true` when the PNG was served from the 7-day disk cache, `false` when it was just generated.

### Errors

All error responses are JSON with `error`, `code` and (where useful) extra context.

| Status | Code | Meaning |
|---|---|---|
| 400 | `missing_url` / `invalid_url` | Missing or unparseable `url` query parameter. |
| 401 | `missing_api_key` / `invalid_api_key` | No key, or key not recognised / revoked. |
| 422 | `favicon_not_found` / `favicon_not_processable` | No usable icon was found, or it could not be decoded. |
| 429 | `quota_exceeded` | Monthly call quota for this key reached. The response body includes `plan`, `limit`, `used`, `period`. |
| 500 | `internal_error` | Internal error. |

A request counts toward the monthly quota only when the API returns `200`, matching FaviconAPIs' behaviour. Quotas reset each calendar month (UTC, `YYYY-MM`).

### Plans and quotas

Quotas per plan are configured via env vars (defaults shown):

| Plan | Env var | Default |
|---|---|---|
| `free` | `PLAN_FREE_LIMIT` | `25` |
| `pro` | `PLAN_PRO_LIMIT` | `2500` |
| `enterprise` | `PLAN_ENTERPRISE_LIMIT` | `0` (unlimited) |

`0` means no limit. The plan you assign at key creation time is what determines the monthly cap. To disable plans entirely (and run as a public API), set `API_REQUIRE_KEY=false` — see [Authentication](#authentication) above.

### CLI: managing API keys

The bundled `scripts/manage-keys.js` reads/writes the SQLite file at `API_KEYS_DB` (default `/cache/api-keys.sqlite`, shared with the cache volume).

```bash
# Create a key for a customer on the pro plan.
# The raw key is printed once and only its SHA-256 hash is stored.
npm run keys:create -- --label "customer A" --plan pro

# List active keys with this month's usage counter.
# Pass --all to also see revoked keys (kept for audit history).
npm run keys:list
npm run keys:list -- --all

# Revoke a key by its visible prefix. The key stops validating immediately
# but the row is kept in the DB (and is excluded from `keys:list` by default).
npm run keys:revoke -- --prefix fa_abcdefgh

# Permanently remove a key and its usage history from the database.
npm run keys:delete -- --prefix fa_abcdefgh
```

Inside Docker, run these via `docker compose exec maflplus-favicon-api npm run keys:create -- --label "..." --plan pro` so the script writes to the same SQLite file the running server reads from.

### Cached images and the CDN route

`GET /cdn/favicons/{domain}.png` is the public read-only mirror of `API_CACHE_DIR` (default `/cache/api/`). It sends `Content-Type: image/png` and `Cache-Control: public, max-age=604800, immutable` so HTTP intermediaries (or a CDN in front of this service) can hold on to the PNG for the full 7 days. The route returns `404` when no PNG has been generated for the given domain yet, so it is safe to expose publicly — callers must hit `/api/v1/favicon` (with a valid key) to populate it.

## SEO

The homepage (`/` and `/index.html`) is rendered through a small template route that substitutes `__BASE_URL__` tokens in `src/public/index.html` with the request's absolute origin (`${req.protocol}://${req.get('host')}`). This populates `<link rel="canonical">`, the Open Graph (`og:url`, `og:image`), Twitter Card (`twitter:image`) and JSON-LD (`schema.org/WebApplication`) tags with the correct public URL automatically — no environment variable or rebuild required when you put the service behind a new hostname or reverse proxy. The Express app already runs with `trust proxy` enabled so `X-Forwarded-Proto` is honoured.

The `<head>` ships with a descriptive `<title>`, meta `description` / `keywords` / `author` / `theme-color`, Open Graph, Twitter Card and `schema.org/WebApplication` JSON-LD — all crawler/share-card friendly.

`/robots.txt` and `/sitemap.xml` are served from dynamic routes (no static file in `src/public/`), again with the host derived from the request. The robots.txt is an allow-list: the homepage, API docs page (`/api`), and static assets (`/favicon.png`, `/logo.png`, `/sitemap.xml`) are indexable; everything else (`/g/...`, `/d/...`, `/s/...`, `/{domain}`, …) is disallowed so search engines don't try to enumerate the unbounded favicon URL space.

## Docker

The bundled `docker-compose.yml` runs two services: `maflplus-favicon-api` and a sidecar [besticon](https://github.com/mat/besticon) instance used by the HTML scraper. Besticon is joined to an internal `besticon` bridge network and has no `ports:` mapping, so its frontend at `/` is **not** publicly reachable — only `maflplus-favicon-api` can talk to it on hostname `besticon`.

```yaml
services:
  maflplus-favicon-api:
    image: ghcr.io/r0gger/maflplus-favicon-api:latest
    container_name: maflplus-favicon-api
    restart: unless-stopped
    ports:
      - "3100:3000"
    volumes:
      - favicon-cache:/cache
    environment:
      - PORT=3000
      - CACHE_DIR=/cache
      - MEMORY_CACHE_MAX=2000
      - MEMORY_CACHE_TTL=3600
      - DISK_CACHE_TTL=86400
      - CACHE_SIZE_MB=512
      - UPSTREAM_TIMEOUT=5000
      - UV_THREADPOOL_SIZE=16
      - WORKERS=8
      - SCRAPER_PROBE_BATCH_SIZE=8
      - PICK_HEAD_START_MS=150
      - DEFAULT_PROVIDER=scraper
      - LOGODEV_TOKEN=
      - BESTICON_URL=http://besticon:8080
    depends_on:
      besticon:
        condition: service_healthy
    networks:
      - besticon

  besticon:
    image: matthiasluedtke/iconserver:latest
    container_name: besticon
    restart: unless-stopped
    # No ports: besticon is only reachable from other containers on the
    # `besticon` network. The frontend at "/" is therefore not exposed.
    environment:
      TZ: Europe/Amsterdam
      ADDRESS: ""
      CACHE_SIZE_MB: 1024
      HOST_ONLY_DOMAINS: "*"
      HTTP_CLIENT_TIMEOUT: 5s
      HTTP_MAX_AGE_DURATION: 720h
      HTTP_USER_AGENT: ""
      PORT: 8080
      SERVER_MODE: redirect
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

To build the image locally instead of pulling the published one, swap `image:` for `build: .` on `maflplus-favicon-api`. To run without besticon, drop the `besticon` service, the `BESTICON_URL` environment variable, the `depends_on` block and the `networks` section — the HTML scraper will then transparently fall back to its built-in implementation.

### Using a host path for the cache volume

If you prefer to use a full host path instead of a named volume, set the correct ownership so the container's `app` user (UID 100) can write to it:

```bash
mkdir -p /path/to/cache
chown 100:101 /path/to/cache
```

Then use the host path in your `docker-compose.yml`:

```yaml
    volumes:
      - /path/to/cache:/cache
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `CACHE_DIR` | `/cache` | Disk cache directory |
| `MEMORY_CACHE_MAX` | `2000` | Max entries in the per-worker LRU memory cache. Each cached favicon is typically 1-10 KB, so the default uses ~10-20 MB per worker. Increase if you serve many unique domains and want a higher hit ratio; decrease to reduce memory usage. |
| `MEMORY_CACHE_TTL` | `3600` | Memory cache TTL (seconds) |
| `DISK_CACHE_TTL` | `86400` | Disk cache TTL (seconds) |
| `CACHE_SIZE_MB` | `0` | Maximum total size of the disk cache (in MB), shared across all cluster workers via the `CACHE_DIR` volume. When the directory exceeds this limit, the oldest entries (by mtime) are evicted until the cache is back under the cap. Set to `0` to disable the size cap (TTL-based eviction only). |
| `UPSTREAM_TIMEOUT` | `5000` | Upstream request timeout (ms) |
| `UV_THREADPOOL_SIZE` | `16` | Size of the libuv thread pool used by Node.js for disk I/O (cache reads/writes), DNS lookups and other blocking work. Node's built-in default is `4`; `16` gives more headroom under concurrent load. Max is `1024`. |
| `WORKERS` | _(CPU cores)_ | Number of cluster workers to spawn. When unset, defaults to `os.cpus().length`. Note: in Docker, Node reports the host's CPU count, not the container's CPU limit — set this explicitly (e.g. `WORKERS=2`) when you constrain CPU via `--cpus` or `deploy.resources.limits`. Use `WORKERS=1` to disable clustering and run everything in a single process. |
| `PICK_HEAD_START_MS` | `150` | Head-start (ms) given to the preferred provider in `/{domain}` requests. The first provider in priority order (typically `DEFAULT_PROVIDER`) starts immediately; the remaining providers start after this delay (or sooner if the preferred provider already failed). Lower = more parallel/faster fallback but more wasted upstream calls; higher = stronger preference for the favored provider. |
| `SCRAPER_PROBE_BATCH_SIZE` | `4` | Number of HTML scraper icon candidates probed in parallel per batch (in `/s/{domain}` and as part of `/{domain}`). Higher values speed up scraping of sites with many `<link rel="icon">` entries but increase concurrent upstream load. |
| `LOGODEV_TOKEN` | _(unset)_ | Optional [logo.dev](https://www.logo.dev/) publishable key. When unset, `/l/{domain}` returns 503 and the logo.dev card is hidden in the UI. |
| `DEFAULT_PROVIDER` | _(unset)_ | Optional preferred provider for `/{domain}` requests. Since providers are now raced in parallel, this provider gets a `PICK_HEAD_START_MS` ms head-start over the others — so it usually wins when reachable, but a slow/failing favorite no longer blocks the response. Valid values: `scraper`, `google`, `googlev2`, `duckduckgo`, `yandex`, `faviconso`, `vemetric`, `favicondev`, `faviconkit`, `logodev`, `selfhst`, `dashboardicons`. Note: `logodev` requires `LOGODEV_TOKEN`. |
| `BESTICON_URL` | _(unset)_ | Optional base URL of a sidecar [besticon](https://github.com/mat/besticon) instance (e.g. `http://besticon:8080`). When set, `/s/{domain}` first asks besticon's `/allicons.json?url={domain}` for the icon list, then probes/picks the best one locally. Falls back to the built-in HTML scraper when besticon is unreachable or returns no candidates. The bundled `docker-compose.yml` runs besticon as an internal-only service (no exposed port; its frontend at `/` is not publicly reachable). |

For API v1 settings (`API_KEYS_DB`, `API_CACHE_DIR`, `API_REQUIRE_KEY`, `PLAN_*_LIMIT`, etc.) see [docs/configuration.md](docs/configuration.md) and [`.env.example`](.env.example).

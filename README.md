# MAFL+ Favicon API

A lightweight favicon proxy that fetches favicons from multiple providers (HTML scraper, Google, Google v2, DuckDuckGo, Yandex, Favicon.so, Vemetric, Favicon-3j1, Faviconkit, logo.dev) plus a service-name lookup against the [selfhst icons](https://github.com/selfhst/icons) catalog. Includes a web UI and a simple API to grab any website's favicon.

## API

| Endpoint | Description |
|---|---|
| `/{domain}` | Best favicon (cascading fallback through all domain-based providers) |
| `/s/{domain}` | HTML scraper: parses the site's `<link rel="icon">`, web manifest and standard fallbacks. Append `?refresh=1` to bypass the cache and re-scrape (see below). |
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
| `/sh/{service}` | [selfhst icons](https://github.com/selfhst/icons) lookup by service name (e.g. `/sh/jellyfin`) |
| `/providers` | JSON config indicating which optional providers are enabled |
| `/{domain}/json` | JSON list of every endpoint URL for the domain |

**Example:** `https://your-host/github.com`

**Scraper example:** `https://your-host/s/github.com`

**Scraper cache bypass:** `https://your-host/s/{domain}?refresh=1`

Forces a fresh scrape for that domain by clearing the cached scraper entry (memory and disk) before fetching again. Use this when a site has changed its favicon, after deploying scraper fixes, or when debugging stale results. `?nocache=1` is accepted as an alias for `?refresh=1`.

**JSON example:** `https://your-host/github.com/json`

**selfhst example:** `https://your-host/sh/jellyfin`

The web UI accepts both a domain (e.g. `example.com`) and a bare service name without a TLD (e.g. `radarr`, `sonarr`); when no dot is present the input is treated as a selfhst service name and only the selfhst icon card is shown.

## Docker

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
      - UPSTREAM_TIMEOUT=5000
      - UV_THREADPOOL_SIZE=16
      #- WORKERS=2
      #- PICK_HEAD_START_MS=150
      #- SCRAPER_PROBE_BATCH_SIZE=4
      - LOGODEV_TOKEN=
      #- DEFAULT_PROVIDER=scraper

volumes:
  favicon-cache:
```

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
| `UPSTREAM_TIMEOUT` | `5000` | Upstream request timeout (ms) |
| `UV_THREADPOOL_SIZE` | `16` | Size of the libuv thread pool used by Node.js for disk I/O (cache reads/writes), DNS lookups and other blocking work. Node's built-in default is `4`; `16` gives more headroom under concurrent load. Max is `1024`. |
| `WORKERS` | _(CPU cores)_ | Number of cluster workers to spawn. When unset, defaults to `os.cpus().length`. Note: in Docker, Node reports the host's CPU count, not the container's CPU limit — set this explicitly (e.g. `WORKERS=2`) when you constrain CPU via `--cpus` or `deploy.resources.limits`. Use `WORKERS=1` to disable clustering and run everything in a single process. |
| `PICK_HEAD_START_MS` | `150` | Head-start (ms) given to the preferred provider in `/{domain}` requests. The first provider in priority order (typically `DEFAULT_PROVIDER`) starts immediately; the remaining providers start after this delay (or sooner if the preferred provider already failed). Lower = more parallel/faster fallback but more wasted upstream calls; higher = stronger preference for the favored provider. |
| `SCRAPER_PROBE_BATCH_SIZE` | `4` | Number of HTML scraper icon candidates probed in parallel per batch (in `/s/{domain}` and as part of `/{domain}`). Higher values speed up scraping of sites with many `<link rel="icon">` entries but increase concurrent upstream load. |
| `LOGODEV_TOKEN` | _(unset)_ | Optional [logo.dev](https://www.logo.dev/) publishable key. When unset, `/l/{domain}` returns 503 and the logo.dev card is hidden in the UI. |
| `DEFAULT_PROVIDER` | _(unset)_ | Optional preferred provider for `/{domain}` requests. Since providers are now raced in parallel, this provider gets a `PICK_HEAD_START_MS` ms head-start over the others — so it usually wins when reachable, but a slow/failing favorite no longer blocks the response. Valid values: `scraper`, `google`, `googlev2`, `duckduckgo`, `yandex`, `faviconso`, `vemetric`, `favicondev`, `faviconkit`, `logodev`, `selfhst`. Note: `logodev` requires `LOGODEV_TOKEN`. |

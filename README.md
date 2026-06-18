# MAFL+ Favicon API

A lightweight favicon proxy that fetches favicons from multiple providers (HTML scraper, Google, Google v2, DuckDuckGo, Yandex, Favicon.so, Vemetric, Favicon-3j1, Faviconkit, logo.dev) plus a service-name lookup against the [selfhst icons](https://github.com/selfhst/icons) catalog. Includes a web UI and a simple API to grab any website's favicon.

## API

| Endpoint | Description |
|---|---|
| `/{domain}` | Best favicon (cascading fallback through all domain-based providers) |
| `/s/{domain}` | HTML scraper: parses the site's `<link rel="icon">`, web manifest and standard fallbacks |
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
      - MEMORY_CACHE_MAX=500
      - MEMORY_CACHE_TTL=3600
      - DISK_CACHE_TTL=86400
      - UPSTREAM_TIMEOUT=5000

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
| `MEMORY_CACHE_MAX` | `500` | Max items in memory cache |
| `MEMORY_CACHE_TTL` | `3600` | Memory cache TTL (seconds) |
| `DISK_CACHE_TTL` | `86400` | Disk cache TTL (seconds) |
| `UPSTREAM_TIMEOUT` | `5000` | Upstream request timeout (ms) |
| `LOGODEV_TOKEN` | _(unset)_ | Optional [logo.dev](https://www.logo.dev/) publishable key. When unset, `/l/{domain}` returns 503 and the logo.dev card is hidden in the UI. |

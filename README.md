# MAFL+ Favicon API

A lightweight favicon proxy that fetches favicons from Google, DuckDuckGo, and Yandex. Includes a web UI and a simple API to grab any website's favicon.

## API

| Endpoint | Description |
|---|---|
| `/{domain}` | Best favicon (DuckDuckGo preferred, fallback to Google/Yandex) |
| `/g/16/{domain}` | Google favicon 16px |
| `/g/32/{domain}` | Google favicon 32px |
| `/g/64/{domain}` | Google favicon 64px |
| `/g/128/{domain}` | Google favicon 128px |
| `/d/{domain}` | DuckDuckGo favicon |
| `/y/{domain}` | Yandex favicon |

**Example:** `https://your-host/github.com`

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

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `CACHE_DIR` | `/cache` | Disk cache directory |
| `MEMORY_CACHE_MAX` | `500` | Max items in memory cache |
| `MEMORY_CACHE_TTL` | `3600` | Memory cache TTL (seconds) |
| `DISK_CACHE_TTL` | `86400` | Disk cache TTL (seconds) |
| `UPSTREAM_TIMEOUT` | `5000` | Upstream request timeout (ms) |

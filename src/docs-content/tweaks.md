# Tweaks

This guide explains cache layers and scraper latency in depth.

## TL;DR

For most self-hosted deployments, set these in your `.env`:

```bash
# Keep scraper discovery + images cached for 7 days (matches the v1 API)
SCRAPER_DISK_CACHE=true
SCRAPER_ICONS_CACHE_TTL=604800
DISK_CACHE_TTL=604800
MEMORY_CACHE_TTL=86400

# Bound disk usage (LRU eviction of oldest entries)
CACHE_SIZE_MB=512

# Concurrency
UV_THREADPOOL_SIZE=16
SCRAPER_PROBE_BATCH_SIZE=6
```

The single biggest win is raising **`SCRAPER_ICONS_CACHE_TTL`** — see below for why.

---

## Why the scraper feels slower than the v1 API

The v1 API (`/api/v1/favicon`) and the HTML scraper use **different cache layers
that store different things**. They do not share a cache.

| | v1 API (`/api/v1/favicon`) | HTML scraper |
|---|---|---|
| What is cached | The finished product: one normalized **128×128** PNG per domain | Only intermediate discovery data (HTML, icon list, probes) + image bytes |
| Cost of a cache hit | `fs.stat` + read meta | Discovery may still re-run; images fetched per icon |
| Default TTL | 7 days (`API_CACHE_TTL`) | 1 hour discovery, 1 day images |
| Browser/CDN caching | `immutable` (long) | `max-age=86400` images, `no-cache` JSON |

A v1 API cache hit is essentially a file stat — no upstream calls, no image
decoding. The scraper has **two cost centers**, and by default both expire much
sooner:

1. **Discovery** — fetch the site HTML, parse `<link rel="icon">`, parse the web
   manifest, and *probe* each candidate icon for its real dimensions. This is by
   far the most expensive step (multiple upstream requests per domain). Cached by
   `SCRAPER_ICONS_CACHE_TTL` (default **3600s / 1 hour**).
2. **Image bytes** — the actual icon files (including assets loaded via the
   `/s-asset` proxy used by the homepage scraper card). Cached on disk by
   `DISK_CACHE_TTL` (default **86400s / 1 day**) and in memory by
   `MEMORY_CACHE_TTL` (default **3600s / 1 hour**).

> Caching only the images is the *smaller half* of the win. If discovery still
> expires every hour, the scraper keeps re-fetching site HTML and re-probing
> icons hourly — which is where most of the latency and upstream load lives.

---

## Recommendation: give the scraper v1-API-style caching

To make the scraper as fast as the v1 API, extend **both** TTLs to the same
horizon the API uses (7 days), and persist the discovery cache to disk so it
survives restarts and is shared across cluster workers.

```bash
# Persist discovery to disk (survives restarts, shared across workers)
SCRAPER_DISK_CACHE=true

# Discovery (HTML + icon list + probes) cached for 7 days — the big win
SCRAPER_ICONS_CACHE_TTL=604800

# Image bytes (scraper output + /s-asset assets) cached for 7 days
DISK_CACHE_TTL=604800

# Optional: keep hot domains in RAM longer (1 day)
MEMORY_CACHE_TTL=86400

# Longer retention = more files on disk; cap it so the oldest get evicted (LRU)
CACHE_SIZE_MB=512
```

No code changes are required — these are all existing knobs.

### Trade-offs

- **Staleness.** If a site changes its favicon, you may serve the old icon for up
  to the TTL. This is the same trade-off the v1 API already makes at 7 days.
  Bust it on demand with `?refresh=1` (or its alias `?nocache=1`) on
  `/scraper/{domain}`, which clears the memory + disk caches before re-fetching.
- **Disk usage.** Longer retention means more cached files. `CACHE_SIZE_MB`
  enforces an upper bound by evicting the oldest entries (by mtime). Budget
  roughly tens of KB per icon.
- **What it does not fix.** The homepage scraper card loads *multiple* images
  (one per discovered icon) via `/s-asset`, whereas the API returns a single URL.
  Those asset bytes are cached under the same `DISK_CACHE_TTL`, so they become
  fast too — but it is inherently more round-trips than the single-image API.

---

## Other performance improvements

### 1. Persist all caches on a durable volume

Make sure `CACHE_DIR` (default `/cache`) points at a persistent Docker volume so
the cache is not wiped on every container restart. The bundled
`docker-compose.yml` already mounts `favicon-cache:/cache`. Cold starts after a
restart re-do all discovery and fetching, so persistence is a real speed win.

### 2. Bound the disk cache (`CACHE_SIZE_MB`)

The code default is `0` (no size cap — TTL eviction only), but `.env.example`
ships `256`. With longer TTLs you should set an explicit cap so the cache cannot
grow unbounded. Eviction is LRU by file mtime and runs in the background.

```bash
CACHE_SIZE_MB=512
```

### 3. Right-size the in-memory cache

The in-memory LRU is the fastest tier (no disk I/O). For busy instances serving
many distinct domains, raise the entry count and lifetime:

```bash
MEMORY_CACHE_MAX=5000     # default 2000
MEMORY_CACHE_TTL=86400    # default 3600 (1h)
SCRAPER_ICONS_CACHE_MAX=2000   # discovery-list LRU, default 500
```

Memory caches are **per worker**, so total RAM scales with `WORKERS`.

### 4. Tune concurrency

- **`UV_THREADPOOL_SIZE=16`** — Node's libuv pool handles blocking disk I/O, DNS,
  and image work (sharp). The Node default of 4 is too small for an I/O-heavy
  proxy. Must be set before the process starts (it is in `.env.example`).
- **`SCRAPER_PROBE_BATCH_SIZE`** — how many icon candidates are probed in
  parallel per domain (default 4). Raising it (e.g. 6–8) speeds up sites with
  many `<link rel="icon">` entries, at the cost of more concurrent upstream
  requests. Lower it if upstreams rate-limit you.
- **`WORKERS`** — defaults to the CPU core count. Set it explicitly to match the
  CPU you actually allocate to the container; `1` disables clustering. More
  workers = more parallelism but more total RAM (caches are per worker).

### 5. Cap the scraper output size (`SCRAPER_MAX_ICON_SIZE`)

For dashboard use cases you rarely need icons larger than 128px. Capping the
output of `/scraper/{domain}` produces smaller PNGs — less to encode, cache,
transfer, and decode in the browser:

```bash
SCRAPER_MAX_ICON_SIZE=128
```

This only affects `/scraper/{domain}`; `/{domain}/json` still lists every
variant at full resolution.

### 6. Use the besticon sidecar (optional)

Setting `BESTICON_URL` (e.g. `http://besticon:8080`) lets the scraper ask a
dedicated [besticon](https://github.com/mat/besticon) instance for icon
candidates first, with its own long-lived cache
(`BESTICON_HTTP_MAX_AGE_DURATION`, default `720h`). It falls back to the built-in
scraper if besticon is unreachable. If you do **not** use it, remove the
besticon service from compose to save resources.

### 7. Pick a fast default provider for `/{domain}`

`/{domain}` races providers in parallel and gives `DEFAULT_PROVIDER` a head start
(`PICK_HEAD_START_MS`, default 150ms). The scraper produces the best icons but is
slower than CDN providers. If you favor latency over icon quality, set a fast CDN
provider as the default:

```bash
DEFAULT_PROVIDER=googlev2
PICK_HEAD_START_MS=150
```

Keep `scraper` if icon quality matters more than the first-request latency
(subsequent requests are cached anyway).

### 8. Lower the upstream timeout

`UPSTREAM_TIMEOUT` (default 5000ms) bounds how long a slow/dead upstream can
stall a request before the next provider/candidate is tried. Lowering it makes
failures fail faster (at the risk of giving up on genuinely slow hosts):

```bash
UPSTREAM_TIMEOUT=4000
```

### 9. Put a reverse proxy / CDN in front

Image routes already send cache-friendly headers (`/scraper/...` and `/s-asset`
send `Cache-Control: public, max-age=86400`; the v1 CDN route sends
`immutable`). Fronting the service with Nginx/Caddy/Cloudflare lets edge caches
serve repeat requests without ever hitting Node, which is the cheapest possible
hit.

### 10. Preload popular sites after deploy

After a fresh install or cache wipe, the first request for each domain is slow
because discovery and upstream fetches run on demand. The CLI at
`scripts/preload-top-sites.js` warms both cache layers in one pass by requesting
favicons for the world's most visited websites.

For each domain it calls:

| Step | Endpoint | What gets cached |
|---|---|---|
| Standard API | `GET /{domain}` | Best-pick provider cache (memory + disk) — same as the homepage API example |
| API v1 | `GET /api/v1/favicon?url=https://{domain}` | Normalized 128×128 PNG under `API_CACHE_DIR`, served via `/cdn/favicons/{domain}.png` |

See [API v1](api-v1.md) for authentication and quota rules on the v1 endpoint.

#### Domain source (Tranco)

By default the script downloads domains from the [Tranco](https://tranco-list.eu/)
research ranking — an aggregate of Cisco Umbrella, Majestic, CrUX, Cloudflare
Radar, and related lists, updated daily.

1. Resolve the latest list ID via `https://tranco-list.eu/latest_list` (redirect).
2. Download the top *N* entries as CSV from
   `https://tranco-list.eu/download/{listId}/{limit}` (default **500**).

Each CSV line is `rank,domain` (e.g. `1,google.com`). Pass `--domains-file
path/to/list.txt` to use your own list instead (one domain per line).

#### Usage

Run the script inside the `favicon-api` container (the service listens on port **3000** inside Docker):

```bash
# Default: top 500, concurrency 4
docker compose exec favicon-api node scripts/preload-top-sites.js --base-url http://127.0.0.1:3000

# With options
docker compose exec favicon-api node scripts/preload-top-sites.js \
  --base-url http://127.0.0.1:3000 --limit 500 --concurrency 4
```

When `API_REQUIRE_KEY=true`, pass a key for the v1 calls:

```bash
docker compose exec favicon-api node scripts/preload-top-sites.js \
  --base-url http://127.0.0.1:3000 --api-key fa_your_key_here
```

Preview which domains would be fetched without calling the API:

```bash
docker compose exec favicon-api node scripts/preload-top-sites.js \
  --base-url http://127.0.0.1:3000 --dry-run --limit 10
```

#### Options

| Option | Default | Description |
|---|---|---|
| `--base-url` | `http://127.0.0.1:3000` (inside container) | FaviconAPI base URL |
| `--limit` | `500` | Number of domains from Tranco |
| `--concurrency` | `4` | Parallel domain workers |
| `--api-key` | `PRELOAD_API_KEY` / `API_KEY` env | Bearer key for `/api/v1/favicon` |
| `--domains-file` | — | Local domain list instead of Tranco |
| `--skip-standard` | — | Skip `GET /{domain}` |
| `--skip-v1` | — | Skip `/api/v1/favicon` |
| `--timeout` | `30000` | Per-request timeout (ms) |
| `--dry-run` | — | Print domains only |

#### Expectations

- **Duration.** The full top 500 typically takes **30–60 minutes**, depending on
  concurrency, upstream latency, and scraper settings. Start with `--limit 50` to
  validate before running the full list.
- **Failures.** Some Tranco entries are infrastructure domains (e.g.
  `gtld-servers.net`) with no usable favicon. The standard API may still return
  a fallback icon; API v1 may respond with `422 favicon_not_found` — that is
  normal and does not stop the script.
- **Load.** Each domain triggers upstream fetches on a cold cache. Run during
  off-peak hours or lower `--concurrency` if upstreams rate-limit you.
- **Persistence.** Preloaded data is written to the same `CACHE_DIR` /
  `API_CACHE_DIR` volume as normal requests — ensure it is mounted persistently
  (see [Persist all caches](#1-persist-all-caches-on-a-durable-volume) above).

### Optional code change: align browser cache with `DISK_CACHE_TTL`

The browser `Cache-Control` max-age on scraper/asset image routes is currently
hardcoded to `86400` (1 day) in `src/index.js` (`CACHE_CONTROL`). If you raise
`DISK_CACHE_TTL` to 7 days but want browsers/CDNs to cache that long too, the
hardcoded value must be changed to derive from `DISK_CACHE_TTL`. This is a small
code change, not just configuration — ask if you want it applied.

---

## Quick reference: cache layers

| Layer | Stores | TTL variable | Default | Scope |
|---|---|---|---|---|
| Scraper discovery (memory) | HTML, icon list, probes | `SCRAPER_ICONS_CACHE_TTL` | 3600s | per worker |
| Scraper discovery (disk) | same as above | `SCRAPER_ICONS_CACHE_TTL` | 3600s | shared (needs `SCRAPER_DISK_CACHE=true`) |
| Image bytes (memory) | scraper + `/s-asset` icons | `MEMORY_CACHE_TTL` | 3600s | per worker |
| Image bytes (disk) | scraper + `/s-asset` icons | `DISK_CACHE_TTL` | 86400s | shared volume |
| v1 API result | normalized PNG per domain | `API_CACHE_TTL` | 604800s | shared volume |

## Verifying it works

- `GET /scraper/{domain}` a cold domain, then request it again — the second call
  should be noticeably faster and avoid upstream traffic.
- Force a refresh to confirm cache busting still works:
  `GET /scraper/{domain}?refresh=1`.
- Watch container logs for repeated upstream fetches of the same domain within
  the TTL window — there should be none after the first request.

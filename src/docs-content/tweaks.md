# Performance tuning & Tweaks

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

`/{domain}` races providers in parallel. When `DEFAULT_PROVIDER` is set, that
provider runs **exclusively first**; the fallback race only starts if it fails
(null, empty, or placeholder). Without `DEFAULT_PROVIDER`, the built-in first
provider (scraper) gets a head start (`PICK_HEAD_START_MS`, default 150ms) before
others join. The scraper produces the best icons but is slower than CDN providers.
If you favor latency over icon quality, set a fast CDN provider as the default:

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

> **Using Cloudflare?** Disable **HTTP/3 (with QUIC)** on the zone, otherwise
> browsers on networks where UDP/443 is blocked stall ~2s per page load before
> falling back to HTTP/2. See [Proxy → Cloudflare](proxy.md#cloudflare).

### 10. Preload popular sites after deploy

After a fresh install or cache wipe, the first request for each domain is slow
because discovery and upstream fetches run on demand. The CLI at
`scripts/preload-top-sites.js` warms both cache layers in one pass by requesting
favicons for the world's most visited websites.

For each domain it calls:

| Step | Endpoint | What gets cached |
|---|---|---|
| Standard API | `GET /{domain}` | Best-pick provider cache (memory + disk) — same as the homepage API example. Stored under `best_{domain}` at the winning provider's native/best resolution (scraper output is capped at `SCRAPER_MAX_ICON_SIZE`). |
| API v1 | `GET /api/v1/favicon?url=https://{domain}` | Normalized 128×128 PNG under `API_CACHE_DIR`, served via `/cdn/favicons/{domain}.png` |
| Scraper sizes *(default)* | `GET /scraper/{size}/{domain}` | Resized scraper PNGs (`scraper_{size}_{domain}`) for **16, 32, 64, 128, 256, 512**. Override with `--sizes`, or skip with `--skip-sizes`. |

By default each domain warms the standard best-pick, the 128×128 v1 PNG, **and**
all six scraper sizes. That multiplies requests per domain — use `--skip-sizes`
or a smaller `--sizes` list if you only need the best-pick / v1 caches.

See [API v1](api-v1.md) for authentication and quota rules on the v1 endpoint.

#### Domain source (`--source`)

By default the script uses
[DataForSEO's free "Top 1000 Websites By Ranking Keywords"](https://dataforseo.com/free-seo-stats/top-1000-websites)
list — sites ranked by how many keywords they rank for on Google (worldwide or
per country). Two sources are available via `--source`:

| Source | Ordering | Notes |
|---|---|---|
| `dataforseo` *(default)* | DataForSEO rank order | [DataForSEO](https://dataforseo.com/free-seo-stats/top-1000-websites) top-1000 (most Google organic keywords). Max ~1000 domains. |
| `file` | File order | Local list via `--domains-file path/to/list.txt` (one domain per line). Implied when `--domains-file` is set. |

The `dataforseo` source accepts `--location` to target a specific country
(default: **Worldwide**, which is DataForSEO location ID `0`). Examples:
`--location 0`, `--location Worldwide`, `--location Netherlands`,
`--location "United States"`, or `--location 2528`.

All sources apply two normalizations:

- **Registrable-domain deduplication** — origins are collapsed to their eTLD+1
  via the [Public Suffix List](https://publicsuffix.org/) (fetched at runtime),
  so `pt.xhamster.com` and `www.xhamster.com` both become `xhamster.com`, and
  multi-level suffixes like `go.id` / `co.uk` are handled correctly. If the PSL
  cannot be fetched it falls back to the last two labels.
- **Service/infra filtering** — known CDN, DNS, cloud-backend and ad/tracking
  domains (e.g. `gstatic.com`, `akamaiedge.net`, `cloudfront.net`,
  `doubleclick.net`) are dropped. Pass `--no-filter` to keep them.

#### Usage

Run the script inside the running FaviconAPI container (the service listens on port **3000** inside Docker).

**Via Docker Compose** (from the directory that contains `docker-compose.yml`):

```bash
# Default: top 500, concurrency 2 (recommended for VPS / scheduled runs)
docker compose exec favicon-api node scripts/preload-top-sites.js --base-url http://127.0.0.1:3000 --concurrency 2

# With options
docker compose exec favicon-api node scripts/preload-top-sites.js \
  --base-url http://127.0.0.1:3000 --limit 500 --concurrency 2
```

**Via Docker CLI** (when the container is already running — no compose file needed). Use the container name from `docker ps` (e.g. `favicon-api`):

```bash
docker exec favicon-api node scripts/preload-top-sites.js \
  --base-url http://127.0.0.1:3000 --limit 500 --concurrency 2

# Explicit worldwide ranking (same as the default; 0 = Worldwide)
docker exec favicon-api node scripts/preload-top-sites.js \
  --base-url http://127.0.0.1:3000 --limit 500 --concurrency 2 --location 0

# Country ranking (name or numeric DataForSEO ID)
docker exec favicon-api node scripts/preload-top-sites.js \
  --base-url http://127.0.0.1:3000 --limit 500 --concurrency 2 --location Netherlands
```

When `API_REQUIRE_KEY=true`, pass a key for the v1 calls:

```bash
docker compose exec favicon-api node scripts/preload-top-sites.js \
  --base-url http://127.0.0.1:3000 --api-key fa_your_key_here

# Or with docker exec:
docker exec favicon-api node scripts/preload-top-sites.js \
  --base-url http://127.0.0.1:3000 --api-key fa_your_key_here
```

Preview which domains would be fetched without calling the API:

```bash
docker compose exec favicon-api node scripts/preload-top-sites.js \
  --base-url http://127.0.0.1:3000 --dry-run --limit 10

# Or with docker exec:
docker exec favicon-api node scripts/preload-top-sites.js \
  --base-url http://127.0.0.1:3000 --dry-run --limit 10
```

#### Options

| Option | Default | Description |
|---|---|---|
| `--base-url` | `http://127.0.0.1:3000` (inside container) | FaviconAPI base URL |
| `--source` | `dataforseo` | Domain source: `dataforseo` or `file` (see above) |
| `--location` | `Worldwide` (`0`) | DataForSEO country — name or numeric ID (`0` / `Worldwide`, `Netherlands`, `"United States"`, `2528`, …) |
| `--limit` | `500` | Number of domains to preload (max ~1000) |
| `--concurrency` | `4` | Parallel domain workers — use **`2`** (or **`1`** on a small VPS) for scheduled runs |
| `--api-key` | `PRELOAD_API_KEY` / `API_KEY` env | Bearer key for `/api/v1/favicon` |
| `--domains-file` | — | Local domain list (one domain per line); sets `--source file` |
| `--no-filter` | — | Keep known service/infra domains (CDN, DNS, tracking) instead of dropping them |
| `--sizes` | `16,32,64,128,256,512` | Scraper sizes to warm via `/scraper/{size}/{domain}`. Pass a comma-separated subset to override. |
| `--skip-sizes` | — | Skip scraper size warming |
| `--skip-standard` | — | Skip `GET /{domain}` |
| `--skip-v1` | — | Skip `/api/v1/favicon` |
| `--timeout` | `30000` | Per-request timeout (ms) — use **`60000`** for weekly cron |
| `--dry-run` | — | Print domains only |

#### Expectations

- **Duration.** The full top 500 with all six scraper sizes typically takes
  longer than a best-pick/v1-only run (plan on roughly **1–2 hours**, depending
  on concurrency, upstream latency, and scraper settings). Start with
  `--limit 50` to validate before running the full list.
- **Failures.** Service/infra domains (CDN, DNS, tracking) are filtered out by
  default, so failure rates stay low. Any remaining domain with no usable
  favicon may still yield `422 favicon_not_found` on API v1 while the standard
  API returns a fallback icon — that is normal and does not stop the script.
- **Load.** Each domain triggers upstream fetches on a cold cache. Run during
  off-peak hours or lower `--concurrency` if upstreams rate-limit you.
- **Persistence.** Preloaded data is written to the same `CACHE_DIR` /
  `API_CACHE_DIR` volume as normal requests — ensure it is mounted persistently
  (see [Persist all caches](#1-persist-all-caches-on-a-durable-volume) above).

#### Recommended `.env` for weekly preload

Preload fills both cache layers, but **default TTLs expire long before a weekly
re-run** unless you align them. Match the [TL;DR](#tldr) block at the top of this
page and add headroom for 500 preloaded domains in the scraper LRU:

```bash
# Scraper discovery + image bytes: 7 days (same horizon as API v1)
SCRAPER_DISK_CACHE=true
SCRAPER_ICONS_CACHE_TTL=604800
DISK_CACHE_TTL=604800
MEMORY_CACHE_TTL=86400

# Preload uses 500 domains; default LRU max is 500 — raise so normal traffic
# does not evict preloaded entries immediately
SCRAPER_ICONS_CACHE_MAX=1000

# Bound disk growth (LRU eviction of oldest files)
CACHE_SIZE_MB=512

# v1 PNG cache — keep at 7 days; do not raise when running weekly preload
API_CACHE_TTL=604800
```

| Variable | Recommendation | Why |
|---|---|---|
| `SCRAPER_DISK_CACHE` | **`true`** | Persists scraper discovery across restarts; shared across cluster workers. `{CACHE_DIR}/scraper-discovery` is the default path — set `SCRAPER_DISK_CACHE_DIR` only if you need a custom location. |
| `SCRAPER_ICONS_CACHE_MAX` | **`1000`** | Default `500` equals the preload size; the LRU evicts entries as soon as it is full. `1000` leaves room for preloaded domains plus day-to-day lookups. Busy instances can use `2000` (see [§3](#3-right-size-the-in-memory-cache)). |
| `SCRAPER_ICONS_CACHE_TTL` | **`604800`** (7 days) | Default `3600` (1 hour) — discovery expires before the next weekly run, forcing full re-scrapes. |
| `DISK_CACHE_TTL` | **`604800`** (7 days) | Default `86400` (1 day) — image bytes expire too soon for weekly preload. |
| `API_CACHE_TTL` | **`604800`** (7 days) | Already the default. **Do not increase** for weekly preload — seven days matches a Sunday-to-Sunday schedule. Raising it (e.g. to 14 or 30 days) only makes sense if you run preload **less often**; it also lengthens browser/CDN `Cache-Control` on `/cdn/favicons/`. |

Raising `SCRAPER_ICONS_CACHE_MAX` alone is not enough — without longer TTLs and
`SCRAPER_DISK_CACHE=true`, weekly preload re-does expensive discovery work every
run.

#### Automate with cron

On a VPS you do not need the git repository or a `docker-compose.yml` on disk —
only a **running container**. Schedule preload during off-peak hours so upstream
load stays low.

**Recommended:** every **Sunday at 03:00**, `--concurrency 2` and
`--timeout 60000` (~45–90 minutes for 500 domains). Use **`--concurrency 1`**
on a small VPS or when upstreams rate-limit you (slower, but gentler).

```cron
# crontab -e  (adjust container name from `docker ps` and path from `which docker`)
0 3 * * 0 /usr/bin/docker exec favicon-api node scripts/preload-top-sites.js --base-url http://127.0.0.1:3000 --limit 500 --concurrency 2 --timeout 60000 >> /var/log/favicon-preload.log 2>&1
```

When `API_REQUIRE_KEY=true`, add `--api-key fa_your_key_here` to the command.

#### Preload timeout (`--timeout`)

The preload script always enforces a per-request timeout (default **30 seconds**).
It limits how long each call to `GET /{domain}` or `/api/v1/favicon` may take
**from the script's perspective**. Without it, a single hung domain can block a
concurrency slot indefinitely — especially problematic for unattended cron runs.

This is separate from **`UPSTREAM_TIMEOUT`** on the FaviconAPI server (default
**5 seconds** per upstream fetch). The server may still be working through
provider races and scraper probes when the preload client aborts — log lines like
`v1=fail(This operation was aborted)` mean the **preload timeout** was hit, not
necessarily that the server failed.

| `--timeout` | When to use |
|---|---|
| **30000** (default) | Manual test runs; acceptable if some v1 entries show `aborted` while `std=ok` |
| **60000** | **Recommended for weekly cron** — fewer aborted v1 calls on slow domains |
| **90000** | Still seeing many aborts at 60s; pair with `--concurrency 1` so one slow domain does not block two slots for too long |

Do not disable the timeout or set it very high (e.g. several minutes) with
`--concurrency 2` — two stuck domains can stall the entire job. For cron,
**60 seconds** is a practical balance between completion rate and total runtime.

**Cron checklist:**

- **Container must be running** — use `restart: unless-stopped` (or equivalent) on your deploy.
- **Full path to `docker`** — cron's `PATH` is minimal; run `which docker` on the host.
- **Container name** — match `docker ps` (e.g. `favicon-api` or `maflplus-favicon-api`).
- **Logging** — redirect stdout/stderr to a log file; configure logrotate so it does not grow unbounded.
- **Image version** — the script ships in the image from v2.8.10 onward (`scripts/preload-top-sites.js`). Registrable-domain deduplication and `--sizes` are available from v2.14.0; DataForSEO as the sole ranking source (no CrUX/Tranco) lands in the release after v2.14.0.

Weekly preload plus the [recommended `.env`](#recommended-env-for-weekly-preload)
above keeps standard, scraper, and v1 caches warm through the week without daily
upstream traffic.

### Browser cache vs `DISK_CACHE_TTL`

Raising `DISK_CACHE_TTL` to 7 days keeps icon bytes on the **server disk** that
long — repeat requests to FaviconAPI itself stay fast. What does **not** follow
automatically is how long **browsers and reverse proxies** may cache scraper and
asset responses.

Those image routes send a fixed header today:

```366:366:src/index.js
const CACHE_CONTROL = 'public, max-age=86400';
```

So clients see **1 day** (`86400` seconds), even when `DISK_CACHE_TTL=604800`.
The v1 CDN route (`/cdn/favicons/`) already uses `API_CACHE_TTL` and can cache
for the full 7 days.

| Route | Server disk TTL | Browser/proxy `Cache-Control` |
|---|---|---|
| `/scraper/…`, `/s-asset`, provider image routes | `DISK_CACHE_TTL` | Hardcoded **1 day** |
| `/cdn/favicons/{domain}.png` | `API_CACHE_TTL` | Matches `API_CACHE_TTL` |

For most self-hosted setups this is fine: the server-side cache does the heavy
lifting; browsers revalidate after a day while the origin still serves from disk.
If you front the service with a CDN and want edge caches to hold scraper icons
for the full `DISK_CACHE_TTL`, `CACHE_CONTROL` in `src/index.js` would need to
derive from `DISK_CACHE_TTL` instead of the fixed `86400` — that is a code
change, not an env var.

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

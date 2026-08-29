# Performance

This guide explains cache layers and scraper latency in depth.

## TL;DR

These are the shipped defaults in `.env.example`, and for most self-hosted
deployments you should leave them alone:

```bash
# Refresh horizon for discovery + image bytes (matches the v1 API)
SCRAPER_DISK_CACHE=true
SCRAPER_ICONS_CACHE_TTL=604800
DISK_CACHE_TTL=7
MEMORY_CACHE_TTL=86400

# Keep serving an expired icon while it is refreshed behind the request
CACHE_STALE_RETENTION=30

# Bound disk usage (LRU eviction + periodic sweep of expired entries)
CACHE_SIZE_MB=1024
CACHE_GC=true

# Concurrency
UV_THREADPOOL_SIZE=16
SCRAPER_PROBE_BATCH_SIZE=4

# Stop an unresponsive origin from stalling a scrape
SCRAPER_TOTAL_TIMEOUT=15000
SCRAPER_PAGE_TOTAL_TIMEOUT=8000
```

Two knobs matter most, for two different kinds of slowness:

- **`CACHE_STALE_RETENTION`** stops a TTL expiry from landing on a visitor's
  clock. Raising the TTLs alone only moves the problem further out in time; see
  [Why a longer TTL is not the fix](#why-a-longer-ttl-is-not-the-fix).
- **`SCRAPER_TOTAL_TIMEOUT`** caps what one unresponsive origin can cost, since a
  single scrape makes dozens of upstream requests that each carry their own
  `UPSTREAM_TIMEOUT`; see [Bound the timeouts](#8-bound-the-timeouts).

---

## Why the scraper feels slower than the v1 API

The v1 API (`/api/v1/favicon`) and the HTML scraper use **different cache layers
that store different things**. They do not share a cache.

| | v1 API (`/api/v1/favicon`) | HTML scraper |
|---|---|---|
| What is cached | The finished product: one normalized **128×128** PNG per domain | Only intermediate discovery data (HTML, icon list, probes) + image bytes |
| Cost of a cache hit | `fs.stat` + read meta | Discovery may still re-run; images fetched per icon |
| Default TTL | 7 days (`API_CACHE_TTL`) | Discovery follows `DISK_CACHE_TTL` when unset; `.env.example` is **7 days** |
| Browser/CDN caching | `immutable` (long) | `max-age=86400` images, `no-cache` JSON |

A v1 API cache hit is essentially a file stat — no upstream calls, no image
decoding. The scraper has **two cost centers**; `.env.example` now keeps both
on the same 7-day horizon as the v1 API:

1. **Discovery** — fetch the site HTML, parse `<link rel="icon">`, `og:image` / `twitter:image` meta (near-square only), parse the web
   manifest, and *probe* each candidate icon for its real dimensions. This is by
   far the most expensive step (multiple upstream requests per domain). Cached by
   `SCRAPER_ICONS_CACHE_TTL` (unset → same as `DISK_CACHE_TTL`; `.env.example`
   uses **7 days** / `604800` seconds).
2. **Image bytes** — the actual icon files (including assets loaded via the
   `/s-asset` proxy used by the homepage scraper card). Cached on disk by
   `DISK_CACHE_TTL` (`.env.example` **7 days**; code fallback if unset is also 7)
   and in memory by `MEMORY_CACHE_TTL` (`.env.example` **86400s / 1 day**; code
   fallback if unset is `3600s`).

> Caching only the images is the *smaller half* of the win. Keep discovery TTL
> aligned with (or longer than) `DISK_CACHE_TTL` — otherwise the scraper keeps
> re-fetching site HTML and re-probing icons while image bytes are still warm.

---

## Recommendation: keep scraper and v1 on the same cache horizon

`.env.example` already aligns scraper discovery and image-byte TTLs with the v1
API (7 days) and persists discovery to disk. Leave those values unless you have
a reason to change them; raise `CACHE_SIZE_MB` or the in-memory LRU sizes if
the volume or RAM is tight.

```bash
# Persist discovery to disk (survives restarts, shared across workers)
SCRAPER_DISK_CACHE=true

# Discovery (HTML + icon list + probes) cached for 7 days — the big win
SCRAPER_ICONS_CACHE_TTL=604800

# Image bytes (scraper output + /s-asset assets) cached for 7 days
DISK_CACHE_TTL=7

# Keep hot domains in RAM for a day
MEMORY_CACHE_TTL=86400

# Cap disk so the oldest files are evicted (LRU)
CACHE_SIZE_MB=1024
```

---

## Why a longer TTL is not the fix

A TTL only decides *when* an entry stops counting as current. On its own it does
not decide who pays for the refresh — and by default the answer was "the next
visitor". Measured on a real deployment with `DISK_CACHE_TTL=1`, requesting
`/{domain}` three times in a row:

| domain | 1st request | 2nd | 3rd |
|---|---|---|---|
| bol.com | 22,129 ms | 53 ms | 36 ms |
| amazon.com | 10,499 ms | 47 ms | 35 ms |
| facebook.com | 5,414 ms | 50 ms | 33 ms |
| google.com | 3,594 ms | 49 ms | 35 ms |

Every one of those domains already had its icon on disk. The bytes were simply
past the TTL, so they were discarded and the whole provider race re-run while
the visitor waited. Stretching the TTL to 7 or 30 days does not remove that
cliff, it just makes it rarer — and therefore more surprising when it hits.

**`CACHE_STALE_RETENTION` removes the cliff.** Past its TTL an entry becomes
*stale* rather than invalid: the stored bytes are served immediately and the
refresh runs behind the request, so the next visitor gets the fresh icon. A
favicon is about the most stable asset a site has, so serving one that is a few
days old costs nothing worth measuring — and the icon still converges on the
current one without anybody waiting.

This is why the TTL and the retention window are separate settings:

| | Question it answers | Setting |
|---|---|---|
| TTL | When should this be refreshed? | `DISK_CACHE_TTL`, `API_CACHE_TTL` |
| Retention | When is this worthless? | `CACHE_STALE_RETENTION` |

Refreshes are deduplicated per cache key and rate-limited by
`CACHE_REVALIDATE_COOLDOWN` (default 15 minutes), so a domain whose upstream is
down does not cause a retry on every request.

Set `CACHE_STALE_RETENTION=0` to opt out and go back to "expired means gone".

### Where stale serving applies

Stale-while-revalidate is wired in at the **route boundary** only:

| Route | Cache | Refresher |
|---|---|---|
| `/{domain}` | `best_{domain}` | full provider race |
| `/{service}` | `best-service_{slug}` | catalog chain |
| `/scraper/…` | `scraper_{…}` | discovery + fetch |
| `/{profile}/…` | `profile_{…}` | profile provider chain |
| `/api/v1/favicon` | normalized PNG in `API_CACHE_DIR` | source-priority fetch |

Everything those refreshers call in turn keeps the old fresh-only behaviour on
purpose. If an inner layer were also allowed to answer with stale bytes, a
refresh would find the same bytes one level down, store them again, and mark
everything fresh without ever contacting a provider — the cache would stop
renewing itself.

---

## Deleting what expired: the sweeper

Every cache in this service expires **lazily**: an entry is only checked, and
only removed, when somebody asks for that exact key. Nothing walks the volume
looking for rot. That means a domain looked up once leaves its files behind
forever, and `CACHE_SIZE_MB` does not help — it only indexes loose icon files in
`CACHE_DIR`, so the discovery and API subdirectories are invisible to it, and it
is size-driven, so it does nothing at all until the cap is reached.

`CACHE_GC=true` (default) runs a sweep every `CACHE_GC_INTERVAL` hours:

| What | Removed after |
|---|---|
| Icon bytes in `CACHE_DIR` | `DISK_CACHE_TTL` + `CACHE_STALE_RETENTION` |
| Normalized PNGs in `API_CACHE_DIR` | `API_CACHE_TTL` + `CACHE_STALE_RETENTION` |
| Raw HTML (`scraper-discovery/page`) | `SCRAPER_PAGE_CACHE_TTL` |
| Other discovery buckets | `SCRAPER_ICONS_CACHE_TTL` |

Note that the sweeper deliberately waits for TTL **plus** retention on anything
that can be served stale. Sweeping at the TTL would delete exactly the bytes
that make a refresh invisible.

Discovery is the exception: it is never served stale, so past its TTL it is pure
garbage and goes immediately.

### Raw HTML has its own TTL

`scraper-discovery/page` stores the homepage HTML that discovery parsed. It is
only an intermediate — once a domain's icon list is cached, the HTML is never
read again — but it is two orders of magnitude larger than anything else. On the
volume this was measured against:

| Bucket | Files | Size |
|---|---|---|
| `page` | 640 | **219.2 MB** |
| `manifest` | 7,190 | 0.3 MB |
| `probe` | 1,819 | 0.3 MB |
| `besticon` | 583 | 0.3 MB |
| `icons` | 476 | 0.3 MB |

So `SCRAPER_PAGE_CACHE_TTL` (default 6 hours) is capped independently of
`SCRAPER_ICONS_CACHE_TTL` (7 days). Keeping HTML as long as the derived icon
list buys almost nothing and costs almost everything.

The sweep logs a line whenever it removes something:

```
Cache sweep: removed 6431 expired entries, freed 241.8 MB (icons 5980/19.4 MB, discovery 445/219.7 MB, api 6/2.7 MB)
```

In a cluster the workers coordinate through a `cache-gc.lock` file in
`CACHE_DIR`, so raising `WORKERS` does not multiply the work.

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
ships `1024`. With longer TTLs you should set an explicit cap so the cache cannot
grow unbounded. Eviction is LRU by file mtime and runs in the background.

```bash
CACHE_SIZE_MB=1024
```

### 3. Right-size the in-memory cache

The in-memory LRU is the fastest tier (no disk I/O). For busy instances serving
many distinct domains, raise the entry count and lifetime:

```bash
MEMORY_CACHE_MAX=5000     # default 2000
MEMORY_CACHE_TTL=86400    # .env.example; code fallback if unset is 3600 (1h)
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
transfer, and decode in the browser. When the cap is set, responses are also
recompressed (transparency preserved):

```bash
SCRAPER_MAX_ICON_SIZE=128
```

The encoder builds both a truecolor and an indexed/palette PNG and keeps the
smaller one. Real favicons are anti-aliased (500-2000 colors), so a bit-exact
palette is rare; instead the palette variant is accepted when its perceptual
quality vs. the source is high enough — controlled by `SCRAPER_PNG_MIN_PSNR`:

```bash
SCRAPER_PNG_PALETTE=true    # enable the palette pass (default)
SCRAPER_PNG_MIN_PSNR=40     # min PSNR (dB) to accept palette; 0 = always smallest
```

At the default `40` dB (≈ visually lossless) this shrinks typical icons 25-55%
while staying `image/png`: github.com −25% (66.9 dB), netflix.com −26% (65.3 dB),
reddit.com −53% (50.5 dB). Raise `SCRAPER_PNG_MIN_PSNR` toward strict lossless, or
set `SCRAPER_PNG_PALETTE=false` to always keep the truecolor PNG.

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

### 8. Bound the timeouts

`UPSTREAM_TIMEOUT` (default 5000ms) bounds a **single** upstream fetch before the
next provider or icon candidate is tried. Lowering it makes failures fail faster,
at the risk of giving up on genuinely slow hosts:

```bash
UPSTREAM_TIMEOUT=4000
```

On its own that is not enough, because one scrape performs *many* upstream
fetches against the same origin, sequentially:

| Step | Upstream requests |
| --- | --- |
| Homepage HTML | 2 URLs (`domain`, `www.domain`) × 5 header/HTTP-version attempts |
| Manifest discovery | up to `MANIFEST_PROBE_MAX` (12) |
| Icon probes | up to 32, in batches of `SCRAPER_PROBE_BATCH_SIZE` |
| `www.` variant | the entire scrape again |

Each of those carries its own `UPSTREAM_TIMEOUT`, so a host that accepts
connections but never answers used to stall the dedicated `/scraper/` route for
**88 seconds**. Two total budgets cap it:

```bash
# Whole origin scrape: HTML + manifests + every icon probe
SCRAPER_TOTAL_TIMEOUT=15000

# The homepage-HTML retry ladder within it
SCRAPER_PAGE_TOTAL_TIMEOUT=8000
```

When a budget runs out, no new upstream request is started and the cheap
fallbacks (curated catalogs, Google faviconV2) produce the icon instead — 8.1s
instead of 88s for an unresponsive origin. A host that fails *fast* (connection
refused, 404) still gets every attempt, since those cost ~200ms each; the budgets
only bite when attempts hang.

`/{domain}` never showed this problem, because there the scraper is raced against
eleven fast providers and simply loses. It was only visible on `/scraper/...` —
which is why the *HTML Scraper* card in the UI could keep spinning while the
Google, DuckDuckGo and Yandex cards had already filled in.

#### Why a slow domain is not always a slow site

Before blaming the scraper, check whether the origin is reachable *from the
container* on every address it publishes. Anycast front-ends often publish
several A records, and one of them can be unroutable on your network:

```bash
docker compose exec favicon-api node -e "require('dns').lookup('2fas.com',{family:4,all:true},(e,a)=>console.log(a))"
```

The client walks all of them, so a single dead address costs one extra
connection attempt rather than a failed request. A domain where *every* address
refuses is genuinely unreachable — the icon then comes from a catalog or Google,
which is the correct outcome, not a bug.

#### Failed HTML fetches are not cached for long

When the homepage HTML cannot be fetched, that failure is remembered in memory
only, for `SCRAPER_PAGE_NEGATIVE_TTL` (default 60s) — long enough that the burst
of requests from one page load does not each re-run the retry ladder, short
enough that a transient network problem does not degrade a site's icons for
hours. Successful fetches are the only ones stored on disk.

### 9. Put a reverse proxy / CDN in front

Image routes already send cache-friendly headers (`/scraper/...` and `/s-asset`
send `Cache-Control: public, max-age=86400`; the v1 CDN route sends
`immutable`). Fronting the service with Nginx/Caddy/Cloudflare lets edge caches
serve repeat requests without ever hitting Node, which is the cheapest possible
hit.

> **Using Cloudflare?** Disable **HTTP/3 (with QUIC)** on the zone, otherwise
> browsers on networks where UDP/443 is blocked stall ~2s per page load before
> falling back to HTTP/2. See [Reverse Proxy → Cloudflare](proxy.md#cloudflare).

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

See [API v1](api.md#api-v1) for authentication and quota rules on the v1 endpoint.

#### Domain source (`--source`)

Five sources are available via `--source`. The two curated worldwide lists are
scraped live on each run (with a built-in snapshot as fallback):

| Source | Ordering | Notes |
|---|---|---|
| `similarweb` | SimilarWeb rank | [Most visited websites](https://www.similarweb.com/top-websites/) worldwide. The public page is the **top 50** (July 2026 snapshot) and includes Adult-category sites. Extra slots up to `--limit` are filled from Backlinko so a top-100 request still returns 100. Alias: `visited`. |
| `backlinko` | Semrush monthly visits | [Most popular websites](https://backlinko.com/most-popular-websites) — Backlinko's Semrush Traffic Analytics top **100**. NSFW is already removed by the publisher. Alias: `popular`. |
| `dataforseo` *(default)* | DataForSEO rank order | [DataForSEO](https://dataforseo.com/free-seo-stats/top-1000-websites) top-1000 (most Google organic keywords — the closest free stand-in for high PageRank / site authority). Max ~1000 domains. Alias: `pagerank`. |
| `db` | Highest usage `rank` first | Enabled domains from your own preload database, ranked by how often they were actually requested. List-imported domains with no hits yet still fill remaining slots, after real traffic. Skips traffic-only domains below `--min-rank` (default `PRELOAD_MIN_RANK`, normally 3). See [Preload database](#preload-database) below. |
| `file` | File order | Local list via `--domains-file path/to/list.txt` (one domain per line). Implied when `--domains-file` is set. |

The `dataforseo` source accepts `--location` to target a specific country
(default: **Worldwide**, which is DataForSEO location ID `0`). Examples:
`--location 0`, `--location Worldwide`, `--location Netherlands`,
`--location "United States"`, or `--location 2528`.

`--adult include|exclude` (default **include**) drops porn/adult domains when
set to `exclude`. SimilarWeb uses its Adult category; other sources use the
built-in list in `src/adultDomains.js`. Backlinko is already NSFW-free, so
exclude does not change that set. `--exclude-adult` / `--include-adult` are
aliases.

A live run (not `--dry-run`) writes the selected domains into the preload
database **before** warming caches, with `source` set to that list
(`backlinko`, `similarweb`, `dataforseo`, `file`) and `source_rank` from list
order (1 = first). Usage `rank` is left alone, so three real requests still
beat position 1 of a top-100 import. Result writeback then fills
`last_preloaded_at` the same way `--source db` already did. Without that, the
hit counter would create the rows as `traffic`. Requests from the preload
script (`User-Agent: FaviconProxy-preload/1.0`) are not counted as hits.

```bash
# Top 100 most visited, without adult sites
docker compose exec favicon-api node scripts/preload-top-sites.js \
  --base-url http://127.0.0.1:3000 --source similarweb --limit 100 --adult exclude --dry-run

# Top 100 most popular (Backlinko / Semrush, already NSFW-free)
docker compose exec favicon-api node scripts/preload-top-sites.js \
  --base-url http://127.0.0.1:3000 --source backlinko --limit 100 --dry-run

# Highest keyword ranking (DataForSEO), without adult sites
docker compose exec favicon-api node scripts/preload-top-sites.js \
  --base-url http://127.0.0.1:3000 --source dataforseo --limit 100 --adult exclude --dry-run
```

Ranking dumps (`dataforseo`, `file`) apply two extra normalizations; the
SimilarWeb and Backlinko lists keep the published host (`gemini.google.com`
stays, it is not collapsed to `google.com`):

- **Registrable-domain deduplication** — origins are collapsed to their eTLD+1
  via the [Public Suffix List](https://publicsuffix.org/) (fetched at runtime),
  so `pt.xhamster.com` and `www.xhamster.com` both become `xhamster.com`, and
  multi-level suffixes like `go.id` / `co.uk` are handled correctly. If the PSL
  cannot be fetched it falls back to the last two labels.
- **Service/infra filtering** — known CDN, DNS, cloud-backend and ad/tracking
  domains (e.g. `gstatic.com`, `akamaiedge.net`, `cloudfront.net`,
  `doubleclick.net`) are dropped. Pass `--no-filter` to keep them. Not applied
  to SimilarWeb / Backlinko, which are already user-facing websites.

#### Preload database

An external top-1000 list is a guess at what *your* users ask for. The preload
database turns that around: the service counts every successful domain lookup,
and `--source db` warms exactly those domains, most-requested first.

It lives in SQLite at `PRELOAD_DB` (default `/cache/db/preload.sqlite`) and is
managed with `scripts/manage-preload.js`. Run it inside the container as shown
below; `--help` prints the same overview. On a local checkout the common ones
are also wired up as `npm run preload:list`, `preload:add`, `preload:enable`,
`preload:disable`, `preload:set`, `preload:import`, `preload:export` and
`preload:recalc`.

Everything below is also available in the browser once you enable the
[preload manager](preload-manager.md) at `/admin` — same database, same rules,
behind a password you set with
`docker compose exec favicon-api npm run admin:password`.

**Inspect**

```bash
# Enabled domains, highest rank first
docker compose exec favicon-api node scripts/manage-preload.js list
# Also disabled ones (n*), only disabled, only domains with preload failures
docker compose exec favicon-api node scripts/manage-preload.js list --all
docker compose exec favicon-api node scripts/manage-preload.js list --disabled
docker compose exec favicon-api node scripts/manage-preload.js list --failing --limit 20
# Database path plus domain, override and blocklist counts
docker compose exec favicon-api node scripts/manage-preload.js stats
```

**Curate the list**

```bash
docker compose exec favicon-api node scripts/manage-preload.js add reddit.com --rank 20
docker compose exec favicon-api node scripts/manage-preload.js enable ah.nl
docker compose exec favicon-api node scripts/manage-preload.js disable ah.nl
docker compose exec favicon-api node scripts/manage-preload.js set ah.nl --rank 15
docker compose exec favicon-api node scripts/manage-preload.js remove ah.nl
```

**Pin an icon**

```bash
docker compose exec favicon-api node scripts/manage-preload.js set ah.nl --icon-url https://cdn.example/ah.png
docker compose exec favicon-api node scripts/manage-preload.js set ah.nl --clear-icon-url
```

**Keep domains out**

```bash
docker compose exec favicon-api node scripts/manage-preload.js block "*.gstatic.com" --reason infra
docker compose exec favicon-api node scripts/manage-preload.js unblock "*.gstatic.com"
# The patterns are a separate table, so they are not part of "list"
docker compose exec favicon-api node scripts/manage-preload.js blocklist
# Load the built-in CDN/DNS/ad-infrastructure set in one go
docker compose exec favicon-api node scripts/manage-preload.js seed-blocklist
```

**Bulk edit and maintenance**

```bash
docker compose exec favicon-api node scripts/manage-preload.js export --file /cache/preload.csv
docker compose exec favicon-api node scripts/manage-preload.js export --enabled-only
docker compose exec favicon-api node scripts/manage-preload.js import --file /cache/preload.csv
# Recompute rank from the monthly hit buckets
docker compose exec favicon-api node scripts/manage-preload.js recalc --months 3
```

Four things are worth knowing.

**Your decisions stick.** Enabling or disabling a domain by hand marks the row
as manually managed (shown as `y*` / `n*` in `list`), and no automated pass —
hit counting, preload writeback, or a future sync — will flip it back.

**Blocking is both retroactive and preventive.** A `block` pattern is an exact
host or `*.example.com` (which also covers the bare parent). Blocking disables
every already-listed domain that matches, and from then on the domain is never
created by the hit counter, skipped on import, refused by `add`/`enable`, and
left out of the preload selection. Unblocking does not switch those domains back
on — that stays a deliberate `enable`. Patterns live in their own table, so they
show up under `blocklist`, not `list`; seed the built-in CDN/infra set with
`seed-blocklist`.

**Counting is deduplicated per visitor.** Every icon route counts — `/{domain}`,
the `/scraper/...` and provider aliases, `/{domain}/json`, and
`/api/v1/favicon` — but the same visitor asking for the same domain counts once
per `PRELOAD_HIT_DEDUPE_MS` (default 60s). One search on the web UI fires 15-25
requests, so without that it would drown out real embedded favicons. Only
successful (HTTP 200) lookups count, so typos and bot scans never create rows.
Requests from `preload-top-sites.js` (`User-Agent: FaviconProxy-preload/1.0`)
are excluded; a ranking-source run writes those domains itself.

**`rank` is a rolling hit count.** Hits are stored per month; `recalc` sums the
last `PRELOAD_RANK_MONTHS` (default 3) into `rank` for every domain whose rank
is not pinned by hand, including list-imported rows. List order lives in
`source_rank` (1 = first) and is only a tiebreaker, so three real requests beat
position 1 of a top-100 import. Run `recalc` from cron just before the preload
run. Note that `recalc` derives rank purely from recorded hits: running it on a
freshly imported list that has no hits yet will reset those auto ranks to 0.

**Icon overrides apply everywhere.** `set {domain} --icon-url https://...` pins
an exact image for a domain when its own favicon is unusable. The override wins
on the best-pick route, the sized scraper routes and the v1 API alike, so a
preload run cannot cache the rejected icon on the routes that skip it.
`X-Favicon-Source: override` marks the responses, and changing the URL takes
effect immediately rather than after `DISK_CACHE_TTL`, because the URL is part
of the cache key. Only `https:` URLs are accepted.

CSV import/export uses the column order
`id,domain,enabled,source,rank,last_preloaded_at,last_preload_result,last_error,alter_icon_url`,
so the list can be bulk-edited in a spreadsheet. On import the `id` column is
ignored (the domain is the key) and the `last_*` columns are skipped, since the
next preload run rewrites them.

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

When `API_REQUIRE_KEY=true`, the v1 calls need a key from
`scripts/manage-keys.js` — not a separate preload secret. Create a dedicated
one (`enterprise` so a weekly run is not capped by the free/pro quota) and put
it in `.env` as `PRELOAD_API_KEY`:

```bash
docker compose exec favicon-api npm run keys:create -- --label preload --plan enterprise
# paste the printed fa_… value into PRELOAD_API_KEY in .env, then: docker compose up -d
```

You can still pass `--api-key fa_…` on a one-off command; for cron, the env var
keeps the secret out of the crontab.

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
| `--source` | `dataforseo` | Domain source: `similarweb`, `backlinko`, `dataforseo`, `db` or `file` (see above) |
| `--adult` | `include` | `include` or `exclude` porn/adult domains. Aliases: `--exclude-adult` / `--include-adult` |
| `--location` | `Worldwide` (`0`) | DataForSEO country — name or numeric ID (`0` / `Worldwide`, `Netherlands`, `"United States"`, `2528`, …) |
| `--limit` | `500` | Number of domains to preload |
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

Put these in `.env` (copied from `.env.example`). Shipped TTLs already match a
weekly run; the extra knob is the scraper LRU so 500 preloaded domains are not
evicted by day-to-day traffic. Match the [TL;DR](#tldr) and raise the LRU:

```bash
# Scraper discovery + image bytes: 7 days (same horizon as API v1)
SCRAPER_DISK_CACHE=true
SCRAPER_ICONS_CACHE_TTL=604800
DISK_CACHE_TTL=7
MEMORY_CACHE_TTL=86400

# Preload uses 500 domains; default LRU max is 500 — raise so normal traffic
# does not evict preloaded entries immediately
SCRAPER_ICONS_CACHE_MAX=1000

# Bound disk growth (LRU eviction of oldest files)
CACHE_SIZE_MB=1024

# v1 PNG cache — keep at 7 days; do not raise when running weekly preload
API_CACHE_TTL=7
```

| Variable | Recommendation | Why |
|---|---|---|
| `SCRAPER_DISK_CACHE` | **`true`** | Persists scraper discovery across restarts; shared across cluster workers. `{CACHE_DIR}/scraper-discovery` is the default path — set `SCRAPER_DISK_CACHE_DIR` only if you need a custom location. |
| `SCRAPER_ICONS_CACHE_MAX` | **`1000`** | Default `500` equals the preload size; the LRU evicts entries as soon as it is full. `1000` leaves room for preloaded domains plus day-to-day lookups. Busy instances can use `2000` (see [§3](#3-right-size-the-in-memory-cache)). |
| `SCRAPER_ICONS_CACHE_TTL` | **`604800`** (7 days, seconds) | Unset → `DISK_CACHE_TTL`. `.env.example` already ships 7 days. |
| `DISK_CACHE_TTL` | **`7`** (7 days) | `.env.example` and the code fallback are both 7 days — enough for a weekly run. |
| `API_CACHE_TTL` | **`7`** (7 days) | Already the default. **Do not increase** for weekly preload — seven days matches a Sunday-to-Sunday schedule. Raising it (e.g. to 14 or 30) only makes sense if you run preload **less often**; it also lengthens browser/CDN `Cache-Control` on `/cdn/favicons/`. |

Raising `SCRAPER_ICONS_CACHE_MAX` alone is not enough — without longer TTLs and
`SCRAPER_DISK_CACHE=true`, weekly preload re-does expensive discovery work every
run.

#### Automate with cron

On a VPS you do not need the git repository or a `docker-compose.yml` on disk —
only a **running container**. Schedule preload during off-peak hours so upstream
load stays low.

The [preload manager](preload-manager.md) **Preload run** tab can generate this
line from the same options you use for a manual run (schedule, `docker exec` or
`docker compose exec`, container name, log file, and an optional `recalc` first).

**Recommended:** every **Sunday at 03:00**, `--concurrency 2` and
`--timeout 60000` (~45–90 minutes for 500 domains). Use **`--concurrency 1`**
on a small VPS or when upstreams rate-limit you (slower, but gentler).

```cron
# crontab -e  (adjust container name from `docker ps` and path from `which docker`)
0 3 * * 0 /usr/bin/docker exec favicon-api node scripts/preload-top-sites.js --base-url http://127.0.0.1:3000 --limit 500 --concurrency 2 --timeout 60000 >> /var/log/favicon-preload.log 2>&1
```

When `API_REQUIRE_KEY=true`, set `PRELOAD_API_KEY` in `.env` (see above) rather
than adding `--api-key` to the crontab line.

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
- **Container name** — match `docker ps` (the bundled compose file uses `favicon-api`).
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

So clients see **1 day** (`86400` seconds), even when `DISK_CACHE_TTL=7`.
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
| Scraper discovery (memory) | HTML, icon list, probes | `SCRAPER_ICONS_CACHE_TTL` | `DISK_CACHE_TTL` if unset | per worker |
| Scraper discovery (disk) | same as above | `SCRAPER_ICONS_CACHE_TTL` | `DISK_CACHE_TTL` if unset | shared (needs `SCRAPER_DISK_CACHE=true`) |
| Image bytes (memory) | scraper + `/s-asset` icons | `MEMORY_CACHE_TTL` | 86400s (`.env.example`; code fallback 3600s) | per worker |
| Image bytes (disk) | scraper + `/s-asset` icons | `DISK_CACHE_TTL` | 7 days | shared volume |
| v1 API result | normalized PNG per domain | `API_CACHE_TTL` | 7 days | shared volume |

## Verifying it works

- `GET /scraper/{domain}` a cold domain, then request it again — the second call
  should be noticeably faster and avoid upstream traffic.
- Force a refresh to confirm cache busting still works:
  `GET /scraper/{domain}?refresh=1`.
- Watch container logs for repeated upstream fetches of the same domain within
  the TTL window — there should be none after the first request.

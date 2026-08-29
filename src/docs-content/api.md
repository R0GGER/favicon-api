# API

Image routes, JSON discovery, and the v1 JSON API. A live playground with code samples is at `/api` on a running instance.

## URL schemes

### Domain providers

```
/{provider}/{size}/{ext}/{domain}
```

Examples:

```
/google/128/png/github.com
/duckduckgo/32/png/github.com
/brandfetch/0/svg/github.com
/vemetric/64/webp/github.com
```

**Legacy** three-segment routes (`/{provider}/{size}/{domain}`) and short aliases (`/g/`, `/d/`, …) remain valid. When `ext` is omitted, PNG is assumed.

### Catalog providers

```
/{provider}/{size}/{format}/{service}
```

- **Raster:** `png` with sizes `64`, `128`, `256` (catalog-dependent)
- **SVG:** `svg` with size **`0`** in the path (e.g. `/selfhst/0/svg/github`)

Legacy routes without `format` default to PNG.

### logo.dev

Unchanged: `/logodev/{size}/{domain}` (alias `/l/`). No `ext` segment.

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /{domain}` | Best favicon for a **domain** (must contain a dot) — parallel provider race. |
| `GET /{app-name}` | Best **service icon** when the path has no dot (e.g. `/jellyfin`) — races catalogs. |
| `GET /{id}/{domain-or-appname}` | encoded provider chain |
| `GET /scraper/{size}/{ext}/{domain}` | HTML scraper (alias `/s/`). Sizeless `/scraper/{domain}` serves largest. With `BESTICON_URL`, delegates discovery to [besticon](https://github.com/mat/besticon) first |
| `GET /google/{size}/{ext}/{domain}` | Google favicon (alias `/g/`) — sizes 16, 32, 64, 128 |
| `GET /googlev2/{size}/{ext}/{domain}` | Google v2 (alias `/g2/`) — sizes 16, 32, 64, 128, 256 |
| `GET /duckduckgo/{size}/{ext}/{domain}` | DuckDuckGo (alias `/d/`) |
| `GET /yandex/{size}/{ext}/{domain}` | Yandex (alias `/y/`) |
| `GET /faviconso/{size}/{ext}/{domain}` | Favicon.so (alias `/f/`) |
| `GET /vemetric/{size}/{ext}/{domain}` | Vemetric (alias `/v/`). Path `ext`: `png`, `jpg`, `webp`. `?format=` still works |
| `GET /favicondev/{size}/{ext}/{domain}` | Favicon Extractor (alias `/p/`) |
| `GET /faviconkit/{size}/{ext}/{domain}` | Faviconkit (alias `/k/`) — sizes 16–256 |
| `GET /faviconrun/{size}/{ext}/{domain}` | Favicon.run (alias `/fr/`) — sizes 16–256 |
| `GET /twentyicons/{size}/{ext}/{domain}` | twenty-icons.com (alias `/ti/`) — sizes 16, 32, 64, 128, 180, 192 |
| `GET /ryanjc/{size}/{ext}/{domain}` | favicon.ryanjc.com (alias `/rj/`) |
| `GET /logodev/{size}/{domain}` | [logo.dev](https://www.logo.dev/) — requires `LOGODEV_TOKEN`; **503** when unset |
| `GET /brandfetch/{size}/{ext}/{domain}` | [Brandfetch](https://docs.brandfetch.com/logo-api/overview) (alias `/bf/`). Requires `BRANDFETCH_CLIENT_ID`. SVG: `/brandfetch/0/svg/{domain}`. Raster: 16–512. `?type=icon\|symbol\|logo`, `?theme=light\|dark` |
| `GET /selfhst/{size}/{format}/{service}` | [selfh.st icons](https://github.com/selfhst/icons) (alias `/sh/`). `?variant=color\|light\|dark` |
| `GET /dashboardicons/{size}/{format}/{service}` | [Dashboard Icons](https://github.com/homarr-labs/dashboard-icons) (alias `/di/`) |
| `GET /lobehub/{size}/{format}/{service}` | [LobeHub icons](https://www.npmjs.com/package/@lobehub/icons-static-svg) (alias `/lb/`). Light/dark serve theme PNGs when available |
| `GET /svgl/{size}/{format}/{service}` | [SVGL](https://github.com/pheralb/svgl) (alias `/sv/`). Default format is SVG (`/svgl/0/svg/{service}`) |
| `GET /thesvg/{size}/{format}/{service}` | [theSVG](https://thesvg.org/) (alias `/ts/`). Default format is SVG (`/thesvg/0/svg/{service}`); CDN: `https://thesvg.org/icons/{slug}/{variant}.svg` |
| `GET /services/resolve/{service}` | Resolve a search term to canonical slugs per catalog |
| `GET /s-asset?url=...` | Server-side asset proxy for scraper-discovered icons. Cached, SSRF-guarded |
| `GET /search?q={query}` | Browser search — redirects to `/?q={query}` |
| `GET /opensearch.xml` | OpenSearch descriptor |
| `GET /providers` | JSON: enabled providers, `urlMode`, API settings |
| `GET /{domain}/json` | JSON discovery for a domain |
| `GET /{app-name}/json` | JSON discovery for a service name |
| `GET /api/v1/favicon?url=...` | FaviconAPIs-compatible JSON — see [API v1](#api-v1) |
| `GET /cdn/favicons/{domain}.png` | CDN route for normalized 128×128 PNGs from the v1 API |
| `GET /robots.txt` | Crawl directives |
| `GET /sitemap.xml` | Sitemap for indexable pages |
| `GET /`, `/api` | Web UI and interactive API documentation |

## Examples

```
https://your-host/github.com
https://your-host/jellyfin
https://your-host/scraper/github.com
https://your-host/google/64/png/github.com
https://your-host/selfhst/128/png/jellyfin
https://your-host/selfhst/0/svg/jellyfin
https://your-host/svgl/0/svg/github
https://your-host/thesvg/0/svg/github
https://your-host/brandfetch/128/png/github.com
https://your-host/github.com/json
https://your-host/jellyfin/json
https://your-host/search?q=%s
```

## Scraper cache bypass

Append `?refresh=1` to `/scraper/{domain}` (or sized variant) to clear cached scraper entries before fetching again.

Use when a site changed its favicon, after scraper fixes, or when debugging stale results. `?nocache=1` is an alias.

## JSON discovery 

Returns proxy and upstream `source` URLs for every applicable provider.

| Path | Input | Top-level fields |
|---|---|---|
| `/{domain}/json` | Domain with a dot | `domain`, `endpoints` (website providers + catalog blocks) |
| `/{app-name}/json` | Service name without a dot | `service`, `endpoints.best`, `endpoints.resolve`, catalog blocks |

### Service-icon blocks

Each block is empty (`service: null`, …) when that catalog has **no matching slug**.

**Variants** list only assets confirmed to exist:

- **selfh.st** and **dashboardicons** — color / light / dark after CDN probe (24 h cache)
- **lobehub** — light/dark probed against `@lobehub/icons-static-png` theme assets
- **svgl** — SVG listed as primary; top-level `png` entry for raster URLs
- **thesvg** — SVG listed as primary (`default` → API `color`); light/dark when the icon ships those variants; top-level `png` entry for raster URLs

Domain JSON derives catalog slugs via `resolveServiceMatches()` using the label from the domain (e.g. `reddit.com` → `reddit`).

When `BESTICON_URL` is set, domain JSON includes icons from besticon under `endpoints.scraper.icons`.

Responses use **`Cache-Control: no-cache`**.

## Asset proxy (`/s-asset`)

| Constraint | Value |
|---|---|
| Allowed schemes | `http://`, `https://` only |
| Max URL length | 2048 characters |
| SSRF protection | Blocks localhost, private IPv4, link-local and ULA IPv6 |
| Cache key | SHA-1 of the URL |

## `/providers` response

```json
{
  "logoDev": false,
  "brandfetch": false,
  "defaultProvider": "scraper",
  "includeAppIcons": true,
  "faviconProviders": ["scraper", "google", "ddg", "yandex", "faviconso", "vemetric", "favicondev", "faviconkit", "faviconrun", "twentyicons", "ryanjc", "logodev", "brandfetch"],
  "appIconProviders": ["selfhst", "dashboardicons", "lobehub", "svgl", "thesvg"],
  "urlMode": "proxy",
  "sizeFilterMin": 16,
  "sizeFilterMax": 512,
  "upstreamIpv4": true,
  "api": {
    "requireKey": false,
    "cacheTtl": 604800,
    "plans": { "free": 25, "pro": 2500, "enterprise": 0 }
  }
}
```

- `urlMode` — mirrors `UI_CARD_URL` (`proxy` or `source`)
- `includeAppIcons` — mirrors `UI_INCLUDE_APP_ICONS` (default “Also include CDN icon lookups” checkbox)
- `faviconProviders` — mirrors `UI_FAVICON_PROVIDERS` (homepage favicon cards; empty env = all)
- `appIconProviders` — mirrors `UI_APP_ICON_PROVIDERS` (homepage CDN icon cards; empty env = all)
- `sizeFilterMin` / `sizeFilterMax` — mirrors `UI_SIZE_FILTER_MIN` / `UI_SIZE_FILTER_MAX` (homepage Size slider defaults; steps `0|16|32|64|128|180|256|512`, max may be `-1` for “Max”)

## Response behavior

| Condition | Typical response |
|---|---|
| Successful lookup | `200` with appropriate content type |
| Icon not found | `404` |
| Upstream failure | `502` |
| logo.dev / Brandfetch without credentials | `503` |
| Invalid domain / hostname | `400` |

JSON v1 errors use a different set of status codes — see [Error responses](#error-responses).

## HTTP caching

Provider **image** routes use memory LRU + disk cache. TTLs: [Getting Started — Configuration](getting-started.md#configuration-env).

**JSON discovery** routes send `Cache-Control: no-cache`.

The v1 CDN route is documented under [CDN route](#cdn-route).

## API v1

`GET /api/v1/favicon?url=<website>` returns JSON (not image bytes) with a CDN URL to a normalized **128×128** PNG, a `sourceType`, and cache metadata. Clients fetch the image from the returned `url` via `/cdn/favicons/{domain}.png`.

### Endpoint

```
GET /api/v1/favicon?url={website}
```

### Authentication

By default, API keys are **required** (`API_REQUIRE_KEY=true`).

For self-hosted setups that want a fully public endpoint, set `API_REQUIRE_KEY=false` (the bundled `.env.example` does this). In that mode:

- No `Authorization` header or `?key=` is required
- Per-key plans and quotas are not enforced
- A provided key is **silently ignored** — not validated, usage counter not incremented

When keys are required, pass the key in one of two ways:

```bash
curl "https://your-host/api/v1/favicon?url=https://github.com" \
  -H "Authorization: Bearer fa_your_key_here"
```

```bash
curl "https://your-host/api/v1/favicon?url=https://github.com&key=fa_your_key_here"
```

Only the SHA-256 hash of each key is stored. The raw key is shown exactly once at creation time.

`curl` is an alias for `Invoke-WebRequest` on Windows PowerShell and will not accept `-H "Authorization: ..."`. Use `curl.exe` or:

```powershell
Invoke-RestMethod "https://your-host/api/v1/favicon?url=https://github.com" `
  -Headers @{ Authorization = "Bearer fa_your_key_here" }
```

### Successful response

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

| Field | Description |
|---|---|
| `url` | Public CDN URL for the normalized PNG |
| `domain` | Extracted domain from the input URL |
| `width`, `height` | Always `128` |
| `format` | Always `png` |
| `sourceType` | Original source tier that won (see [Source priority](#source-priority)) |
| `cached` | `true` when served from the 7-day disk cache; `false` when just generated |
| `cachedAt` | ISO timestamp when the PNG was first generated |

### Source priority

The first tier to produce a usable icon ≥ 128px wins. ICO files are excluded (frames are typically too small).

1. `svg`
2. `manifest`
3. `apple-touch-icon`
4. `png`
5. `og-image` (`og:image` / `twitter:image` / `msapplication-TileImage`; near-square only for the chosen favicon — widescreen share cards are listed in scraper discovery / `/{domain}/json` but not selected as the default)
6. `selfhst` / `dashboardicons` / `lobehub` / `svgl` / `thesvg` (catalog fallbacks when a slug matches)
7. `external` (Google faviconV2 as last resort)

Within each tier, larger declared sizes are preferred.

### Error responses

All errors return JSON with `error`, `code`, and extra context where useful.

| Status | Code | Meaning |
|---|---|---|
| 400 | `missing_url` | Missing `url` query parameter |
| 400 | `invalid_url` | URL could not be parsed |
| 401 | `missing_api_key` | No key provided (when required) |
| 401 | `invalid_api_key` | Key not recognized or revoked |
| 422 | `favicon_not_found` | No usable icon found |
| 422 | `favicon_not_processable` | Icon found but could not be decoded — includes `sourceType` and `sourceUrl` for diagnostics |
| 429 | `quota_exceeded` | Monthly quota reached — body includes `plan`, `limit`, `used`, `period` |
| 500 | `internal_error` | Server error |

### Plans and quotas

Quotas apply only when `API_REQUIRE_KEY=true`.

| Plan | Env var | Default |
|---|---|---|
| `free` | `PLAN_FREE_LIMIT` | 25 |
| `pro` | `PLAN_PRO_LIMIT` | 2500 |
| `enterprise` | `PLAN_ENTERPRISE_LIMIT` | 0 (unlimited) |

`0` means no limit. The plan assigned at key creation determines the monthly cap.

**Quota rules** (matching FaviconAPIs behaviour):

- A request counts toward the monthly quota **only when the API returns `200`**
- `4xx` and `5xx` responses do not consume quota
- `cached: true` responses **do** count — the API authenticated you and returned a valid result
- Quotas reset each calendar month (UTC, `YYYY-MM`)

To disable plans entirely, set `API_REQUIRE_KEY=false`.

### CDN route

```
GET /cdn/favicons/{domain}.png
```

Public read-only mirror of `API_CACHE_DIR` (default `/cache/api/`).

| Header | Value |
|---|---|
| `Content-Type` | `image/png` |
| `Cache-Control` | `public, max-age=604800, immutable` |

HTTP intermediaries (or a CDN in front of this service) can cache the PNG for the full 7 days.

Returns **404** when no PNG has been generated for that domain yet — safe to expose publicly. Callers must hit `/api/v1/favicon` first to populate the cache (with a valid key when `API_REQUIRE_KEY=true`, or without when public mode is enabled).

To warm the v1 cache for hundreds of popular domains in one run, use the preload CLI described in [Performance — Preload popular sites](performance.md#10-preload-popular-sites-after-deploy) (`scripts/preload-top-sites.js`).

### Managing API keys

Keys are stored in SQLite at `API_KEYS_DB` (default `/cache/api-keys.sqlite` on the cache volume). Only the SHA-256 hash is persisted; the raw key is shown once at creation. The CLI is `scripts/manage-keys.js`.

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

Prefix `fa_` + 24 characters from a base32-style alphabet (no `0/O/1/I`), ~120 bits of entropy. The visible prefix in `keys:list` is the first 11 characters — enough to revoke unambiguously without leaking the secret.

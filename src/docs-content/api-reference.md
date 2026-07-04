# API Reference

This page lists every endpoint, URL scheme, JSON discovery, and caching behaviour.

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

## Complete endpoint table

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
| `GET /logodev/{size}/{domain}` | [logo.dev](https://www.logo.dev/) — requires `LOGODEV_TOKEN`; **503** when unset |
| `GET /brandfetch/{size}/{ext}/{domain}` | [Brandfetch](https://docs.brandfetch.com/logo-api/overview) (alias `/bf/`). Requires `BRANDFETCH_CLIENT_ID`. SVG: `/brandfetch/0/svg/{domain}`. Raster: 16–512. `?type=icon\|symbol\|logo`, `?theme=light\|dark` |
| `GET /selfhst/{size}/{format}/{service}` | [selfh.st icons](https://github.com/selfhst/icons) (alias `/sh/`). `?variant=color\|light\|dark` |
| `GET /dashboardicons/{size}/{format}/{service}` | [Dashboard Icons](https://github.com/homarr-labs/dashboard-icons) (alias `/di/`) |
| `GET /lobehub/{size}/{format}/{service}` | [LobeHub icons](https://www.npmjs.com/package/@lobehub/icons-static-svg) (alias `/lb/`). Light/dark serve theme PNGs when available |
| `GET /svgl/{size}/{format}/{service}` | [SVGL](https://github.com/pheralb/svgl) (alias `/sv/`). Default format is SVG (`/svgl/0/svg/{service}`) |
| `GET /services/resolve/{service}` | Resolve a search term to canonical slugs per catalog |
| `GET /s-asset?url=...` | Server-side asset proxy for scraper-discovered icons. Cached, SSRF-guarded |
| `GET /search?q={query}` | Browser search — redirects to `/?q={query}` |
| `GET /opensearch.xml` | OpenSearch descriptor |
| `GET /providers` | JSON: enabled providers, `urlMode`, API settings |
| `GET /{domain}/json` | JSON discovery for a domain |
| `GET /{app-name}/json` | JSON discovery for a service name |
| `GET /api/v1/favicon?url=...` | FaviconAPIs-compatible JSON |
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
https://your-host/brandfetch/128/png/github.com
https://your-host/github.com/json
https://your-host/jellyfin/json
https://your-host/search?q=%s
```

## Scraper cache bypass

Append `?refresh=1` to `/scraper/{domain}` (or sized variant) to clear cached scraper entries before fetching again.

Use when a site changed its favicon, after scraper fixes, or when debugging stale results. `?nocache=1` is an alias.

## JSON discovery (`/{domain}/json` and `/{app-name}/json`)

Returns proxy and upstream `source` URLs for every applicable provider.

| Path | Input | Top-level fields |
|---|---|---|
| `/{domain}/json` | Domain with a dot | `domain`, `endpoints` (website providers + catalog blocks) |
| `/{app-name}/json` | Service name without a dot | `service`, `endpoints.best`, `endpoints.resolve`, catalog blocks |

### Service-icon blocks (`selfhst`, `dashboardicons`, `lobehub`, `svgl`)

Each block is empty (`service: null`, …) when that catalog has **no matching slug**.

**Variants** list only assets confirmed to exist:

- **selfh.st** and **dashboardicons** — color / light / dark after CDN probe (24 h cache)
- **lobehub** — light/dark probed against `@lobehub/icons-static-png` theme assets
- **svgl** — SVG listed as primary; top-level `png` entry for raster URLs

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
  "urlMode": "proxy",
  "upstreamIpv4": true,
  "api": {
    "requireKey": false,
    "cacheTtl": 604800,
    "plans": { "free": 25, "pro": 2500, "enterprise": 0 }
  }
}
```

- `urlMode` — mirrors `UI_CARD_URL` (`proxy` or `source`)
- `includeAppIcons` — mirrors `UI_INCLUDE_APP_ICONS` (default checkbox state)

## Response behavior

| Condition | Typical response |
|---|---|
| Successful lookup | `200` with appropriate content type |
| Icon not found | `404` |
| Upstream failure | `502` |
| logo.dev / Brandfetch without credentials | `503` |
| Invalid domain / hostname | `400` |

## HTTP caching

Provider **image** routes use memory LRU + disk cache. TTLs: [Getting Started - Configuration](/docs/getting-started#configuration).

**JSON discovery** routes send `Cache-Control: no-cache`.

The v1 CDN route sends `Cache-Control: public, max-age=604800, immutable` (7 days).

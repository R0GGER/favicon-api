# API v1

This page is the full API v1 guide.

## Endpoint

```
GET /api/v1/favicon?url={website}
```

## Authentication

By default, API keys are **required** (`API_REQUIRE_KEY=true`).

For self-hosted setups that want a fully public endpoint, set `API_REQUIRE_KEY=false` (the bundled `docker-compose.yml` does this). In that mode:

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

### Windows PowerShell

`curl` is an alias for `Invoke-WebRequest` and will not accept `-H "Authorization: ..."`. Use `curl.exe` or:

```powershell
Invoke-RestMethod "https://your-host/api/v1/favicon?url=https://github.com" `
  -Headers @{ Authorization = "Bearer fa_your_key_here" }
```

## Successful response

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
| `sourceType` | Original source tier that won (see below) |
| `cached` | `true` when served from the 7-day disk cache; `false` when just generated |
| `cachedAt` | ISO timestamp when the PNG was first generated |

### Source priority

The first tier to produce a usable icon ≥ 128px wins. ICO files are excluded (frames are typically too small).

1. `svg`
2. `manifest`
3. `apple-touch-icon`
4. `png`
5. `selfhst` / `dashboardicons` / `lobehub` / `svgl` / `thesvg` (catalog fallbacks when a slug matches)
6. `external` (Google faviconV2 as last resort)

Within each tier, larger declared sizes are preferred.

## Error responses

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

## Plans and quotas

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

## CDN route

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

To warm the v1 cache for hundreds of popular domains in one run, use the preload CLI described in [Tweaks — Preload popular sites](/docs/tweaks#10-preload-popular-sites-after-deploy) (`scripts/preload-top-sites.js`).

## Managing API keys

The CLI at `scripts/manage-keys.js` reads/writes `API_KEYS_DB` (default `/cache/api-keys.sqlite`, shared with the cache volume).

```bash
# Create — raw key printed once, only SHA-256 hash stored
npm run keys:create -- --label "customer A" --plan pro

# List active keys with this month's usage counter
npm run keys:list
npm run keys:list -- --all    # include revoked keys (kept for audit)

# Revoke — stops validating immediately, row kept in DB
npm run keys:revoke -- --prefix fa_abcdefgh

# Permanently remove key and usage history
npm run keys:delete -- --prefix fa_abcdefgh
```

Inside Docker:

```bash
docker compose exec maflplus-favicon-api npm run keys:create -- --label "customer A" --plan pro
```

### Key format

Prefix `fa_` + 24 characters from a base32-style alphabet (no `0/O/1/I`), ~120 bits of entropy. The visible prefix in `keys:list` is the first 11 characters — enough to revoke unambiguously without leaking the secret.

## Interactive documentation

Visit `/api` in a running instance for a live playground, code samples (curl, JavaScript, Node.js, Python, PHP, PowerShell), and adaptive UI that hides authentication sections when `API_REQUIRE_KEY=false`.

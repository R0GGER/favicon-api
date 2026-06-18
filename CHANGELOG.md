# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **HTML scraper provider** (`/s/{domain}`)
  - Parses the target site's HTML for `<link rel="icon">`, `shortcut icon`, `apple-touch-icon`, `apple-touch-icon-precomposed`, `mask-icon` and `fluid-icon`.
  - Reads the web app manifest (`<link rel="manifest">`) and merges its declared icons into the candidate list.
  - Honours `<base href>` and follows redirects to resolve relative URLs against the final document URL.
  - Adds standard fallbacks: `/favicon.ico`, `/apple-touch-icon.png`, `/apple-touch-icon-precomposed.png`.
  - Probes well-known larger size variants on CDN paths that follow an `NxN` naming pattern (e.g. `64x64.png` → `128x128.png`, `256x256.png`, `512x512.png`) to recover hi-res icons that SPAs only inject client-side.
  - Score-ranks candidates by declared `sizes` attribute and format (SVG > PNG > WebP > ICO), then verifies real image dimensions via `sharp` and picks the largest valid result.
  - New `cheerio` dependency for HTML parsing.
- **Google v2 provider** (`/g2/{size}/{domain}`)
  - Uses `t0.gstatic.com/faviconV2` for higher-resolution Google icons.
  - Supported sizes: 16, 32, 64, 128, 256.
- **Faviconkit provider** (`/k/{size}/{domain}`)
  - Uses `ico.faviconkit.net`. Supported sizes: 16, 32, 64, 128, 256.
- **logo.dev provider** (`/l/{domain}`)
  - Optional, gated by the new `LOGODEV_TOKEN` environment variable.
  - Returns HTTP 503 when the token is not configured.
- **selfhst icons lookup** (`/sh/{service}`)
  - Service-name lookup against the [selfhst icons](https://github.com/selfhst/icons) catalog via `cdn.jsdelivr.net`.
  - Supports `?variant=color|light|dark`.
  - Service slug validation: lowercase alphanumerics with `.`, `_`, `-`.
- **Provider configuration endpoint** (`/providers`)
  - Reports which optional providers are enabled (currently `logoDev`) and exposes the publishable logo.dev token to the UI for direct image references.
- **`/{domain}/json` endpoint expansion**
  - Now includes Google v2, Faviconkit (sized variants), Vemetric (default + sized + format variants), logo.dev, HTML scraper and selfhst entries (with `color`/`light`/`dark` variants).
  - Each endpoint exposes both a `proxy` URL (this server) and a `source` URL (upstream provider) for transparency.
- **Best-pick cascade** (`/{domain}`) updated to include the new providers
  - New default fallback order: scraper → Google v2 → DuckDuckGo → Google → Faviconkit → Favicon.so → Vemetric → Favicon-3j1 → Yandex.
  - When `LOGODEV_TOKEN` is set, logo.dev is inserted near the top of the cascade.
- **Web UI**
  - New cards for HTML Scraper, Faviconkit (with size buttons 16–256), logo.dev (only shown when the server reports it as configured) and selfhst icons (with color/light/dark variant buttons).
  - Search input now accepts both a domain (e.g. `example.com`) and a bare service name without a TLD (e.g. `radarr`, `sonarr`); when no dot is present the input is treated as a selfhst service name and only the selfhst card is shown.
  - "Also include selfhst icon lookup when searching a domain" toggle to additionally probe a derived service slug for any domain query.
  - Quick-link suggestions extended with self-hosted service examples (`firefox`, `immich`, `jellyfin`).
  - Front-end fetches `/providers` on load to conditionally show or hide the logo.dev card.
- **Configuration**
  - New `LOGODEV_TOKEN` environment variable, documented in `README.md`, `.env.example` and `docker-compose.yml`.
- **Documentation**
  - `README.md` rewritten to cover all new endpoints, the size matrix per provider, the selfhst lookup, the `/providers` endpoint, and the `LOGODEV_TOKEN` variable.
  - Endpoint table consolidated to use parameterised paths (e.g. `/g/{size}/{domain}`) instead of one row per size.

### Changed

- `docker-compose.yml` defaults back to the published image `ghcr.io/r0gger/maflplus-favicon-api:latest` (the local `build: .` line is kept commented out for development).
- Best-pick (`/{domain}`) now scrapes the source site first, falling back to network providers only when scraping does not yield a usable icon — typically improving icon quality and resilience for self-hosted/private domains.

### Internal

- `services.txt` added to `.gitignore` (local notes file).

---

## [1.0.0] — Initial public release

### Added

- Express-based favicon proxy with two-tier (memory + disk) caching.
- Domain-based providers:
  - Google (`/g/{size}/{domain}`) — sizes 16, 32, 64, 128.
  - DuckDuckGo (`/d/{domain}`).
  - Yandex (`/y/{domain}`).
  - Favicon.so (`/f/{domain}`).
  - Vemetric (`/v/{domain}`) with optional `?size=` and `?format=png|jpg|webp`.
  - Favicon-3j1 (`/p/{domain}`).
- Best-pick endpoint (`/{domain}`) cascading through all providers and scoring results with `sharp`.
- `/{domain}/json` endpoint listing every favicon URL for a given domain.
- Web UI (`src/public/index.html`):
  - Per-provider cards with click-to-copy URL behaviour.
  - Top navigation bar linking to MAFL+, the Favicon API repo and the Wiki.
  - Bookmarklet ("Mafl+ Favicon Copy") that copies the favicon URL of the current page.
  - "Show source" indicator displaying which upstream provider returned the favicon.
- Configuration via environment variables: `PORT`, `CACHE_DIR`, `MEMORY_CACHE_MAX`, `MEMORY_CACHE_TTL`, `DISK_CACHE_TTL`, `UPSTREAM_TIMEOUT`.
- Dockerfile, `docker-entrypoint.sh` and `docker-compose.yml` for container deployment, plus a GitHub Actions workflow that publishes images to `ghcr.io/r0gger/maflplus-favicon-api`.
- `.gitattributes` enforcing LF line endings.

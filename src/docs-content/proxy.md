# Proxy

Deploy FaviconAPI behind a reverse proxy (nginx, Caddy, or Traefik). Covers HTTPS headers, canonical URLs, and SEO tag behaviour when `trust proxy` is enabled.

## Reverse proxy

`trust proxy` is enabled. Honored headers:

- `X-Forwarded-Proto` — HTTPS in SEO tags and redirects
- `X-Forwarded-Host` / `Host` — canonical URLs

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name favicons.example.com;

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Traefik

Label the service; forwarded headers must reach the container. No application-level hostname config required.

### Caddy

`reverse_proxy` sets `X-Forwarded-Proto`, `X-Forwarded-Host`, and
`X-Forwarded-For` automatically — no extra header directives needed (unlike
nginx above). When Caddy terminates TLS, the upstream receives
`X-Forwarded-Proto: https`, so canonical URLs and SEO tags use `https://`.

Minimal setup (security headers only — do **not** set a global `Cache-Control`
here; see [Caddy optimizations](#caddy-optimizations)):

```caddy
(sec_headers) {
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "SAMEORIGIN"
		Content-Security-Policy "upgrade-insecure-requests"
		Referrer-Policy "strict-origin-when-cross-origin"
		Permissions-Policy interest-cohort=()
		-Server
		-X-Powered-By
	}
}

favicon.example.com {
	import sec_headers
	reverse_proxy 172.17.0.1:3100
}
```

### Caddy optimizations

These changes improve **repeat page loads** and **icon delivery**. First-hit
latency for uncached domains is dominated by upstream scraping (see
[Tweaks](tweaks.md)); Caddy cannot fix that — it can only compress, multiplex,
and avoid re-fetching what the app already marked cacheable.

#### 1. Compress text responses (`encode`)

Enable `zstd` + `gzip` so HTML, CSS, JS, and JSON shrink on the wire. PNGs and
other already-compressed images are skipped automatically (Caddy only encodes
compressible types).

```caddy
favicon.example.com {
	encode zstd gzip
	import sec_headers
	reverse_proxy 172.17.0.1:3100
}
```

Stock Caddy prefers `zstd` when the browser advertises it (Chrome/Firefox/
Safari recent versions). Brotli needs a custom build (`caddy-brotli`); for most
deployments `zstd gzip` is enough.

#### 2. Do not override `Cache-Control` globally

FaviconAPI already sets path-appropriate cache headers:

| Path | App `Cache-Control` |
|---|---|
| `/assets/*.css`, `/assets/*.js` | `public, max-age=31536000, immutable` |
| `/cdn/favicons/*.png` | `public, max-age=604800, immutable` (default) |
| `/scraper/...`, `/s-asset`, `/{domain}` icons | `public, max-age=86400` (+ `immutable` where applicable) |
| HTML pages (`/`, docs, API UI) | `no-cache` |

A site-wide `Cache-Control "public, max-age=15, must-revalidate"` **wins over
the upstream headers** and forces browsers to revalidate hashed assets and CDN
icons every 15 seconds — that hurts page load far more than it helps freshness.

Keep security headers in a snippet; leave caching to the app. If you must set
cache policy in Caddy, scope it per path and never shorten the immutable asset /
CDN routes:

```caddy
favicon.example.com {
	encode zstd gzip
	import sec_headers

	# Optional: only if you want Caddy to own HTML freshness
	@html path / /docs* /api.html
	header @html Cache-Control "no-cache"

	reverse_proxy 172.17.0.1:3100
}
```

#### 3. HTTP/3 (QUIC) — open UDP/443

Modern Caddy advertises HTTP/3 by default when it terminates TLS. Browsers on
lossy or high-latency networks benefit from QUIC (no TCP head-of-line blocking).
Ensure the firewall allows **UDP/443** as well as TCP/443:

```bash
# nftables / ufw / security group: allow 443/udp inbound to Caddy
```

Verify negotiation:

```bash
curl --http3 -sI https://favicon.example.com/ | head -n 5
# or inspect response headers for: alt-svc: h3=":443"; ma=...
```

**Behind Cloudflare?** Disable Cloudflare’s HTTP/3 instead (see
[Cloudflare](#cloudflare)) — the ~2s QUIC stall applies to the edge, not to
origin Caddy. Prefer either Cloudflare-as-edge *or* Caddy HTTP/3, not both
fighting over `alt-svc`.

To pin protocols (e.g. disable h3 on a broken middlebox):

```caddy
{
	servers {
		protocols h1 h2
		# omit h3 to stop advertising HTTP/3
	}
}
```

#### 4. Keep-alive and buffers to the Node upstream

Keep-alive to the upstream is on by default (idle timeout **2m**). Raise the
idle pool and buffers if you serve many concurrent icon requests — default
read/write buffers are only **4KiB**:

```caddy
favicon.example.com {
	encode zstd gzip
	import sec_headers

	reverse_proxy 172.17.0.1:3100 {
		transport http {
			keepalive_idle_conns 64
			keepalive_idle_conns_per_host 32
			read_buffer 64KiB
			write_buffer 64KiB
		}
	}
}
```

#### 5. Optional: edge-cache immutable CDN icons

For high traffic, let Caddy serve repeat `/cdn/favicons/` hits without hitting
Node. Requires the [`cache`](https://caddyserver.com/docs/modules/http.handlers.cache)
handler (not in the stock binary — build with
`xcaddy build --with github.com/caddyserver/cache-handler`, or put Cloudflare /
another CDN in front).

Conceptually: cache only successful immutable PNG responses with a TTL matching
`API_CACHE_TTL` (default 7 days). HTML and JSON discovery routes should stay
uncached at the edge.

Simpler alternative without a custom build: put Cloudflare (or similar) in front
and cache `/cdn/favicons/*` and `/assets/*` by path — the app’s `immutable`
headers already allow it.

#### 6. Prefer early hints sparingly

Caddy can send `Link` preload headers, but FaviconAPI’s HTML already inlines or
references hashed `/assets/` URLs. Extra `103 Early Hints` usually adds little
unless you measure a clear win on the docs/homepage waterfall. Skip by default.

#### Recommended production snippet

```caddy
(sec_headers) {
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "SAMEORIGIN"
		Content-Security-Policy "upgrade-insecure-requests"
		Referrer-Policy "strict-origin-when-cross-origin"
		Permissions-Policy interest-cohort=()
		-Server
		-X-Powered-By
	}
}

favicon.example.com {
	encode zstd gzip
	import sec_headers

	reverse_proxy 172.17.0.1:3100 {
		transport http {
			keepalive_idle_conns 64
			keepalive_idle_conns_per_host 32
			read_buffer 64KiB
			write_buffer 64KiB
		}
	}
}
```

Checklist:

1. `encode zstd gzip` enabled
2. No global short `Cache-Control` overriding `/assets` and `/cdn/favicons`
3. TCP **and** UDP 443 open (HTTP/3), unless you intentionally disable h3
4. If Cloudflare is in front: disable Cloudflare HTTP/3 (see below)
5. App-side cache TTLs tuned — see [Tweaks](tweaks.md)

## Cloudflare

If you put the site behind Cloudflare's proxy (orange cloud), **disable HTTP/3
(with QUIC)**. Cloudflare advertises HTTP/3 via an `alt-svc` header, which makes
browsers attempt a QUIC connection over UDP/443. On networks where that UDP path
is blocked, filtered, or unreliable, the browser stalls on the failed QUIC
attempt for roughly **2 seconds** before falling back to TCP (HTTP/2) — adding a
consistent ~2s to page load, even though the server itself responds in a few
hundred milliseconds.

Turn it off in the Cloudflare dashboard:

> **Zone (`domain.tld`) → Speed → Settings → tab "Protocol Optimization" →
> disable "HTTP/3 (with QUIC)"**

After disabling, the `alt-svc: h3` header disappears and browsers connect over
HTTP/2, removing the delay. Verify with:

```bash
curl -sI https://domain.tld/ | grep -i alt-svc
```

No `alt-svc` line should be returned. Browsers that already cached the old
`alt-svc` record keep trying QUIC until it expires (up to 24h); clear the
browser's cached network state (or wait it out) to test immediately.


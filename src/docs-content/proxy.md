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

```yaml
(sec_headers) {
        header {
                Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
                X-Xss-Protection "1; mode=block"
                X-Content-Type-Options "nosniff"
                X-Frame-Options "SAMEORIGIN"
                Content-Security-Policy "upgrade-insecure-requests"
                Referrer-Policy "strict-origin-when-cross-origin"
                Cache-Control "public, max-age=15, must-revalidate"
                Permissions-Policy interest-cohort=()
                -server
                -X-Powered-By
        }
}

favicon.example.com {
        reverse_proxy 172.17.0.1:3100
        import sec_headers
}
```


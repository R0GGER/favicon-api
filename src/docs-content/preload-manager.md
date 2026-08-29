# Preload manager

A web interface for the preload database at `/admin`: domains, icon overrides, the blocklist, popularity stats, CSV import/export and preload runs — everything [`scripts/manage-preload.js`](performance.md) does, without a shell on the server.

The page is off by default. It only exists once you configure a signing secret and a password; until then `/admin` returns **404**, exactly as it did before the feature existed.

## Enable it

### 1. Generate a secret

Run it inside the container, so the key never touches your shell history on the host:

```bash
docker compose exec favicon-api npm run admin:secret
```

That prints a line to paste into `.env`, the gitignored file `docker-compose.yml` loads on top of `.env.example`:

```
ADMIN_SESSION_SECRET=9f2c…        # 64 random bytes, hex encoded
```

Always 512 bits (64 bytes), which signs **HS512** — the strongest of the two algorithms the server accepts, and there is nothing to gain from a shorter key.

The secret signs the session cookie; it is not the password.

### 2. Set a password

```bash
docker compose exec favicon-api npm run admin:password -- --user yourname
```

It asks for the password twice without echoing it, then prints the two lines to add to your `.env`:

```
ADMIN_USER=yourname
ADMIN_PASSWORD_HASH=scrypt:N=16384,r=8,p=1:…:…
```

The password itself is never stored — only the scrypt hash, which cannot be turned back into the password. Minimum length is 10 characters; `--user` defaults to `admin`. Piping the password in (`… | npm run admin:password`) works too and skips the confirmation prompt.

Both lines go in the same `.env`. Then recreate the container with `docker compose up -d` — `env_file` is read when the container is created, so a plain `restart` would keep the old values — and check the result with `docker compose exec favicon-api npm run admin:status`. Until both the secret and the hash are configured, `/admin` stays at 404 and the reason is logged at startup.

### 3. Sign in

Open `https://your-host/admin` and enter the username and password. Your password manager sees a normal login form, so it can store and fill both fields.

The server hands back a session token in an `HttpOnly`, `SameSite=Strict` cookie (`Secure` as well when you are on https). `ADMIN_SESSION_TTL` is an *idle* timeout: every action extends the session, so it only expires after an hour of doing nothing. Tick **Keep me signed in** to use `ADMIN_REMEMBER_TTL` (30 days by default) as that window instead.

## What you can do

| Tab | Actions |
|---|---|
| **Domains** | Search, sort by clicking a column header, and filter by state (on / off). Hide columns you do not need; the choice is remembered. Add a domain, edit usage rank and icon override inline, enable or disable, delete. Rank is rolling request count — a worldwide list position cannot outrank real traffic. Tick rows (or the header checkbox for the whole page) to disable, enable or delete several at once. |
| **Blocklist** | Add exact (`example.com`) or wildcard (`*.example.com`) patterns, seed the built-in service/infra set, unblock. |
| **Stats** | Domain, override and blocklist counts, the active configuration, hits per month and a **Recalculate ranks** button. |
| **Import / Export** | Download the CSV (all or enabled only), paste or upload one to import. Same column order as the CLI. |
| **Preload run** | Preview the ranked domain set in a modal (Most popular / Most visited / Highest keyword rank), start `preload-top-sites.js` against this instance, follow its log live, stop it, and generate a host crontab line from the same options. |

Edits made here behave exactly like CLI edits: adding, enabling, disabling or changing a domain marks the row as **manual**, so no automated pass (hit counting, preload writeback) flips it back.

### Preload runs

A run is a separate process, so it keeps going when you close the tab, and its progress is visible from every cluster worker. A lock file next to the database prevents two runs at once; if the process disappears mid-run the state is reported as **interrupted** and the lock is cleared automatically.

`Dry run` lists the selected domains without calling the API — the quickest way to check what a set of filters would actually warm. **View list** opens a modal with a ranked table (domain and Adult columns, no icons).

`Timeout` is the per-request budget passed to the script as `--timeout`, in milliseconds. The default of 30000 is enough for most domains, but slow sites need more: raise it to 60000 for a scheduled run. A domain that runs out of budget shows up in the log as `This operation was aborted` and the run continues with the next one.

**Schedule with cron** turns the current form into a crontab line for the host (`docker exec` or `docker compose exec -T`). It tracks source, adult include/exclude, limit, min rank, concurrency, timeout and skip flags; dry run is omitted so a scheduled job actually warms the cache. Optional **Recalculate ranks first** prepends `manage-preload.js recalc` when the source is the preload database. Paste the line with `crontab -e`. Cron's `PATH` is minimal, so the generator uses the full docker binary path. See [Performance §10](performance.md#automate-with-cron) for the recommended Sunday 03:00 schedule.

The run form can pull three worldwide sets: **most popular** ([Backlinko / Semrush](https://backlinko.com/most-popular-websites), top 100, NSFW already removed), **most visited** ([SimilarWeb](https://www.similarweb.com/top-websites/), public top 50, remaining slots filled from Backlinko) and **highest keyword rank** (DataForSEO). **Adult / porn domains** is include or exclude — SimilarWeb's Adult-category sites are dropped when you pick exclude.

A live run from one of those sets stores the domains in the list with that source (`backlinko`, `similarweb`, `dataforseo`) and a 1-based list position (`#1` on the Source column). Usage rank is not overwritten. Dry run does not write.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ADMIN_SESSION_SECRET` | *(unset)* | Signing key for the session cookie. Unset, or shorter than 32 bytes, keeps `/admin` at 404. Legacy name `ADMIN_JWT_SECRET` still works, with a deprecation warning. |
| `ADMIN_PASSWORD_HASH` | *(unset)* | scrypt hash of the login password. Unset or malformed keeps `/admin` at 404. |
| `ADMIN_USER` | `admin` | Login name. |
| `ADMIN_SESSION_TTL` | `3600` | Idle timeout in seconds of a normal session. |
| `ADMIN_REMEMBER_TTL` | `30d` | Idle timeout when **Keep me signed in** was ticked. Takes `30d`, `12h`, `45m` or seconds. |
| `ADMIN_LOGIN_MAX_ATTEMPTS` | `10` | Failed sign-ins per IP per 15 minutes before further attempts are refused. |

## Security notes

- **Anyone who can sign in** can change which domains get preloaded and which images are served for them. Pick a password you do not use elsewhere.
- **Rotating `ADMIN_SESSION_SECRET` signs everyone out at once** — there is no session store to clear, by design: nothing is kept server-side. Changing `ADMIN_PASSWORD_HASH` blocks new sign-ins but leaves live sessions running until they idle out, so rotate the secret as well if that matters.
- The password is stored as scrypt (N=16384, r=8, p=1) with a random 16-byte salt. A wrong username still costs a full hash computation, so response time does not reveal which field was wrong.
- The hash is colon-separated and base64url encoded on purpose: `docker compose` interpolates `$name` inside an `env_file`, so a PHC-style `scrypt$N=…` hash would reach the server mangled and `/admin` would silently stay at 404.
- Admin responses are sent with `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow` and `X-Frame-Options: DENY`, without the permissive CORS headers the icon routes carry, and `/admin` is disallowed in `robots.txt`.
- Requests that change something must carry an `X-Admin-Request: 1` header. Together with `SameSite=Strict` that keeps another site from driving the API with your cookie.
- Put the page behind your reverse proxy's TLS. Over plain http the cookie cannot be marked `Secure`.
- Sign-in attempts are throttled per worker, so the effective limit is `ADMIN_LOGIN_MAX_ATTEMPTS × WORKERS` per window.

## Icon overrides take a moment to apply

Each worker re-reads the override table when the database file changes, at most once per `PRELOAD_OVERRIDE_RELOAD_MS` (default 30s). A new or changed icon override is live within that window; the blocklist applies immediately in the worker that made the change and within the same window elsewhere.

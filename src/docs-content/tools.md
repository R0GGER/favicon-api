# Tools

## Browser Search

Look up favicons straight from your browser's address bar — type a domain or app name and land on the FaviconAPI homepage with results already loaded.

### Search URL

Add this as a custom search engine in Chrome, Edge, or Firefox:

```
https://your-host/search?q=%s
```

`%s` is the placeholder your browser replaces with whatever you type. Example: searching for `github.com` opens:

```
https://your-host/search?q=github.com
```

That redirects to `/?q=github.com`, which runs the same lookup as the homepage search box (domain favicons and, when enabled, service-icon catalogs).

### Install

1. Open the homepage and click **Tools** in the top navigation.
2. Click **Search from browser** (under **Browser search**).
3. Copy the URL from the modal, or follow the step-by-step guide for your browser.

**Firefox shortcut:** the homepage exposes [OpenSearch](api-reference.md) at `/opensearch.xml`. Firefox may show **Add search engine** automatically when you visit the site.

Suggested values when adding manually:

| Field | Value |
|---|---|
| Name | `FaviconAPI` |
| Keyword / Shortcut | `fav` (optional) |
| URL | `https://your-host/search?q=%s` |

### Use

1. Focus the address bar.
2. Type your keyword (if you set one, e.g. `fav`) followed by a space, **or** pick **FaviconAPI** from the search-engine list.
3. Enter a domain (`reddit.com`) or app name (`immich`).
4. The homepage opens with favicon cards for that query.

Works for both website domains and service-icon lookups (same rules as the homepage: domains contain a dot, app names do not).

### Browser notes

| Browser | Support |
|---|---|
| **Chrome** | Settings → Search engine → Manage search engines and site search → Add |
| **Edge** | Settings → Privacy, search, and services → Address bar and search → Manage search engines → Add |
| **Firefox** | OpenSearch auto-detect, or Settings → Search → Search Shortcuts → Add |
| **Safari** | No custom search-engine URLs on desktop; use the [bookmarklet](#bookmarklet) instead |

On iPhone/iPad Safari, only built-in search engines are available.


## Build custom URL

Build a **shareable URL template** that returns favicons and service icons with *your* preferred provider order, fallbacks, and minimum size — encoded in the URL itself. No account, no database, no per-site configuration on the server.

```
https://your-host/{id}/{domain-or-appname}
```

Generate `{id}` once from **Tools → Build custom URL** on the homepage (live preview and copy), then swap `{domain-or-appname}` for each site or app you need an icon for. The same `{id}` works for every target.

### Why use it?

The default `GET /{domain}` endpoint picks the best icon from all providers. A custom URL lets you **pin a resolution strategy** instead:

- Prefer your own HTML scraper, then fall back to Google and DuckDuckGo.
- Require at least 64×64 so dashboard tiles never look blurry.
- Prefer self-hosted icon catalogs (`selfhst`, `dashboardicons`, `lobehub`) for homelab app names like `immich` or `jellyfin`.
- Share one URL pattern with your team — everyone gets the same icon quality and fallback behaviour.

Because settings live in the path, you can paste a single base URL into config files, bookmark managers, or `<img src="…">` tags and only change the trailing segment per item.

### Use cases

| Scenario | How it helps |
|---|---|
| **Dashboards** ([Mafl+](https://maflplus.eu/), Homer, Heimdall, Dashy, …) | One icon URL pattern for every tile: `/{id}/github.com`. Swap the domain per link; provider order and minimum size stay fixed. |
| **Password managers** (Bitwarden, Vaultwarden, KeePass plugins) | Attach consistent, high-quality icons to login entries without hunting for each site's favicon manually. |
| **Homelab / self-hosted launchers** | Mix website domains (`nextcloud.example.com`) and catalog app names (`immich`, `plex`) in the same template when fallbacks include service-icon providers. |
| **Status & monitoring** (Uptime Kuma, Grafana, …) | Uniform icon size and fallback chain across dozens of monitored endpoints. |
| **RSS readers & feed lists** | Stable icon URLs next to feed titles; no per-feed icon upload. |
| **Internal portals & wikis** | Link lists, service catalogs, and "quick links" pages with matching icons at a chosen minimum size. |
| **Browser start pages & bookmark tools** | Custom new-tab pages or bookmark extensions that load icons from one predictable URL shape. |
| **Apps & integrations** | Bots, mobile widgets, or scripts that need a favicon URL without calling the JSON API or hard-coding provider paths. |

### Quick start

1. Open the homepage → **Tools** → **Build custom URL**.
2. Choose a **preferred provider**, up to **four fallbacks** (numbered 1–4), and a **minimum size** (`16`, `32`, `64`, or `128`).
3. Preview with a sample domain or app name, then **Copy URL**.
4. Replace the sample target with any domain (`github.com`) or app name (`immich`):

```
https://your-host/{generated-id}/github.com
https://your-host/{generated-id}/jellyfin
```

The `{id}` is a URL-safe base64url string (minimum 20 characters, opaque in the Web UI) that encodes the whole configuration.

### Resolution

The chain `[preferred, …fallbacks]` is tried in order; the first usable icon wins:

| Source type | Rule |
|---|---|
| **SVG** | Satisfies any minimum size; served as-is (`image/svg+xml`). |
| **Raster** | Source must be ≥ the minimum size on its smaller side; output is PNG at exactly that size. |
| **Failure** | Try the next fallback; if the whole chain fails → transparent `404`. |

Minimum sizes: `16`, `32`, `64`, `128`.

### Encoding

The id is base64url of a compact JSON array:

```js
// [version, preferredProvider, [fallbacks...], minSize]
[1, "scraper", ["googlev2", "duckduckgo"], 128]
```

**Providers** — any from the **favicon providers** or **service-icon** catalogs tables.

**Credentials** — `logodev` and `brandfetch` steps are skipped when their tokens are not configured.

**App names** — domain-only providers (scraper, raster providers, brandfetch) are skipped when the target has no dot (service name).

## Bookmarklet

Copy a site's favicon URL from any page you visit — without opening the FaviconAPI homepage first.

### Install

1. Open the homepage and click **Tools** in the top navigation.
2. Find **Bookmarklet** and **drag** the purple **FaviconAPI Copy** button to your browser's bookmarks bar.

Do not click the button or copy its URL manually — browsers only auto-fill the bookmark name **FaviconAPI Copy** when you drag it. If you add the link by hand, you must type the name yourself.

The bookmarklet is tied to **your** FaviconAPI instance: it uses the origin of the page where you dragged it (e.g. `https://favicons.example.com`).

### Use

1. Browse to any website (e.g. `https://github.com`).
2. Click the **FaviconAPI Copy** bookmark in your bookmarks bar.

The bookmarklet:

- Reads the current page's hostname (`github.com`).
- Builds the best-pick favicon URL: `https://your-host/github.com` (same as `GET /{domain}`).
- Copies that URL to your clipboard.
- Shows a short on-page toast with a preview of the icon and a clickable link (dismisses after 5 seconds).

If the page has no hostname (e.g. a blank tab or `file://` URL), you get an alert instead.

<div class="docs-tool-card">
<p><span class="docs-drag-hint">Drag</span> the button to your bookmarks bar (don't click &amp; copy &mdash; the name will only auto-fill when dragging). Click the saved bookmark on any page to copy that site's favicon URL.</p>
<a class="bookmarklet-btn" data-bookmarklet href="#" draggable="true" title="Drag me to your bookmarks bar" onclick="bookmarkletClicked(event)"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v13.5a.5.5 0 0 1-.777.416L8 13.101l-5.223 2.815A.5.5 0 0 1 2 15.5V2z"/></svg> FaviconAPI Copy</a>
</div>

### Tips

- Works in Chrome, Edge, Firefox, and other browsers that support JavaScript bookmarklets.
- Safari on desktop has limited support for custom bookmark JavaScript; use Chrome, Edge, or Firefox, or use **Browser search** instead.
- The copied URL returns the icon directly — paste it into a dashboard tile, `<img src="…">`, or anywhere you need a favicon link.


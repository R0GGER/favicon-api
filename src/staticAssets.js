// Boot-time asset splitter. The homepage / API / docs templates ship their CSS
// and JS as large inline <style>/<script> blocks. Serving those inline means the
// browser re-downloads and re-parses ~250 KB on every navigation and can never
// cache the styling/behaviour separately from the (per-request templated) HTML.
//
// extractPageAssets() pulls the inline blocks out at startup, optionally
// minifies them, content-hashes them and hands back a shrunk HTML template that
// references the extracted files via <link>/<script src>. The extracted bytes
// live in an in-memory map (no files written to disk); identical blocks shared
// between pages collapse to the same hashed URL automatically (dedup), so they
// are downloaded and cached once.

const crypto = require('crypto');

let esbuild = null;
try {
  esbuild = require('esbuild');
} catch {
  // esbuild is optional: without it we serve the (un-minified) extracted blocks,
  // which still gives the caching / parallel-download / code-cache wins.
  esbuild = null;
}

// routePath -> { body: Buffer, contentType: string }
const assetStore = new Map();

function minifyCss(css) {
  if (!esbuild) return css;
  try {
    return esbuild.transformSync(css, { loader: 'css', minify: true }).code;
  } catch {
    return css;
  }
}

function minifyJs(js) {
  if (!esbuild) return js;
  try {
    // Keep identifier names: the extracted script declares top-level functions
    // (quickFetch, copyApiUrl, ...) that are referenced from inline onclick=
    // handlers in the HTML, so renaming globals would break them. Whitespace +
    // safe syntax compaction is where the bulk of the savings are anyway.
    return esbuild.transformSync(js, {
      loader: 'js',
      minifyWhitespace: true,
      minifySyntax: true,
      minifyIdentifiers: false,
      legalComments: 'none',
    }).code;
  } catch {
    return js;
  }
}

function registerAsset(content, ext, contentType) {
  const body = Buffer.from(content, 'utf8');
  const hash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
  const routePath = `/assets/${hash}.${ext}`;
  if (!assetStore.has(routePath)) {
    assetStore.set(routePath, { body, contentType });
  }
  return routePath;
}

// First inline stylesheet: the page's own <style> block (bare, no attributes).
const STYLE_RE = /<style>([\s\S]*?)<\/style>/;
// The page's main script: the only attribute-less <script> block. The JSON-LD
// script carries type="application/ld+json" and the iconify script carries a
// src=, so neither matches <script> exactly. The offline-search generator embeds
// a <script>…<\/script> as a template-literal string with an escaped closing
// tag, so the first real </script> after the opening tag closes the whole block.
const SCRIPT_RE = /<script>([\s\S]*?)<\/script>/;

// Extract the inline <style> and main <script> from an HTML template, register
// them as hashed in-memory assets and return the shrunk template plus the asset
// paths. The server-side template tokens (__BASE_URL__, __VERSION__, …) all live
// in the head/body markup, never inside these blocks, so the extracted bytes are
// static and safe to serve with a long immutable cache.
function extractPageAssets(template) {
  let html = template;
  let cssPath = null;
  let jsPath = null;

  const styleMatch = html.match(STYLE_RE);
  if (styleMatch) {
    const css = minifyCss(styleMatch[1]);
    cssPath = registerAsset(css, 'css', 'text/css; charset=utf-8');
    html = html.replace(STYLE_RE, () => `<link rel="stylesheet" href="${cssPath}">`);
  }

  const scriptMatch = html.match(SCRIPT_RE);
  if (scriptMatch) {
    const js = minifyJs(scriptMatch[1]);
    jsPath = registerAsset(js, 'js', 'text/javascript; charset=utf-8');
    html = html.replace(SCRIPT_RE, () => `<script defer src="${jsPath}"></script>`);
  }

  return { html, cssPath, jsPath };
}

function getAsset(routePath) {
  return assetStore.get(routePath) || null;
}

module.exports = { extractPageAssets, getAsset, assetStore };

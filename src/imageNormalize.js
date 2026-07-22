const sharp = require('sharp');
const decodeIco = require('decode-ico');
const crypto = require('crypto');

const TARGET_SIZE = 128;
// Minimum acceptable source image size (applies to ICO frames and raster images).
const MIN_SOURCE_SIZE = 128;
// When converting a scraped SVG to a display PNG, rasterize at the largest
// standard icon size so on-demand ?size= downsizing preserves quality.
const SVG_DISPLAY_SIZE = 512;

// Near-lossless indexed/palette PNG for capped scraper output. Real favicons are
// anti-aliased and carry 500-2000 colors, so a strictly bit-identical palette is
// almost never possible; allowing a ≤256-color quantization typically shrinks the
// file 25-55% with no perceptible change. The palette result is only used when it
// meets SCRAPER_PNG_MIN_PSNR (perceptual, alpha-premultiplied) AND is smaller.
const PNG_PALETTE_ENABLED = !/^(0|false|no|off)$/i.test(
  String(process.env.SCRAPER_PNG_PALETTE ?? 'true').trim()
);
// Minimum PSNR (dB) the palette PNG must reach vs. the source to be accepted.
// ∞ = bit-identical; ~50+ = visually indistinguishable; <35 starts to show.
// Default 40 = "visually lossless" while still capturing typical savings. Lower
// it to compress harder, raise it toward strict lossless. 0 = always take smaller.
const PNG_MIN_PSNR = (() => {
  const v = parseFloat(process.env.SCRAPER_PNG_MIN_PSNR);
  return Number.isFinite(v) && v >= 0 ? v : 40;
})();

function transparentBackground() {
  return { r: 0, g: 0, b: 0, alpha: 0 };
}

function resizeOptions() {
  return {
    fit: 'contain',
    background: transparentBackground(),
  };
}

function looksLikeSvg(buffer) {
  if (!buffer || buffer.length === 0) return false;
  const head = buffer
    .slice(0, Math.min(buffer.length, 512))
    .toString('utf8')
    .trim()
    .toLowerCase();
  return head.startsWith('<?xml') || head.startsWith('<svg');
}

function looksLikeIco(buffer) {
  if (!buffer || buffer.length < 4) return false;
  return (
    buffer[0] === 0x00 &&
    buffer[1] === 0x00 &&
    (buffer[2] === 0x01 || buffer[2] === 0x02) &&
    buffer[3] === 0x00
  );
}

// Sharp/librsvg cannot resolve CSS custom properties (e.g. favicon.so SVGs using
// var(--primary-fill) with prefers-color-scheme). Substitute light-mode defaults.
function preprocessSvgForRaster(buffer) {
  if (!buffer || buffer.length === 0) return buffer;
  const svg = buffer.toString('utf8');
  if (!svg.includes('var(')) return buffer;
  return Buffer.from(
    svg
      .replace(/var\(--primary-fill\)/gi, '#ffffff')
      .replace(/var\(--secondary-fill\)/gi, '#000000'),
    'utf8'
  );
}

function parseSvgLength(value) {
  if (value == null) return null;
  const match = String(value).trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(px|pt|em|rem|%)?$/i);
  if (!match) return null;
  const num = Number(match[1]);
  if (!Number.isFinite(num) || num <= 0) return null;
  const unit = (match[2] || 'px').toLowerCase();
  if (unit === '%') return null;
  if (unit === 'pt') return num * (96 / 72);
  return num;
}

function svgIntrinsicSize(svg) {
  const viewBox = svg.match(/viewBox\s*=\s*["']([^"']+)["']/i);
  if (viewBox) {
    const parts = viewBox[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      return { width: parts[2], height: parts[3] };
    }
  }

  const root = svg.match(/<svg\b([^>]*)>/i);
  if (!root) return null;
  const attrs = root[1];
  const widthMatch = attrs.match(/\bwidth\s*=\s*["']([^"']+)["']/i);
  const heightMatch = attrs.match(/\bheight\s*=\s*["']([^"']+)["']/i);
  const width = widthMatch ? parseSvgLength(widthMatch[1]) : null;
  const height = heightMatch ? parseSvgLength(heightMatch[1]) : null;
  if (width && height) return { width, height };
  return null;
}

// Pin the SVG root to an explicit pixel size before sharp/librsvg rasterizes.
// Large viewBox units (e.g. Google Analytics ~2200×2430) × density=size×4 can
// exceed sharp's input pixel limit and 500 on /svgl/128|256/png/….
function scaleSvgForRaster(buffer, maxEdge) {
  if (!buffer || buffer.length === 0 || !maxEdge) return buffer;
  const svg = buffer.toString('utf8');
  if (!/<svg\b/i.test(svg)) return buffer;

  const intrinsic = svgIntrinsicSize(svg);
  let width = maxEdge;
  let height = maxEdge;
  if (intrinsic) {
    const aspect = intrinsic.width / intrinsic.height;
    if (aspect >= 1) {
      width = maxEdge;
      height = Math.max(1, Math.round(maxEdge / aspect));
    } else {
      height = maxEdge;
      width = Math.max(1, Math.round(maxEdge * aspect));
    }
  }

  let replaced = false;
  const scaled = svg.replace(/<svg\b([^>]*)>/i, (_, attrs) => {
    replaced = true;
    const cleaned = attrs
      .replace(/\s*width\s*=\s*("[^"]*"|'[^']*')/gi, '')
      .replace(/\s*height\s*=\s*("[^"]*"|'[^']*')/gi, '');
    return `<svg${cleaned} width="${width}" height="${height}">`;
  });

  return replaced ? Buffer.from(scaled, 'utf8') : buffer;
}

async function rasterizeSvg(buffer) {
  return rasterizeSvgToSize(buffer, TARGET_SIZE);
}

async function rasterizeSvgToSize(buffer, size = TARGET_SIZE) {
  const renderEdge = Math.max(size * 4, size);
  const prepared = scaleSvgForRaster(preprocessSvgForRaster(buffer), renderEdge);
  return sharp(prepared)
    .resize(size, size, resizeOptions())
    .png()
    .toBuffer();
}

function pickLargestIcoFrame(frames) {
  let best = null;
  let bestArea = -1;
  for (const frame of frames) {
    if (!frame || !frame.width || !frame.height || !frame.data) continue;
    const area = frame.width * frame.height;
    if (area > bestArea) {
      best = frame;
      bestArea = area;
    }
  }
  return best;
}

// Build a sharp instance from a decode-ico frame. PNG frames are decoded by
// sharp directly; BMP frames come back from decode-ico as raw pixel data that is
// ALREADY in RGBA order, so it is handed to sharp as-is (no channel swap — an
// earlier BGRA→RGBA swap corrupted colours, turning e.g. Microsoft red into
// blue on ICOs that use BMP frames).
function icoFrameToSharp(frame) {
  if (frame.type === 'png') {
    return sharp(Buffer.from(frame.data));
  }
  const rgba = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
  return sharp(rgba, {
    raw: { width: frame.width, height: frame.height, channels: 4 },
  });
}

async function icoFrameToPng(frame) {
  return icoFrameToSharp(frame).png().toBuffer();
}

function entryLooksLikeIco(entry) {
  if (!entry?.buffer?.length) return false;
  const hint = `${entry.contentType || ''} ${entry.url || ''}`.toLowerCase();
  return looksLikeIco(entry.buffer) || hint.includes('ico') || hint.includes('x-icon');
}

// Decode ICO / x-icon (and SVG) to PNG bytes for browser <img> tags and /…/png/… routes.
async function normalizeEntryForPng(entry) {
  if (!entry?.buffer?.length) return entry;

  const contentType = (entry.contentType || '').toLowerCase();
  const isSvg = contentType.includes('svg') || looksLikeSvg(entry.buffer);
  if (!isSvg && !entryLooksLikeIco(entry)) return entry;

  const displayed = await toDisplayPng(entry.buffer, {
    contentType: entry.contentType,
    url: entry.url,
  });
  return {
    ...entry,
    buffer: displayed.buffer,
    contentType: 'image/png',
  };
}

// Sharp cannot read many ICO files (BMP frames). Use decode-ico as fallback.
async function readImageDimensions(buffer, { contentType = '', url = '' } = {}) {
  if (!buffer || buffer.length === 0) return null;

  try {
    const meta = await sharp(buffer).metadata();
    const width = meta.width || 0;
    const height = meta.height || 0;
    if (width > 0 && height > 0) {
      return {
        width,
        height,
        format: meta.format ? String(meta.format).toLowerCase() : null,
      };
    }
  } catch {
    /* fall through */
  }

  const hint = `${contentType} ${url}`.toLowerCase();
  if (looksLikeIco(buffer) || hint.includes('ico')) {
    try {
      const frame = pickLargestIcoFrame(decodeIco(buffer));
      if (frame) {
        return { width: frame.width, height: frame.height, format: 'ico' };
      }
    } catch {
      /* ignore */
    }
  }

  return null;
}

// Convert ICO / SVG (and other non-browser-friendly formats) to PNG for
// display in <img> tags. SVGs are rasterized to SVG_DISPLAY_SIZE so they
// don't render at an arbitrary browser-chosen resolution.
async function toDisplayPng(buffer, { contentType = '', url = '' } = {}) {
  if (!buffer || buffer.length === 0) {
    throw new Error('Empty image buffer');
  }

  const hint = `${contentType} ${url}`.toLowerCase();
  const isSvg = looksLikeSvg(buffer) || hint.includes('svg');
  const isIco =
    !isSvg && (looksLikeIco(buffer) || hint.includes('ico') || hint.includes('x-icon'));

  if (isSvg) {
    const png = await rasterizeSvgToSize(buffer, SVG_DISPLAY_SIZE);
    return {
      buffer: png,
      contentType: 'image/png',
      width: SVG_DISPLAY_SIZE,
      height: SVG_DISPLAY_SIZE,
      originalSvgBuffer: buffer,
    };
  }

  if (isIco) {
    const frame = pickLargestIcoFrame(decodeIco(buffer));
    if (!frame) throw new Error('ICO contained no decodable frames');
    const png = await icoFrameToPng(frame);
    return {
      buffer: png,
      contentType: 'image/png',
      width: frame.width,
      height: frame.height,
    };
  }

  return { buffer, contentType: contentType || 'application/octet-stream' };
}

async function rasterizeIco(buffer) {
  const frames = decodeIco(buffer);
  const frame = pickLargestIcoFrame(frames);
  if (!frame) throw new Error('ICO contained no decodable frames');

  if (frame.width < MIN_SOURCE_SIZE || frame.height < MIN_SOURCE_SIZE) {
    throw new Error(
      `ICO largest frame is ${frame.width}x${frame.height}, below minimum ${MIN_SOURCE_SIZE}px`
    );
  }

  return icoFrameToSharp(frame)
    .resize(TARGET_SIZE, TARGET_SIZE, resizeOptions())
    .png()
    .toBuffer();
}

async function rasterizeRaster(buffer) {
  const metadata = await sharp(buffer).metadata();
  if (
    !metadata.width ||
    !metadata.height ||
    metadata.width < MIN_SOURCE_SIZE ||
    metadata.height < MIN_SOURCE_SIZE
  ) {
    throw new Error(
      `Source image is ${metadata.width || 0}x${metadata.height || 0}, below minimum ${MIN_SOURCE_SIZE}px`
    );
  }

  return sharp(buffer)
    .resize(TARGET_SIZE, TARGET_SIZE, resizeOptions())
    .png()
    .toBuffer();
}

async function ensureExactSize(buffer) {
  const meta = await sharp(buffer).metadata();
  if (meta.width === TARGET_SIZE && meta.height === TARGET_SIZE) return buffer;
  return sharp(buffer)
    .resize(TARGET_SIZE, TARGET_SIZE, resizeOptions())
    .png()
    .toBuffer();
}

async function toPng(buffer, { hintFormat = null } = {}) {
  if (!buffer || buffer.length === 0) {
    throw new Error('Empty image buffer');
  }

  const hint = (hintFormat || '').toLowerCase();
  const isSvg = hint.includes('svg') || looksLikeSvg(buffer);
  const isIco = !isSvg && (hint.includes('ico') || looksLikeIco(buffer));

  let png;
  if (isSvg) {
    png = await rasterizeSvg(buffer);
  } else if (isIco) {
    png = await rasterizeIco(buffer);
  } else {
    try {
      png = await rasterizeRaster(buffer);
    } catch (err) {
      if (looksLikeIco(buffer)) {
        png = await rasterizeIco(buffer);
      } else {
        throw err;
      }
    }
  }

  png = await ensureExactSize(png);

  return {
    buffer: png,
    width: TARGET_SIZE,
    height: TARGET_SIZE,
    format: 'png',
  };
}

async function resizeIcon(buffer, size) {
  return sharp(buffer)
    .resize(size, size, resizeOptions())
    .png()
    .toBuffer();
}

// True when a raster favicon has no visible pixels (e.g. Yandex's empty 16×16 PNG).
async function isBlankFavicon(buffer, { contentType = '', url = '' } = {}) {
  if (!buffer || buffer.length === 0) return true;

  const hint = `${contentType} ${url}`.toLowerCase();
  if (looksLikeSvg(buffer) || hint.includes('svg')) return false;

  try {
    const meta = await sharp(buffer).metadata();
    if ((meta.width || 0) <= 1 && (meta.height || 0) <= 1) return true;
    const stats = await sharp(buffer).stats();
    return (stats.channels[3]?.max ?? 255) === 0;
  } catch {
    return false;
  }
}

function providerHint(meta = {}) {
  return `${meta.provider || ''} ${meta.url || ''}`.toLowerCase();
}

function isFaviconSoResult(meta = {}) {
  const hint = providerHint(meta);
  return hint.includes('favicon.so') || hint.includes('faviconso');
}

function isVemetricResult(meta = {}) {
  const hint = providerHint(meta);
  return hint.includes('vemetric.com') || hint.includes('vemetric');
}

function isRyanjcResult(meta = {}) {
  const hint = providerHint(meta);
  return hint.includes('favicon.ryanjc.com') || hint.includes('ryanjc');
}

// Favicon.so returns a generic SVG code-bracket icon when the site has no favicon;
// real hits are always raster (png/ico).
function isFaviconSoPlaceholder(buffer, meta = {}) {
  if (!isFaviconSoResult(meta)) return false;
  const hint = (meta.contentType || '').toLowerCase();
  return looksLikeSvg(buffer) || hint.includes('svg');
}

// Vemetric serves a tabler "world-question" icon when no favicon exists.
const VEMETRIC_PLACEHOLDER_SHA256 = new Set([
  '716386384223ef83da6c1e214399ed18b2e22c31b69fa5bb5df0ca32f7989360', // 16px png
  'd6b82a2f8afb4ad5d1564f98bd9ba179de23ac82062bf4258b64b02161718eaf', // 32px png
  '508c896cc7f491e1ebeef24686f3a0673e5cd9f1f71e1af002120ecfa45ed512', // 64px png
  '1910648a0ea674b3e059ed2d83a211c02caae9d4530111cd35a269d23b573382', // 128px png
  'd6b5ed227d47ebc0a5aaeaf1dc634730b3bb13e1b0e20d906f00d5687f6c5357', // 256px png
]);

function isVemetricPlaceholder(buffer, meta = {}) {
  if (!isVemetricResult(meta)) return false;
  if (!buffer || buffer.length === 0) return false;

  const hint = (meta.contentType || '').toLowerCase();
  if (looksLikeSvg(buffer) || hint.includes('svg')) {
    return buffer.toString('utf8').toLowerCase().includes('world-question');
  }

  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  return VEMETRIC_PLACEHOLDER_SHA256.has(hash);
}

// favicon.ryanjc.com serves a tabler "earth" SVG when it cannot resolve a favicon.
const RYANJC_PLACEHOLDER_SHA256 = new Set([
  '58d5367b47452a2a8d47ea0e5e39f9b3203af531011a189189754b10e6632258',
]);

function isRyanjcPlaceholder(buffer, meta = {}) {
  if (!isRyanjcResult(meta)) return false;
  if (!buffer || buffer.length === 0) return false;

  const hint = (meta.contentType || '').toLowerCase();
  if (looksLikeSvg(buffer) || hint.includes('svg')) {
    const svg = buffer.toString('utf8').toLowerCase();
    if (svg.includes('viewbox="0 0 24 24"') && svg.includes('m1-16a10 10')) return true;
    const hash = crypto.createHash('sha256').update(buffer.toString('utf8').trim()).digest('hex');
    return RYANJC_PLACEHOLDER_SHA256.has(hash);
  }
  return false;
}

async function isUnusableIcon(buffer, meta = {}) {
  if (await isBlankFavicon(buffer, meta)) return true;
  if (isFaviconSoPlaceholder(buffer, meta)) return true;
  if (isVemetricPlaceholder(buffer, meta)) return true;
  if (isRyanjcPlaceholder(buffer, meta)) return true;
  return false;
}

// Perceptual PSNR (dB) between two raw RGBA buffers. Alpha is premultiplied so
// that differences in the (invisible) RGB under fully-transparent pixels — which
// libimagequant/libwebp freely rewrite — do not drag the score down. Returns
// Infinity when the visible result is bit-identical.
function rgbaPsnr(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    const aa = a[i + 3];
    const ba = b[i + 3];
    for (let c = 0; c < 3; c++) {
      const av = Math.round((a[i + c] * aa) / 255);
      const bv = Math.round((b[i + c] * ba) / 255);
      const d = av - bv;
      sum += d * d;
      n++;
    }
    const da = aa - ba;
    sum += da * da;
    n++;
  }
  const mse = sum / n;
  if (mse === 0) return Infinity;
  return 10 * Math.log10((255 * 255) / mse);
}

// Compact PNG encode for capped scraper output: max zlib compression, keep alpha.
// Accepts a Buffer or an existing sharp pipeline (e.g. after resize).
//
// Strategy: encode both a truecolor PNG and an indexed/palette PNG, then keep the
// smaller one. Real favicons are anti-aliased (500-2000 colors), so a bit-exact
// palette is rare; instead the palette variant is accepted when its perceptual
// PSNR vs. the source meets SCRAPER_PNG_MIN_PSNR (default 40 dB ≈ visually
// lossless). Set SCRAPER_PNG_PALETTE=false to force strict truecolor PNG, or
// SCRAPER_PNG_MIN_PSNR higher (toward strict lossless) / lower (harder compression).
//
// Note: do not enable adaptiveFiltering — for flat/simple icons it often
// increases size vs default filters (e.g. github.com 8.5 KB vs 6.1 KB).
async function encodeLosslessPng(input) {
  const pipeline =
    input && typeof input.ensureAlpha === 'function' ? input : sharp(input);

  // Materialize the (already-resized) source once as raw RGBA so we can try
  // multiple encoders and score the palette result against these exact pixels.
  const { data: rawSource, info } = await pipeline
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rawOpts = {
    raw: { width: info.width, height: info.height, channels: 4 },
  };

  const truecolor = await sharp(rawSource, rawOpts)
    .png({ compressionLevel: 9 })
    .toBuffer();

  let best = truecolor;
  if (PNG_PALETTE_ENABLED) {
    try {
      const paletted = await sharp(rawSource, rawOpts)
        .png({ palette: true, colors: 256, dither: 0, effort: 10, compressionLevel: 9 })
        .toBuffer();
      if (paletted.length < best.length) {
        const decoded = await sharp(paletted).ensureAlpha().raw().toBuffer();
        if (rgbaPsnr(rawSource, decoded) >= PNG_MIN_PSNR) best = paletted;
      }
    } catch {
      /* keep the truecolor PNG */
    }
  }

  return best;
}

// Keep legacy export name for compatibility
const toPng256 = toPng;

module.exports = {
  toPng256,
  toPng,
  toDisplayPng,
  normalizeEntryForPng,
  entryLooksLikeIco,
  readImageDimensions,
  resizeIcon,
  encodeLosslessPng,
  isBlankFavicon,
  isUnusableIcon,
  looksLikeIco,
  looksLikeSvg,
  rasterizeSvgToSize,
  TARGET_SIZE,
  MIN_SOURCE_SIZE,
  SVG_DISPLAY_SIZE,
};

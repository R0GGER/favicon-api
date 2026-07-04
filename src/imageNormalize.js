const sharp = require('sharp');
const decodeIco = require('decode-ico');
const crypto = require('crypto');

const TARGET_SIZE = 128;
// Minimum acceptable source image size (applies to ICO frames and raster images).
const MIN_SOURCE_SIZE = 128;
// 4x default 96 dpi so SVGs rasterize crisply at TARGET_SIZE (128px).
const SVG_DENSITY = 192;
// When converting a scraped SVG to a display PNG, rasterize at the largest
// standard icon size so on-demand ?size= downsizing preserves quality.
const SVG_DISPLAY_SIZE = 512;

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

async function rasterizeSvg(buffer) {
  return rasterizeSvgToSize(buffer, TARGET_SIZE);
}

async function rasterizeSvgToSize(buffer, size = TARGET_SIZE) {
  const density = Math.max(72, size * 4);
  return sharp(preprocessSvgForRaster(buffer), { density })
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

function bgraToRgba(buffer, width, height) {
  const pixels = width * height;
  const rgba = Buffer.alloc(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    const src = i * 4;
    rgba[src] = buffer[src + 2];
    rgba[src + 1] = buffer[src + 1];
    rgba[src + 2] = buffer[src];
    rgba[src + 3] = buffer[src + 3];
  }
  return rgba;
}

async function icoFrameToPng(frame) {
  let input;
  if (frame.type === 'png') {
    input = sharp(Buffer.from(frame.data));
  } else {
    const bgra = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
    const rgba = bgraToRgba(bgra, frame.width, frame.height);
    input = sharp(rgba, {
      raw: { width: frame.width, height: frame.height, channels: 4 },
    });
  }
  return input.png().toBuffer();
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

  let input;
  if (frame.type === 'png') {
    input = sharp(Buffer.from(frame.data));
  } else {
    const bgra = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
    const rgba = bgraToRgba(bgra, frame.width, frame.height);
    input = sharp(rgba, {
      raw: { width: frame.width, height: frame.height, channels: 4 },
    });
  }

  return input.resize(TARGET_SIZE, TARGET_SIZE, resizeOptions()).png().toBuffer();
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

async function isUnusableIcon(buffer, meta = {}) {
  if (await isBlankFavicon(buffer, meta)) return true;
  if (isFaviconSoPlaceholder(buffer, meta)) return true;
  if (isVemetricPlaceholder(buffer, meta)) return true;
  return false;
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
  isBlankFavicon,
  isUnusableIcon,
  looksLikeIco,
  looksLikeSvg,
  rasterizeSvgToSize,
  TARGET_SIZE,
  MIN_SOURCE_SIZE,
};

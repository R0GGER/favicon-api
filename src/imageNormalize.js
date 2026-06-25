const sharp = require('sharp');
const decodeIco = require('decode-ico');

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

async function rasterizeSvg(buffer) {
  return rasterizeSvgToSize(buffer, TARGET_SIZE);
}

async function rasterizeSvgToSize(buffer, size = TARGET_SIZE) {
  const density = Math.max(72, size * 4);
  return sharp(buffer, { density })
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

async function icoFrameToPng(frame) {
  let input;
  if (frame.type === 'png') {
    input = sharp(Buffer.from(frame.data));
  } else {
    input = sharp(Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength), {
      raw: { width: frame.width, height: frame.height, channels: 4 },
    });
  }
  return input.png().toBuffer();
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
  const isIco = !isSvg && (looksLikeIco(buffer) || hint.includes('ico'));

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
    input = sharp(Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength), {
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

// Keep legacy export name for compatibility
const toPng256 = toPng;

module.exports = {
  toPng256,
  toPng,
  toDisplayPng,
  readImageDimensions,
  resizeIcon,
  looksLikeIco,
  looksLikeSvg,
  rasterizeSvgToSize,
  TARGET_SIZE,
  MIN_SOURCE_SIZE,
};

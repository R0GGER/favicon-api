const sharp = require('sharp');
const decodeIco = require('decode-ico');

const TARGET_SIZE = 128;
// Minimum acceptable source image size (applies to ICO frames and raster images).
const MIN_SOURCE_SIZE = 128;
// 4x default 96 dpi so SVGs rasterize crisply at TARGET_SIZE (128px).
const SVG_DENSITY = 192;

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
  const density = Math.max(72, Math.round(size * 1.5));
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

// Keep legacy export name for compatibility
const toPng256 = toPng;

module.exports = {
  toPng256,
  toPng,
  rasterizeSvgToSize,
  TARGET_SIZE,
  MIN_SOURCE_SIZE,
};

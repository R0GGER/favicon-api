const sharp = require('sharp');
const decodeIco = require('decode-ico');

const TARGET_SIZE = 256;
// 4x default 96 dpi so SVGs rasterize crisply at 256px.
const SVG_DENSITY = 384;

function transparentBackground() {
  return { r: 0, g: 0, b: 0, alpha: 0 };
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
  // ICO header: reserved=0, type=1 (icon) or 2 (cursor).
  return (
    buffer[0] === 0x00 &&
    buffer[1] === 0x00 &&
    (buffer[2] === 0x01 || buffer[2] === 0x02) &&
    buffer[3] === 0x00
  );
}

async function rasterizeSvg(buffer) {
  return sharp(buffer, { density: SVG_DENSITY })
    .resize(TARGET_SIZE, TARGET_SIZE, {
      fit: 'contain',
      background: transparentBackground(),
    })
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

  // decode-ico returns either { type: 'png', data: Buffer } where data is a
  // ready-to-decode PNG, or { type: 'bmp', data: Uint8ClampedArray } with raw
  // RGBA bytes. Handle both.
  if (frame.type === 'png') {
    return sharp(Buffer.from(frame.data))
      .resize(TARGET_SIZE, TARGET_SIZE, {
        fit: 'contain',
        background: transparentBackground(),
      })
      .png()
      .toBuffer();
  }

  return sharp(Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength), {
    raw: { width: frame.width, height: frame.height, channels: 4 },
  })
    .resize(TARGET_SIZE, TARGET_SIZE, {
      fit: 'contain',
      background: transparentBackground(),
    })
    .png()
    .toBuffer();
}

async function rasterizeRaster(buffer) {
  return sharp(buffer)
    .resize(TARGET_SIZE, TARGET_SIZE, {
      fit: 'contain',
      background: transparentBackground(),
    })
    .png()
    .toBuffer();
}

async function toPng256(buffer, { hintFormat = null } = {}) {
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
      // sharp rejects unsupported formats (e.g. an ICO mis-detected as raster);
      // fall back to ICO decoding before giving up.
      if (looksLikeIco(buffer)) {
        png = await rasterizeIco(buffer);
      } else {
        throw err;
      }
    }
  }

  return {
    buffer: png,
    width: TARGET_SIZE,
    height: TARGET_SIZE,
    format: 'png',
  };
}

module.exports = {
  toPng256,
  TARGET_SIZE,
};

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SOURCE_BUFFER = fs.readFileSync(path.join(__dirname, 'assets', 'not-found.png'));
const SOURCE_SIZE = 128;

const sizeCache = new Map([[SOURCE_SIZE, SOURCE_BUFFER]]);

async function bufferForSize(size) {
  const target = Math.max(1, Math.round(size || SOURCE_SIZE));
  if (sizeCache.has(target)) return sizeCache.get(target);

  const buffer = target === SOURCE_SIZE
    ? SOURCE_BUFFER
    : await sharp(SOURCE_BUFFER).resize(target, target).png().toBuffer();
  sizeCache.set(target, buffer);
  return buffer;
}

async function notFoundEntry(size = SOURCE_SIZE) {
  return {
    buffer: await bufferForSize(size),
    contentType: 'image/png',
    provider: 'none',
    notFound: true,
  };
}

module.exports = { notFoundEntry };

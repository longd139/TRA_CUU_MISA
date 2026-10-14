const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');

// Helper to create PNG buffer with pure JS & zlib
function createPng(width, height, drawFn) {
  const bytesPerPixel = 4;
  const rawData = Buffer.alloc(height * (width * bytesPerPixel + 1));

  for (let y = 0; y < height; y++) {
    const rowOffset = y * (width * bytesPerPixel + 1);
    rawData[rowOffset] = 0; // Filter byte: None

    for (let x = 0; x < width; x++) {
      const pixelOffset = rowOffset + 1 + x * bytesPerPixel;
      const [r, g, b, a] = drawFn(x, y, width, height);
      rawData[pixelOffset] = r;
      rawData[pixelOffset + 1] = g;
      rawData[pixelOffset + 2] = b;
      rawData[pixelOffset + 3] = a;
    }
  }

  const compressedData = zlib.deflateSync(rawData);

  function createChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);

    const typeBuffer = Buffer.from(type, 'ascii');
    const combined = Buffer.concat([typeBuffer, data]);

    const crcBuffer = Buffer.alloc(4);
    const crc = crc32(combined);
    crcBuffer.writeUInt32BE(crc, 0);

    return Buffer.concat([len, combined, crcBuffer]);
  }

  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let j = 0; j < 8; j++) {
        c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
      }
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // 8 bit depth
  ihdrData[9] = 6; // RGBA
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace

  const ihdr = createChunk('IHDR', ihdrData);
  const idat = createChunk('IDAT', compressedData);
  const iend = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

// Draw modern gradient icon with price tag / dollar symbol
function drawIcon(x, y, w, h) {
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) / 2 - 1;
  const dist = Math.hypot(x - cx, y - cy);

  if (dist > r) return [0, 0, 0, 0]; // Transparent outside circle

  // Rounded squircle background - Royal indigo gradient #4F46E5 to #7C3AED
  const gradientT = (x + y) / (w + h);
  const bgR = Math.round(79 + gradientT * (124 - 79));
  const bgG = Math.round(70 + gradientT * (58 - 70));
  const bgB = Math.round(229 + gradientT * (237 - 229));

  // Border antialiasing
  let alpha = 255;
  if (dist > r - 1) {
    alpha = Math.round(255 * (r - dist));
  }

  // Draw a stylized 'C' or '$' shape in center
  const nx = (x - cx) / (w * 0.4);
  const ny = (y - cy) / (h * 0.4);
  const iconDist = Math.hypot(nx, ny);

  // Central circle ring
  if (iconDist > 0.45 && iconDist < 0.85 && (nx < 0.3 || Math.abs(ny) > 0.35)) {
    return [255, 255, 255, alpha];
  }
  // Central bar for CTV currency tag
  if (Math.abs(nx) < 0.15 && Math.abs(ny) < 0.9) {
    return [255, 255, 255, alpha];
  }
  if (Math.abs(ny) < 0.18 && nx > -0.5 && nx < 0.5) {
    return [255, 255, 255, alpha];
  }

  return [bgR, bgG, bgB, alpha];
}

const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });

[16, 48, 128].forEach(size => {
  const buf = createPng(size, size, drawIcon);
  fs.writeFileSync(path.join(iconsDir, `icon-${size}.png`), buf);
  console.log(`Generated icon-${size}.png`);
});

// Download xlsx.full.min.js
const libDir = path.join(__dirname, 'lib');
if (!fs.existsSync(libDir)) fs.mkdirSync(libDir, { recursive: true });

const xlsxUrl = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
const xlsxPath = path.join(libDir, 'xlsx.full.min.js');

console.log('Downloading xlsx library...');
function downloadFile(url, dest, cb) {
  https.get(url, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      downloadFile(res.headers.location, dest, cb);
    } else if (res.statusCode === 200) {
      const fileStream = fs.createWriteStream(dest);
      res.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close(cb);
      });
    } else {
      console.error(`Status code: ${res.statusCode}`);
    }
  }).on('error', (err) => {
    console.error('Download error:', err);
  });
}

downloadFile(xlsxUrl, xlsxPath, () => {
  console.log('Downloaded xlsx.full.min.js successfully');
});

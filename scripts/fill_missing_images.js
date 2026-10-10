const cloudinary = require('cloudinary').v2;
const fs = require('fs');
const path = require('path');

const PRODUCTS_FILE = path.join(__dirname, '..', 'data', 'products.json');
const CLOUDINARY_CONFIG_FILE = path.join(__dirname, '..', 'data', 'cloudinary-config.json');

let globalFillState = {
  running: false,
  total: 0,
  processed: 0,
  filled: 0,
  skipped: 0,
  percent: 0,
  currentSku: '',
  elapsedSec: 0,
  message: 'Sẵn sàng',
  startedAt: null,
  finishedAt: null
};

function getFillProgress() {
  return { ...globalFillState };
}

function initCloudinary() {
  if (!fs.existsSync(CLOUDINARY_CONFIG_FILE)) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(CLOUDINARY_CONFIG_FILE, 'utf-8'));
    if (!cfg.cloudName || !cfg.apiKey || !cfg.apiSecret) return null;
    cloudinary.config({
      cloud_name: cfg.cloudName,
      api_key: cfg.apiKey,
      api_secret: cfg.apiSecret,
      secure: true
    });
    return cfg;
  } catch (e) {
    return null;
  }
}

// Fetch real image buffer with polite sequential check (.png first, then .jpg)
async function fetchRealImageBuffer(pictureId) {
  const extensions = ['.png', '.jpg'];
  
  for (const ext of extensions) {
    const url = `https://cobedenim.mshopkeeper.vn/backendg2/api/Image?id=${pictureId}${ext}&type=1&mode=pad&CompanyCode=cobedenim`;
    try {
      const res = await fetch(url, { 
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(5000)
      });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        // MShopKeeper placeholder bag is ~6.9KB or ~16.4KB; real product photos are > 20,000 bytes
        if (buf.byteLength > 20000) {
          return { ext, buffer: buf, size: buf.byteLength };
        }
      }
    } catch (e) {}
  }

  return null;
}

// Upload buffer directly to Cloudinary overwriting any empty placeholder
async function uploadToCloudinary(pictureId, buffer) {
  const cleanId = pictureId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return new Promise((resolve) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: 'cobe-inventory',
        public_id: cleanId,
        overwrite: true,
        invalidate: true,
        resource_type: 'image',
        format: 'jpg'
      },
      (err, result) => {
        if (err) resolve({ success: false, error: err.message });
        else resolve({ success: true, url: result.secure_url, bytes: result.bytes });
      }
    );
    uploadStream.end(buffer);
  });
}

/**
 * Execute smart image fill
 * @param {Object} options
 * @param {string[]} [options.targetPictureIds] - Optional list of specific pictureIds to fill
 * @param {Function} [options.onProgress] - Optional progress callback
 */
async function startFillMissingImages(options = {}) {
  if (globalFillState.running) {
    return { success: false, message: 'Tiến trình fill hình đang chạy!', state: globalFillState };
  }

  const cfg = initCloudinary();
  if (!cfg) {
    throw new Error('Chưa cấu hình Cloudinary trong data/cloudinary-config.json');
  }

  const products = JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf-8'));
  
  // Collect unique pictureIds
  const picMap = new Map();
  for (const p of products) {
    if (p.pictureId && p.pictureId !== '00000000-0000-0000-0000-000000000000') {
      if (!picMap.has(p.pictureId)) {
        picMap.set(p.pictureId, {
          pictureId: p.pictureId,
          sku: p.sku,
          name: p.name
        });
      }
    }
  }

  let items = Array.from(picMap.values());
  if (Array.isArray(options.targetPictureIds) && options.targetPictureIds.length > 0) {
    const targetSet = new Set(options.targetPictureIds);
    items = items.filter(it => targetSet.has(it.pictureId));
  }

  const total = items.length;
  globalFillState = {
    running: true,
    total,
    processed: 0,
    filled: 0,
    skipped: 0,
    percent: 0,
    currentSku: '',
    elapsedSec: 0,
    message: 'Đang bắt đầu quét ảnh từ MShopKeeper...',
    startedAt: new Date().toISOString(),
    finishedAt: null
  };

  const startTime = Date.now();
  const BATCH_SIZE = 6; // Nhẹ nhàng, 6 ảnh/đợt để chống nghẽn MISA

  (async () => {
    try {
      for (let i = 0; i < total; i += BATCH_SIZE) {
        if (!globalFillState.running) break; // Allow cancellation

        const batch = items.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (item) => {
          if (!globalFillState.running) return;
          globalFillState.currentSku = item.sku;
          const cleanId = item.pictureId.replace(/[^a-zA-Z0-9_-]/g, '_');

          // Tối ưu 1: Kiểm tra HEAD request trên Cloudinary CDN
          // Nếu ảnh thật (> 20KB) đã tồn tại trên Cloudinary thì không cần tải lại
          try {
            const checkUrl = `https://res.cloudinary.com/${cfg.cloudName}/image/upload/cobe-inventory/${cleanId}.jpg`;
            const headRes = await fetch(checkUrl, { method: 'HEAD' });
            if (headRes.ok) {
              const clen = Number(headRes.headers.get('content-length') || 0);
              if (clen > 20000) {
                globalFillState.filled++;
                return;
              }
            }
          } catch (e) {}

          // Tối ưu 2: Chưa có hoặc là placeholder -> tải ảnh thật từ MShopKeeper
          const real = await fetchRealImageBuffer(item.pictureId);
          if (real) {
            const up = await uploadToCloudinary(item.pictureId, real.buffer);
            if (up.success) {
              globalFillState.filled++;
            } else {
              globalFillState.skipped++;
            }
          } else {
            globalFillState.skipped++;
          }
        }));

        globalFillState.processed = Math.min(i + batch.length, total);
        globalFillState.percent = Math.round((globalFillState.processed / total) * 100);
        globalFillState.elapsedSec = Math.round((Date.now() - startTime) / 1000);
        globalFillState.message = `Đang quét ${globalFillState.processed}/${total} ảnh (${globalFillState.percent}%) — Đã có ${globalFillState.filled} ảnh thật`;

        if (typeof options.onProgress === 'function') {
          options.onProgress({ ...globalFillState });
        }

        // Nhịp nghỉ 350ms giữa các đợt để server MISA giải phóng pool
        if (i + BATCH_SIZE < total && globalFillState.running) {
          await new Promise(r => setTimeout(r, 350));
        }
      }

      if (globalFillState.running) {
        globalFillState.running = false;
        globalFillState.finishedAt = new Date().toISOString();
        globalFillState.message = `Hoàn tất! Đã có sẵn & nạp ${globalFillState.filled}/${total} ảnh thật lên Cloudinary.`;
      }
    } catch (err) {
      globalFillState.running = false;
      globalFillState.message = `Lỗi tiến trình: ${err.message}`;
    }
  })();

  return { success: true, message: 'Đã khởi chạy tiến trình quét và bổ sung ảnh!', state: globalFillState };
}

function stopFillMissingImages() {
  if (globalFillState.running) {
    globalFillState.running = false;
    globalFillState.message = 'Đã dừng tiến trình quét ảnh theo yêu cầu.';
    return { success: true, message: 'Đã dừng tiến trình quét ảnh.' };
  }
  return { success: false, message: 'Không có tiến trình nào đang chạy.' };
}

module.exports = {
  startFillMissingImages,
  stopFillMissingImages,
  getFillProgress,
  fetchRealImageBuffer,
  uploadToCloudinary
};

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const XLSX = require('xlsx');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { PayOS } = require('@payos/node');
const cloudinary = require('cloudinary').v2;
const { startFillMissingImages, stopFillMissingImages, getFillProgress } = require('./scripts/fill_missing_images');

const app = express();
const PORT = process.env.PORT || 3000;

// Security: Disable express fingerprinting & apply defensive HTTP headers
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = path.join(__dirname, 'data', 'products.json');
const CONFIG_FILE = path.join(__dirname, 'data', 'sync-config.json');
const API_KEYS_FILE = path.join(__dirname, 'data', 'api-keys.json');
const USERS_FILE = path.join(__dirname, 'data', 'users.json');
const TRANSACTIONS_FILE = path.join(__dirname, 'data', 'transactions.json');
const PAYOS_CONFIG_FILE = path.join(__dirname, 'data', 'payos-config.json');
const JWT_SECRET_FILE = path.join(__dirname, 'data', 'jwt-secret.json');
const CLOUDINARY_CONFIG_FILE = path.join(__dirname, 'data', 'cloudinary-config.json');
const VARIANTS_CACHE_FILE = path.join(__dirname, 'data', 'variants_cache.json');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Rate Limiter 1: Public Web (Người dùng thật & CTV tra cứu trên giao diện)
// 180 request/phút/IP. Người dùng duyệt web gõ phím bình thường chỉ tốn 5-15 req/phút nên không bao giờ bị nghẽn!
const webRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 180,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: 'RATE_LIMIT_EXCEEDED',
    message: 'Tần suất thao tác quá nhanh từ IP của bạn. Vui lòng thử lại sau 1 phút.'
  }
});

// Rate Limiter 2: Admin & Sync routes (Bảo vệ đồng bộ MShopKeeper chống spam & bruteforce PIN)
const adminRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: 'ADMIN_RATE_LIMIT_EXCEEDED',
    message: 'Thao tác đồng bộ hoặc xác thực quá nhiều lần. Vui lòng thử lại sau 1 phút.'
  }
});

// Rate Limiter 3: Commercial API (Dành riêng cho đối tác kết nối qua API Key)
const commercialRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: 'COMMERCIAL_RATE_LIMIT_EXCEEDED',
    message: 'Vượt quá giới hạn tần suất truy vấn thương mại (60 requests/phút). Vui lòng thử lại sau.'
  }
});

// Rate Limiter 4: Authentication (Đăng nhập / Đăng ký đối tác chống brute-force SĐT)
const authRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: 'AUTH_RATE_LIMIT_EXCEEDED',
    message: 'Thao tác xác thực quá nhiều lần. Vui lòng thử lại sau 1 phút.'
  }
});

// Heuristic Bot/Scraper Detection for Public Web Route
function botDetectionMiddleware(req, res, next) {
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  const knownScrapers = ['python-requests', 'aiohttp', 'scrapy', 'curl/', 'wget/', 'httpie', 'postmanruntime'];
  const isScraper = knownScrapers.some(bot => ua.includes(bot));

  if (isScraper && !req.headers['x-api-key']) {
    return res.status(403).json({
      success: false,
      code: 'AUTOMATION_BLOCKED',
      message: 'Cổng Web công khai từ chối các công cụ cào dữ liệu tự động (Scrapers/Bots). Vui lòng sử dụng Commercial API có xác thực chữ ký HMAC.'
    });
  }
  next();
}

// In-memory Nonce Cache chống Replay Attack (lưu nonce trong 2 phút)
const seenNonces = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [nonce, expiresAt] of seenNonces.entries()) {
    if (expiresAt <= now) seenNonces.delete(nonce);
  }
}, 5 * 60 * 1000);

// Helper: Read API keys
function getApiKeys() {
  try {
    if (!fs.existsSync(API_KEYS_FILE)) return [];
    return JSON.parse(fs.readFileSync(API_KEYS_FILE, 'utf-8'));
  } catch (err) {
    return [];
  }
}

// Commercial API HMAC-SHA256 Signature Middleware
function verifyCommercialHmac(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  const timestamp = parseInt(req.headers['x-timestamp'], 10);
  const nonce = req.headers['x-nonce'];
  const clientSignature = req.headers['x-signature'];

  if (!apiKey || !timestamp || !nonce || !clientSignature) {
    return res.status(401).json({
      success: false,
      code: 'AUTH_MISSING_HEADERS',
      message: 'Thiếu thông tin xác thực bắt buộc: x-api-key, x-timestamp, x-nonce, x-signature'
    });
  }

  const keys = getApiKeys();
  const client = keys.find(k => k.apiKey === apiKey);
  if (!client) {
    return res.status(401).json({
      success: false,
      code: 'INVALID_API_KEY',
      message: 'API Key không tồn tại trên hệ thống.'
    });
  }

  if (client.status !== 'active') {
    return res.status(403).json({
      success: false,
      code: 'API_KEY_INACTIVE',
      message: 'API Key đang trong trạng thái tạm ngưng hoặc chưa kích hoạt.'
    });
  }

  // Kiểm tra thời hạn thuê API (Gói cước 30 ngày)
  if (client.expiresAt && new Date(client.expiresAt).getTime() < Date.now()) {
    return res.status(403).json({
      success: false,
      code: 'SUBSCRIPTION_EXPIRED',
      message: 'Gói cước API đã hết hạn. Vui lòng truy cập Cổng Đối Tác (100.000đ / 30 ngày) để gia hạn.'
    });
  }

  const now = Date.now();
  const diff = Math.abs(now - timestamp);
  // Cho phép độ lệch tối đa 60 giây giữa đồng hồ client và server
  if (isNaN(timestamp) || diff > 60 * 1000) {
    return res.status(401).json({
      success: false,
      code: 'REQUEST_EXPIRED',
      message: `Thời gian request không hợp lệ hoặc đã hết hạn (lệch ${Math.round(diff / 1000)}s so với máy chủ).`
    });
  }

  // Chống Replay Attack bằng Nonce
  if (seenNonces.has(nonce)) {
    return res.status(401).json({
      success: false,
      code: 'REPLAY_ATTACK_DETECTED',
      message: 'Nonce đã được sử dụng. Mỗi request bắt buộc sử dụng một nonce ngẫu nhiên duy nhất.'
    });
  }
  seenNonces.set(nonce, now + 2 * 60 * 1000);

  // Tạo HMAC-SHA256 chuẩn: METHOD + ":" + PATH (đã chuẩn hóa) + ":" + TIMESTAMP + ":" + NONCE
  const rawPath = req.originalUrl.split('?')[0];
  const targetPath = rawPath.toLowerCase().replace(/\/+$/, '') || '/';
  const canonicalString = `${req.method.toUpperCase()}:${targetPath}:${timestamp}:${nonce}`;
  const expectedSignature = crypto
    .createHmac('sha256', client.apiSecret)
    .update(canonicalString)
    .digest('hex');

  const match = clientSignature.length === expectedSignature.length &&
    crypto.timingSafeEqual(Buffer.from(clientSignature), Buffer.from(expectedSignature));

  if (!match) {
    return res.status(401).json({
      success: false,
      code: 'INVALID_SIGNATURE',
      message: 'Chữ ký số (HMAC-SHA256 signature) không chính xác.'
    });
  }

  req.authClient = client;
  next();
}

// Helper: Remove Vietnamese tones for accent-insensitive search
function removeVietnameseTones(str) {
  if (!str) return '';
  str = str.toLowerCase();
  str = str.replace(/à|á|ạ|ả|ã|â|ầ|ấ|ậ|ẩ|ẫ|ă|ằ|ắ|ặ|ẳ|ẵ/g, 'a');
  str = str.replace(/è|é|ẹ|ẻ|ẽ|ê|ề|ế|ệ|ể|ễ/g, 'e');
  str = str.replace(/ì|í|ị|ỉ|ĩ/g, 'i');
  str = str.replace(/ò|ó|ọ|ỏ|õ|ô|ồ|ố|ộ|ổ|ỗ|ơ|ờ|ớ|ợ|ở|ỡ/g, 'o');
  str = str.replace(/ù|ú|ụ|ủ|ũ|ư|ừ|ứ|ự|ử|ữ/g, 'u');
  str = str.replace(/ỳ|ý|ỵ|ỷ|ỹ/g, 'y');
  str = str.replace(/đ/g, 'd');
  str = str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return str.trim();
}

// Helper: Read products
function getProducts() {
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const products = JSON.parse(raw);
    return products.map(p => {
      const totalStock = (p.variants || []).reduce((acc, v) => acc + (Number(v.stock) || 0), 0);
      const status = totalStock > 0 ? 'in_stock' : 'out_of_stock';
      return { ...p, totalStock, status };
    });
  } catch (err) {
    console.error('Error reading products:', err);
    return [];
  }
}

// Helper: Save products
function saveProducts(products) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(products, null, 2), 'utf-8');
  try {
    const publicDataFile = path.join(__dirname, 'public', 'data', 'products.json');
    const publicDataDir = path.dirname(publicDataFile);
    if (!fs.existsSync(publicDataDir)) fs.mkdirSync(publicDataDir, { recursive: true });
    fs.writeFileSync(publicDataFile, JSON.stringify(products, null, 2), 'utf-8');
  } catch (e) {}
}

// Helper: Read config
function getConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return {};
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch (err) {
    return {};
  }
}

// Helper: Save config
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
}

// Shared Filtering and Sorting Logic
function filterAndSortProducts(allProducts, queryParams) {
  const { q = '', brand = 'all', category = 'all', status = 'all', size = 'all', sort = 'default' } = queryParams;
  let products = [...allProducts];

  // Search filter
  if (q.trim()) {
    const rawQuery = q.trim().toLowerCase();
    const queryNormalized = removeVietnameseTones(rawQuery);
    const sizeQuery = rawQuery.replace(/^(?:size|sz)\s+/i, '').trim();

    products = products.filter(p => {
      const skuNorm = (p.sku || '').toLowerCase();
      const parentSkuNorm = (p.parentSku || '').toLowerCase();
      const barcodeNorm = (p.barcode || '').toLowerCase();
      const nameNorm = removeVietnameseTones(p.name || '');
      const catNorm = removeVietnameseTones(p.category || '');
      const brandNorm = removeVietnameseTones(p.brand || '');
      const fullCatNorm = removeVietnameseTones(p.fullCategory || '');

      // Check product details
      if (skuNorm.includes(rawQuery) || parentSkuNorm.includes(rawQuery) || barcodeNorm.includes(rawQuery)) return true;
      if (nameNorm.includes(queryNormalized) || catNorm.includes(queryNormalized) || brandNorm.includes(queryNormalized) || fullCatNorm.includes(queryNormalized)) return true;

      // Check variant details (color, size, skuVariant)
      return (p.variants || []).some(v => {
        const colorNorm = removeVietnameseTones(v.color || '');
        const sizeNorm = (v.size || '').toLowerCase();
        const skuVNorm = (v.skuVariant || '').toLowerCase();
        return colorNorm.includes(queryNormalized) || sizeNorm === rawQuery || (sizeQuery && sizeNorm === sizeQuery) || skuVNorm.includes(rawQuery);
      });
    });
  }

  // Size filter
  if (size && size !== 'all' && size.trim()) {
    const targetSize = size.toUpperCase().trim();
    products = products.filter(p => {
      return (p.variants || []).some(v => {
        const vSize = String(v.size || '').toUpperCase().trim();
        const hasStock = Number(v.stock) > 0;
        const matchesSize = vSize === targetSize || (targetSize.length >= 3 && vSize.includes(targetSize));
        if (status === 'out_of_stock') {
          return matchesSize;
        }
        return matchesSize && hasStock;
      });
    });
  }

  // Brand filter
  if (brand && brand !== 'all') {
    products = products.filter(p => (p.brand || '').toLowerCase() === brand.toLowerCase());
  }

  // Category filter
  if (category && category !== 'all') {
    products = products.filter(p => (p.category || '').toLowerCase() === category.toLowerCase() || (p.fullCategory || '').toLowerCase() === category.toLowerCase());
  }

  // Stock status filter
  if (status && status !== 'all') {
    products = products.filter(p => p.status === status);
  }

  // Sorting
  if (sort === 'stock_desc') {
    products.sort((a, b) => b.totalStock - a.totalStock);
  } else if (sort === 'stock_asc') {
    products.sort((a, b) => a.totalStock - b.totalStock);
  } else if (sort === 'price_asc') {
    products.sort((a, b) => a.retailPrice - b.retailPrice);
  } else if (sort === 'price_desc') {
    products.sort((a, b) => b.retailPrice - a.retailPrice);
  } else if (sort === 'name') {
    products.sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  }

  return products;
}

// API: Public Web Products Endpoint (Bảo vệ bằng webRateLimiter & botDetectionMiddleware)
app.get('/api/products', webRateLimiter, botDetectionMiddleware, (req, res) => {
  const { q = '', brand = 'all', category = 'all', status = 'all', size = 'all', sort = 'default', page = 1, limit = 24 } = req.query;
  const allProducts = getProducts();
  const products = filterAndSortProducts(allProducts, { q, brand, category, status, size, sort });

  // Aggregated Brands and Categories for UI
  const brandCounts = {};
  const categoryCounts = {};

  allProducts.forEach(p => {
    const b = p.brand || 'Khác';
    brandCounts[b] = (brandCounts[b] || 0) + 1;

    if (brand === 'all' || (p.brand || '').toLowerCase() === brand.toLowerCase()) {
      const c = p.category || 'Khác';
      categoryCounts[c] = (categoryCounts[c] || 0) + 1;
    }
  });

  const brands = Object.entries(brandCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  const categories = Object.entries(categoryCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  // Pagination calculation
  const total = products.length;
  let pagedProducts = products;
  let totalPages = 1;
  const parsedPage = Math.max(1, parseInt(page, 10) || 1);

  if (limit !== 'all') {
    // Ép tối đa 100 sản phẩm / trang để chống cào thô
    const parsedLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 24));
    totalPages = Math.ceil(total / parsedLimit) || 1;
    const startIndex = (parsedPage - 1) * parsedLimit;
    pagedProducts = products.slice(startIndex, startIndex + parsedLimit);
  }

  res.json({
    success: true,
    total,
    page: parsedPage,
    limit: limit === 'all' ? 'all' : Math.min(100, parseInt(limit, 10) || 24),
    totalPages,
    brands,
    categories,
    products: pagedProducts
  });
});

// ==========================================
// CLOUDINARY CONFIG & REVERSE IMAGE PROXY
// ==========================================
function getCloudinaryConfig() {
  try {
    if (fs.existsSync(CLOUDINARY_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CLOUDINARY_CONFIG_FILE, 'utf-8'));
    }
  } catch (e) {}
  return null;
}

let isCloudinaryConfigured = false;
function initCloudinary() {
  const cfg = getCloudinaryConfig();
  if (cfg && cfg.cloudName && cfg.apiKey && cfg.apiSecret) {
    if (!isCloudinaryConfigured) {
      cloudinary.config({
        cloud_name: cfg.cloudName,
        api_key: cfg.apiKey,
        api_secret: cfg.apiSecret,
        secure: true
      });
      isCloudinaryConfigured = true;
    }
    return cfg;
  }
  const fallbackCloud = (cfg && cfg.cloudName) || process.env.CLOUDINARY_CLOUD_NAME || 'pv0t9rx7';
  return { cloudName: fallbackCloud };
}

// ROUTE: Reverse Image Proxy (Giấu 100% nguồn gốc MISA)
// URL: /api/images/:filename (VD: /api/images/13948112-0973-4d2d-b792-20a58bbb656f.jpg)
app.get('/api/images/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    const picId = filename.replace(/\.(jpg|jpeg|png|webp)$/i, '');
    const cleanPicId = picId.replace(/[^a-zA-Z0-9_-]/g, '_');

    // Ưu tiên 1: Chuyển hướng sang Cloudinary CDN với auto WebP & tối ưu hóa tự động
    const cfg = initCloudinary();
    if (cfg && cfg.cloudName) {
      const cloudUrl = `https://res.cloudinary.com/${cfg.cloudName}/image/upload/f_auto,q_auto/cobe-inventory/${cleanPicId}.jpg`;
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.redirect(cloudUrl);
    }

    // Ưu tiên 2: Phục vụ từ thư mục cache cục bộ nếu có
    const localCachePath = path.join(__dirname, 'public', 'images', 'products', `${cleanPicId}.jpg`);
    if (fs.existsSync(localCachePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.sendFile(localCachePath);
    }

    // Ưu tiên 3: Tải từ MShopKeeper về, lưu cache rồi trả về
    const mshopUrl = `https://cobedenim.mshopkeeper.vn/backendg2/api/Image?id=${picId}.jpg&type=1&mode=pad&CompanyCode=cobedenim`;
    const response = await fetch(mshopUrl);
    if (!response.ok) {
      return res.status(404).send('Image not found');
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    res.setHeader('Content-Type', response.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(buffer);
  } catch (err) {
    res.status(500).send('Image load error');
  }
});

// COMMERCIAL API V1: Healthcheck & Ping (Bảo vệ bằng HMAC Chữ ký số)
app.get('/api/v1/ping', commercialRateLimiter, verifyCommercialHmac, (req, res) => {
  res.json({
    success: true,
    message: 'Xác thực Commercial API thành công!',
    client: {
      id: req.authClient.id,
      name: req.authClient.name
    },
    serverTime: new Date().toISOString()
  });
});

// COMMERCIAL API V1: Get Products (Bảo vệ bằng HMAC + Nonce + Timestamp + Giới hạn tải)
app.get('/api/v1/products', commercialRateLimiter, verifyCommercialHmac, (req, res) => {
  const { q = '', brand = 'all', category = 'all', status = 'all', size = 'all', sort = 'default', page = 1, limit = 20 } = req.query;
  const allProducts = getProducts();
  const products = filterAndSortProducts(allProducts, { q, brand, category, status, size, sort });

  // Giới hạn an toàn: tối đa 50 sản phẩm mỗi lượt gọi (không cho phép limit=all để chống cào sập kho)
  const safeLimit = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
  const parsedPage = Math.max(1, parseInt(page, 10) || 1);
  const total = products.length;
  const totalPages = Math.ceil(total / safeLimit) || 1;
  const startIndex = (parsedPage - 1) * safeLimit;
  const pagedProducts = products.slice(startIndex, startIndex + safeLimit);

  res.json({
    success: true,
    meta: {
      authClient: req.authClient.name,
      total,
      page: parsedPage,
      limit: safeLimit,
      totalPages
    },
    products: pagedProducts
  });
});

// ==========================================
// DEVELOPER PORTAL, AUTH (JWT) & PAYOS PAYMENT
// ==========================================

// Throttle Cache chống lỗi 429 khi tra cứu PayOS API
const payosApiThrottle = new Map();
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [k, t] of payosApiThrottle.entries()) {
    if (t < cutoff) payosApiThrottle.delete(k);
  }
}, 15 * 60 * 1000);

// Helper: Lấy khóa bí mật JWT
function getJwtSecret() {
  try {
    if (fs.existsSync(JWT_SECRET_FILE)) {
      const data = JSON.parse(fs.readFileSync(JWT_SECRET_FILE, 'utf-8'));
      if (data.secret) return data.secret;
    }
  } catch (e) {}
  return 'cobe_jwt_super_secure_fallback_secret_key_2026';
}

// Helper: Đọc cấu hình PayOS
function getPayosConfig() {
  try {
    if (fs.existsSync(PAYOS_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(PAYOS_CONFIG_FILE, 'utf-8'));
    }
  } catch (e) {}
  return null;
}

// Helper: Khởi tạo client PayOS
function getPayosClient() {
  const cfg = getPayosConfig();
  if (!cfg || !cfg.clientId || !cfg.apiKey || !cfg.checksumKey) return null;
  try {
    return new PayOS({
      clientId: cfg.clientId,
      apiKey: cfg.apiKey,
      checksumKey: cfg.checksumKey
    });
  } catch (e) {
    console.error('[PAYOS] Lỗi khởi tạo client:', e.message);
    return null;
  }
}

// Helper: Đọc & ghi danh sách người dùng
function getUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return [];
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
  } catch (e) {
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf-8');
}

// Helper: Đọc & ghi danh sách giao dịch
function getTransactions() {
  try {
    if (!fs.existsSync(TRANSACTIONS_FILE)) return [];
    return JSON.parse(fs.readFileSync(TRANSACTIONS_FILE, 'utf-8'));
  } catch (e) {
    return [];
  }
}

function saveTransactions(txs) {
  fs.writeFileSync(TRANSACTIONS_FILE, JSON.stringify(txs, null, 2), 'utf-8');
}

// Helper: Ẩn passwordHash khi trả về client
function sanitizeUser(u) {
  if (!u) return null;
  const { passwordHash, ...safe } = u;
  return safe;
}

// Helper: Đồng bộ thông tin user vào data/api-keys.json để phục vụ HMAC Commercial API
function syncUserToApiKeys(user) {
  try {
    const keys = getApiKeys();
    const idx = keys.findIndex(k => k.id === user.id || k.apiKey === user.apiKey);
    const keyObj = {
      id: user.id,
      name: user.name || user.phone,
      apiKey: user.apiKey,
      apiSecret: user.apiSecret,
      status: user.status || 'inactive',
      expiresAt: user.subscriptionExpiresAt || null,
      plan: user.plan || 'standard_30d',
      phone: user.phone,
      createdAt: user.createdAt || new Date().toISOString()
    };
    if (idx >= 0) {
      keys[idx] = { ...keys[idx], ...keyObj };
    } else {
      keys.push(keyObj);
    }
    fs.writeFileSync(API_KEYS_FILE, JSON.stringify(keys, null, 2), 'utf-8');
  } catch (err) {
    console.error('Lỗi syncUserToApiKeys:', err);
  }
}

// Helper: Kích hoạt / gia hạn gói cước 30 ngày cho User
function activateUserSubscription(userId, daysToAdd = 30) {
  const users = getUsers();
  const user = users.find(u => u.id === userId);
  if (!user) return null;

  const now = Date.now();
  const currentExp = user.subscriptionExpiresAt ? new Date(user.subscriptionExpiresAt).getTime() : 0;
  // Nếu gói còn hạn: cộng dồn từ ngày hết hạn cũ. Nếu đã hết hạn hoặc mới: cộng từ bây giờ.
  const baseTime = currentExp > now ? currentExp : now;
  const newExp = new Date(baseTime + daysToAdd * 24 * 60 * 60 * 1000).toISOString();

  user.subscriptionExpiresAt = newExp;
  user.status = 'active';
  user.plan = 'standard_30d';
  saveUsers(users);
  syncUserToApiKeys(user);
  return { user, newExp };
}

// Middleware: Xác thực JWT Bearer Token chặt chẽ
function authenticateJwt(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      code: 'AUTH_TOKEN_MISSING',
      message: 'Thiếu mã xác thực phiên đăng nhập (JWT Bearer Token).'
    });
  }

  const token = authHeader.substring(7).trim();
  try {
    const decoded = jwt.verify(token, getJwtSecret());
    const users = getUsers();
    const user = users.find(u => u.id === decoded.userId);
    if (!user) {
      return res.status(401).json({
        success: false,
        code: 'USER_NOT_FOUND',
        message: 'Tài khoản không tồn tại trên hệ thống.'
      });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      code: 'INVALID_TOKEN',
      message: 'Phiên đăng nhập đã hết hạn hoặc không hợp lệ. Vui lòng đăng nhập lại.'
    });
  }
}

// ROUTE: Đăng ký tài khoản bằng SĐT + Mật khẩu
app.post('/api/auth/register', authRateLimiter, async (req, res) => {
  try {
    const { phone, password, name } = req.body;
    if (!phone || !password) {
      return res.status(400).json({
        success: false,
        code: 'MISSING_FIELDS',
        message: 'Vui lòng cung cấp số điện thoại và mật khẩu.'
      });
    }

    // Chuẩn hóa & kiểm tra định dạng SĐT Việt Nam (10 số, đầu 03, 05, 07, 08, 09)
    const phoneClean = String(phone).trim().replace(/\s+/g, '');
    const phoneRegex = /^(03|05|07|08|09)\d{8}$/;
    if (!phoneRegex.test(phoneClean)) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_PHONE',
        message: 'Số điện thoại không đúng định dạng VN (10 chữ số, ví dụ 0987654321).'
      });
    }

    if (String(password).length < 6) {
      return res.status(400).json({
        success: false,
        code: 'WEAK_PASSWORD',
        message: 'Mật khẩu phải có tối thiểu 6 ký tự.'
      });
    }

    const users = getUsers();
    if (users.some(u => u.phone === phoneClean)) {
      return res.status(409).json({
        success: false,
        code: 'PHONE_EXISTS',
        message: 'Số điện thoại này đã được đăng ký. Vui lòng đăng nhập.'
      });
    }

    // Băm mật khẩu an toàn với bcrypt (salt rounds = 10)
    const passwordHash = await bcrypt.hash(password, 10);
    const userId = 'usr_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
    const apiKey = 'cobe_pk_live_' + crypto.randomBytes(16).toString('hex');
    const apiSecret = 'cobe_sk_live_' + crypto.randomBytes(24).toString('hex');

    const newUser = {
      id: userId,
      phone: phoneClean,
      name: (name || '').trim() || `Đối tác ${phoneClean.slice(-4)}`,
      passwordHash,
      apiKey,
      apiSecret,
      status: 'inactive', // Chờ nạp tiền kích hoạt
      plan: 'standard_30d',
      subscriptionExpiresAt: null,
      createdAt: new Date().toISOString()
    };

    users.push(newUser);
    saveUsers(users);
    syncUserToApiKeys(newUser);

    // Ký cấp JWT token (thời hạn 7 ngày)
    const token = jwt.sign(
      { userId: newUser.id, phone: newUser.phone, role: 'partner' },
      getJwtSecret(),
      { expiresIn: '7d' }
    );

    return res.json({
      success: true,
      message: 'Đăng ký tài khoản đối tác thành công!',
      token,
      user: {
        ...sanitizeUser(newUser),
        daysRemaining: 0,
        isActive: false
      }
    });
  } catch (err) {
    console.error('Lỗi đăng ký:', err);
    res.status(500).json({ success: false, message: 'Lỗi máy chủ khi đăng ký tài khoản.' });
  }
});

// ROUTE: Đăng nhập bằng SĐT + Mật khẩu
app.post('/api/auth/login', authRateLimiter, async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) {
      return res.status(400).json({
        success: false,
        code: 'MISSING_FIELDS',
        message: 'Vui lòng cung cấp số điện thoại và mật khẩu.'
      });
    }

    const phoneClean = String(phone).trim().replace(/\s+/g, '');
    const users = getUsers();
    const user = users.find(u => u.phone === phoneClean);
    if (!user) {
      return res.status(401).json({
        success: false,
        code: 'INVALID_CREDENTIALS',
        message: 'Số điện thoại hoặc mật khẩu không chính xác.'
      });
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      return res.status(401).json({
        success: false,
        code: 'INVALID_CREDENTIALS',
        message: 'Số điện thoại hoặc mật khẩu không chính xác.'
      });
    }

    // Ký cấp JWT token
    const token = jwt.sign(
      { userId: user.id, phone: user.phone, role: 'partner' },
      getJwtSecret(),
      { expiresIn: '7d' }
    );

    let daysRemaining = 0;
    if (user.subscriptionExpiresAt) {
      const diff = new Date(user.subscriptionExpiresAt).getTime() - Date.now();
      daysRemaining = diff > 0 ? Math.ceil(diff / (1000 * 60 * 60 * 24)) : 0;
    }
    const isActive = user.status === 'active' && daysRemaining > 0;

    return res.json({
      success: true,
      message: 'Đăng nhập thành công!',
      token,
      user: {
        ...sanitizeUser(user),
        daysRemaining,
        isActive
      }
    });
  } catch (err) {
    console.error('Lỗi đăng nhập:', err);
    res.status(500).json({ success: false, message: 'Lỗi máy chủ khi đăng nhập.' });
  }
});

// ROUTE: Lấy thông tin tài khoản hiện tại
app.get('/api/auth/me', authenticateJwt, (req, res) => {
  const users = getUsers();
  const user = users.find(u => u.id === req.user.id);
  if (!user) {
    return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng' });
  }

  let daysRemaining = 0;
  if (user.subscriptionExpiresAt) {
    const diff = new Date(user.subscriptionExpiresAt).getTime() - Date.now();
    daysRemaining = diff > 0 ? Math.ceil(diff / (1000 * 60 * 60 * 24)) : 0;
  }
  const isActive = user.status === 'active' && daysRemaining > 0;

  res.json({
    success: true,
    user: {
      ...sanitizeUser(user),
      daysRemaining,
      isActive
    }
  });
});

// ROUTE: Tạo link thanh toán PayOS (100.000 VNĐ / 30 ngày)
app.post('/api/payment/create-payment-link', authenticateJwt, async (req, res) => {
  try {
    const payos = getPayosClient();
    const payosCfg = getPayosConfig();
    if (!payos || !payosCfg) {
      return res.status(500).json({
        success: false,
        code: 'PAYOS_NOT_CONFIGURED',
        message: 'Cổng thanh toán PayOS chưa được kích hoạt cấu hình.'
      });
    }

    const price = Number(payosCfg.price) || 100000;
    // PayOS orderCode là số nguyên dương duy nhất
    const orderCode = Number(String(Date.now()).slice(-7) + Math.floor(Math.random() * 89 + 10));

    // Description tối đa 25 ký tự không dấu
    const userPhone = req.user.phone || '';
    const description = `COBE ${userPhone.slice(-6)}`.substring(0, 25);

    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.get('host') || 'localhost:3000';
    const returnUrl = `${protocol}://${host}/developer.html?payment=success&orderCode=${orderCode}`;
    const cancelUrl = `${protocol}://${host}/developer.html?payment=cancel&orderCode=${orderCode}`;

    const paymentLink = await payos.paymentRequests.create({
      orderCode,
      amount: price,
      description,
      returnUrl,
      cancelUrl
    });

    const txs = getTransactions();
    txs.push({
      orderCode,
      userId: req.user.id,
      phone: req.user.phone,
      amount: price,
      status: 'PENDING',
      paymentLinkId: paymentLink.paymentLinkId || '',
      checkoutUrl: paymentLink.checkoutUrl || '',
      qrCode: paymentLink.qrCode || '',
      createdAt: new Date().toISOString()
    });
    saveTransactions(txs);

    res.json({
      success: true,
      orderCode,
      amount: price,
      description,
      checkoutUrl: paymentLink.checkoutUrl,
      qrCode: paymentLink.qrCode
    });
  } catch (err) {
    console.error('Lỗi create-payment-link:', err);
    res.status(500).json({
      success: false,
      code: 'PAYMENT_LINK_FAILED',
      message: `Lỗi khi tạo liên kết thanh toán PayOS: ${err.message}`
    });
  }
});

// ROUTE: Kiểm tra trạng thái đơn hàng (Hỗ trợ polling kiểm tra & kích hoạt tự động)
app.get('/api/payment/check-order/:orderCode', authenticateJwt, async (req, res) => {
  try {
    const orderCode = req.params.orderCode;
    const txs = getTransactions();
    const tx = txs.find(t => String(t.orderCode) === String(orderCode));
    if (!tx) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy giao dịch' });
    }

    if (tx.userId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Bạn không có quyền xem đơn hàng này' });
    }

    // Nếu đã đánh dấu PAID trong database nội bộ (được Webhook kích hoạt tức thì)
    if (tx.status === 'PAID') {
      const refreshedUser = getUsers().find(u => u.id === req.user.id);
      return res.json({
        success: true,
        paid: true,
        status: 'PAID',
        user: sanitizeUser(refreshedUser)
      });
    }

    // Nếu vẫn PENDING, chỉ tra cứu PayOS API nếu:
    // 1. Khách chủ động bấm "Kiểm tra ngay" (query ?force=true)
    // 2. HOẶC lần gọi PayOS API gần nhất cách đây hơn 10 giây (Throttle chống lỗi 429 Too Many Requests)
    const isForce = req.query.force === 'true';
    const lastCheckTime = payosApiThrottle.get(orderCode) || 0;
    const now = Date.now();
    const shouldQueryPayos = isForce || (now - lastCheckTime > 10000);

    const payos = getPayosClient();
    if (payos && shouldQueryPayos) {
      payosApiThrottle.set(orderCode, now);
      try {
        const paymentInfo = await payos.paymentRequests.get(orderCode);
        if (paymentInfo && (paymentInfo.status === 'PAID' || paymentInfo.status === 'COMPLETED')) {
          tx.status = 'PAID';
          tx.paidAt = new Date().toISOString();
          saveTransactions(txs);
          const result = activateUserSubscription(tx.userId, 30);
          console.log(`[PAYOS-CHECK] ✓ Đã kích hoạt 30 ngày cho user ${tx.userId} qua PayOS query (Order: ${orderCode})`);
          return res.json({
            success: true,
            paid: true,
            status: 'PAID',
            user: sanitizeUser(result ? result.user : req.user)
          });
        }
      } catch (checkErr) {
        // Phòng vệ nếu PayOS báo lỗi 429 rate limit thì chỉ log warning, không làm sập luồng
        if (checkErr.status === 429 || (checkErr.message && checkErr.message.includes('429'))) {
          console.warn(`[PAYOS-CHECK] Đạt ngưỡng giới hạn PayOS API (429) cho đơn #${orderCode}. Chờ webhook tự động xử lý.`);
        }
      }
    }

    return res.json({
      success: true,
      paid: false,
      status: tx.status
    });
  } catch (err) {
    console.error('Lỗi check-order:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ROUTE: Webhook nhận thông báo từ PayOS khi khách chuyển khoản thành công
app.post('/api/payment/payos-webhook', async (req, res) => {
  try {
    const payos = getPayosClient();
    let webhookData = req.body.data || req.body;

    if (payos) {
      try {
        webhookData = await payos.webhooks.verify(req.body);
      } catch (verifyErr) {
        console.warn('[PAYOS-WEBHOOK] Chữ ký webhook không hợp lệ:', verifyErr.message);
        return res.status(400).json({ success: false, message: 'Chữ ký webhook PayOS không hợp lệ' });
      }
    }

    const orderCode = webhookData.orderCode;
    if (!orderCode) {
      return res.status(400).json({ success: false, message: 'Thiếu orderCode' });
    }

    const txs = getTransactions();
    const tx = txs.find(t => String(t.orderCode) === String(orderCode));
    if (tx) {
      if (tx.status !== 'PAID') {
        tx.status = 'PAID';
        tx.paidAt = new Date().toISOString();
        tx.webhookReceivedAt = new Date().toISOString();
        saveTransactions(txs);
        activateUserSubscription(tx.userId, 30);
        console.log(`[PAYOS-WEBHOOK] ✓ Đã kích hoạt 30 ngày cho user ${tx.userId} (Order: ${orderCode})`);
      }
    }

    return res.json({ success: true, message: 'Webhook đã được ghi nhận' });
  } catch (err) {
    console.error('[PAYOS-WEBHOOK] Lỗi xử lý:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Giao diện Developer Portal URL đẹp
app.get('/developer', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'developer.html'));
});

// API: Get category tree
app.get('/api/categories', (req, res) => {
  const treePath = path.join(__dirname, 'data', 'categories_tree.json');
  if (fs.existsSync(treePath)) {
    try {
      const tree = JSON.parse(fs.readFileSync(treePath, 'utf8'));
      return res.json({ success: true, tree });
    } catch (e) {}
  }
  res.json({ success: true, tree: [] });
});

// API: Get single product by SKU
app.get('/api/products/:sku', (req, res) => {
  const sku = req.params.sku.toUpperCase();
  const products = getProducts();
  const product = products.find(p => (p.sku || '').toUpperCase() === sku);
  if (!product) {
    return res.status(404).json({ success: false, message: 'Không tìm thấy sản phẩm' });
  }
  res.json({ success: true, product });
});

// API: Stats overview
app.get('/api/stats', (req, res) => {
  const products = getProducts();
  const config = getConfig();

  const totalProducts = products.length;
  const totalStockQuantity = products.reduce((acc, p) => acc + (Number(p.totalStock) || 0), 0);
  const outOfStockCount = products.filter(p => (Number(p.totalStock) || 0) <= 0).length;
  const inStockCount = products.filter(p => (Number(p.totalStock) || 0) > 0).length;

  res.json({
    success: true,
    totalProducts,
    totalStockQuantity,
    inStockCount,
    outOfStockCount,
    lastSyncTime: config.lastSyncTime || new Date().toISOString(),
    companyCode: config.companyCode || 'cobedenim'
  });
});

// API: Image Proxy (avoid CORS/Referrer blocks from MISA)
app.get('/api/proxy-image', (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl) return res.status(400).send('Missing url param');

  try {
    const parsed = new URL(imageUrl);
    const client = parsed.protocol === 'https:' ? https : http;

    client.get(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': 'https://cobedenim.mshopkeeper.vn/'
      }
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    }).on('error', (err) => {
      console.error('Image proxy error:', err.message);
      res.status(500).send('Proxy error');
    });
  } catch (err) {
    res.status(400).send('Invalid URL');
  }
});

// Helper: Decode JWT payload for user info
function decodeJwtPayload(token) {
  if (!token) return {};
  try {
    const parts = token.split('.');
    if (parts.length >= 2) {
      const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const pad = b64.padEnd(b64.length + (4 - b64.length % 4) % 4, '=');
      return JSON.parse(Buffer.from(pad, 'base64').toString('utf8'));
    }
  } catch (e) {}
  return {};
}

// Helper: Auto-detect MShopKeeper token from Chrome / Edge / CocCoc LevelDB
function findLevelDbToken() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return null;

  const candidateDirs = [
    path.join(localAppData, 'Google', 'Chrome', 'User Data', 'Default', 'Local Storage', 'leveldb'),
    path.join(localAppData, 'Microsoft', 'Edge', 'User Data', 'Default', 'Local Storage', 'leveldb'),
    path.join(localAppData, 'CocCoc', 'Browser', 'User Data', 'Default', 'Local Storage', 'leveldb'),
    path.join(localAppData, 'Google', 'Chrome', 'User Data', 'Profile 1', 'Local Storage', 'leveldb'),
    path.join(localAppData, 'Microsoft', 'Edge', 'User Data', 'Profile 1', 'Local Storage', 'leveldb')
  ];

  for (const dir of candidateDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir)
        .filter(f => f.endsWith('.log') || f.endsWith('.ldb'))
        .sort((a, b) => {
          try {
            return fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs;
          } catch (e) { return 0; }
        });

      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(dir, file));
          const rawStr = content.toString('latin1');

          // Priority 1: MShopKeeper opaque token (700-800 characters) right after access_token
          if (rawStr.includes('cobedenim') && rawStr.includes('access_token')) {
            const idx = rawStr.indexOf('access_token');
            const slice = rawStr.slice(idx, idx + 1500);
            const opaqueMatch = slice.match(/([a-zA-Z0-9_-]{700,800})/);
            if (opaqueMatch) {
              return {
                token: opaqueMatch[1],
                userId: '',
                userName: '',
                expired: false,
                browser: dir.includes('Chrome') ? 'Google Chrome' : 'Microsoft Edge'
              };
            }
          }
        } catch (e) {}
      }
    } catch (e) {}
  }

  // Fallback: check config.cachedToken
  const config = getConfig();
  if (config.cachedToken) {
    return {
      token: config.cachedToken,
      userId: '',
      userName: '',
      expired: false,
      browser: 'Google Chrome (Đã lưu)'
    };
  }

  return null;
}

// Helper: Parse product names & resolve accurate color and size from MShopKeeper master
function resolveProductColorAndSize(rawName, sku, master) {
  let name = String(rawName || '').trim();
  let color = '';
  let size = '';

  // 1. Check if name contains "(Color/Size)" or "(Size)" or "(Color)"
  const slashMatch = name.match(/^(.*?)\s*\((.*?)\/(.*?)\)\s*$/);
  if (slashMatch) {
    name = slashMatch[1].trim();
    color = slashMatch[2].trim();
    size = slashMatch[3].trim().toUpperCase();
  } else {
    const singleMatch = name.match(/^(.*?)\s*\((.*?)\)\s*$/);
    if (singleMatch) {
      name = singleMatch[1].trim();
      const inside = singleMatch[2].trim();
      if (/^(s|m|l|xl|xxl|2xl|3xl|\d{2})$/i.test(inside)) {
        size = inside.toUpperCase();
      } else {
        color = inside;
      }
    }
  }

  // 2. Supplement from master item from MShopKeeper
  if (master) {
    if (!color && master.Color) {
      const c = String(master.Color).trim();
      if (!c.includes(',')) {
        color = c;
      } else {
        color = 'Đa sắc';
      }
    }

    if (!size && master.Size) {
      const s = String(master.Size).trim();
      if (!s.includes(',')) {
        size = s.toUpperCase();
      } else {
        const parts = s.split(',').map(x => x.trim()).filter(Boolean);
        const order = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', '3XL'];
        parts.sort((a, b) => {
          const idxA = order.indexOf(a.toUpperCase());
          const idxB = order.indexOf(b.toUpperCase());
          if (idxA !== -1 && idxB !== -1) return idxA - idxB;
          return a.localeCompare(b, undefined, { numeric: true });
        });
        if (parts.length > 1) {
          size = `${parts[0]}-${parts[parts.length - 1]}`;
        } else {
          size = s.toUpperCase();
        }
      }
    }
  }

  // 3. Fallbacks
  if (!color) color = 'Tiêu chuẩn';
  if (!size) size = 'Freesize';

  return { name, color, size };
}

function parseProductNameVariant(rawName) {
  return resolveProductColorAndSize(rawName, '', null);
}

// Helper: Resolve product Brand and Category from MShopKeeper tree & fallback inference
function resolveBrandAndCategory(master, categoryMap) {
  const catId = master.InventoryItemCategoryID;
  if (catId && categoryMap && categoryMap.has(catId)) {
    const mapped = categoryMap.get(catId);
    return {
      brand: mapped.brand,
      category: mapped.category,
      fullCategory: mapped.fullCategory
    };
  }

  // Fallback: Infer brand & category from SKU code and product name
  const rawText = `${master.SKUCode || ''} ${master.InventoryItemName || ''}`.toUpperCase();
  let brand = 'Cobe Denim';
  if (/\bTM\b|TOMMY/.test(rawText)) brand = 'TOMMY';
  else if (/\bCK\b|CALVIN/.test(rawText)) brand = 'CALVIN KLEIN';
  else if (/\bLV\b|LEVI|LEVIS/.test(rawText)) brand = 'LEVIS';
  else if (/POLO RL|RALPH LAUREN|\bRL\b/.test(rawText)) brand = 'Polo RL';
  else if (/\bLC\b|LACOSTE|CÁ/.test(rawText)) brand = 'LACOSTE';

  let category = 'Thời trang';
  if (/POLO/.test(rawText)) category = 'ÁO POLO';
  else if (/SƠ MI|SOMI|\bASM\b/.test(rawText)) category = 'ÁO SƠ MI';
  else if (/QUẦN BÒ|\bQB\b|JEAN/.test(rawText)) category = 'QUẦN BÒ';
  else if (/QUẦN ĐÙI|ĐÙI|SHORT|\bQD\b/.test(rawText)) category = 'QUẦN ĐÙI';
  else if (/SỊP|LÓT|BOXER/.test(rawText)) category = 'SỊP ĐÙI';
  else if (/KHOÁC|JACKET/.test(rawText)) category = 'ÁO KHOÁC';
  else if (/LEN/.test(rawText)) category = 'ÁO LEN';
  else if (/NỈ|HOODIE/.test(rawText)) category = 'ÁO NỈ';
  else if (/PHÔNG|THUN|T-SHIRT/.test(rawText)) category = 'ÁO PHÔNG';
  else if (/KAKI|KHAKI/.test(rawText)) category = 'QUẦN KAKI';
  else if (/GIÀY|GIẦY|DÉP/.test(rawText)) category = 'GIÀY DÉP';
  else if (/PHỤ KIỆN|CẶP|TÚI|DÂY LƯNG/.test(rawText)) category = 'PHỤ KIỆN';

  return {
    brand,
    category,
    fullCategory: `${brand} > ${category}`
  };
}

// Helper: Kiểm tra nhanh hiệu lực của Token MShopKeeper với máy chủ MISA
async function verifyMshopkeeperSession(token, branchId) {
  if (!token) {
    return { valid: false, message: 'Token không được để trống' };
  }
  const cleanToken = String(token).replace(/^Bearer\s+/i, '').trim();
  const targetBranchId = branchId || getConfig().branchId || '68d5c6a7-2ad8-44c8-b36c-58e095dd6ceb';
  const reqHeaders = {
    'accept': 'application/json',
    'authorization': `Bearer ${cleanToken}`,
    'companycode': 'cobedenim',
    'x-misa-branchid': targetBranchId,
    'x-misa-language': 'vi-VN'
  };

  try {
    const testUrl = `https://cobedenim.mshopkeeper.vn/backendg2/api/InventoryItemCategory/TreeItem?_dc=${Date.now()}&node=root`;
    const res = await fetch(testUrl, {
      method: 'GET',
      headers: reqHeaders,
      signal: AbortSignal.timeout(5000)
    });

    if (res.ok) {
      return {
        valid: true,
        status: res.status,
        message: 'Phiên đăng nhập MShopKeeper hợp lệ và đang hoạt động!'
      };
    }

    if (res.status === 401 || res.status === 403) {
      return {
        valid: false,
        status: res.status,
        expired: true,
        message: 'Phiên đăng nhập đã hết hạn. Hãy mở tab cobedenim.mshopkeeper.vn trên Chrome để làm mới phiên.'
      };
    }

    return {
      valid: false,
      status: res.status,
      message: `MShopKeeper trả về mã lỗi HTTP ${res.status}.`
    };
  } catch (err) {
    return {
      valid: false,
      status: 0,
      message: `Lỗi kết nối tới MShopKeeper: ${err.message}`
    };
  }
}

// API: Kiểm tra trạng thái phiên đăng nhập MShopKeeper (LevelDB máy trạm hoặc token truyền lên)
app.all('/api/sync/check-session', async (req, res) => {
  try {
    let token = (req.body && req.body.token) || req.query.token;
    let browserName = '';
    let isFromBrowser = false;

    // Nếu không truyền token, tự động đọc từ LevelDB trên máy trạm
    if (!token) {
      const tokenInfo = findLevelDbToken();
      if (!tokenInfo || !tokenInfo.token) {
        return res.json({
          success: false,
          valid: false,
          found: false,
          message: 'Chưa tìm thấy phiên đăng nhập trên trình duyệt. Hãy mở Chrome / Edge và đăng nhập vào cobedenim.mshopkeeper.vn.'
        });
      }
      token = tokenInfo.token;
      browserName = tokenInfo.browser;
      isFromBrowser = true;
    }

    const checkResult = await verifyMshopkeeperSession(token);
    const masked = token.length > 16 ? `${token.slice(0, 8)}...${token.slice(-8)}` : token;

    return res.json({
      success: true,
      valid: checkResult.valid,
      expired: Boolean(checkResult.expired),
      browser: browserName || 'Thủ công',
      isFromBrowser,
      token,
      tokenMasked: masked,
      status: checkResult.status,
      message: checkResult.message
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      valid: false,
      message: 'Lỗi kiểm tra phiên: ' + err.message
    });
  }
});

// API: Auto-detect token from host machine LevelDB
app.get('/api/sync/auto-token', (req, res) => {
  const result = findLevelDbToken();
  if (result) {
    return res.json({
      success: true,
      token: result.token,
      userId: result.userId,
      userName: result.userName,
      browser: result.browser,
      expired: result.expired
    });
  }
  return res.json({
    success: false,
    message: 'Chưa tìm thấy token trong Chrome/Edge. Bạn hãy mở tab mshopkeeper trên Chrome rồi bấm lại nút này nhé.'
  });
});

// Helper: Parse Excel buffer into normalized product catalog
function parseExcelBufferToProducts(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  if (!workbook.SheetNames || workbook.SheetNames.length === 0) return [];
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

  if (!rows || rows.length < 2) return [];

  // Identify header row & column indices
  let headerRowIdx = -1;
  let colNameIdx = -1;
  let colCodeIdx = -1;
  let colStockIdx = -1;
  let colPriceIdx = -1;

  for (let i = 0; i < Math.min(15, rows.length); i++) {
    const row = rows[i] || [];
    for (let j = 0; j < row.length; j++) {
      const cell = String(row[j] || '').toLowerCase().trim();
      if (cell.includes('tên hàng') || cell.includes('tên sản phẩm')) colNameIdx = j;
      if (cell.includes('mã hàng') || cell.includes('mã sp') || cell.includes('số chứng từ')) colCodeIdx = j;
      if (cell.includes('tồn cuối') || cell.includes('số lượng') || cell.includes('tồn kho') || cell.includes('tổng')) colStockIdx = j;
      if (cell.includes('giá bán') || cell.includes('đơn giá') || cell.includes('giá')) colPriceIdx = j;
    }
    if (colNameIdx !== -1) {
      headerRowIdx = i;
      break;
    }
  }

  if (colNameIdx === -1) {
    colNameIdx = 2;
    colStockIdx = colStockIdx !== -1 ? colStockIdx : 3;
    headerRowIdx = 8;
  }

  const productMap = new Map();

  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const rawName = String(row[colNameIdx] || '').trim();
    if (!rawName || rawName === 'Cộng' || rawName.startsWith('Tổng') || rawName.includes('Công nợ')) continue;

    const { name, color, size } = parseProductNameVariant(rawName);
    if (!name) continue;

    const rawStock = Number(row[colStockIdx]) || 1;
    const rawPrice = colPriceIdx !== -1 ? Number(row[colPriceIdx]) || 0 : 0;
    const baseSku = (row[colCodeIdx] ? String(row[colCodeIdx]).trim() : name.split(' ').slice(0, 3).join('-')).toUpperCase();

    if (!productMap.has(name)) {
      productMap.set(name, {
        id: `cobe-${Math.random().toString(36).substring(2, 8)}`,
        sku: baseSku,
        name: name,
        category: 'Cobe Denim',
        retailPrice: rawPrice > 0 ? rawPrice : 350000,
        imageUrl: 'https://images.unsplash.com/photo-1541099649105-f69ad21f3246?auto=format&fit=crop&w=800&q=80',
        description: `Sản phẩm ${name} chính hãng Cobe Denim.`,
        updatedAt: new Date().toISOString(),
        variants: []
      });
    }

    const prod = productMap.get(name);
    prod.variants.push({
      color,
      size,
      stock: rawStock,
      skuVariant: `${baseSku}-${color}-${size}`
    });
  }

  // Recalculate totalStock and status for each product
  const productList = Array.from(productMap.values()).map(p => {
    const totalStock = p.variants.reduce((acc, v) => acc + v.stock, 0);
    return {
      ...p,
      totalStock,
      status: totalStock === 0 ? 'out_of_stock' : totalStock <= 5 ? 'low_stock' : 'in_stock'
    };
  });

  return productList;
}

// API: Upload and parse Excel inventory exported from MShopKeeper
app.post('/api/sync/upload-excel', adminRateLimiter, (req, res) => {
  const { fileData } = req.body;
  if (!fileData) {
    return res.status(400).json({ success: false, message: 'Thiếu dữ liệu file' });
  }

  try {
    const base64Data = fileData.replace(/^data:.*?;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    const parsedList = parseExcelBufferToProducts(buffer);

    if (parsedList.length === 0) {
      return res.status(400).json({ success: false, message: 'Không trích xuất được dòng sản phẩm nào từ file Excel này.' });
    }

    saveProducts(parsedList);
    const config = getConfig();
    config.lastSyncTime = new Date().toISOString();
    config.totalProducts = parsedList.length;
    saveConfig(config);

    return res.json({
      success: true,
      message: `Đã nạp thành công ${parsedList.length} mẫu sản phẩm từ file Excel!`,
      total: parsedList.length
    });
  } catch (err) {
    console.error('Excel parse error:', err);
    return res.status(500).json({ success: false, message: `Lỗi xử lý file Excel: ${err.message}` });
  }
});

// Category image picker for aesthetic Cobe Denim Lookbook
function getCategoryPlaceholder(catName, itemName) {
  const text = ((catName || '') + ' ' + (itemName || '')).toLowerCase();
  if (text.includes('polo')) return 'https://images.unsplash.com/photo-1625910513413-7ec5314787d5?auto=format&fit=crop&w=800&q=80';
  if (text.includes('golf')) return 'https://images.unsplash.com/photo-1581655353564-df123a1eb820?auto=format&fit=crop&w=800&q=80';
  if (text.includes('thun') || text.includes('cổ tròn') || text.includes('t-shirt')) return 'https://images.unsplash.com/photo-1521572267360-ee0c2909d518?auto=format&fit=crop&w=800&q=80';
  if (text.includes('quần đùi') || text.includes('sịp') || text.includes('đồ ngủ')) return 'https://images.unsplash.com/photo-1591195853828-11db59a44f6b?auto=format&fit=crop&w=800&q=80';
  if (text.includes('jean') || text.includes('bò') || text.includes('quần dài') || text.includes('kaki') || text.includes('quần')) return 'https://images.unsplash.com/photo-1541099649105-f69ad21f3246?auto=format&fit=crop&w=800&q=80';
  if (text.includes('khoác') || text.includes('jacket') || text.includes('hoodie')) return 'https://images.unsplash.com/photo-1551028719-00167b16eac5?auto=format&fit=crop&w=800&q=80';
  return 'https://images.unsplash.com/photo-1541099649105-f69ad21f3246?auto=format&fit=crop&w=800&q=80';
}

// State tracking real-time MShopKeeper Sync Progress
let mshopSyncProgress = {
  running: false,
  step: 0,
  totalSteps: 4,
  stepTitle: 'Sẵn sàng',
  percent: 0,
  detail: '',
  itemsProcessed: 0,
  totalItems: 0,
  startedAt: null,
  finishedAt: null,
  error: null
};

function getMshopSyncProgress() {
  return { ...mshopSyncProgress };
}

// Core helper: Perform sync from MShopKeeper API using verified InventoryItem and instocks endpoints
async function performSyncFromMShopKeeper(token, branchId) {
  const config = getConfig();
  const targetToken = token || config.cachedToken || process.env.MSHOPKEEPER_TOKEN;
  const targetBranchId = branchId || config.branchId || '68d5c6a7-2ad8-44c8-b36c-58e095dd6ceb';

  if (!targetToken) {
    return {
      success: false,
      message: 'Cần có Access Token của MShopKeeper để đồng bộ.'
    };
  }

  mshopSyncProgress = {
    running: true,
    step: 1,
    totalSteps: 4,
    stepTitle: 'Kết nối MShopKeeper & tải cây danh mục',
    percent: 10,
    detail: 'Đang kết nối API MShopKeeper...',
    itemsProcessed: 0,
    totalItems: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null
  };

  const reqHeaders = {
    'accept': 'application/json',
    'authorization': `Bearer ${targetToken}`,
    'companycode': 'cobedenim',
    'x-misa-branchid': targetBranchId,
    'x-misa-language': 'vi-VN'
  };

  try {
    // 0. Fetch Category Tree from TreeItem
    console.log(`[SYNC] Lấy cây phân loại nhóm hàng hóa (InventoryItemCategory/TreeItem)...`);
    const categoryMap = new Map();
    let categoryTreeData = [];
    try {
      const treeUrl = `https://cobedenim.mshopkeeper.vn/backendg2/api/InventoryItemCategory/TreeItem?_dc=${Date.now()}&node=root`;
      const treeRes = await fetch(treeUrl, { method: 'GET', headers: reqHeaders });
      if (treeRes.ok) {
        const treeJson = await treeRes.json();
        categoryTreeData = treeJson.Data || [];

        function parseCategoryNode(node, parentBrand = '') {
          const brand = parentBrand || (node.Grade === 1 ? node.ItemCategoryName : '');
          const catName = node.ItemCategoryName;
          const fullCat = brand && brand !== catName ? `${brand} > ${catName}` : catName;

          categoryMap.set(node.InventoryItemCategoryID, {
            id: node.InventoryItemCategoryID,
            code: node.ItemCategoryCode,
            brand: brand || 'Cobe Denim',
            category: catName,
            fullCategory: fullCat,
            grade: node.Grade
          });

          if (Array.isArray(node.Data)) {
            node.Data.forEach(child => parseCategoryNode(child, brand || node.ItemCategoryName));
          }
        }

        categoryTreeData.forEach(root => parseCategoryNode(root));
        console.log(`[SYNC] -> Đã nạp ${categoryMap.size} nhóm hàng từ cây danh mục MShopKeeper.`);

        // Save treeData for API & frontend
        fs.writeFileSync(path.join(__dirname, 'data', 'categories_tree.json'), JSON.stringify(categoryTreeData, null, 2), 'utf-8');
      }
    } catch (e) {
      console.warn(`[SYNC] Không thể tải danh mục TreeItem: ${e.message}`);
    }

    // 1. Fetch Master InventoryItem catalog for PictureID and real UnitPrice
    console.log(`[SYNC] Lấy danh mục sản phẩm gốc & ảnh từ MShopKeeper...`);
    mshopSyncProgress.percent = 20;
    mshopSyncProgress.detail = 'Đang tải danh sách sản phẩm gốc và mã hình ảnh...';
    const invUrl = `https://cobedenim.mshopkeeper.vn/backendg2/api/InventoryItem?_dc=${Date.now()}&inventoryItemCategoryID=00000000-0000-0000-0000-000000000000&branchID=${targetBranchId}&isOutStock=0&page=1&start=0&limit=1000`;
    
    let masterItems = [];
    try {
      const invRes = await fetch(invUrl, { method: 'GET', headers: reqHeaders });
      if (invRes.status === 401) {
        mshopSyncProgress.running = false;
        mshopSyncProgress.error = 'Token đã hết hạn';
        mshopSyncProgress.detail = 'Phiên đăng nhập đã hết hạn. Vui lòng mở tab cobedenim.mshopkeeper.vn để làm mới token.';
        return {
          success: false,
          expired: true,
          message: 'Token đã hết hạn hoặc không có quyền truy cập MShopKeeper. Hãy mở tab cobedenim.mshopkeeper.vn trên Chrome để làm mới.'
        };
      }
      if (invRes.ok) {
        const invData = await invRes.json();
        masterItems = invData.Data || [];
        console.log(`[SYNC] -> Đã lấy được ${masterItems.length} mẫu gốc từ InventoryItem.`);
      }
    } catch (e) {
      console.warn(`[SYNC] Không thể tải danh mục InventoryItem: ${e.message}`);
    }

    mshopSyncProgress.totalItems = masterItems.length;
    mshopSyncProgress.percent = 30;
    mshopSyncProgress.detail = `Đã tìm thấy ${masterItems.length} mẫu sản phẩm gốc từ MShopKeeper.`;

    // Build master lookup maps by SKU and Name
    const masterBySku = new Map();
    const masterByName = new Map();
    for (const m of masterItems) {
      if (m.SKUCode) masterBySku.set(m.SKUCode.toUpperCase().trim(), m);
      if (m.InventoryItemName) masterByName.set(m.InventoryItemName.toLowerCase().trim(), m);
    }

    // 2. Fetch current instocks for today's real-time inventory
    mshopSyncProgress.step = 2;
    mshopSyncProgress.stepTitle = 'Đang tải tồn kho tổng thể';
    mshopSyncProgress.percent = 35;
    mshopSyncProgress.detail = 'Đang truy vấn số lượng tồn kho theo thời gian thực...';
    const nowVn = new Date(Date.now() + 7 * 3600 * 1000);
    const today = nowVn.toISOString().split('T')[0];
    const stockUrl = `https://cobedenim.mshopkeeper.vn/backendg2/api/instocks?_dc=${Date.now()}&fromDate=${today}T00:00:00&toDate=${today}T23:59:59&branchID=${targetBranchId}&stockID=00000000-0000-0000-0000-000000000000&inventoryItemCategoryID=00000000-0000-0000-0000-000000000000&inventoryItem=&showOrderedQuantity=false&UnitID=00000000-0000-0000-0000-000000000000&instockType=0&instockStatusID=0&trancationStatusID=0&quantityStatusID=0&BrandID=00000000-0000-0000-0000-000000000000&page=1&start=0&limit=1000`;

    console.log(`[SYNC] Gửi yêu cầu lấy số lượng tồn kho MShopKeeper (${targetBranchId})...`);
    const stockResponse = await fetch(stockUrl, {
      method: 'GET',
      headers: reqHeaders
    });

    if (stockResponse.status === 401) {
      mshopSyncProgress.running = false;
      mshopSyncProgress.error = 'Token đã hết hạn';
      return {
        success: false,
        expired: true,
        message: 'Token đã hết hạn hoặc không có quyền truy cập MShopKeeper. Hãy mở tab cobedenim.mshopkeeper.vn trên Chrome để làm mới.'
      };
    }

    if (!stockResponse.ok) {
      mshopSyncProgress.running = false;
      mshopSyncProgress.error = `HTTP ${stockResponse.status}`;
      return {
        success: false,
        message: `MShopKeeper trả về lỗi HTTP ${stockResponse.status}: ${stockResponse.statusText}`
      };
    }

    const data = await stockResponse.json();
    const rawItems = data.Data || [];

    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      mshopSyncProgress.running = false;
      mshopSyncProgress.error = 'Không có dữ liệu';
      return {
        success: false,
        message: 'Không tìm thấy dữ liệu hàng hóa nào trong kho MShopKeeper.'
      };
    }

    // 3. Fetch full child variants via ByParentID to get distinct colors, photos, and prices
    mshopSyncProgress.step = 3;
    mshopSyncProgress.stepTitle = 'Đang nạp chi tiết màu sắc, hình ảnh & giá';
    mshopSyncProgress.percent = 40;
    mshopSyncProgress.detail = `Đang tải chi tiết biến thể màu và ảnh cho ${masterItems.length} sản phẩm...`;

    console.log(`[SYNC] Lấy chi tiết phân loại màu, ảnh và giá từng màu (ByParentID)...`);
    const childrenCache = new Map();

    // TỐI ƯU 1: Đọc từ cache variants cục bộ để tránh nã hàng trăm request vào MShopKeeper
    if (fs.existsSync(VARIANTS_CACHE_FILE)) {
      try {
        const cachedData = JSON.parse(fs.readFileSync(VARIANTS_CACHE_FILE, 'utf-8'));
        for (const [k, v] of Object.entries(cachedData)) {
          childrenCache.set(k, v);
        }
        console.log(`[SYNC] -> Đã tận dụng ${childrenCache.size} mẫu từ cache biến thể màu/ảnh sẵn có.`);
      } catch (e) {}
    }

    // Chỉ gọi ByParentID cho những mẫu thực sự mới / chưa có trong cache
    const itemsNeedFetch = masterItems.filter(m => !childrenCache.has(m.InventoryItemID));
    console.log(`[SYNC] -> Số mẫu mới cần truy vấn MShopKeeper: ${itemsNeedFetch.length}/${masterItems.length}.`);

    const BATCH_SIZE_VARIANTS = 8; // Giảm từ 25 xuống 8 để bảo vệ kết nối MISA
    for (let i = 0; i < itemsNeedFetch.length; i += BATCH_SIZE_VARIANTS) {
      const batch = itemsNeedFetch.slice(i, i + BATCH_SIZE_VARIANTS);
      await Promise.all(batch.map(async (m) => {
        try {
          const u = `https://cobedenim.mshopkeeper.vn/backendg2/api/InventoryItem/ByParentID?parentId=${m.InventoryItemID}&page=1&start=0&limit=100`;
          const r = await fetch(u, { headers: reqHeaders, signal: AbortSignal.timeout(8000) });
          const d = await r.json();
          if (d.Data && d.Data.length > 0) {
            childrenCache.set(m.InventoryItemID, d.Data);
          }
        } catch (e) {}
      }));

      const processed = Math.min(i + batch.length, itemsNeedFetch.length);
      mshopSyncProgress.itemsProcessed = processed;
      mshopSyncProgress.percent = 40 + Math.round((processed / (itemsNeedFetch.length || 1)) * 30);
      mshopSyncProgress.detail = `Đang tải mẫu mới: ${processed}/${itemsNeedFetch.length} (${mshopSyncProgress.percent}%)`;

      // Khoảng nghỉ nhẹ 350ms giữa các đợt để bảo vệ server MISA
      if (i + BATCH_SIZE_VARIANTS < itemsNeedFetch.length) {
        await sleep(350);
      }
    }

    // Lưu lại cache biến thể để các lần sau hoàn toàn 0 tốn request
    try {
      const cacheObj = Object.fromEntries(childrenCache);
      fs.writeFileSync(VARIANTS_CACHE_FILE, JSON.stringify(cacheObj, null, 2), 'utf-8');
    } catch (e) {}

    console.log(`[SYNC] -> Đã lấy chi tiết biến thể của ${childrenCache.size} sản phẩm.`);

    // 4. Fetch exact real-time variant stocks from instocks/detail API
    mshopSyncProgress.step = 4;
    mshopSyncProgress.stepTitle = 'Đang nạp tồn kho chính xác từng size/màu';
    mshopSyncProgress.percent = 70;
    mshopSyncProgress.detail = 'Đang tải số lượng tồn kho từng size/màu chi tiết...';

    console.log(`[SYNC] Lấy số lượng tồn kho chính xác từng size/màu (instocks/detail)...`);
    const stockDetailMap = new Map();
    const BATCH_SIZE_STOCKS = 8; // Giảm từ 25 xuống 8 để không gây nghẽn kết nối MISA
    for (let i = 0; i < masterItems.length; i += BATCH_SIZE_STOCKS) {
      const batch = masterItems.slice(i, i + BATCH_SIZE_STOCKS);
      await Promise.all(batch.map(async (m) => {
        try {
          const u = `https://cobedenim.mshopkeeper.vn/backendg2/api/instocks/detail?_dc=${Date.now()}&fromDate=${today}T00:00:00&toDate=${today}T23:59:59&branchID=${targetBranchId}&stockID=00000000-0000-0000-0000-000000000000&inventoryItemID=${m.InventoryItemID}&showOrderedQuantity=false&UnitID=00000000-0000-0000-0000-000000000000&lotID=&expiryDate=&isShowAllDetail=true`;
          const r = await fetch(u, { headers: reqHeaders, signal: AbortSignal.timeout(8000) });
          const d = await r.json();
          (d.Data || []).forEach(it => {
            if (it.SKUCode) {
              stockDetailMap.set(it.SKUCode.toUpperCase().trim(), Number(it.InstockQuantity) || 0);
            }
          });
        } catch (e) {}
      }));

      const processed = Math.min(i + batch.length, masterItems.length);
      mshopSyncProgress.percent = 70 + Math.round((processed / masterItems.length) * 25); // 70% -> 95%
      mshopSyncProgress.detail = `Đang nạp tồn kho chi tiết: ${processed}/${masterItems.length} sản phẩm (${mshopSyncProgress.percent}%)`;

      // Khoảng nghỉ 300ms giữa các đợt để server MISA kịp nhả kết nối
      if (i + BATCH_SIZE_STOCKS < masterItems.length) {
        await sleep(300);
      }
    }
    console.log(`[SYNC] -> Đã lấy tồn kho thực tế của ${stockDetailMap.size} biến thể size/màu.`);

    // Fallback stock lookup from parent instocks
    const stockMap = new Map();
    rawItems.forEach(s => {
      if (s.SKUCode) stockMap.set(s.SKUCode.toUpperCase().trim(), Number(s.InstockQuantity) || 0);
    });

    // Helper: Strip size suffix from variant SKU (e.g. "3QNC02-MON01-S" -> "3QNC02-MON01")
    function cleanColorSku(childSku, size) {
      let s = String(childSku || '').trim();
      if (!s) return '';
      if (size) {
        const cleanSize = String(size).trim();
        const regex = new RegExp(`-${cleanSize}$`, 'i');
        if (regex.test(s)) {
          return s.replace(regex, '');
        }
      }
      return s.replace(/-(?:xs|s|m|l|xl|xxl|2xl|3xl|\d{2})$/i, '');
    }

    // 5. Expand products by color with distinct pictures, prices, and accurate sizes
    const expandedProducts = [];
    let picCount = 0;

    for (const master of masterItems) {
      const children = childrenCache.get(master.InventoryItemID) || [];
      const baseSku = String(master.SKUCode || '').trim();
      const parentStock = stockMap.get(baseSku.toUpperCase()) ?? 0;
      const catInfo = resolveBrandAndCategory(master, categoryMap);
      const brand = catInfo.brand;
      const cat = catInfo.category;
      const fullCategory = catInfo.fullCategory;

      if (children.length > 0) {
        // Group children by Color
        const byColor = new Map();
        children.forEach(c => {
          const col = c.Color ? String(c.Color).trim() : 'Tiêu chuẩn';
          if (!byColor.has(col)) byColor.set(col, []);
          byColor.get(col).push(c);
        });

        const totalColors = byColor.size;
        for (const [colorName, childList] of byColor.entries()) {
          const first = childList[0];
          // Find child with valid PictureID in this color group
          const childWithPic = childList.find(c => c.PictureID && c.PictureID !== '00000000-0000-0000-0000-000000000000');
          const hasChildPic = !!childWithPic;
          const picId = hasChildPic
            ? childWithPic.PictureID
            : (master.PictureID && master.PictureID !== '00000000-0000-0000-0000-000000000000' ? master.PictureID : null);

          if (picId) picCount++;

          const rawExt = (hasChildPic ? childWithPic.Extension : master.Extension) || '.jpg';
          const cleanExt = rawExt.startsWith('.') ? rawExt : ('.' + rawExt);

          const retailPrice = Number(first.UnitPrice) > 0
            ? Number(first.UnitPrice)
            : Number(master.UnitPrice) > 0
              ? Number(master.UnitPrice)
              : 350000;

          const imgUrl = picId
            ? `/api/images/${picId}.jpg`
            : getCategoryPlaceholder(cat, master.InventoryItemName);

          const displayName = totalColors > 1 && colorName !== 'Tiêu chuẩn'
            ? `${master.InventoryItemName} (${colorName})`
            : master.InventoryItemName;

          // Strip size suffix from color SKU (e.g. "3QNC02-MON01-S" -> "3QNC02-MON01")
          const colorCardSku = cleanColorSku(first.SKUCode, first.Size) || baseSku;

          // Individual size pills with EXACT stock from instocks/detail
          const variants = childList.map(c => {
            const childSku = String(c.SKUCode || '').toUpperCase().trim();
            const childStock = stockDetailMap.has(childSku)
              ? stockDetailMap.get(childSku)
              : (stockMap.get(childSku) ?? 0);

            return {
              color: colorName,
              size: String(c.Size || 'Freesize').trim().toUpperCase(),
              stock: childStock,
              skuVariant: c.SKUCode || baseSku,
              unitPrice: Number(c.UnitPrice) || retailPrice
            };
          });

          // Total stock is sum of all size variants for this color
          const cardTotalStock = variants.reduce((acc, v) => acc + (Number(v.stock) || 0), 0);

          expandedProducts.push({
            id: `cobe-${master.InventoryItemID}-${Buffer.from(colorName).toString('hex').slice(0, 8)}`,
            sku: colorCardSku,
            parentSku: baseSku,
            name: displayName,
            brand,
            category: cat,
            fullCategory,
            color: colorName,
            retailPrice,
            pictureId: picId,
            imageUrl: imgUrl,
            description: `Sản phẩm ${displayName} chính hãng ${brand}.`,
            updatedAt: new Date().toISOString(),
            variants,
            totalStock: cardTotalStock,
            status: cardTotalStock <= 0 ? 'out_of_stock' : 'in_stock'
          });
        }
      } else {
        // Master item without child variants
        const picId = master.PictureID && master.PictureID !== '00000000-0000-0000-0000-000000000000' ? master.PictureID : null;
        if (picId) picCount++;

        const rawExt = master.Extension || '.jpg';
        const cleanExt = rawExt.startsWith('.') ? rawExt : ('.' + rawExt);

        const retailPrice = Number(master.UnitPrice) > 0 ? Number(master.UnitPrice) : 350000;
        const imgUrl = picId
          ? `/api/images/${picId}.jpg`
          : getCategoryPlaceholder(cat, master.InventoryItemName);

        const sizes = master.Size ? master.Size.split(',').map(x => x.trim().toUpperCase()) : ['FREESIZE'];
        const variants = sizes.map(sz => ({
          color: master.Color || 'Tiêu chuẩn',
          size: sz,
          stock: parentStock,
          skuVariant: baseSku,
          unitPrice: retailPrice
        }));

        expandedProducts.push({
          id: `cobe-${master.InventoryItemID}`,
          sku: baseSku,
          parentSku: baseSku,
          name: master.InventoryItemName,
          brand,
          category: cat,
          fullCategory,
          color: master.Color || 'Tiêu chuẩn',
          retailPrice,
          pictureId: picId,
          imageUrl: imgUrl,
          description: `Sản phẩm ${master.InventoryItemName} chính hãng ${brand}.`,
          updatedAt: new Date().toISOString(),
          variants,
          totalStock: parentStock,
          status: parentStock <= 0 ? 'out_of_stock' : 'in_stock'
        });
      }
    }

    saveProducts(expandedProducts);
    config.lastSyncTime = new Date().toISOString();
    config.syncStatus = 'SUCCESS';
    config.totalProducts = expandedProducts.length;
    if (token) config.cachedToken = token;
    saveConfig(config);

    console.log(`[SYNC] Hoàn tất: ${expandedProducts.length} phân loại màu, ${picCount} mẫu có ảnh thật.`);

    // Tự động đẩy dữ liệu đồng bộ lên Cloudflare nếu có cloudflareUrl
    forwardSyncToCloudflare(targetToken, targetBranchId).catch(() => {});

    mshopSyncProgress.running = false;
    mshopSyncProgress.percent = 100;
    mshopSyncProgress.stepTitle = 'Hoàn tất đồng bộ';
    mshopSyncProgress.detail = `Đã đồng bộ thành công ${expandedProducts.length} mẫu theo từng màu với ${picCount} ảnh thật!`;
    mshopSyncProgress.finishedAt = new Date().toISOString();

    return {
      success: true,
      message: `Đồng bộ trực tiếp thành công ${expandedProducts.length} mẫu theo từng màu và giá từ MShopKeeper với ${picCount} ảnh thật!`,
      totalUpdated: expandedProducts.length,
      realPictures: picCount,
      lastSyncTime: config.lastSyncTime
    };

  } catch (err) {
    console.error('Sync error:', err);
    mshopSyncProgress.running = false;
    mshopSyncProgress.error = err.message;
    mshopSyncProgress.detail = `Lỗi kết nối MShopKeeper: ${err.message}`;
    return {
      success: false,
      message: `Lỗi kết nối MShopKeeper: ${err.message}`
    };
  }
}

// Helper: Tự động đẩy kết quả đồng bộ lên Cloudflare Pages & KV nếu có cấu hình cloudflareUrl
async function forwardSyncToCloudflare(token, branchId) {
  const config = getConfig();
  const cfUrl = (config.cloudflareUrl || process.env.CLOUDFLARE_URL || '').trim().replace(/\/+$/, '');
  if (!cfUrl) return null;

  try {
    console.log(`[SYNC-CLOUDFLARE] Đang gửi token lên Cloudflare (${cfUrl})...`);
    const cfRes = await fetch(`${cfUrl}/api/sync/mshopkeeper`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: token || config.cachedToken,
        branchId: branchId || config.branchId
      })
    });
    const cfJson = await cfRes.json().catch(() => ({}));
    if (cfRes.ok && cfJson.success) {
      console.log(`[SYNC-CLOUDFLARE] ✓ Thành công! Cloudflare đã cập nhật ${cfJson.totalProducts || 0} sản phẩm vào INVENTORY_KV.`);
      return { success: true, message: cfJson.message };
    } else {
      console.warn(`[SYNC-CLOUDFLARE] ⚠ Cloudflare phản hồi:`, cfJson.message || cfRes.statusText);
      return { success: false, message: cfJson.message || cfRes.statusText };
    }
  } catch (err) {
    console.warn(`[SYNC-CLOUDFLARE] ⚠ Không thể kết nối Cloudflare: ${err.message}`);
    return { success: false, message: err.message };
  }
}

// Helper: Đẩy dữ liệu cập nhật tức thì lên Cloudflare Pages & KV
async function forwardTargetedSyncToCloudflare(updatedProducts) {
  if (!Array.isArray(updatedProducts) || updatedProducts.length === 0) return null;
  const config = getConfig();
  const cfUrl = (config.cloudflareUrl || process.env.CLOUDFLARE_URL || '').trim().replace(/\/+$/, '');
  if (!cfUrl) return null;

  try {
    const cfRes = await fetch(`${cfUrl}/api/sync/targeted-products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updatedProducts }),
      signal: AbortSignal.timeout(5000)
    });
    const cfJson = await cfRes.json().catch(() => ({}));
    if (cfRes.ok && cfJson.success) {
      console.log(`[SYNC-CLOUDFLARE] ✓ Đồng bộ tức thì ${updatedProducts.length} sản phẩm lên Cloudflare KV (${cfUrl}) thành công!`);
      return { success: true };
    } else {
      console.warn(`[SYNC-CLOUDFLARE] ⚠ Cloudflare (${cfUrl}) phản hồi: ${cfJson.message || cfRes.statusText}`);
    }
  } catch (err) {
    console.warn(`[SYNC-CLOUDFLARE] ℹ Không thể kết nối Cloudflare URL (${cfUrl}): ${err.message}. (Nếu chưa deploy Cloudflare Pages hoặc tên miền khác, bạn có thể cập nhật lại cloudflareUrl trong sync-config.json).`);
  }
  return null;
}

// Core Targeted Real-Time Sync: Cập nhật biến động kho chính xác từ MShopKeeper khi có giao dịch
async function syncTargetedProducts({ action = 'targeted_sync', items = [], refId = null, token = null, branchId = null }) {
  const tStart = Date.now();
  const config = getConfig();
  const levelDbInfo = findLevelDbToken();
  const targetToken = token || (levelDbInfo && levelDbInfo.token) || config.cachedToken || process.env.MSHOPKEEPER_TOKEN;
  const targetBranchId = branchId || config.branchId || '68d5c6a7-2ad8-44c8-b36c-58e095dd6ceb';

  if (!targetToken) {
    return {
      success: false,
      message: 'Chưa có Access Token MShopKeeper để đồng bộ.'
    };
  }

  const reqHeaders = {
    'accept': 'application/json',
    'authorization': `Bearer ${targetToken}`,
    'companycode': 'cobedenim',
    'x-misa-branchid': targetBranchId,
    'x-misa-language': 'vi-VN'
  };

  const resolvedItems = [...(Array.isArray(items) ? items : [])];

  // Nếu có refId mà không có sẵn chi tiết items, tự động kéo từ MISA API tương ứng
  if (refId && resolvedItems.length === 0) {
    try {
      const isLikelyInward = action.includes('inward');
      if (isLikelyInward) {
        const inwardDetailUrl = `https://cobedenim.mshopkeeper.vn/backendg2/api/INInwards/INInwardDetail/${encodeURIComponent(refId)}?_dc=${Date.now()}&page=1&start=0&limit=100`;
        const inRes = await fetch(inwardDetailUrl, { headers: reqHeaders, signal: AbortSignal.timeout(15000) });
        if (inRes.ok) {
          const inJson = await inRes.json();
          const details = (inJson.Data && Array.isArray(inJson.Data)) ? inJson.Data : (inJson.INInwardDetails || []);
          details.forEach(dt => {
            if (dt.SKUCode) {
              resolvedItems.push({
                sku: dt.SKUCode,
                parentId: dt.ParentID || dt.InventoryItemID,
                parentSku: dt.SKUCodeParent,
                quantity: dt.Quantity
              });
            }
          });
        }
      } else {
        const getDetailUrl = `https://cobedenim.mshopkeeper.vn/salecloud/backendg2/api/v1/SAInvoice/getdetail?refId=${encodeURIComponent(refId)}`;
        const dRes = await fetch(getDetailUrl, { headers: reqHeaders, signal: AbortSignal.timeout(15000) });
        if (dRes.ok) {
          const dJson = await dRes.json();
          const details = (dJson.Data && dJson.Data.SAInvoiceDetails) || dJson.SAInvoiceDetails || [];
          details.forEach(dt => {
            resolvedItems.push({
              sku: dt.SKUCode,
              parentId: dt.InventoryItemParentID || dt.InventoryItemParent || dt.ParentID,
              parentSku: dt.SKUCodeParent,
              quantity: dt.Quantity
            });
          });
        }
      }
    } catch (e) {
      console.warn(`[TARGETED-SYNC] Không thể tải chi tiết chứng từ ${refId}:`, e.message);
    }
  }

  if (resolvedItems.length === 0 && !refId) {
    return {
      success: false,
      message: 'Không tìm thấy danh sách sản phẩm cần đồng bộ.'
    };
  }

  const products = getProducts();
  const parentIdSet = new Set();
  const itemSkuSet = new Set();

  const GUID_REGEX = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/i;
  function extractGuid(str) {
    if (!str) return null;
    const m = String(str).match(GUID_REGEX);
    return m ? m[0].toLowerCase() : null;
  }

  resolvedItems.forEach(it => {
    const guid = extractGuid(it.parentId);
    if (guid && guid !== '00000000-0000-0000-0000-000000000000') {
      parentIdSet.add(guid);
    }
    if (it.sku) {
      itemSkuSet.add(String(it.sku).toUpperCase().trim());
    }
    if (it.parentSku) {
      const pSku = String(it.parentSku).toUpperCase().trim();
      const found = products.find(p => String(p.parentSku || '').toUpperCase().trim() === pSku);
      if (found && found.id) {
        const pGuid = extractGuid(found.id);
        if (pGuid) parentIdSet.add(pGuid);
      }
    }
  });

  // Nếu có item chưa xác định được parentId, dò trong products.json
  if (itemSkuSet.size > 0) {
    products.forEach(p => {
      const cardSku = String(p.sku || '').toUpperCase().trim();
      const parentSku = String(p.parentSku || '').toUpperCase().trim();
      const hasVariant = (p.variants || []).some(v => itemSkuSet.has(String(v.skuVariant || '').toUpperCase().trim()));

      if (hasVariant || itemSkuSet.has(cardSku) || itemSkuSet.has(parentSku)) {
        const pGuid = extractGuid(p.id);
        if (pGuid) parentIdSet.add(pGuid);
      }
    });
  }

  if (parentIdSet.size === 0) {
    return {
      success: false,
      message: 'Không xác định được InventoryItemID cha để lấy tồn kho MISA.'
    };
  }

  // Kéo tồn kho thực tế từng size/màu của từng mã cha từ endpoint instocks/detail
  // Đảm bảo lấy đúng ngày theo múi giờ Việt Nam (UTC+7)
  const nowVn = new Date(Date.now() + 7 * 3600 * 1000);
  const today = nowVn.toISOString().split('T')[0];
  const stockDetailMap = new Map();

  await Promise.all(Array.from(parentIdSet).map(async (pId) => {
    try {
      const u = `https://cobedenim.mshopkeeper.vn/backendg2/api/instocks/detail?_dc=${Date.now()}&fromDate=${today}T00:00:00&toDate=${today}T23:59:59&branchID=${targetBranchId}&stockID=00000000-0000-0000-0000-000000000000&inventoryItemID=${pId}&showOrderedQuantity=false&UnitID=00000000-0000-0000-0000-000000000000&lotID=&expiryDate=&isShowAllDetail=true`;
      const r = await fetch(u, { headers: reqHeaders, signal: AbortSignal.timeout(15000) });
      if (r.ok) {
        const d = await r.json();
        (d.Data || []).forEach(it => {
          if (it.SKUCode) {
            stockDetailMap.set(String(it.SKUCode).toUpperCase().trim(), Number(it.InstockQuantity) || 0);
          }
        });
      }
    } catch (e) {
      console.warn(`[TARGETED-SYNC] Lỗi lấy tồn kho cho mã cha ${pId}:`, e.message);
    }
  }));

  // Cập nhật các biến thể trong danh sách sản phẩm
  const updatedCards = [];
  const nowIso = new Date().toISOString();

  products.forEach(p => {
    let cardModified = false;
    const pIdFromCard = extractGuid(p.id);
    const isTargetParent = pIdFromCard && parentIdSet.has(pIdFromCard);

    if (Array.isArray(p.variants) && p.variants.length > 0) {
      p.variants.forEach(v => {
        const vSku = String(v.skuVariant || '').toUpperCase().trim();
        if (stockDetailMap.has(vSku)) {
          v.stock = stockDetailMap.get(vSku);
          cardModified = true;
        }
      });
    }

    if (cardModified || isTargetParent) {
      p.totalStock = (p.variants || []).reduce((acc, v) => acc + (Number(v.stock) || 0), 0);
      p.status = p.totalStock <= 0 ? 'out_of_stock' : 'in_stock';
      p.updatedAt = nowIso;
      updatedCards.push(p);
    }
  });

  // Nếu sản phẩm này hoàn toàn mới (chưa có trong products.json), tự động tải chi tiết và thêm mới
  for (const pId of parentIdSet) {
    const exists = products.some(p => extractGuid(p.id) === pId);
    if (!exists && stockDetailMap.size > 0) {
      try {
        console.log(`[TARGETED-SYNC] Phát hiện sản phẩm mới ${pId}, đang tải thông tin chi tiết từ ByParentID...`);
        const byParentUrl = `https://cobedenim.mshopkeeper.vn/backendg2/api/InventoryItem/ByParentID?parentId=${pId}&page=1&start=0&limit=100`;
        const bpRes = await fetch(byParentUrl, { headers: reqHeaders, signal: AbortSignal.timeout(15000) });
        if (bpRes.ok) {
          const bpData = await bpRes.json();
          const children = bpData.Data || [];
          if (children.length > 0) {
            const colorGroups = new Map();
            children.forEach(c => {
              const col = String(c.Color || 'Tiêu chuẩn').trim();
              if (!colorGroups.has(col)) colorGroups.set(col, []);
              colorGroups.get(col).push(c);
            });

            for (const [colName, group] of colorGroups) {
              const first = group[0];
              const baseSku = String(first.SKUCodeParent || first.SKUCode || '').split('-')[0].trim();
              const cat = first.ItemCategoryName || 'Khác';
              const variants = group.map(c => {
                const cSku = String(c.SKUCode || '').toUpperCase().trim();
                return {
                  color: colName,
                  size: String(c.Size || 'Freesize').trim().toUpperCase(),
                  stock: stockDetailMap.get(cSku) ?? 0,
                  skuVariant: c.SKUCode,
                  unitPrice: Number(c.UnitPrice) || 350000
                };
              });

              const totalStock = variants.reduce((acc, v) => acc + (Number(v.stock) || 0), 0);
              const card = {
                id: `cobe-${pId}-${Buffer.from(colName).toString('hex').slice(0, 8)}`,
                sku: group[0].SKUCode ? group[0].SKUCode.replace(/-[A-Z0-9]+$/i, '') : baseSku,
                parentSku: baseSku,
                name: first.InventoryItemName ? first.InventoryItemName.replace(/\s*\([^)]*\)$/, '') : baseSku,
                brand: 'Cobe Denim',
                category: cat,
                fullCategory: cat,
                color: colName,
                retailPrice: Number(first.UnitPrice) || 350000,
                pictureId: first.PictureID || null,
                imageUrl: first.PictureID ? `/api/images/${first.PictureID}.jpg` : '/images/placeholder.svg',
                description: `Sản phẩm ${first.InventoryItemName} chính hãng.`,
                updatedAt: nowIso,
                variants,
                totalStock,
                status: totalStock <= 0 ? 'out_of_stock' : 'in_stock'
              };
              products.unshift(card);
              updatedCards.push(card);
            }
          }
        }
      } catch (err) {
        console.warn(`[TARGETED-SYNC] Lỗi tạo card sản phẩm mới ${pId}:`, err.message);
      }
    }
  }

  if (updatedCards.length > 0) {
    saveProducts(products);
    config.lastSyncTime = nowIso;
    saveConfig(config);

    // Bắn ngầm sang Cloudflare Edge để KV cập nhật ngay
    forwardTargetedSyncToCloudflare(updatedCards).catch(() => {});
  }

  const durationMs = Date.now() - tStart;
  console.log(`[TARGETED-SYNC] ✓ Đã cập nhật tức thì ${updatedCards.length} card sản phẩm (${stockDetailMap.size} biến thể) cho "${action}" trong ${durationMs}ms.`);

  return {
    success: true,
    action,
    parentIds: Array.from(parentIdSet),
    updatedCardsCount: updatedCards.length,
    updatedVariantsCount: stockDetailMap.size,
    durationMs,
    lastSyncTime: config.lastSyncTime
  };
}

// API: Real-Time Targeted Sync (Kích hoạt từ POS Thu ngân / Quản trị MShopKeeper)
app.post('/api/sync/targeted-products', async (req, res) => {
  try {
    const { action, items, refId, token, branchId } = req.body || {};
    const result = await syncTargetedProducts({ action, items, refId, token, branchId });
    if (result.success) {
      return res.json(result);
    }
    return res.status(400).json(result);
  } catch (err) {
    console.error('[TARGETED-SYNC] Lỗi xử lý:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// API: Get Sync Status (Fast endpoint for live frontend auto-refresh)
app.get('/api/sync/status', (req, res) => {
  const config = getConfig();
  const products = getProducts();
  res.json({
    success: true,
    lastSyncTime: config.lastSyncTime || null,
    totalProducts: products.length,
    timestamp: Date.now()
  });
});

// API: Get Real-time Progress (Both MShopKeeper inventory sync & Cloudinary image fill)
app.get('/api/sync/progress', (req, res) => {
  const config = getConfig();
  res.json({
    success: true,
    lastSyncTime: config.lastSyncTime || null,
    sync: getMshopSyncProgress(),
    images: getFillProgress()
  });
});

// API: Trigger Background Image Fill to Cloudinary
app.post('/api/sync/fill-images', adminRateLimiter, async (req, res) => {
  try {
    const result = await startFillMissingImages();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// API: Cancel Background Image Fill
app.post('/api/sync/fill-images/cancel', adminRateLimiter, (req, res) => {
  const result = stopFillMissingImages();
  res.json(result);
});

// API: Trigger MShopKeeper Live Sync
app.post('/api/sync/mshopkeeper', adminRateLimiter, async (req, res) => {
  const { token, endpoint, branchId, userId, userName, layoutCode, reportId, demoMode = false } = req.body;
  const config = getConfig();

  if (demoMode) {
    const products = getProducts();
    const updated = products.map(p => ({
      ...p,
      updatedAt: new Date().toISOString()
    }));
    saveProducts(updated);

    config.lastSyncTime = new Date().toISOString();
    config.syncStatus = 'SUCCESS';
    saveConfig(config);

    return res.json({
      success: true,
      message: 'Đồng bộ demo thành công! Dữ liệu đã được làm mới.',
      totalUpdated: updated.length,
      lastSyncTime: config.lastSyncTime
    });
  }

  const result = await performSyncFromMShopKeeper(token, branchId, userId, userName, layoutCode, reportId);
  if (result.success) {
    return res.json(result);
  }
  return res.status(result.expired ? 401 : 400).json(result);
});

// API: Verify Admin PIN (Bảo vệ chống bruteforce dò mã PIN)
app.post('/api/sync/verify-pin', adminRateLimiter, (req, res) => {
  const { pin } = req.body;
  const config = getConfig();
  const validPin = config.adminPin || '1234';

  if (String(pin).trim() === String(validPin).trim()) {
    return res.json({ success: true, message: 'Xác thực Admin thành công!' });
  }
  return res.status(401).json({ success: false, message: 'Mã PIN Admin không đúng.' });
});

// API: Direct Import JSON / Excel normalized data
app.post('/api/sync/import', adminRateLimiter, (req, res) => {
  const { products } = req.body;
  if (!Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ success: false, message: 'Danh sách sản phẩm không hợp lệ' });
  }

  saveProducts(products);
  const config = getConfig();
  config.lastSyncTime = new Date().toISOString();
  config.totalProducts = products.length;
  saveConfig(config);

  res.json({
    success: true,
    message: `Đã nhập thành công ${products.length} sản phẩm vào hệ thống!`,
    total: products.length
  });
});

// Background Auto-Sync Scheduler (runs every 2 hours)
function startAutoSyncScheduler() {
  const config = getConfig();
  const intervalMinutes = Number(config.syncIntervalMinutes) || 120; // 120 mins = 2 hours
  const intervalMs = intervalMinutes * 60 * 1000;

  console.log(`[AUTO-SYNC] Khởi chạy bộ hẹn giờ đồng bộ tự động: mỗi ${intervalMinutes} phút (${(intervalMinutes / 60).toFixed(1)} tiếng) 1 lần.`);

  async function runAutoSync() {
    const currentConfig = getConfig();
    if (currentConfig.autoSyncEnabled === false) {
      console.log('[AUTO-SYNC] Tính năng tự động đồng bộ đang tạm tắt trong cấu hình.');
      return;
    }

    const timeStr = new Date().toLocaleTimeString('vi-VN');
    console.log(`[AUTO-SYNC] [${timeStr}] Đang quét token từ Chrome/Edge LevelDB...`);
    const tokenInfo = findLevelDbToken();

    if (!tokenInfo || !tokenInfo.token) {
      console.log('[AUTO-SYNC] Chưa tìm thấy token trong trình duyệt. Kho giữ nguyên dữ liệu lần đồng bộ trước.');
      return;
    }

    if (tokenInfo.expired) {
      console.log('[AUTO-SYNC] Token trong Chrome đã hết hạn. Hãy mở lại tab cobedenim.mshopkeeper.vn để Chrome cập nhật token mới.');
      return;
    }

    // KIỂM TRA PHIÊN ĐĂNG NHẬP THỰC TẾ VỚI MISA
    console.log(`[AUTO-SYNC] [${timeStr}] Đang kiểm tra hiệu lực phiên đăng nhập (${tokenInfo.browser})...`);
    const sessionCheck = await verifyMshopkeeperSession(tokenInfo.token, currentConfig.branchId);

    if (!sessionCheck.valid) {
      console.log(`[AUTO-SYNC] ⚠ Phiên đăng nhập (${tokenInfo.browser}) không còn hợp lệ: ${sessionCheck.message}`);
      console.log('[AUTO-SYNC] Giữ nguyên dữ liệu kho hiện tại, chờ thu ngân đăng nhập lại trên trình duyệt.');
      return;
    }

    console.log(`[AUTO-SYNC] ✓ Phiên đăng nhập (${tokenInfo.browser}) HỢP LỆ! Bắt đầu đồng bộ kho...`);
    try {
      console.log(`[AUTO-SYNC] [${timeStr}] Bắt đầu tự động cập nhật kho từ MShopKeeper (${tokenInfo.browser})...`);
      const result = await performSyncFromMShopKeeper(tokenInfo.token, currentConfig.branchId, tokenInfo.userId, tokenInfo.userName);
      if (result.success) {
        console.log(`[AUTO-SYNC] ✓ THÀNH CÔNG! Đã cập nhật ${result.totalUpdated} sản phẩm lúc ${new Date().toLocaleTimeString('vi-VN')}.`);
      } else {
        console.log(`[AUTO-SYNC] ⚠ Kết quả: ${result.message}`);
      }
    } catch (err) {
      console.error('[AUTO-SYNC] Lỗi khi chạy đồng bộ tự động:', err.message);
    }
  }

  // Khởi động chạy lần đầu sau 15 giây (bỏ qua nếu vừa đồng bộ trong vòng 30 phút để bảo vệ MISA)
  setTimeout(() => {
    const cfg = getConfig();
    const lastSyncMs = cfg.lastSyncTime ? new Date(cfg.lastSyncTime).getTime() : 0;
    const diffMins = (Date.now() - lastSyncMs) / (60 * 1000);
    if (diffMins < 30) {
      console.log(`[AUTO-SYNC] Lần đồng bộ gần nhất cách đây ${Math.round(diffMins)} phút. Bỏ qua chạy ngay khi khởi động để tránh quá tải MISA.`);
      return;
    }
    runAutoSync();
  }, 15000);

  // Lặp lại mỗi 2 tiếng
  setInterval(runAutoSync, intervalMs);
}

// Route alias for Swagger Docs & Developer Portal
app.get(['/swagger', '/docs', '/api-docs'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'swagger.html'));
});

app.get('/developer', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'developer.html'));
});

// Fallback to index.html for SPA routing
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[COBE DENIM INVENTORY] Server is running at http://localhost:${PORT}`);
  // Start background auto sync timer
  startAutoSyncScheduler();
});

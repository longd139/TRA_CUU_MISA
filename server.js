const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const XLSX = require('xlsx');

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
    const invUrl = `https://cobedenim.mshopkeeper.vn/backendg2/api/InventoryItem?_dc=${Date.now()}&inventoryItemCategoryID=00000000-0000-0000-0000-000000000000&branchID=${targetBranchId}&isOutStock=0&page=1&start=0&limit=1000`;
    
    let masterItems = [];
    try {
      const invRes = await fetch(invUrl, { method: 'GET', headers: reqHeaders });
      if (invRes.status === 401) {
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

    // Build master lookup maps by SKU and Name
    const masterBySku = new Map();
    const masterByName = new Map();
    for (const m of masterItems) {
      if (m.SKUCode) masterBySku.set(m.SKUCode.toUpperCase().trim(), m);
      if (m.InventoryItemName) masterByName.set(m.InventoryItemName.toLowerCase().trim(), m);
    }

    // 2. Fetch current instocks for today's real-time inventory
    const today = new Date().toISOString().split('T')[0];
    const stockUrl = `https://cobedenim.mshopkeeper.vn/backendg2/api/instocks?_dc=${Date.now()}&fromDate=${today}T00:00:00&toDate=${today}T23:59:59&branchID=${targetBranchId}&stockID=00000000-0000-0000-0000-000000000000&inventoryItemCategoryID=00000000-0000-0000-0000-000000000000&inventoryItem=&showOrderedQuantity=false&UnitID=00000000-0000-0000-0000-000000000000&instockType=0&instockStatusID=0&trancationStatusID=0&quantityStatusID=0&BrandID=00000000-0000-0000-0000-000000000000&page=1&start=0&limit=1000`;

    console.log(`[SYNC] Gửi yêu cầu lấy số lượng tồn kho MShopKeeper (${targetBranchId})...`);
    const stockResponse = await fetch(stockUrl, {
      method: 'GET',
      headers: reqHeaders
    });

    if (stockResponse.status === 401) {
      return {
        success: false,
        expired: true,
        message: 'Token đã hết hạn hoặc không có quyền truy cập MShopKeeper. Hãy mở tab cobedenim.mshopkeeper.vn trên Chrome để làm mới.'
      };
    }

    if (!stockResponse.ok) {
      return {
        success: false,
        message: `MShopKeeper trả về lỗi HTTP ${stockResponse.status}: ${stockResponse.statusText}`
      };
    }

    const data = await stockResponse.json();
    const rawItems = data.Data || [];

    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return {
        success: false,
        message: 'Không tìm thấy dữ liệu hàng hóa nào trong kho MShopKeeper.'
      };
    }

    // 3. Fetch full child variants via ByParentID to get distinct colors, photos, and prices
    console.log(`[SYNC] Lấy chi tiết phân loại màu, ảnh và giá từng màu (ByParentID)...`);
    const childrenCache = new Map();
    const BATCH_SIZE = 25;
    for (let i = 0; i < masterItems.length; i += BATCH_SIZE) {
      const batch = masterItems.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (m) => {
        try {
          const u = `https://cobedenim.mshopkeeper.vn/backendg2/api/InventoryItem/ByParentID?parentId=${m.InventoryItemID}&page=1&start=0&limit=100`;
          const r = await fetch(u, { headers: reqHeaders });
          const d = await r.json();
          if (d.Data && d.Data.length > 0) {
            childrenCache.set(m.InventoryItemID, d.Data);
          }
        } catch (e) {}
      }));
    }
    console.log(`[SYNC] -> Đã lấy chi tiết biến thể của ${childrenCache.size} sản phẩm.`);

    // 4. Fetch exact real-time variant stocks from instocks/detail API
    console.log(`[SYNC] Lấy số lượng tồn kho chính xác từng size/màu (instocks/detail)...`);
    const stockDetailMap = new Map();
    for (let i = 0; i < masterItems.length; i += BATCH_SIZE) {
      const batch = masterItems.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (m) => {
        try {
          const u = `https://cobedenim.mshopkeeper.vn/backendg2/api/instocks/detail?_dc=${Date.now()}&fromDate=${today}T00:00:00&toDate=${today}T23:59:59&branchID=&stockID=7fba5f82-0e11-4694-8056-23eb6cf34dce&inventoryItemID=${m.InventoryItemID}&showOrderedQuantity=false&UnitID=${m.UnitID || '746ec67b-d56b-4df7-8187-2fb7fcf31216'}&lotID=&expiryDate=&isShowAllDetail=true`;
          const r = await fetch(u, { headers: reqHeaders });
          const d = await r.json();
          (d.Data || []).forEach(it => {
            if (it.SKUCode) {
              stockDetailMap.set(it.SKUCode.toUpperCase().trim(), Number(it.InstockQuantity) || 0);
            }
          });
        } catch (e) {}
      }));
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
            ? `https://cobedenim.mshopkeeper.vn/backendg2/api/Image?id=${picId}${cleanExt}&type=1&mode=pad&CompanyCode=cobedenim`
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
          ? `https://cobedenim.mshopkeeper.vn/backendg2/api/Image?id=${picId}${cleanExt}&type=1&mode=pad&CompanyCode=cobedenim`
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

    return {
      success: true,
      message: `Đồng bộ trực tiếp thành công ${expandedProducts.length} mẫu theo từng màu và giá từ MShopKeeper với ${picCount} ảnh thật!`,
      totalUpdated: expandedProducts.length,
      realPictures: picCount,
      lastSyncTime: config.lastSyncTime
    };

  } catch (err) {
    console.error('Sync error:', err);
    return {
      success: false,
      message: `Lỗi kết nối MShopKeeper: ${err.message}`
    };
  }
}

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

  // Khởi động chạy lần đầu sau 10 giây
  setTimeout(() => {
    runAutoSync();
  }, 10000);

  // Lặp lại mỗi 2 tiếng
  setInterval(runAutoSync, intervalMs);
}

// Fallback to index.html for SPA routing
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[COBE DENIM INVENTORY] Server is running at http://localhost:${PORT}`);
  // Start background auto sync timer
  startAutoSyncScheduler();
});

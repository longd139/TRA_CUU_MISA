// Shared Utilities for Cloudflare Pages Functions (V8 Edge Runtime)
// 100% Web Standards: fetch, crypto.subtle, Request, Response

// In-memory rate limiting and nonce tracking in Edge worker isolate
const ipRateLimits = new Map();
const seenNonces = new Map();

// Helper: Rate limiting for Edge
export function checkRateLimit(ip, maxRequests = 180, windowMs = 60000) {
  const now = Date.now();
  let record = ipRateLimits.get(ip);

  if (!record || now > record.resetTime) {
    record = { count: 1, resetTime: now + windowMs };
    ipRateLimits.set(ip, record);
    return { allowed: true, remaining: maxRequests - 1 };
  }

  record.count++;
  if (record.count > maxRequests) {
    return { allowed: false, remaining: 0, resetTime: record.resetTime };
  }

  return { allowed: true, remaining: maxRequests - record.count };
}

// Helper: Anti-bot detection
export function isBotOrScraper(request) {
  const ua = (request.headers.get('user-agent') || '').toLowerCase();
  const knownScrapers = ['python-requests', 'aiohttp', 'scrapy', 'curl/', 'wget/', 'httpie', 'postmanruntime'];
  return knownScrapers.some(bot => ua.includes(bot));
}

// Helper: Fetch products from ASSETS CDN
let cachedProducts = null;
let lastProductsFetch = 0;

export async function getProductsData(context) {
  const now = Date.now();
  // In-isolate cache for 15 seconds to minimize sub-requests
  if (cachedProducts && (now - lastProductsFetch < 15000)) {
    return cachedProducts;
  }

  try {
    const assetUrl = new URL('/data/products.json', context.request.url);
    const res = await context.env.ASSETS.fetch(assetUrl);
    if (res.ok) {
      cachedProducts = await res.json();
      lastProductsFetch = now;
      return cachedProducts;
    }
  } catch (err) {
    console.error('Lỗi tải products từ ASSETS:', err);
  }

  return cachedProducts || [];
}

// Helper: Fetch categories from ASSETS CDN
let cachedCategories = null;
export async function getCategoriesData(context) {
  if (cachedCategories) return cachedCategories;

  try {
    const assetUrl = new URL('/data/categories_tree.json', context.request.url);
    const res = await context.env.ASSETS.fetch(assetUrl);
    if (res.ok) {
      cachedCategories = await res.json();
      return cachedCategories;
    }
  } catch (e) {}

  return [];
}

// Helper: Filter & Sort products matching Node.js server logic
export function filterAndSortProducts(products, { q, brand, category, status, size, sort }) {
  let result = [...products];

  // 1. Search filter
  if (q && q.trim()) {
    const searchTerms = q.toLowerCase().trim().split(/\s+/);
    result = result.filter(p => {
      const searchTarget = [
        p.sku,
        p.parentSku,
        p.name,
        p.color,
        p.brand,
        p.category,
        p.description,
        ...(p.variants || []).map(v => `${v.skuVariant} ${v.size} ${v.color}`)
      ].join(' ').toLowerCase();

      return searchTerms.every(term => searchTarget.includes(term));
    });
  }

  // 2. Brand filter
  if (brand && brand !== 'all') {
    result = result.filter(p => (p.brand || '').toLowerCase() === brand.toLowerCase());
  }

  // 3. Category filter
  if (category && category !== 'all') {
    result = result.filter(p => (p.category || '').toLowerCase() === category.toLowerCase());
  }

  // 4. Status filter
  if (status && status !== 'all') {
    result = result.filter(p => p.status === status);
  }

  // 5. Size filter
  if (size && size !== 'all') {
    const targetSize = String(size).toUpperCase().trim();
    result = result.filter(p => {
      return (p.variants || []).some(v => 
        String(v.size || '').toUpperCase().trim() === targetSize && Number(v.stock) > 0
      );
    });
  }

  // 6. Sort
  switch (sort) {
    case 'price-asc':
      result.sort((a, b) => (Number(a.retailPrice) || 0) - (Number(b.retailPrice) || 0));
      break;
    case 'price-desc':
      result.sort((a, b) => (Number(b.retailPrice) || 0) - (Number(a.retailPrice) || 0));
      break;
    case 'stock-desc':
      result.sort((a, b) => (Number(b.totalStock) || 0) - (Number(a.totalStock) || 0));
      break;
    case 'name-asc':
      result.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      break;
    default:
      result.sort((a, b) => {
        if (a.status === 'in_stock' && b.status !== 'in_stock') return -1;
        if (a.status !== 'in_stock' && b.status === 'in_stock') return 1;
        return (Number(b.totalStock) || 0) - (Number(a.totalStock) || 0);
      });
  }

  return result;
}

// Web Crypto HMAC-SHA256 Implementation
async function hmacSha256Hex(secretKey, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secretKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  const hashArray = Array.from(new Uint8Array(signature));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Timing-safe string comparison
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// Commercial API Keys Store (From env.API_KEYS or default)
export function getCommercialApiKeys(env) {
  if (env && env.API_KEYS) {
    try {
      return JSON.parse(env.API_KEYS);
    } catch (e) {}
  }
  // Default mock clients for testing if no env variable is set
  return [
    {
      apiKey: "cobe_test_key_live_999",
      secretKey: "cobe_sec_test_secret_abc123",
      clientName: "Đối Tác Kiểm Thử Mặc Định",
      role: "partner",
      status: "active"
    }
  ];
}

// Verify Commercial HMAC for V8 Edge
export async function verifyCommercialHmac(request, env) {
  const apiKey = request.headers.get('x-api-key');
  const timestamp = request.headers.get('x-timestamp');
  const nonce = request.headers.get('x-nonce');
  const clientSignature = request.headers.get('x-signature');

  if (!apiKey || !timestamp || !nonce || !clientSignature) {
    return {
      valid: false,
      status: 401,
      code: 'AUTH_HEADERS_MISSING',
      message: 'Thiếu thông tin xác thực. Yêu cầu đủ 4 headers: x-api-key, x-timestamp, x-nonce, x-signature.'
    };
  }

  const keys = getCommercialApiKeys(env);
  const client = keys.find(k => k.apiKey === apiKey);
  if (!client || client.status !== 'active') {
    return {
      valid: false,
      status: 401,
      code: 'INVALID_API_KEY',
      message: 'API Key không hợp lệ hoặc đã bị vô hiệu hóa.'
    };
  }

  // Check timestamp window (60s)
  const reqTime = parseInt(timestamp, 10);
  const now = Date.now();
  if (isNaN(reqTime) || Math.abs(now - reqTime) > 60000) {
    return {
      valid: false,
      status: 401,
      code: 'REQUEST_EXPIRED',
      message: 'Timestamp không hợp lệ hoặc đã lệch quá 60 giây so với giờ chuẩn.'
    };
  }

  // Check Nonce (120s TTL)
  const nonceKey = `${apiKey}:${nonce}`;
  if (seenNonces.has(nonceKey)) {
    return {
      valid: false,
      status: 401,
      code: 'REPLAY_ATTACK_DETECTED',
      message: 'Nonce này đã được sử dụng. Phát hiện dấu hiệu Replay Attack.'
    };
  }
  seenNonces.set(nonceKey, now);

  // Clean old nonces
  if (seenNonces.size > 2000) {
    for (const [k, t] of seenNonces.entries()) {
      if (now - t > 120000) seenNonces.delete(k);
    }
  }

  // Canonical string: METHOD + "\n" + PATH + "\n" + TIMESTAMP + "\n" + NONCE
  const url = new URL(request.url);
  const rawPath = url.pathname.toLowerCase().replace(/\/+$/, '');
  const method = request.method.toUpperCase();
  const canonicalString = `${method}\n${rawPath}\n${timestamp}\n${nonce}`;

  const expectedSignature = await hmacSha256Hex(client.secretKey, canonicalString);

  if (!timingSafeEqual(expectedSignature.toLowerCase(), clientSignature.toLowerCase())) {
    return {
      valid: false,
      status: 401,
      code: 'INVALID_SIGNATURE',
      message: 'Chữ ký số HMAC-SHA256 không hợp lệ.'
    };
  }

  return { valid: true, client };
}

// Helper: Standard JSON Response with security headers
export function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'X-XSS-Protection': '1; mode=block',
      ...headers
    }
  });
}

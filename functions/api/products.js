import { 
  getProductsData, 
  filterAndSortProducts, 
  checkRateLimit, 
  isBotOrScraper, 
  jsonResponse 
} from '../_utils.js';

export async function onRequestGet(context) {
  const { request } = context;
  const ip = request.headers.get('cf-connecting-ip') || '127.0.0.1';

  // 1. Anti-bot detection
  if (isBotOrScraper(request) && !request.headers.get('x-api-key')) {
    return jsonResponse({
      success: false,
      code: 'SCRAPER_DETECTED',
      message: 'Hệ thống phát hiện truy vấn tự động không hợp lệ. Vui lòng sử dụng cổng Commercial API chính thức (/api/v1/products).'
    }, 403);
  }

  // 2. Rate limiting (180 requests/phút/IP)
  const rate = checkRateLimit(ip, 180, 60000);
  if (!rate.allowed) {
    return jsonResponse({
      success: false,
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Tần suất thao tác quá nhanh từ IP của bạn. Vui lòng thử lại sau 1 phút.'
    }, 429);
  }

  // 3. Parse query parameters
  const url = new URL(request.url);
  const q = url.searchParams.get('q') || '';
  const brand = url.searchParams.get('brand') || 'all';
  const category = url.searchParams.get('category') || 'all';
  const status = url.searchParams.get('status') || 'all';
  const size = url.searchParams.get('size') || 'all';
  const sort = url.searchParams.get('sort') || 'default';
  const pageParam = url.searchParams.get('page') || '1';
  const limitParam = url.searchParams.get('limit') || '20';

  // 4. Load all products
  const allProducts = await getProductsData(context);
  const filtered = filterAndSortProducts(allProducts, { q, brand, category, status, size, sort });

  // 5. Pagination (Trần an toàn tối đa 100 sản phẩm/trang)
  const total = filtered.length;
  let pagedProducts = filtered;
  let page = 1;
  let totalPages = 1;
  let limit = 20;

  if (limitParam === 'all') {
    // Tối đa 100 sản phẩm cho limit=all để chống sập Edge
    limit = Math.min(total, 100);
    pagedProducts = filtered.slice(0, limit);
    page = 1;
    totalPages = 1;
  } else {
    limit = Math.min(100, Math.max(1, parseInt(limitParam, 10) || 20));
    page = Math.max(1, parseInt(pageParam, 10) || 1);
    totalPages = Math.ceil(total / limit) || 1;
    const startIndex = (page - 1) * limit;
    pagedProducts = filtered.slice(startIndex, startIndex + limit);
  }

  // 6. Aggregate brands & categories
  const brandMap = new Map();
  const categoryMap = new Map();

  allProducts.forEach(p => {
    if (p.brand) {
      brandMap.set(p.brand, (brandMap.get(p.brand) || 0) + 1);
    }
    if (p.category) {
      categoryMap.set(p.category, (categoryMap.get(p.category) || 0) + 1);
    }
  });

  const brands = Array.from(brandMap.entries()).map(([name, count]) => ({ name, count }));
  const categories = Array.from(categoryMap.entries()).map(([name, count]) => ({ name, count }));

  return jsonResponse({
    success: true,
    total,
    page,
    totalPages,
    limit,
    count: pagedProducts.length,
    brands,
    categories,
    products: pagedProducts
  });
}

import { 
  verifyCommercialHmac, 
  checkRateLimit, 
  getProductsData, 
  filterAndSortProducts, 
  jsonResponse 
} from '../../_utils.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const ip = request.headers.get('cf-connecting-ip') || '127.0.0.1';

  // 1. Rate Limiter: Commercial (60 req/min/IP)
  const rate = checkRateLimit(`commercial:${ip}`, 60, 60000);
  if (!rate.allowed) {
    return jsonResponse({
      success: false,
      code: 'COMMERCIAL_RATE_LIMIT_EXCEEDED',
      message: 'Vượt quá giới hạn tần suất truy vấn thương mại (60 requests/phút). Vui lòng thử lại sau.'
    }, 429);
  }

  // 2. HMAC Verification
  const auth = await verifyCommercialHmac(request, env);
  if (!auth.valid) {
    return jsonResponse({
      success: false,
      code: auth.code,
      message: auth.message
    }, auth.status);
  }

  // 3. Parse query
  const url = new URL(request.url);
  const q = url.searchParams.get('q') || '';
  const brand = url.searchParams.get('brand') || 'all';
  const category = url.searchParams.get('category') || 'all';
  const status = url.searchParams.get('status') || 'all';
  const size = url.searchParams.get('size') || 'all';
  const sort = url.searchParams.get('sort') || 'default';
  const pageParam = url.searchParams.get('page') || '1';
  const limitParam = url.searchParams.get('limit') || '20';

  const allProducts = await getProductsData(context);
  const filtered = filterAndSortProducts(allProducts, { q, brand, category, status, size, sort });

  // Giới hạn an toàn tuyệt đối: tối đa 50 sản phẩm mỗi lượt gọi (không cho phép limit=all)
  const safeLimit = Math.min(50, Math.max(1, parseInt(limitParam, 10) || 20));
  const parsedPage = Math.max(1, parseInt(pageParam, 10) || 1);
  const total = filtered.length;
  const totalPages = Math.ceil(total / safeLimit) || 1;
  const startIndex = (parsedPage - 1) * safeLimit;
  const pagedProducts = filtered.slice(startIndex, startIndex + safeLimit);

  return jsonResponse({
    success: true,
    meta: {
      authClient: auth.client.clientName,
      total,
      page: parsedPage,
      limit: safeLimit,
      totalPages,
      count: pagedProducts.length,
      serverTime: new Date().toISOString()
    },
    data: pagedProducts
  });
}

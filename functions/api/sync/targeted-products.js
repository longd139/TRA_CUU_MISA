import { jsonResponse, getProductsData, setCachedProducts, deduplicateProducts } from '../../_utils.js';

export async function onRequestPost(context) {
  try {
    const body = await context.request.json().catch(() => ({}));
    const updatedProducts = body.updatedProducts;

    if (!Array.isArray(updatedProducts) || updatedProducts.length === 0) {
      return jsonResponse({
        success: false,
        message: 'Danh sách sản phẩm cập nhật trống hoặc không hợp lệ.'
      }, 400);
    }

    // Nếu đẩy danh sách lớn (toàn bộ danh mục > 500 sản phẩm), làm sạch và ghi đè hoàn toàn
    if (updatedProducts.length >= 500) {
      const cleanList = deduplicateProducts(updatedProducts);
      const kv = context.env && (context.env.INVENTORY_KV || context.env.PRODUCTS_KV);
      if (kv) {
        await kv.put('products', JSON.stringify(cleanList));
        await kv.put('last_sync_time', new Date().toISOString());
      }
      setCachedProducts(cleanList);

      return jsonResponse({
        success: true,
        message: `Đã nạp sạch ${cleanList.length} sản phẩm (không trùng lặp) vào Cloudflare Edge KV!`,
        totalProducts: cleanList.length,
        updatedAt: new Date().toISOString()
      });
    }

    // Với cập nhật từng phần (targeted-products): Dùng Map theo SKU để chống trùng lặp tuyệt đối
    const currentProducts = await getProductsData(context);
    const productMap = new Map();

    // 1. Nạp sản phẩm hiện tại vào Map theo SKU
    currentProducts.forEach(p => {
      const skuKey = String(p.sku || p.id || '').toUpperCase().trim();
      if (skuKey) productMap.set(skuKey, p);
    });

    // 2. Ghi đè hoặc thêm mới các sản phẩm được cập nhật
    updatedProducts.forEach(p => {
      const skuKey = String(p.sku || p.id || '').toUpperCase().trim();
      if (skuKey) productMap.set(skuKey, p);
    });

    const merged = Array.from(productMap.values());

    // 3. Ghi đè trực tiếp vào Cloudflare KV
    const kv = context.env && (context.env.INVENTORY_KV || context.env.PRODUCTS_KV);
    if (kv) {
      await kv.put('products', JSON.stringify(merged));
      await kv.put('last_sync_time', new Date().toISOString());
    }

    // 4. Cập nhật cache RAM trong Worker Isolate
    setCachedProducts(merged);

    return jsonResponse({
      success: true,
      message: `Đã cập nhật tức thì ${updatedProducts.length} sản phẩm trên Cloudflare Edge KV!`,
      updatedCount: updatedProducts.length,
      totalProducts: merged.length,
      updatedAt: new Date().toISOString()
    });

  } catch (err) {
    return jsonResponse({
      success: false,
      message: `Lỗi cập nhật Edge KV: ${err.message}`
    }, 500);
  }
}

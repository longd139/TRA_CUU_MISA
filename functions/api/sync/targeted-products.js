import { jsonResponse, getProductsData, setCachedProducts } from '../../_utils.js';

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

    // 1. Lấy dữ liệu sản phẩm hiện tại trên Cloudflare Edge (từ KV hoặc ASSETS)
    const currentProducts = await getProductsData(context);

    // 2. Tạo map cập nhật theo ID và SKU
    const updateMapById = new Map();
    const updateMapBySku = new Map();
    updatedProducts.forEach(p => {
      if (p.id) updateMapById.set(p.id, p);
      if (p.sku) updateMapBySku.set(String(p.sku).toUpperCase().trim(), p);
    });

    const merged = currentProducts.map(p => {
      if (p.id && updateMapById.has(p.id)) {
        return updateMapById.get(p.id);
      }
      const cardSku = String(p.sku || '').toUpperCase().trim();
      if (cardSku && updateMapBySku.has(cardSku)) {
        return updateMapBySku.get(cardSku);
      }
      return p;
    });

    // Thêm các sản phẩm hoàn toàn mới nếu chưa tồn tại
    const currentIdSet = new Set(currentProducts.map(p => p.id));
    const currentSkuSet = new Set(currentProducts.map(p => String(p.sku || '').toUpperCase().trim()));

    updatedProducts.forEach(p => {
      const cardSku = String(p.sku || '').toUpperCase().trim();
      if (!currentIdSet.has(p.id) && !currentSkuSet.has(cardSku)) {
        merged.push(p);
      }
    });

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

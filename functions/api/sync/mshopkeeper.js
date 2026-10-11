import { jsonResponse, getProductsData, setCachedProducts } from '../../_utils.js';

export async function onRequestPost(context) {
  try {
    const body = await context.request.json().catch(() => ({}));
    let token = String(body.token || '').trim();

    if (!token) {
      return jsonResponse({
        success: false,
        message: 'Vui lòng cung cấp Access Token của MShopKeeper.'
      }, 400);
    }

    // Clean "Bearer " prefix if user pasted the entire Authorization header
    token = token.replace(/^Bearer\s+/i, '').trim();

    const branchId = body.branchId || '68d5c6a7-2ad8-44c8-b36c-58e095dd6ceb';
    const reqHeaders = {
      'accept': 'application/json',
      'authorization': `Bearer ${token}`,
      'companycode': 'cobedenim',
      'x-misa-branchid': branchId,
      'x-misa-language': 'vi-VN'
    };

    const today = new Date().toISOString().split('T')[0];
    const stockUrl = `https://cobedenim.mshopkeeper.vn/backendg2/api/instocks?_dc=${Date.now()}&fromDate=${today}T00:00:00&toDate=${today}T23:59:59&branchID=${branchId}&stockID=00000000-0000-0000-0000-000000000000&inventoryItemCategoryID=00000000-0000-0000-0000-000000000000&inventoryItem=&showOrderedQuantity=false&UnitID=00000000-0000-0000-0000-000000000000&instockType=0&instockStatusID=0&trancationStatusID=0&quantityStatusID=0&BrandID=00000000-0000-0000-0000-000000000000&page=1&start=0&limit=1000`;

    // 1. Fetch real-time instocks
    const stockRes = await fetch(stockUrl, { method: 'GET', headers: reqHeaders });

    if (stockRes.status === 401) {
      return jsonResponse({
        success: false,
        expired: true,
        message: 'Token MShopKeeper đã hết hạn hoặc không có quyền truy cập. Vui lòng mở lại tab cobedenim.mshopkeeper.vn để lấy token mới.'
      }, 401);
    }

    if (!stockRes.ok) {
      return jsonResponse({
        success: false,
        message: `MShopKeeper trả về lỗi HTTP ${stockRes.status}: ${stockRes.statusText}`
      }, 500);
    }

    const stockJson = await stockRes.json();
    const rawStockItems = stockJson.Data || [];

    // Build Stock Map: SKU -> Quantity
    const stockMap = new Map();
    rawStockItems.forEach(item => {
      if (item.SKUCode) {
        stockMap.set(item.SKUCode.toUpperCase().trim(), Number(item.InstockQuantity) || 0);
      }
    });

    // 2. Fetch catalog details (UnitPrice, PictureID)
    const invUrl = `https://cobedenim.mshopkeeper.vn/backendg2/api/InventoryItem?_dc=${Date.now()}&inventoryItemCategoryID=00000000-0000-0000-0000-000000000000&branchID=${branchId}&isOutStock=0&page=1&start=0&limit=1000`;
    let masterPriceMap = new Map();
    try {
      const invRes = await fetch(invUrl, { method: 'GET', headers: reqHeaders });
      if (invRes.ok) {
        const invJson = await invRes.json();
        (invJson.Data || []).forEach(m => {
          if (m.SKUCode && Number(m.UnitPrice) > 0) {
            masterPriceMap.set(m.SKUCode.toUpperCase().trim(), Number(m.UnitPrice));
          }
        });
      }
    } catch (e) {
      console.warn('Lỗi tải InventoryItem catalog:', e);
    }

    // 3. Load current product list
    const currentProducts = await getProductsData(context);
    const updatedProducts = JSON.parse(JSON.stringify(currentProducts)); // Deep copy

    let totalStockQty = 0;
    let inStockProductsCount = 0;
    const nowIso = new Date().toISOString();

    // 4. Update each product and its size/color variants
    updatedProducts.forEach(product => {
      const parentSku = String(product.parentSku || product.sku || '').toUpperCase().trim();
      const parentStock = stockMap.has(parentSku) ? stockMap.get(parentSku) : null;
      const cardSku = String(product.sku || '').toUpperCase().trim();
      const cardStock = stockMap.has(cardSku) ? stockMap.get(cardSku) : null;

      // Update variants
      if (Array.isArray(product.variants) && product.variants.length > 0) {
        product.variants.forEach(v => {
          const vSku = String(v.skuVariant || '').toUpperCase().trim();
          if (stockMap.has(vSku)) {
            v.stock = stockMap.get(vSku);
          } else if (parentStock !== null && product.variants.length === 1) {
            v.stock = parentStock;
          }

          if (masterPriceMap.has(vSku)) {
            v.unitPrice = masterPriceMap.get(vSku);
          } else if (masterPriceMap.has(parentSku)) {
            v.unitPrice = masterPriceMap.get(parentSku);
          }
        });

        // Total stock of card is sum of variant stocks
        const sumStock = product.variants.reduce((acc, v) => acc + (Number(v.stock) || 0), 0);
        product.totalStock = sumStock > 0 ? sumStock : (cardStock !== null ? cardStock : (parentStock !== null ? parentStock : 0));
      } else {
        product.totalStock = cardStock !== null ? cardStock : (parentStock !== null ? parentStock : 0);
      }

      // Update unit price on card if available
      if (masterPriceMap.has(cardSku)) {
        product.retailPrice = masterPriceMap.get(cardSku);
      } else if (masterPriceMap.has(parentSku)) {
        product.retailPrice = masterPriceMap.get(parentSku);
      }

      product.status = product.totalStock > 0 ? 'in_stock' : 'out_of_stock';
      product.updatedAt = nowIso;

      totalStockQty += product.totalStock;
      if (product.totalStock > 0) {
        inStockProductsCount++;
      }
    });

    // 5. Store into Cloudflare KV if bound
    if (context.env && context.env.INVENTORY_KV) {
      try {
        await context.env.INVENTORY_KV.put('products', JSON.stringify(updatedProducts));
        await context.env.INVENTORY_KV.put('lastSyncTime', nowIso);
        await context.env.INVENTORY_KV.put('totalProducts', String(updatedProducts.length));
        await context.env.INVENTORY_KV.put('totalStock', String(totalStockQty));
      } catch (kvErr) {
        console.warn('Lỗi ghi Cloudflare KV:', kvErr);
      }
    }

    // Update in-memory isolate cache
    setCachedProducts(updatedProducts);

    return jsonResponse({
      success: true,
      message: `Đồng bộ thành công ${updatedProducts.length} mẫu hàng (${totalStockQty.toLocaleString('vi-VN')} chiếc) trực tiếp từ MShopKeeper!`,
      totalProducts: updatedProducts.length,
      totalStockQuantity: totalStockQty,
      inStockProducts: inStockProductsCount,
      lastSyncTime: nowIso
    });

  } catch (err) {
    return jsonResponse({
      success: false,
      message: `Lỗi đồng bộ MShopKeeper: ${err.message}`
    }, 500);
  }
}

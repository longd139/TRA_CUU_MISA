import { getProductsData, jsonResponse } from '../_utils.js';

export async function onRequestGet(context) {
  const products = await getProductsData(context);
  const totalProducts = products.length;

  let totalStockQuantity = 0;
  let inStockProducts = 0;

  products.forEach(p => {
    const stock = Number(p.totalStock) || 0;
    totalStockQuantity += stock;
    if (stock > 0 || p.status === 'in_stock') {
      inStockProducts++;
    }
  });

  let lastSyncTime = products[0]?.updatedAt || new Date().toISOString();
  if (context && context.env && context.env.INVENTORY_KV) {
    try {
      const kvTime = await context.env.INVENTORY_KV.get('lastSyncTime');
      if (kvTime) lastSyncTime = kvTime;
    } catch (e) {}
  }

  return jsonResponse({
    success: true,
    totalProducts,
    totalStockQuantity,
    inStockProducts,
    lastSyncTime
  });
}

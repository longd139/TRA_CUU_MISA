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

  const lastSyncTime = products[0]?.updatedAt || new Date().toISOString();

  return jsonResponse({
    success: true,
    totalProducts,
    totalStockQuantity,
    inStockProducts,
    lastSyncTime
  });
}

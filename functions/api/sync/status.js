import { jsonResponse, getProductsData } from '../../_utils.js';

export async function onRequestGet(context) {
  const { env } = context;
  let lastSyncTime = null;
  let totalProducts = 0;

  try {
    const kv = env && (env.INVENTORY_KV || env.PRODUCTS_KV);
    if (kv) {
      lastSyncTime = await kv.get('last_sync_time');
    }
  } catch (e) {}

  const products = await getProductsData(context);
  totalProducts = Array.isArray(products) ? products.length : 0;

  return jsonResponse({
    success: true,
    lastSyncTime: lastSyncTime || new Date().toISOString(),
    totalProducts,
    timestamp: Date.now()
  });
}

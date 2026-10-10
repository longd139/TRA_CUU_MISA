import { getCategoriesData, jsonResponse } from '../_utils.js';

export async function onRequestGet(context) {
  const tree = await getCategoriesData(context);
  return jsonResponse({
    success: true,
    data: tree
  });
}

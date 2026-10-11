import { jsonResponse } from '../../_utils.js';

export async function onRequestPost() {
  return jsonResponse({
    success: false,
    message: 'Hệ thống đang chạy trên Cloudflare Pages (môi trường máy chủ biên 24/7). Tính năng đồng bộ trực tiếp từ MShopKeeper MISA được thực hiện tự động mỗi 2 giờ trên máy chủ Local Node.js tại cửa hàng.'
  }, 400);
}

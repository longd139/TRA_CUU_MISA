import { jsonResponse } from '../../_utils.js';

export async function onRequestGet() {
  return jsonResponse({
    success: false,
    message: 'Quét token từ trình duyệt Chrome/Edge chỉ hỗ trợ khi chạy trên máy tính cửa hàng (Local Server). Vui lòng chạy server local hoặc dán token thủ công.'
  }, 400);
}

import { jsonResponse } from '../../_utils.js';

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const { phone } = body;

    if (!phone) {
      return jsonResponse({ success: false, message: 'Vui lòng cung cấp số điện thoại' }, 400);
    }

    // Edge response for demonstration / portal
    return jsonResponse({
      success: true,
      message: 'Đăng nhập thành công trên Cloudflare Edge!',
      token: 'edge_demo_token_' + Date.now(),
      user: {
        id: 'usr_edge_' + phone,
        phone,
        status: 'ACTIVE',
        hasPaid: true,
        daysLeft: 30
      }
    });
  } catch (err) {
    return jsonResponse({ success: false, message: err.message }, 500);
  }
}

import { jsonResponse, checkRateLimit } from '../../_utils.js';

export async function onRequestPost(context) {
  const clientIp = context.request.headers.get('cf-connecting-ip') || 'unknown';
  const rate = checkRateLimit(`pin_${clientIp}`, 15, 60000); // 15 attempts / min
  if (!rate.allowed) {
    return jsonResponse({
      success: false,
      message: 'Quá nhiều lần thử mã PIN. Vui lòng thử lại sau 1 phút.'
    }, 429);
  }

  try {
    const body = await context.request.json().catch(() => ({}));
    const pin = body.pin;
    const validPin = (context.env && context.env.ADMIN_PIN) || '1234';

    if (pin && String(pin).trim() === String(validPin).trim()) {
      return jsonResponse({
        success: true,
        message: 'Xác thực Quản trị thành công!'
      });
    }

    return jsonResponse({
      success: false,
      message: 'Mã PIN Admin không đúng. Mặc định: 1234'
    }, 401);
  } catch (err) {
    return jsonResponse({
      success: false,
      message: 'Dữ liệu xác thực không hợp lệ.'
    }, 400);
  }
}

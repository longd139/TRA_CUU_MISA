import { verifyCommercialHmac, checkRateLimit, jsonResponse } from '../../_utils.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const ip = request.headers.get('cf-connecting-ip') || '127.0.0.1';

  // Rate Limiter: Commercial (60 req/min/IP)
  const rate = checkRateLimit(`commercial:${ip}`, 60, 60000);
  if (!rate.allowed) {
    return jsonResponse({
      success: false,
      code: 'COMMERCIAL_RATE_LIMIT_EXCEEDED',
      message: 'Vượt quá giới hạn tần suất truy vấn thương mại (60 requests/phút). Vui lòng thử lại sau.'
    }, 429);
  }

  // HMAC Verification
  const auth = await verifyCommercialHmac(request, env);
  if (!auth.valid) {
    return jsonResponse({
      success: false,
      code: auth.code,
      message: auth.message
    }, auth.status);
  }

  return jsonResponse({
    success: true,
    message: 'Xác thực Commercial API thành công!',
    client: {
      apiKey: auth.client.apiKey,
      name: auth.client.clientName
    },
    serverTime: new Date().toISOString()
  });
}

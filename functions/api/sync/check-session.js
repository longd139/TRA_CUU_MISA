import { jsonResponse } from '../../_utils.js';

export async function onRequest(context) {
  try {
    let token = '';
    if (context.request.method === 'POST') {
      const body = await context.request.json().catch(() => ({}));
      token = body.token;
    } else {
      const url = new URL(context.request.url);
      token = url.searchParams.get('token');
    }

    if (!token) {
      return jsonResponse({
        success: false,
        valid: false,
        message: 'Vui lòng cung cấp Access Token để kiểm tra phiên đăng nhập.'
      }, 400);
    }

    token = String(token).replace(/^Bearer\s+/i, '').trim();
    const branchId = '68d5c6a7-2ad8-44c8-b36c-58e095dd6ceb';
    const reqHeaders = {
      'accept': 'application/json',
      'authorization': `Bearer ${token}`,
      'companycode': 'cobedenim',
      'x-misa-branchid': branchId,
      'x-misa-language': 'vi-VN'
    };

    const testUrl = `https://cobedenim.mshopkeeper.vn/backendg2/api/InventoryItemCategory/TreeItem?_dc=${Date.now()}&node=root`;

    const res = await fetch(testUrl, {
      method: 'GET',
      headers: reqHeaders
    });

    const masked = token.length > 16 ? `${token.slice(0, 8)}...${token.slice(-8)}` : token;

    if (res.ok) {
      return jsonResponse({
        success: true,
        valid: true,
        expired: false,
        status: res.status,
        tokenMasked: masked,
        message: 'Phiên đăng nhập MShopKeeper HỢP LỆ! Sẵn sàng đồng bộ tồn kho.'
      });
    }

    if (res.status === 401 || res.status === 403) {
      return jsonResponse({
        success: true,
        valid: false,
        expired: true,
        status: res.status,
        tokenMasked: masked,
        message: 'Phiên đăng nhập đã hết hạn. Vui lòng mở lại tab cobedenim.mshopkeeper.vn trên trình duyệt để lấy token mới.'
      });
    }

    return jsonResponse({
      success: false,
      valid: false,
      status: res.status,
      message: `MShopKeeper phản hồi mã lỗi HTTP ${res.status}.`
    });
  } catch (err) {
    return jsonResponse({
      success: false,
      valid: false,
      message: 'Lỗi kiểm tra phiên: ' + err.message
    }, 500);
  }
}

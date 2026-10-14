// toolCalcCTV/content/interceptor.js
// Runs in MAIN world (page context) to intercept ExtJS/Ajax & Fetch on MShopKeeper

(function () {
  'use strict';

  if (window.__MISA_REALTIME_INTERCEPTOR_ACTIVE__) return;
  window.__MISA_REALTIME_INTERCEPTOR_ACTIVE__ = true;

  console.log('%c[CTV POS Sync] ⚡ Bộ theo dõi tồn kho tức thì MShopKeeper đã kích hoạt!', 'background: #4f46e5; color: white; padding: 4px 8px; border-radius: 4px; font-weight: bold;');

  // Trích xuất tất cả các sản phẩm / SKU từ bất kỳ cấu trúc dữ liệu JSON nào
  function extractItemsFromData(data) {
    const items = [];
    const visited = new Set();
    const seenSkus = new Set();

    function walk(obj) {
      if (!obj || typeof obj !== 'object' || visited.has(obj)) return;
      visited.add(obj);

      // Nếu đối tượng chứa SKUCode
      if (obj.SKUCode && typeof obj.SKUCode === 'string') {
        const sku = obj.SKUCode.trim().toUpperCase();
        if (sku && !seenSkus.has(sku)) {
          seenSkus.add(sku);
          items.push({
            sku: obj.SKUCode,
            parentId: obj.ParentID || obj.InventoryItemParent || obj.InventoryItemParentID || obj.InventoryItemID,
            parentSku: obj.SKUCodeParent,
            quantity: Number(obj.Quantity || obj.ActualQuantity || obj.InstockQuantity || 1)
          });
        }
      }

      if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) walk(obj[i]);
      } else {
        const keys = Object.keys(obj);
        for (let i = 0; i < keys.length; i++) walk(obj[keys[i]]);
      }
    }

    walk(data);
    return items;
  }

  // Cố gắng parse chuỗi thành JSON (hỗ trợ cả JSON chuẩn lẫn form-urlencoded data={...})
  function parsePayloadString(str) {
    if (!str || typeof str !== 'string') return null;
    str = str.trim();

    // 1. Thử parse JSON trực tiếp
    try {
      if (str.startsWith('{') || str.startsWith('[')) {
        return JSON.parse(str);
      }
    } catch (e) {}

    // 2. Thử URL-encoded (ExtJS thường gửi data={...} hoặc jsonData={...})
    try {
      if (str.includes('=') && (str.includes('%7B') || str.includes('{'))) {
        const params = new URLSearchParams(str);
        for (const [k, v] of params.entries()) {
          if (v && (v.startsWith('{') || v.startsWith('['))) {
            try { return JSON.parse(v); } catch (e) {}
          }
        }
      }
    } catch (e) {}

    return null;
  }

  // Xử lý khi bắt được yêu cầu hoặc phản hồi mạng liên quan đến tồn kho
  function handleNetworkTraffic(url, method, reqBody, resText) {
    if (!url) return;
    const lowerUrl = String(url).toLowerCase();

    // Lọc các API nghiệp vụ ảnh hưởng tồn kho của MShopKeeper
    const isInward = lowerUrl.includes('ininward') || lowerUrl.includes('inward');
    const isOutward = lowerUrl.includes('inoutward') || lowerUrl.includes('outward');
    const isInvoice = lowerUrl.includes('sainvoice') || lowerUrl.includes('invoice');
    const isReturn = lowerUrl.includes('sareturn') || lowerUrl.includes('return');
    const isStockAdj = lowerUrl.includes('stockadjustment') || lowerUrl.includes('stockadj') || lowerUrl.includes('audit');
    const isItemSave = lowerUrl.includes('inventoryitem') && (method === 'POST' || method === 'PUT');
    const isTransfer = lowerUrl.includes('transfer') || lowerUrl.includes('transferex');

    if (!isInward && !isOutward && !isInvoice && !isReturn && !isStockAdj && !isItemSave && !isTransfer) {
      return;
    }

    // Parse từ body gửi đi
    const reqData = parsePayloadString(reqBody);
    // Parse từ phản hồi trả về từ server MISA
    const resData = parsePayloadString(resText);

    let items = [];
    if (resData) items = items.concat(extractItemsFromData(resData));
    if (reqData) items = items.concat(extractItemsFromData(reqData));

    // Lọc trùng theo SKU
    const uniqueItems = [];
    const skuMap = new Set();
    items.forEach(it => {
      const s = String(it.sku || '').toUpperCase().trim();
      if (s && !skuMap.has(s)) {
        skuMap.add(s);
        uniqueItems.push(it);
      }
    });

    let refId = null;
    if (resData && (resData.RefID || (resData.Data && resData.Data.RefID))) {
      refId = resData.RefID || resData.Data.RefID;
    } else if (reqData && (reqData.RefID || (reqData.Data && reqData.Data.RefID))) {
      refId = reqData.RefID || reqData.Data.RefID;
    }

    let actionName = 'targeted_sync';
    let label = 'BIẾN ĐỘNG KHO';
    let badgeColor = '#6366f1';

    if (isInward) { actionName = 'stock_inward'; label = 'NHẬP KHO'; badgeColor = '#8b5cf6'; }
    else if (isOutward) { actionName = 'stock_outward'; label = 'XUẤT KHO'; badgeColor = '#ec4899'; }
    else if (isInvoice) { actionName = 'invoice_action'; label = 'BÁN HÀNG'; badgeColor = '#10b981'; }
    else if (isReturn) { actionName = 'stock_return'; label = 'ĐỔI TRẢ HÀNG'; badgeColor = '#06b6d4'; }
    else if (isStockAdj) { actionName = 'stock_adjustment'; label = 'ĐIỀU CHỈNH / KIỂM KÊ'; badgeColor = '#f59e0b'; }
    else if (isItemSave) { actionName = 'item_saved'; label = 'LƯU HÀNG HÓA'; badgeColor = '#3b82f6'; }
    else if (isTransfer) { actionName = 'stock_transfer'; label = 'CHUYỂN KHO'; badgeColor = '#14b8a6'; }

    if (uniqueItems.length > 0 || refId) {
      console.log(
        `%c[CTV POS Sync] ⚡ BẮT ĐƯỢC ${label} (${uniqueItems.length} sản phẩm, RefID: ${refId || 'N/A'})`,
        `background: ${badgeColor}; color: white; padding: 3px 6px; border-radius: 3px; font-weight: bold;`,
        uniqueItems
      );

      // Bắn sự kiện sang Content Script (ISOLATED World) để gửi cho Extension Background
      window.postMessage({
        type: 'MISA_REALTIME_SYNC_EVENT',
        payload: {
          action: actionName,
          items: uniqueItems,
          refId,
          url
        }
      }, '*');
    }
  }

  // =========================================================================
  // HOOK XMLHTTPREQUEST (Dành cho ExtJS và các thư viện Ajax cũ)
  // =========================================================================
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    this.__cobeMethod = String(method || 'GET').toUpperCase();
    this.__cobeUrl = String(url || '');
    return origOpen.apply(this, [method, url, ...args]);
  };

  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) {
    this.__cobeBody = body;
    this.addEventListener('load', function () {
      if (this.status >= 200 && this.status < 300) {
        try {
          handleNetworkTraffic(this.__cobeUrl, this.__cobeMethod, this.__cobeBody, this.responseText);
        } catch (e) {
          console.warn('[CTV POS Sync] ⚠ Lỗi phân tích XHR:', e.message);
        }
      }
    });
    return origSend.apply(this, arguments);
  };

  // =========================================================================
  // HOOK FETCH (Dành cho các thư viện hiện đại)
  // =========================================================================
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = async function (...args) {
      let reqUrl = '';
      let reqMethod = 'GET';
      let reqBody = null;

      try {
        if (typeof args[0] === 'string') reqUrl = args[0];
        else if (args[0] && args[0].url) reqUrl = args[0].url;

        if (args[1]) {
          if (args[1].method) reqMethod = String(args[1].method).toUpperCase();
          if (args[1].body) reqBody = args[1].body;
        }
      } catch (e) {}

      const response = await origFetch.apply(this, args);

      try {
        if (response && response.ok) {
          const clone = response.clone();
          clone.text().then(text => {
            handleNetworkTraffic(reqUrl, reqMethod, reqBody, text);
          }).catch(() => {});
        }
      } catch (e) {}

      return response;
    };
  }

})();

// content/content.js - POS CTV Price Extension (Pure Number Format, No 'đ')

(function () {
  'use strict';

  // CHỈ CHO PHÉP HOẠT ĐỘNG TRÊN MISA MSHOPKEEPER (hoặc localhost/127.0.0.1 để test demo)
  function isTargetDomain() {
    const host = (window.location.hostname || '').toLowerCase();
    if (host.endsWith('mshopkeeper.vn') || host === 'mshopkeeper.vn') {
      return true;
    }
    if ((host === 'localhost' || host === '127.0.0.1') && 
        (window.location.pathname.includes('demo') || window.location.pathname.includes('pos') || window.location.pathname.includes('salecloud'))) {
      return true;
    }
    return false;
  }

  if (!isTargetDomain()) {
    return;
  }

  // Bỏ qua các iframe widget bên thứ ba (misacdn, zalo, facebook, v.v.)
  if (window.location.hostname.includes('misacdn.net') || 
      window.location.hostname.includes('facebook.com') || 
      window.location.hostname.includes('google.com') ||
      window.location.hostname.includes('zalo.me')) {
    return;
  }

  if (window.__CTV_EXTENSION_LOADED__) return;
  window.__CTV_EXTENSION_LOADED__ = true;

  console.log('[CTV POS Extension] Active on MShopKeeper POS.');

  // =========================================================================
  // REAL-TIME INVENTORY SYNC FOR MSHOPKEEPER (BÁN HÀNG, HỦY ĐƠN, NHẬP KHO)
  // =========================================================================
  function initMisaRealtimeSync() {
    // Chỉ chạy trên các trang thuộc mshopkeeper.vn (hỗ trợ cả các modal/popup iframe của MISA)
    if (!window.location.hostname.includes('mshopkeeper.vn')) return;

    // Lắng nghe sự kiện từ trang MShopKeeper (MAIN world)
    window.addEventListener('message', (event) => {
      if (event.source !== window || !event.data || event.data.type !== 'MISA_REALTIME_SYNC_EVENT') return;
      const payload = event.data.payload;
      try {
        chrome.runtime.sendMessage({
          action: 'SYNC_TARGETED_PRODUCTS',
          payload
        }, (res) => {
          if (chrome.runtime.lastError) {
            console.warn('[CTV POS Sync] ⚠ Lỗi gửi sang Service Worker:', chrome.runtime.lastError.message);
          } else if (res && res.success) {
            const ms = res.data?.durationMs || 300;
            const updated = res.data?.updatedCardsCount || 1;
            console.log(`%c[CTV POS Sync] ✓ ĐÃ CẬP NHẬT TỒN KHO TỨC THÌ LÊN WEB (${updated} SP) TRONG ${ms}ms!`, 'color: #10b981; font-weight: bold;');
          }
        });
      } catch (err) {}
    });

    // Đảm bảo interceptor.js được nạp vào context của trang web nếu Manifest chưa nạp
    try {
      if (!window.__MISA_REALTIME_INTERCEPTOR_ACTIVE__) {
        const scriptEl = document.createElement('script');
        scriptEl.src = chrome.runtime.getURL('content/interceptor.js');
        scriptEl.onload = () => scriptEl.remove();
        (document.head || document.documentElement).appendChild(scriptEl);
      }
    } catch (err) {}
  }

  initMisaRealtimeSync();

  let ctvPricesCache = {};
  let isEnabled = true;
  let isProcessing = false;
  let debounceTimer = null;

  // Remove any legacy floating summary cards
  const legacyCard = document.getElementById('ctv-summary-card');
  if (legacyCard) legacyCard.remove();

  // Known Size regex: removes trailing size like -L, -M, -S, -XL, -2XL, -38, -39, etc.
  const KNOWN_SIZE_REGEX = /[-_/. ]+(?:XS|XXS|S|M|L|XL|XXL|2XL|3XL|4XL|5XL|XXXL|FS|FREE|FREESIZE|\d{2})(?:\s*)$/i;

  /**
   * Normalize SKU: Keeps Product Code + Color, strips Size
   * DCC01-DE-L -> DCC01-DE
   */
  function normalizeSkuKey(rawSku) {
    if (!rawSku) return '';
    let clean = String(rawSku).trim().toUpperCase();
    clean = clean.replace(/^[[({\s]+|[\])}\s]+$/g, '');

    if (KNOWN_SIZE_REGEX.test(clean)) {
      clean = clean.replace(KNOWN_SIZE_REGEX, '');
    } else {
      const parts = clean.split(/[-_]/);
      if (parts.length >= 3) {
        const lastPart = parts[parts.length - 1];
        if (/^(?:[A-Z0-9]{1,3}|\d+)$/i.test(lastPart)) {
          parts.pop();
          clean = parts.join('-');
        }
      }
    }
    return clean;
  }

  function parsePriceInput(inputStr) {
    if (!inputStr) return 0;
    let str = String(inputStr).trim().toLowerCase().replace(/,/g, '.');

    const trKMatch = str.match(/^(\d+)tr(\d+)$/);
    if (trKMatch) {
      const millions = parseInt(trKMatch[1], 10);
      let rest = trKMatch[2];
      if (rest.length === 1) rest += '00000';
      else if (rest.length === 2) rest += '0000';
      else if (rest.length === 3) rest += '000';
      return millions * 1000000 + parseInt(rest, 10);
    }

    const trMatch = str.match(/^([\d.]+)\s*(?:tr|trieu|m)$/);
    if (trMatch) {
      return Math.round(parseFloat(trMatch[1]) * 1000000);
    }

    const kMatch = str.match(/^([\d.]+)\s*k$/);
    if (kMatch) {
      return Math.round(parseFloat(kMatch[1]) * 1000);
    }

    const cleanNum = str.replace(/[^\d]/g, '');
    return cleanNum ? parseInt(cleanNum, 10) : 0;
  }

  function formatVND(num) {
    if (!num || num === 0) return '0';
    return num.toLocaleString('vi-VN');
  }

  function applyEnabledState(enabled) {
    isEnabled = Boolean(enabled);
    if (!isEnabled) {
      // 1. Dọn sạch toàn bộ container hiển thị giá CTV
      document.querySelectorAll('.ctv-price-container').forEach(el => el.remove());
      // 2. Dọn sạch nút KIỂM TRA TRÙNG ĐƠN
      const btnWrapper = document.getElementById('ctv-above-pay-wrapper');
      if (btnWrapper) btnWrapper.remove();
      // 3. Dọn sạch modal cảnh báo trùng đơn nếu đang mở
      const dupModal = document.getElementById('ctv-dup-warning-modal');
      if (dupModal) dupModal.remove();
      // 4. Dọn toast thông báo
      const toast = document.querySelector('.ctv-pos-toast');
      if (toast) toast.remove();
      console.log('[CTV POS Extension] ⏹ Đã TẮT tính năng trên POS.');
    } else {
      console.log('[CTV POS Extension] ▶ Đã BẬT tính năng trên POS.');
      processPosDOM();
      injectCheckButtonOnPOS();
    }
  }

  async function loadStorageData() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const data = await chrome.storage.local.get(['ctvPrices', 'settings']);
        ctvPricesCache = data.ctvPrices || {};
        isEnabled = data.settings ? (data.settings.enabled !== false) : true;
      }
    } catch (e) {
      console.warn('[CTV Extension] Storage error:', e);
    }
    applyEnabledState(isEnabled);
  }

  async function saveSkuPrice(normalizedSku, newPrice) {
    if (!normalizedSku) return;
    ctvPricesCache[normalizedSku] = newPrice;

    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      try {
        const data = await chrome.storage.local.get('ctvPrices');
        const prices = data.ctvPrices || {};
        prices[normalizedSku] = newPrice;
        await chrome.storage.local.set({ ctvPrices: prices });
      } catch (e) {
        console.warn('[CTV Extension] Save error:', e);
      }
    }

    updateAllBadgesWithSku(normalizedSku, newPrice);
  }

  /**
   * Main scan function: strictly target actual product rows, NEVER headers
   */
  function processPosDOM() {
    if (!isEnabled) {
      document.querySelectorAll('.ctv-price-container').forEach(el => el.remove());
      const btnWrapper = document.getElementById('ctv-above-pay-wrapper');
      if (btnWrapper) btnWrapper.remove();
      return;
    }
    if (isProcessing) return;
    if (!window.location.pathname.includes('salecloud') && !window.location.pathname.includes('pos')) return;
    isProcessing = true;

    try {
      const skuElements = document.querySelectorAll('.product-sku, [class*="product-sku"]');

      skuElements.forEach(skuEl => {
        const rawSku = skuEl.innerText.trim();
        if (!rawSku) return;

        // Skip header words
        const upper = rawSku.toUpperCase();
        if (upper === 'SKU' || upper === 'MÃ' || upper === 'MÃ HÀNG' || upper === 'MÃ SKU' || upper === 'MÃ SP') {
          return;
        }

        // Find the row container
        const row = skuEl.closest('.product-wrap-more-parent, [class*="product-wrap"]') || skuEl.parentElement;
        if (!row) return;

        // Check if row is a header row
        if (row.classList.contains('header') || row.closest('thead') || row.classList.contains('title') || row.classList.contains('product-header')) {
          return;
        }

        // Find unit price element
        const unitPriceEl = row.querySelector('.product-unitprice, [class*="product-unitprice"]');
        if (!unitPriceEl) return;

        // Ensure this unitprice element is in an actual product row (has money input or price text)
        const hasMoneyInput = unitPriceEl.querySelector('input, .misa-input-money, .q-field, [class*="money"]');
        if (!hasMoneyInput && unitPriceEl.innerText.trim().toLowerCase().includes('đơn giá')) {
          const stray = unitPriceEl.querySelector('.ctv-price-container');
          if (stray) stray.remove();
          return;
        }

        const normalizedSku = normalizeSkuKey(rawSku);
        if (!normalizedSku) return;

        row.setAttribute('data-ctv-sku', normalizedSku);

        // Align unitprice flex column
        unitPriceEl.style.display = 'flex';
        unitPriceEl.style.flexDirection = 'column';
        unitPriceEl.style.alignItems = 'flex-end';
        unitPriceEl.style.justifyContent = 'center';

        let container = unitPriceEl.querySelector('.ctv-price-container');
        if (!container) {
          container = document.createElement('div');
          container.className = 'ctv-price-container';
          unitPriceEl.appendChild(container);
        }

        const currentRendered = container.getAttribute('data-rendered-sku');
        if (currentRendered !== normalizedSku || !container.querySelector('.ctv-price-badge, .ctv-inline-editor-wrap')) {
          container.setAttribute('data-rendered-sku', normalizedSku);
          renderPriceBadge(container, normalizedSku);
        }
      });

      // Clean up any stray badges inside table headers
      document.querySelectorAll('th .ctv-price-container, .header .ctv-price-container, .product-header .ctv-price-container').forEach(el => el.remove());
    } catch (err) {
      console.warn('[CTV Extension] Error:', err);
    } finally {
      isProcessing = false;
    }
  }

  /**
   * Render clean badge with no 'đ'
   */
  function renderPriceBadge(container, normalizedSku) {
    const currentPrice = ctvPricesCache[normalizedSku] || 0;
    const isZero = currentPrice === 0;

    container.innerHTML = `
      <div class="ctv-price-badge ${isZero ? 'ctv-zero' : ''}" title="Click vào để sửa giá CTV cho mã: ${normalizedSku}">
        <span class="ctv-badge-label">CTV:</span>
        <span class="ctv-price-val">${isZero ? '0' : formatVND(currentPrice)}</span>
      </div>
    `;

    const badge = container.querySelector('.ctv-price-badge');
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      openInlineEditor(container, normalizedSku, currentPrice);
    });
  }

  /**
   * Inline editor when clicking badge
   */
  function openInlineEditor(container, normalizedSku, currentPrice) {
    const defaultValue = currentPrice > 0 ? currentPrice : '';

    container.innerHTML = `
      <div class="ctv-inline-editor-wrap">
        <input type="text" class="ctv-inline-input" placeholder="Nhập giá..." value="${defaultValue}" />
      </div>
    `;

    const input = container.querySelector('.ctv-inline-input');
    input.focus();
    input.select();

    // Real-time thousand separator formatting while typing (3000 -> 3.000)
    input.addEventListener('input', () => {
      const val = input.value;
      // If user typed shorthand like 'k', 'tr', don't format with dots
      if (/[a-zA-Z]/.test(val)) return;

      const cleanDigits = val.replace(/[^\d]/g, '');
      if (!cleanDigits) {
        input.value = '';
        return;
      }

      const num = parseInt(cleanDigits, 10);
      if (!isNaN(num)) {
        input.value = num.toLocaleString('vi-VN');
      }
    });

    let isSaved = false;

    const handleSave = async () => {
      if (isSaved) return;
      isSaved = true;
      const rawVal = input.value.trim();
      const newPrice = parsePriceInput(rawVal);

      await saveSkuPrice(normalizedSku, newPrice);

      renderPriceBadge(container, normalizedSku);
      const newBadge = container.querySelector('.ctv-price-badge');
      if (newBadge) newBadge.classList.add('ctv-just-saved');
    };

    const handleCancel = () => {
      if (isSaved) return;
      isSaved = true;
      renderPriceBadge(container, normalizedSku);
    };

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSave();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      }
    });

    input.addEventListener('blur', () => {
      setTimeout(() => {
        if (!isSaved) handleSave();
      }, 150);
    });
  }

  function updateAllBadgesWithSku(normalizedSku, newPrice) {
    const allContainers = document.querySelectorAll(`[data-rendered-sku="${normalizedSku}"]`);
    allContainers.forEach(container => {
      renderPriceBadge(container, normalizedSku);
      const badge = container.querySelector('.ctv-price-badge');
      if (badge) badge.classList.add('ctv-just-saved');
    });
  }

  // ==========================================================================
  // ANTI-DUPLICATE ORDER CHECKER (ENGINE & UI)
  // ==========================================================================

  let recentOrdersCache = [];
  let lastFetchTime = 0;
  let isCheckingDuplicate = false;

  /**
   * Extract current Customer/CTV Name from POS DOM
   */
  function extractCurrentCustomerFromDOM() {
    const customerEl = document.querySelector(
      '[name="search-customer-input"] .text-weight-bold, ' +
      '.customer-search .text-weight-bold, ' +
      '.misa-side-bar-guest .text-weight-bold, ' +
      '.tool-guest .text-weight-bold, ' +
      '.customer-name, [class*="customer-name"]'
    );
    if (customerEl) {
      const text = customerEl.innerText.trim();
      if (text && !text.toLowerCase().includes('tìm kiếm') && !text.toLowerCase().includes('khách lẻ')) {
        return text;
      }
    }
    return '';
  }

  /**
   * Extract current product SKUs & names from POS DOM
   */
  function extractCurrentProductsFromDOM() {
    const rows = document.querySelectorAll(
      '.one-row-product, [class*="one-row-product"], ' +
      '.pos-table tbody tr, tbody tr'
    );
    const products = [];

    rows.forEach(row => {
      // Skip header rows
      if (row.closest('thead') || row.classList.contains('header') || row.innerText.includes('Hàng hóa') || row.innerText.includes('Đơn giá')) {
        return;
      }

      // Find SKU element
      const skuEl = row.querySelector('.product-sku, [class*="product-sku"], .sku-cell, [class*="sku"]');
      let rawSku = skuEl ? skuEl.innerText.trim() : '';

      // If not directly in sku element, search in text
      if (!rawSku) {
        const text = row.innerText.trim();
        const skuMatch = text.match(/([A-Z0-9]{3,}-[A-Z0-9]+(?:-[A-Z0-9]+)?)/i);
        if (skuMatch) rawSku = skuMatch[1];
      }

      if (!rawSku || rawSku.toUpperCase() === 'SKU') return;

      const normalizedSku = normalizeSkuKey(rawSku);
      
      // Find Product name
      const nameEl = row.querySelector('.product-cell, [class*="product-name"], [class*="item-name"]');
      const name = nameEl ? nameEl.innerText.trim() : '';

      // Find Quantity
      const qtyEl = row.querySelector('[class*="quantity"], [class*="col-sl"], input[type="number"]');
      let qty = 1;
      if (qtyEl) {
        const qVal = parseFloat(qtyEl.value || qtyEl.innerText);
        if (!isNaN(qVal) && qVal > 0) qty = qVal;
      }

      products.push({
        rawSku: rawSku,
        normalizedSku: normalizedSku,
        name: name || rawSku,
        qty: qty
      });
    });

    return products;
  }

  /**
   * Clean string for fuzzy matching (CTV - Chiến -> chien)
   */
  function cleanCustomerName(name) {
    if (!name) return '';
    return name
      .toLowerCase()
      .replace(/^ctv\s*[-_:]*\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Fetch recent invoices from native POS API (Last 12 hours)
   */
  async function fetchRecentOrdersFromAPI(forceRefresh = false) {
    if (!window.location.pathname.includes('salecloud') && !window.location.pathname.includes('pos')) return [];
    const now = Date.now();
    // Cache for 45 seconds unless forced
    if (!forceRefresh && recentOrdersCache.length > 0 && (now - lastFetchTime) < 45000) {
      return recentOrdersCache;
    }

    try {
      // 1. Get credentials from localStorage
      let companyCode = 'cobedenim';
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.endsWith('_access_token') || key.endsWith('_Token'))) {
          companyCode = key.split('_')[0];
          break;
        }
      }

      const token = localStorage.getItem(`${companyCode}_access_token`) || 
                    sessionStorage.getItem(`${companyCode}_access_token`) || 
                    localStorage.getItem(`${companyCode}_Token`);
      const branchId = localStorage.getItem(`${companyCode}_CurrentBranchID`) || 
                       sessionStorage.getItem(`${companyCode}_CurrentBranchID`) || 
                       '68d5c6a7-2ad8-44c8-b36c-58e095dd6ceb';
      const userId = localStorage.getItem(`${companyCode}_userId`) || '8c578236-8388-4042-a5b9-52655b646c28';
      const userName = localStorage.getItem(`${companyCode}_userName`) || 'STAFF01';

      if (!token) {
        return recentOrdersCache;
      }

      // 2. Compute 12 hours ago with +07:00 timezone
      const past12h = new Date(now - 12 * 60 * 60 * 1000);
      const pad = (n) => String(n).padStart(2, '0');
      const fromDate = `${past12h.getFullYear()}-${pad(past12h.getMonth() + 1)}-${pad(past12h.getDate())}T${pad(past12h.getHours())}:${pad(past12h.getMinutes())}:${pad(past12h.getSeconds())}+07:00`;
      const toDate = `${new Date().getFullYear()}-${pad(new Date().getMonth() + 1)}-${pad(new Date().getDate())}T23:59:59.999+07:00`;

      // 3. Call native POS API SaInvoice/pagging
      const payload = {
        StorePagging: 2,
        page: 1,
        PaggingDatas: [
          { ObjectName: "fromDate", ObjectValue: fromDate, ObjectType: 5 },
          { ObjectName: "toDate", ObjectValue: toDate, ObjectType: 5 },
          { ObjectName: "BranchID", ObjectValue: branchId, ObjectType: 6 },
          { ObjectName: "TypeSort", ObjectValue: 1, ObjectType: 7 },
          { ObjectName: "cashierID", ObjectValue: "00000000-0000-0000-0000-000000000000", ObjectType: 6 },
          { ObjectName: "employeeID", ObjectValue: "00000000-0000-0000-0000-000000000000", ObjectType: 6 },
          { ObjectName: "isCheckByTaxAccountant", ObjectValue: "false", ObjectType: 3 },
          { ObjectName: "listTagID", ObjectValue: "", ObjectType: 1 }
        ],
        Limit: 100,
        Filter: "",
        Sort: JSON.stringify([{ property: "RefDate", direction: "DESC" }])
      };

      const res = await fetch(`${window.location.origin}/salecloud/backendg2/api/v1/SaInvoice/pagging`, {
        method: "POST",
        credentials: "include",
        headers: {
          "accept": "application/json, text/plain, */*",
          "authorization": `Bearer ${token}`,
          "companycode": companyCode,
          "content-type": "application/json",
          "x-misa-branchid": branchId,
          "x-misa-userid": userId,
          "x-misa-username": userName
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) return recentOrdersCache;

      const result = await res.json();

      if (result.Success && Array.isArray(result.Data)) {
        recentOrdersCache = result.Data;
        lastFetchTime = now;
        updateFloatingBadgeCount(recentOrdersCache.length);
        return recentOrdersCache;
      }
    } catch (err) {
      // Silently ignore network failures to avoid console alerts
    }

    return recentOrdersCache;
  }

  /**
   * Fetch invoice details (SKU line items) for a specific RefID
   */
  async function fetchInvoiceDetails(refId) {
    try {
      let companyCode = 'cobedenim';
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.endsWith('_access_token') || key.endsWith('_Token'))) {
          companyCode = key.split('_')[0];
          break;
        }
      }

      const token = localStorage.getItem(`${companyCode}_access_token`) || localStorage.getItem(`${companyCode}_Token`);
      const branchId = localStorage.getItem(`${companyCode}_CurrentBranchID`) || '';
      const userId = localStorage.getItem(`${companyCode}_userId`) || '';
      const userName = localStorage.getItem(`${companyCode}_userName`) || 'STAFF01';

      const res = await fetch(`${window.location.origin}/salecloud/backendg2/api/v1/SAInvoice/getdetail?refId=${refId}`, {
        method: "GET",
        credentials: "include",
        headers: {
          "accept": "application/json, text/plain, */*",
          "authorization": `Bearer ${token}`,
          "companycode": companyCode,
          "x-misa-branchid": branchId,
          "x-misa-userid": userId,
          "x-misa-username": userName
        }
      });

      if (!res.ok) return [];
      const result = await res.json();
      if (result.Success && result.Data && Array.isArray(result.Data.SAInvoiceDetails)) {
        return result.Data.SAInvoiceDetails;
      }
    } catch (e) {}
    return [];
  }

  /**
   * Main Check Function: Compares current POS DOM with Recent Orders
   */
  async function checkDuplicateOrderOnPOS() {
    if (isCheckingDuplicate) return;
    isCheckingDuplicate = true;

    const btn = document.getElementById('ctv-btn-above-pay') || document.getElementById('ctv-btn-check-dup');
    if (btn) {
      btn.classList.add('loading');
      btn.innerHTML = `<span>🔄 ĐANG KIỂM TRA...</span>`;
    }

    try {
      const currentCustomer = extractCurrentCustomerFromDOM();
      const currentProducts = extractCurrentProductsFromDOM();

      if (!currentCustomer && currentProducts.length === 0) {
        showPosToast('Vui lòng chọn CTV và thêm sản phẩm trước khi kiểm tra!', 'warning');
        return;
      }

      if (currentProducts.length === 0) {
        showPosToast('Chưa có sản phẩm nào trên đơn hàng!', 'warning');
        return;
      }

      // Fetch fresh orders (12h)
      const orders = await fetchRecentOrdersFromAPI(true);

      const cleanCurrCust = cleanCustomerName(currentCustomer);
      const currSkus = currentProducts.map(p => p.normalizedSku);

      // 1. Filter invoices of this customer
      const candidateInvoices = orders.filter(inv => {
        const itemCust = cleanCustomerName(inv.CustomerName);
        return cleanCurrCust && itemCust && (
          itemCust.includes(cleanCurrCust) || cleanCurrCust.includes(itemCust)
        );
      });

      const duplicateOrders = [];

      // 2. For each candidate invoice, fetch details and check SKU match
      for (const inv of candidateInvoices) {
        const details = await fetchInvoiceDetails(inv.RefID);
        const matchingItems = [];

        details.forEach(item => {
          const itemNormSku = normalizeSkuKey(item.SKUCode);
          if (currSkus.includes(itemNormSku)) {
            matchingItems.push({
              name: item.InventoryItemName || item.SKUCode,
              sku: item.SKUCode,
              qty: item.Quantity || 1
            });
          }
        });

        if (matchingItems.length > 0) {
          duplicateOrders.push({
            refNo: inv.RefNo,
            customer: inv.CustomerName,
            tel: inv.CustomerTel || '',
            staff: inv.CashierName || inv.EmployeeName || 'Nhân viên',
            time: new Date(inv.RefDate).toLocaleString('vi-VN'),
            items: matchingItems
          });
        }
      }

      if (duplicateOrders.length > 0) {
        // Show Red Warning Modal
        showDuplicateWarningModal(currentCustomer, duplicateOrders);
      } else {
        // Show Success Toast
        showPosToast(`ĐƠN MỚI HỢP LỆ! Chưa có đơn nào của CTV [${currentCustomer || 'này'}] trong 12h qua.`, 'success');
      }
    } catch (err) {
      showPosToast('Lỗi khi kiểm tra: ' + err.message, 'warning');
    } finally {
      isCheckingDuplicate = false;
      if (btn) {
        btn.classList.remove('loading');
        btn.innerHTML = `<span>KIỂM TRA TRÙNG ĐƠN (F4)</span>`;
      }
    }
  }

  /**
   * Display Red Warning Modal on POS
   */
  function showDuplicateWarningModal(customerName, duplicateOrders) {
    // Remove existing modal if any
    const existing = document.getElementById('ctv-dup-warning-modal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'ctv-dup-warning-modal';
    overlay.className = 'ctv-modal-overlay';

    let ordersHtml = '';
    duplicateOrders.forEach((ord, i) => {
      const itemsHtml = ord.items.map(it => 
        `<div class="ctv-dup-item-entry">⚠️ ${it.name} (SKU: <b>${it.sku}</b>) x ${it.qty}</div>`
      ).join('');

      ordersHtml += `
        <div class="ctv-dup-info-card">
          <div class="ctv-info-row">
            <span class="ctv-info-label">Mã đơn đã làm:</span>
            <span class="ctv-info-value" style="color:#dc2626; font-size:14px;">#${ord.refNo}</span>
          </div>
          <div class="ctv-info-row">
            <span class="ctv-info-label">CTV / Khách:</span>
            <span class="ctv-info-value">${ord.customer} ${ord.tel ? '(' + ord.tel + ')' : ''}</span>
          </div>
          <div class="ctv-info-row">
            <span class="ctv-info-label">Người đã làm:</span>
            <span class="ctv-info-value">${ord.staff}</span>
          </div>
          <div class="ctv-info-row">
            <span class="ctv-info-label">Thời gian tạo:</span>
            <span class="ctv-info-value">${ord.time}</span>
          </div>
          <div style="margin-top:8px;">
            <div style="font-size:12px; font-weight:700; color:#991b1b; margin-bottom:4px;">Sản phẩm trùng khớp:</div>
            <div class="ctv-dup-items-list">
              ${itemsHtml}
            </div>
          </div>
        </div>
      `;
    });

    overlay.innerHTML = `
      <div class="ctv-warning-dialog">
        <div class="ctv-dialog-header">
          <span class="icon-alert">🚨</span>
          <div>
            <h3>CẢNH BÁO: ĐƠN HÀNG ĐÃ ĐƯỢC THỰC HIỆN!</h3>
            <div style="font-size:12px; color:#b91c1c;">Kiểm tra kỹ trước khi đóng gói / thanh toán để tránh làm thừa đơn.</div>
          </div>
        </div>
        <div class="ctv-dialog-body">
          ${ordersHtml}
        </div>
        <div class="ctv-dialog-actions">
          <button id="ctv-btn-modal-close" class="ctv-btn-dismiss">ĐÃ HIỂU & ĐÓNG (Enter / Esc)</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const closeBtn = overlay.querySelector('#ctv-btn-modal-close');
    const closeModal = () => {
      overlay.remove();
      window.removeEventListener('keydown', handleKey);
    };

    const handleKey = (e) => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        closeModal();
      }
    };

    closeBtn.addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });
    window.addEventListener('keydown', handleKey);
    closeBtn.focus();
  }

  /**
   * Display Toast on POS screen
   */
  function showPosToast(message, type = 'success') {
    const existing = document.querySelector('.ctv-pos-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `ctv-pos-toast toast-${type}`;
    const icon = type === 'success' ? '✅' : '⚠️';
    toast.innerHTML = `<span style="font-size: 16px; line-height: 1;">${icon}</span> <div style="font-size: 13.5px; font-weight: 700;">${message}</div>`;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-10px)';
      setTimeout(() => toast.remove(), 300);
    }, 3800);
  }

  function updateFloatingBadgeCount(count) {
    const infoEl = document.getElementById('ctv-cache-count-text');
    if (infoEl) {
      infoEl.innerText = `${count} dòng đơn 12h`;
    }
  }

  /**
   * Inject Check Button directly ABOVE the Thu Tiền (F9) button in POS Sidebar
   */
  function injectCheckButtonOnPOS() {
    try {
      if (!isEnabled || !isTargetDomain()) {
        const existing = document.getElementById('ctv-above-pay-wrapper');
        if (existing) existing.remove();
        return;
      }
      if (!window.location.pathname.includes('salecloud') && !window.location.pathname.includes('pos')) return;
      if (document.getElementById('ctv-btn-above-pay')) return;

      // 1. Find Thu tiền (F9) button targeting buttons specifically
      const allBtns = Array.from(document.querySelectorAll('button, .q-btn, [role="button"], a.btn'));
      const payBtn = allBtns.find(el => {
        const txt = (el.textContent || '').trim();
        return txt.includes('Thu tiền');
      });

      if (!payBtn) return;

      // 2. Find the direct horizontal row containing both buttons
      let btnRow = payBtn;
      while (btnRow && btnRow.parentElement && btnRow.parentElement !== document.body) {
        const pTxt = btnRow.parentElement.innerText || '';
        if (pTxt.includes('Lưu tạm') && pTxt.includes('Thu tiền')) {
          btnRow = btnRow.parentElement;
          break;
        }
        btnRow = btnRow.parentElement;
      }

      if (btnRow && btnRow.parentElement) {
        const wrapper = document.createElement('div');
        wrapper.id = 'ctv-above-pay-wrapper';
        wrapper.style.cssText = 'width: 100% !important; margin-bottom: 8px !important; display: flex !important; box-sizing: border-box !important; padding: 0 4px !important;';

        const btn = document.createElement('button');
        btn.id = 'ctv-btn-above-pay';
        btn.type = 'button';
        btn.className = 'ctv-check-dup-btn ctv-btn-large';
        btn.title = 'Kiểm tra xem đơn hàng và các sản phẩm của CTV này đã được làm trong 12h qua chưa (Phím tắt F4)';
        btn.innerHTML = `<span>KIỂM TRA TRÙNG ĐƠN (F4)</span>`;
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          checkDuplicateOrderOnPOS();
        });

        wrapper.appendChild(btn);
        btnRow.parentElement.insertBefore(wrapper, btnRow);
      }
    } catch (err) {
      console.warn('[CTV Extension] Button inject error:', err);
    }
  }

  /**
   * Setup Hotkeys (F4 or Alt+K to check duplicate)
   */
  function setupHotkeys() {
    window.addEventListener('keydown', (e) => {
      if (!isEnabled || !isTargetDomain()) return;
      // F4 key or Alt + K
      if (e.key === 'F4' || (e.altKey && (e.key === 'k' || e.key === 'K'))) {
        e.preventDefault();
        checkDuplicateOrderOnPOS();
      }
    });
  }

  function setupScanner() {
    const observer = new MutationObserver((mutations) => {
      if (!isEnabled || isProcessing) return;

      const isExternal = mutations.some(m => {
        const t = m.target;
        if (!t || !t.closest) return true;
        return !t.closest('.ctv-price-container') && !t.closest('.ctv-floating-action-bar') && !t.closest('.ctv-modal-overlay');
      });

      if (!isExternal) return;

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (isEnabled) {
          processPosDOM();
          injectCheckButtonOnPOS();
        }
      }, 200);
    });

    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }

    setInterval(() => {
      if (isEnabled && !isProcessing) {
        processPosDOM();
        injectCheckButtonOnPOS();
      }
    }, 1500);
  }

  // Lắng nghe lệnh bật/tắt trực tiếp từ Popup qua Message
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message && message.action === 'SET_EXTENSION_ENABLED') {
        applyEnabledState(message.enabled);
        sendResponse({ success: true, isEnabled });
      }
    });
  }

  // Lắng nghe thay đổi cài đặt từ chrome.storage
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local') {
        if (changes.ctvPrices) {
          ctvPricesCache = changes.ctvPrices.newValue || {};
          if (isEnabled) processPosDOM();
        }
        if (changes.settings) {
          const settings = changes.settings.newValue || {};
          applyEnabledState(settings.enabled !== false);
        }
      }
    });
  }

  // Khởi tạo tiện ích
  loadStorageData();
  setupHotkeys();
  setupScanner();

})();


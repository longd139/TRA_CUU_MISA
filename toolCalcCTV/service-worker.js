// service-worker.js - Background service worker for CTV Price Extension

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[CTV Extension] Extension installed/updated:', details.reason);
  
  // Initialize default storage structure if empty
  const { ctvPrices = {} } = await chrome.storage.local.get('ctvPrices');
  if (Object.keys(ctvPrices).length === 0) {
    await chrome.storage.local.set({
      ctvPrices: {},
      settings: {
        enabled: true,
        showSummaryBar: true
      }
    });
  }
});

// Listen for messages from content scripts or popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'PING') {
    sendResponse({ status: 'PONG' });
    return true;
  }

  // Real-Time Inventory Sync: Forward captured POS/Inward events to Local Server
  if (message.action === 'SYNC_TARGETED_PRODUCTS') {
    fetch('http://127.0.0.1:3000/api/sync/targeted-products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message.payload || {})
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          console.log('[CTV POS Sync] ✓ Đồng bộ kho tức thì thành công:', data);
          // Thông báo cho các tab tra cứu đang mở để cập nhật giao diện ngay lập tức
          try {
            chrome.tabs.query({}, (tabs) => {
              (tabs || []).forEach(tab => {
                if (tab.url && (tab.url.includes('localhost:3000') || tab.url.includes('127.0.0.1:3000') || tab.url.includes('pages.dev'))) {
                  chrome.tabs.sendMessage(tab.id, { action: 'AUTO_REFRESH_PRODUCTS', data }).catch(() => {});
                }
              });
            });
          } catch (e) {}
          sendResponse({ success: true, data });
        } else {
          console.warn('[CTV POS Sync] ⚠ Máy chủ trả lời lỗi:', data);
          sendResponse({ success: false, data });
        }
      })
      .catch((err) => {
        console.warn('[CTV POS Sync] ⚠ Không thể kết nối Local Server (:3000):', err.message);
        sendResponse({ success: false, error: err.message });
      });
    return true; // Keep message channel open for async response
  }

  return true;
});

/**
 * COBE DENIM INVENTORY LOOKUP — APP CLIENT LOGIC
 * Refined under taste-skill directives: high visual density, tactile response, skeleton loaders
 */

document.addEventListener('DOMContentLoaded', () => {
  // State
  let allProducts = [];
  let currentBrands = [];
  let currentCategories = [];
  let currentTheme = localStorage.getItem('cobe_theme') || 'denim';
  if (currentTheme !== 'light') currentTheme = 'denim';
  let activeStatus = 'all';
  let activeBrand = 'all';
  let activeCategory = 'all';
  let activeSize = 'all';
  let activeSort = 'default';
  let currentSearch = '';
  let currentPage = 1;
  let totalPages = 1;
  let pageSize = 24;
  let totalProductsCount = 0;
  let debounceTimer = null;

  // DOM Elements
  const searchInput = document.getElementById('searchInput');
  const btnClearSearch = document.getElementById('btnClearSearch');
  const productsContainer = document.getElementById('productsContainer');
  const resultsCount = document.getElementById('resultsCount');
  const statusTabs = document.getElementById('statusTabs');
  const brandTabs = document.getElementById('brandTabs');
  const categoryChips = document.getElementById('categoryChips');
  const sortSelect = document.getElementById('sortSelect');
  const btnThemeToggle = document.getElementById('btnThemeToggle');
  const themeIconSun = document.getElementById('themeIconSun');
  const themeIconMoon = document.getElementById('themeIconMoon');
  const statusSyncText = document.getElementById('statusSyncText');
  const statTotalModels = document.getElementById('statTotalModels');
  const statTotalStock = document.getElementById('statTotalStock');
  const toastEl = document.getElementById('toast');
  const toastText = document.getElementById('toastText');

  // Pagination Elements
  const paginationContainer = document.getElementById('paginationContainer');
  const paginationNav = document.getElementById('paginationNav');
  const pageRangeStart = document.getElementById('pageRangeStart');
  const pageRangeEnd = document.getElementById('pageRangeEnd');
  const pageTotalCount = document.getElementById('pageTotalCount');
  const limitSelect = document.getElementById('limitSelect');

  // Lightbox Elements
  const imageLightbox = document.getElementById('imageLightbox');
  const lightboxImg = document.getElementById('lightboxImg');
  const lightboxTitle = document.getElementById('lightboxTitle');
  const lightboxSku = document.getElementById('lightboxSku');
  const lightboxDesc = document.getElementById('lightboxDesc');
  const btnCloseLightbox = document.getElementById('btnCloseLightbox');
  const lightboxBackdrop = document.getElementById('lightboxBackdrop');
  const btnDownloadImg = document.getElementById('btnDownloadImg');
  const btnCopySkuModal = document.getElementById('btnCopySkuModal');
  let currentLightboxProduct = null;

  // Admin Modal Elements
  const btnOpenSync = document.getElementById('btnOpenSync');
  const syncModal = document.getElementById('syncModal');
  const syncModalBackdrop = document.getElementById('syncModalBackdrop');
  const btnCloseSyncModal = document.getElementById('btnCloseSyncModal');
  const modalLastSyncTime = document.getElementById('modalLastSyncTime');
  const modalTotalItems = document.getElementById('modalTotalItems');
  const btnTriggerDemoSync = document.getElementById('btnTriggerDemoSync');
  const btnTriggerTokenSync = document.getElementById('btnTriggerTokenSync');
  const btnImportJson = document.getElementById('btnImportJson');
  const tokenInput = document.getElementById('tokenInput');
  const syncFeedback = document.getElementById('syncFeedback');

  // Live Sync & Image Fill Progress Tracker Elements
  const syncProgressCard = document.getElementById('syncProgressCard');
  const syncProgressTitle = document.getElementById('syncProgressTitle');
  const syncProgressPercent = document.getElementById('syncProgressPercent');
  const syncProgressBar = document.getElementById('syncProgressBar');
  const syncProgressDetail = document.getElementById('syncProgressDetail');
  const syncProgressElapsed = document.getElementById('syncProgressElapsed');
  const syncImageExtraRow = document.getElementById('syncImageExtraRow');
  const statImgProcessed = document.getElementById('statImgProcessed');
  const statImgFilled = document.getElementById('statImgFilled');
  const statImgSkipped = document.getElementById('statImgSkipped');
  const btnCancelFillImages = document.getElementById('btnCancelFillImages');
  const btnStartFillImages = document.getElementById('btnStartFillImages');
  let progressPollingTimer = null;

  // Live Session Checker Elements
  const sessionCheckerCard = document.getElementById('sessionCheckerCard');
  const sessionIndicator = document.getElementById('sessionIndicator');
  const sessionStatusBadge = document.getElementById('sessionStatusBadge');
  const sessionStatusDesc = document.getElementById('sessionStatusDesc');
  const btnCheckSession = document.getElementById('btnCheckSession');

  // Initialize
  init();

  async function init() {
    applyTheme(currentTheme);
    setupEventListeners();
    renderSkeletons();
    await loadStats();
    await fetchProducts();
  }

  // Setup Event Listeners
  function setupEventListeners() {
    // Search input with debounce
    searchInput.addEventListener('input', (e) => {
      currentSearch = e.target.value.trim();
      currentPage = 1;
      btnClearSearch.style.display = currentSearch ? 'flex' : 'none';
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        fetchProducts();
      }, 180);
    });

    btnClearSearch.addEventListener('click', () => {
      searchInput.value = '';
      currentSearch = '';
      currentPage = 1;
      btnClearSearch.style.display = 'none';
      searchInput.focus();
      fetchProducts();
    });

    // Dedicated Size Search Input beside main search input
    const sizeInput = document.getElementById('sizeInput');
    const btnClearSize = document.getElementById('btnClearSize');
    let sizeDebounceTimer = null;

    if (sizeInput) {
      sizeInput.addEventListener('input', (e) => {
        const val = e.target.value.trim();
        btnClearSize.style.display = val ? 'flex' : 'none';
        activeSize = val || 'all';
        currentPage = 1;

        clearTimeout(sizeDebounceTimer);
        sizeDebounceTimer = setTimeout(() => {
          fetchProducts();
        }, 180);
      });

      btnClearSize.addEventListener('click', () => {
        sizeInput.value = '';
        btnClearSize.style.display = 'none';
        activeSize = 'all';
        currentPage = 1;
        sizeInput.focus();
        fetchProducts();
      });
    }

    // Status segment tabs
    statusTabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.segment-btn');
      if (!btn) return;
      document.querySelectorAll('.segment-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeStatus = btn.dataset.status;
      currentPage = 1;
      fetchProducts();
    });

    // Sort dropdown
    sortSelect.addEventListener('change', (e) => {
      activeSort = e.target.value;
      currentPage = 1;
      fetchProducts();
    });

    // Brand tabs click delegation
    if (brandTabs) {
      brandTabs.addEventListener('click', (e) => {
        const btn = e.target.closest('.brand-btn');
        if (!btn) return;
        document.querySelectorAll('.brand-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeBrand = btn.dataset.brand;
        activeCategory = 'all'; // Reset subcategory when brand changes
        currentPage = 1;
        fetchProducts();
      });
    }

    // Category pills click delegation
    categoryChips.addEventListener('click', (e) => {
      const btn = e.target.closest('.pill-btn');
      if (!btn) return;
      document.querySelectorAll('.pill-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeCategory = btn.dataset.category;
      currentPage = 1;
      fetchProducts();
    });

    // Pagination nav button delegation
    if (paginationNav) {
      paginationNav.addEventListener('click', (e) => {
        const btn = e.target.closest('.page-btn');
        if (!btn || btn.disabled) return;
        const targetPage = parseInt(btn.dataset.page, 10);
        if (targetPage && targetPage !== currentPage && targetPage >= 1 && targetPage <= totalPages) {
          currentPage = targetPage;
          fetchProducts();
          const anchor = document.getElementById('productsContainer');
          if (anchor) {
            anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }
      });
    }

    // Limit select change
    if (limitSelect) {
      limitSelect.addEventListener('change', (e) => {
        pageSize = e.target.value === 'all' ? 'all' : parseInt(e.target.value, 10);
        currentPage = 1;
        fetchProducts();
      });
    }

    // Toggle Light / Dark Mode directly
    if (btnThemeToggle) {
      btnThemeToggle.addEventListener('click', () => {
        const newTheme = currentTheme === 'light' ? 'denim' : 'light';
        applyTheme(newTheme);
        showToast(newTheme === 'light' ? 'Đã chuyển sang giao diện Sáng' : 'Đã chuyển sang giao diện Tối');
      });
    }

    // Floating Back to Top Button
    const btnScrollTop = document.getElementById('btnScrollTop');
    if (btnScrollTop) {
      window.addEventListener('scroll', () => {
        if (window.scrollY > 280) {
          btnScrollTop.classList.add('visible');
        } else {
          btnScrollTop.classList.remove('visible');
        }
      }, { passive: true });

      btnScrollTop.addEventListener('click', () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }

    // Lightbox events
    btnCloseLightbox.addEventListener('click', closeLightbox);
    lightboxBackdrop.addEventListener('click', closeLightbox);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeLightbox();
        closeSyncModal();
      }
    });

    btnCopySkuModal.addEventListener('click', () => {
      if (currentLightboxProduct) {
        copyToClipboard(currentLightboxProduct.sku, `Đã copy mã: ${currentLightboxProduct.sku}`);
      }
    });

    // Sync modal events (mở trực tiếp không cần nhập mã PIN)
    btnOpenSync.addEventListener('click', () => {
      openSyncModal();
    });
    btnCloseSyncModal.addEventListener('click', closeSyncModal);
    syncModalBackdrop.addEventListener('click', closeSyncModal);

    // Sync tab switching
    document.querySelectorAll('.nav-tab').forEach(tabBtn => {
      tabBtn.addEventListener('click', () => {
        document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(c => c.classList.remove('active'));
        tabBtn.classList.add('active');
        document.getElementById(`tab-${tabBtn.dataset.tab}`).classList.add('active');
        hideSyncFeedback();
      });
    });

    // Trigger Demo Sync
    btnTriggerDemoSync.addEventListener('click', async () => {
      btnTriggerDemoSync.disabled = true;
      btnTriggerDemoSync.textContent = '⏳ Đang đồng bộ kho...';
      startProgressPolling('sync');
      try {
        const res = await fetch('/api/sync/mshopkeeper', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ demoMode: true })
        });
        const data = await res.json();
        if (data.success) {
          showSyncFeedback(data.message, 'success');
          await loadStats();
          await fetchProducts();
          showToast('Đồng bộ kho thành công!');
        } else {
          showSyncFeedback(data.message, 'error');
        }
      } catch (err) {
        showSyncFeedback('Lỗi kết nối máy chủ', 'error');
      } finally {
        btnTriggerDemoSync.disabled = false;
        btnTriggerDemoSync.textContent = '⚡ Làm Mới Dữ Liệu Kho Tức Thì';
      }
    });

    // Dynamic Bookmarklet Generator (Points directly to current domain/origin)
    const bookmarkletLink = document.getElementById('bookmarkletLink');
    if (bookmarkletLink) {
      const targetOrigin = window.location.origin;
      const bmCode = `javascript:(function(){let t='';try{const keys=['cobedenim_access_token','misa_common_access_token','access_token','token'];for(const k of keys){t=localStorage.getItem(k)||sessionStorage.getItem(k);if(t)break;}if(!t){for(let i=0;i<localStorage.length;i++){const v=localStorage.getItem(localStorage.key(i));if(v&&v.length>80&&v.includes('eyJ')){const m=v.match(/eyJ[a-zA-Z0-9._\\-]{60,}/);if(m){t=m[0];break;}}}if(!t){for(let i=0;i<sessionStorage.length;i++){const v=sessionStorage.getItem(sessionStorage.key(i));if(v&&v.length>80&&v.includes('eyJ')){const m=v.match(/eyJ[a-zA-Z0-9._\\-]{60,}/);if(m){t=m[0];break;}}}}}}catch(e){}if(t){t=t.replace(/^Bearer\\s*/i,'').replace(/[^\\w.\\-]/g,'');if(navigator.clipboard){navigator.clipboard.writeText(t);}window.open('${targetOrigin}/#token='+encodeURIComponent(t),'_blank');}else{alert('Không tìm thấy token. Hãy đảm bảo bạn đang ở tab cobedenim.mshopkeeper.vn và đã đăng nhập!');}})();`;
      bookmarkletLink.setAttribute('href', bmCode);
    }

    // Auto-fill token from URL hash (Bookmarklet 1-click support)
    if (window.location.hash && window.location.hash.startsWith('#token=')) {
      const incomingToken = decodeURIComponent(window.location.hash.replace('#token=', ''));
      history.replaceState(null, '', window.location.pathname);
      tokenInput.value = incomingToken;
      openSyncModal();
      showToast('Đã nhận token từ Bookmarklet!');
      // Auto trigger sync with this token
      setTimeout(() => {
        btnTriggerTokenSync.click();
      }, 500);
    }

    // Helper: Kiểm tra phiên đăng nhập MShopKeeper (LevelDB hoặc Token nhập vào)
    async function checkSessionStatus(opts = {}) {
      const silent = Boolean(opts.silent);
      if (!sessionCheckerCard || !sessionIndicator || !sessionStatusBadge || !sessionStatusDesc) return { valid: false };

      if (btnCheckSession) {
        btnCheckSession.disabled = true;
        btnCheckSession.innerHTML = '<span class="btn-spinner-mini"></span> <span>Đang kiểm tra...</span>';
      }

      sessionCheckerCard.classList.remove('valid', 'expired');
      sessionIndicator.className = 'session-pulse-indicator loading';
      sessionStatusBadge.className = 'session-status-badge loading';
      sessionStatusBadge.textContent = 'Đang kiểm tra...';
      sessionStatusDesc.textContent = 'Đang gửi tín hiệu kiểm tra tới MShopKeeper...';

      const inputToken = tokenInput ? tokenInput.value.trim() : '';

      try {
        let res;
        if (inputToken) {
          res = await fetch('/api/sync/check-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: inputToken })
          });
        } else {
          res = await fetch('/api/sync/check-session');
        }

        const data = await res.json();

        if (data.success && data.valid) {
          sessionCheckerCard.classList.remove('expired');
          sessionCheckerCard.classList.add('valid');
          sessionIndicator.className = 'session-pulse-indicator valid';
          sessionStatusBadge.className = 'session-status-badge valid';
          sessionStatusBadge.textContent = data.browser ? `Hợp lệ (${data.browser}) ✓` : 'Hợp lệ ✓';
          sessionStatusDesc.textContent = 'Phiên đăng nhập còn hạn, sẵn sàng đồng bộ tồn kho!';

          if (tokenInput && !tokenInput.value.trim() && data.token) {
            tokenInput.value = data.token;
          }

          if (!silent) {
            showToast('Phiên đăng nhập MShopKeeper hợp lệ!');
          }
          return { valid: true, token: data.token };
        } else if (data.expired) {
          sessionCheckerCard.classList.remove('valid');
          sessionCheckerCard.classList.add('expired');
          sessionIndicator.className = 'session-pulse-indicator expired';
          sessionStatusBadge.className = 'session-status-badge expired';
          sessionStatusBadge.textContent = 'Hết hạn ⚠';
          sessionStatusDesc.textContent = 'Phiên đã hết hạn. Hãy mở tab cobedenim.mshopkeeper.vn trên Chrome để làm mới phiên.';
          if (!silent) {
            showToast('Phiên đăng nhập MShopKeeper đã hết hạn!', 'error');
          }
          return { valid: false, expired: true };
        } else {
          sessionCheckerCard.classList.remove('valid');
          sessionCheckerCard.classList.add('expired');
          sessionIndicator.className = 'session-pulse-indicator expired';
          sessionStatusBadge.className = 'session-status-badge expired';
          sessionStatusBadge.textContent = 'Chưa sẵn sàng';
          sessionStatusDesc.textContent = data.message || 'Chưa tìm thấy phiên đăng nhập. Vui lòng dán token hoặc mở Chrome.';
          if (!silent) {
            showToast(data.message || 'Chưa xác thực được phiên đăng nhập', 'error');
          }
          return { valid: false, message: data.message };
        }
      } catch (err) {
        sessionCheckerCard.classList.remove('valid');
        sessionCheckerCard.classList.add('expired');
        sessionIndicator.className = 'session-pulse-indicator expired';
        sessionStatusBadge.className = 'session-status-badge expired';
        sessionStatusBadge.textContent = 'Lỗi kết nối';
        sessionStatusDesc.textContent = 'Không thể kết nối đến máy chủ để kiểm tra phiên.';
        if (!silent) {
          showToast('Lỗi kiểm tra phiên: ' + err.message, 'error');
        }
        return { valid: false, error: err.message };
      } finally {
        if (btnCheckSession) {
          btnCheckSession.disabled = false;
          btnCheckSession.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="btn-svg-mini"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg><span>Kiểm Tra Phiên</span>';
        }
      }
    }

    // Button: Kiểm tra phiên đăng nhập
    if (btnCheckSession) {
      btnCheckSession.addEventListener('click', () => {
        checkSessionStatus({ silent: false });
      });
    }

    // Auto-detect token from Chrome/Edge LevelDB with Session Verification
    const btnAutoDetectToken = document.getElementById('btnAutoDetectToken');
    if (btnAutoDetectToken) {
      btnAutoDetectToken.addEventListener('click', async () => {
        btnAutoDetectToken.disabled = true;
        btnAutoDetectToken.textContent = '⏳ Đang quét Chrome & kiểm tra phiên...';
        try {
          const check = await checkSessionStatus({ silent: false });
          if (check && check.valid) {
            showSyncFeedback(`Phiên đăng nhập hợp lệ! Đang bắt đầu đồng bộ tồn kho...`, 'success');
            setTimeout(() => {
              btnTriggerTokenSync.click();
            }, 500);
          } else {
            showSyncFeedback(check && check.message ? check.message : 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn. Hãy mở tab cobedenim.mshopkeeper.vn trên Chrome rồi thử lại.', 'error');
          }
        } catch (e) {
          showSyncFeedback('Lỗi kết nối máy chủ: ' + e.message, 'error');
        } finally {
          btnAutoDetectToken.disabled = false;
          btnAutoDetectToken.textContent = '🔍 Tự Động Đọc Token Từ Chrome & Đồng Bộ';
        }
      });
    }

    // Excel Drag & Drop Zone
    const excelDropZone = document.getElementById('excelDropZone');
    const excelFileInput = document.getElementById('excelFileInput');

    if (excelDropZone && excelFileInput) {
      excelDropZone.addEventListener('click', () => excelFileInput.click());

      excelDropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        excelDropZone.classList.add('dragover');
      });

      excelDropZone.addEventListener('dragleave', () => {
        excelDropZone.classList.remove('dragover');
      });

      excelDropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        excelDropZone.classList.remove('dragover');
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
          handleExcelFile(e.dataTransfer.files[0]);
        }
      });

      excelFileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) {
          handleExcelFile(e.target.files[0]);
        }
      });
    }

    function handleExcelFile(file) {
      if (!file.name.match(/\.(xlsx|xls)$/i)) {
        showSyncFeedback('Vui lòng chọn file định dạng Excel (.xlsx hoặc .xls)', 'error');
        return;
      }
      showSyncFeedback(`Đang đọc file ${file.name}...`, 'success');
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const res = await fetch('/api/sync/upload-excel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileData: e.target.result })
          });
          const data = await res.json();
          if (data.success) {
            showSyncFeedback(data.message, 'success');
            await loadStats();
            await fetchProducts();
            showToast('Đã nạp file Excel tồn kho thành công!');
          } else {
            showSyncFeedback(data.message, 'error');
          }
        } catch (err) {
          showSyncFeedback(`Lỗi tải file: ${err.message}`, 'error');
        }
      };
      reader.readAsDataURL(file);
    }

    // Quick Paste Token Button
    const btnQuickPasteToken = document.getElementById('btnQuickPasteToken');
    if (btnQuickPasteToken) {
      btnQuickPasteToken.addEventListener('click', async () => {
        try {
          const clipText = await navigator.clipboard.readText();
          if (clipText && clipText.trim()) {
            tokenInput.value = clipText.trim();
            showToast('Đã dán Token từ Clipboard!');
            checkSessionStatus({ silent: false });
          } else {
            showToast('Clipboard trống', 'error');
          }
        } catch (e) {
          tokenInput.focus();
          showToast('Hãy bấm Ctrl+V để dán', 'error');
        }
      });
    }

    // Trigger Token Sync (Đồng bộ trực tiếp qua Web hoặc máy trạm)
    btnTriggerTokenSync.addEventListener('click', async () => {
      let token = tokenInput.value.trim();
      if (!token) {
        showSyncFeedback('Vui lòng dán Access Token MShopKeeper vào ô trên', 'error');
        return;
      }
      token = token.replace(/^Bearer\s+/i, '').trim();

      btnTriggerTokenSync.disabled = true;
      btnTriggerTokenSync.innerHTML = '<span class="btn-spinner"></span> Đang đồng bộ kho... <span class="btn-percent-pill" id="btnSyncPercentBadge">10%</span>';
      hideSyncFeedback();

      // Show Live Progress Card Immediately
      updateSyncProgressUI({
        title: '⚡ Đang kết nối MShopKeeper...',
        percent: 10,
        detail: 'Đang gửi yêu cầu đồng bộ danh mục & tồn kho...',
        elapsed: 0
      });
      syncProgressCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

      // Start live polling
      startProgressPolling('sync');

      // Smooth simulated interpolator in case running on serverless without local progress endpoint
      let simulatedPercent = 10;
      const simTimer = setInterval(() => {
        if (simulatedPercent < 88) {
          simulatedPercent += Math.floor(Math.random() * 8) + 3;
          updateSyncProgressUI({ percent: simulatedPercent });
        }
      }, 700);

      try {
        const res = await fetch('/api/sync/mshopkeeper', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        });
        clearInterval(simTimer);
        const data = await res.json();
        if (data.success) {
          updateSyncProgressUI({
            title: '✓ Hoàn tất đồng bộ kho!',
            percent: 100,
            detail: data.message || 'Đã nạp đầy đủ sản phẩm và tồn kho.'
          });
          showSyncFeedback(data.message, 'success');
          await loadStats();
          await fetchProducts();
          showToast('Đã đồng bộ kho MShopKeeper thành công!');
        } else {
          updateSyncProgressUI({
            title: '⚠ Lỗi đồng bộ',
            detail: data.message || 'Không thể đồng bộ từ MShopKeeper'
          });
          showSyncFeedback(data.message || 'Lỗi đồng bộ từ MShopKeeper', 'error');
        }
      } catch (err) {
        clearInterval(simTimer);
        updateSyncProgressUI({
          title: '⚠ Lỗi kết nối',
          detail: err.message
        });
        showSyncFeedback('Lỗi kết nối: ' + err.message, 'error');
      } finally {
        clearInterval(simTimer);
        setTimeout(() => {
          btnTriggerTokenSync.disabled = false;
          btnTriggerTokenSync.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="btn-action-icon"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg><span>Bắt Đầu Đồng Bộ Tồn Kho Ngay</span>';
        }, 1500);
      }
    });

    // Tab 4: Cloudinary Image Fill Event Listeners
    if (btnStartFillImages) {
      btnStartFillImages.addEventListener('click', async () => {
        btnStartFillImages.disabled = true;
        btnStartFillImages.textContent = '⏳ Đang bắt đầu quét ảnh...';
        hideSyncFeedback();
        try {
          const res = await fetch('/api/sync/fill-images', { method: 'POST' });
          const data = await res.json();
          if (data.success) {
            showSyncFeedback('Đã bắt đầu tiến trình quét và nạp ảnh nền!', 'success');
            startProgressPolling('images');
          } else {
            showSyncFeedback(data.message, 'error');
            btnStartFillImages.disabled = false;
            btnStartFillImages.textContent = '🚀 Bắt Đầu Quét & Nạp Ảnh Lên Cloudinary';
          }
        } catch (err) {
          showSyncFeedback('Lỗi kết nối máy chủ: ' + err.message, 'error');
          btnStartFillImages.disabled = false;
          btnStartFillImages.textContent = '🚀 Bắt Đầu Quét & Nạp Ảnh Lên Cloudinary';
        }
      });
    }

    if (btnCancelFillImages) {
      btnCancelFillImages.addEventListener('click', async () => {
        btnCancelFillImages.disabled = true;
        try {
          const res = await fetch('/api/sync/fill-images/cancel', { method: 'POST' });
          const data = await res.json();
          showSyncFeedback(data.message || 'Đã gửi yêu cầu dừng quét ảnh.', 'info');
        } catch (e) {}
        setTimeout(() => { btnCancelFillImages.disabled = false; }, 1500);
      });
    }

    // Import JSON
    btnImportJson.addEventListener('click', async () => {
      const rawJson = jsonImportInput.value.trim();
      if (!rawJson) {
        showSyncFeedback('Vui lòng nhập dữ liệu JSON', 'error');
        return;
      }
      try {
        const parsed = JSON.parse(rawJson);
        const res = await fetch('/api/sync/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ products: parsed })
        });
        const data = await res.json();
        if (data.success) {
          showSyncFeedback(data.message, 'success');
          await loadStats();
          await fetchProducts();
          showToast('Đã cập nhật kho mới thành công!');
        } else {
          showSyncFeedback(data.message, 'error');
        }
      } catch (err) {
        showSyncFeedback(`Lỗi định dạng JSON: ${err.message}`, 'error');
      }
    });

    // Tự động cập nhật tồn kho mới nhất khi người dùng quay lại tab tra cứu
    // 1. Tự động nhận tín hiệu cập nhật tức thì từ Chrome Extension khi có giao dịch POS / Nhập kho
    if (window.chrome && chrome.runtime && chrome.runtime.onMessage) {
      try {
        chrome.runtime.onMessage.addListener((msg) => {
          if (msg && msg.action === 'AUTO_REFRESH_PRODUCTS') {
            console.log('[APP] ⚡ Nhận tín hiệu cập nhật tồn kho tức thì từ Extension!');
            fetchProducts();
            loadStats();
            showToast('⚡ Đã tự động cập nhật tồn kho mới!');
          }
        });
      } catch (e) {}
    }

    // 2. Tự động theo dõi biến động kho ngầm (Lightweight Status Polling mỗi 3.5s)
    let currentKnownSyncTime = null;
    let isPollingSync = false;
    async function checkLiveSyncStatus() {
      if (isPollingSync || document.visibilityState !== 'visible') return;
      isPollingSync = true;
      try {
        const res = await fetch('/api/sync/status', { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          if (data && data.lastSyncTime) {
            if (currentKnownSyncTime && data.lastSyncTime !== currentKnownSyncTime) {
              console.log('[APP] ⚡ Phát hiện biến động kho mới từ máy chủ:', data.lastSyncTime);
              currentKnownSyncTime = data.lastSyncTime;
              fetchProducts();
              loadStats();
              showToast('⚡ Tồn kho đã tự động cập nhật số lượng mới!');
            } else {
              currentKnownSyncTime = data.lastSyncTime;
            }
          }
        }
      } catch (e) {
      } finally {
        isPollingSync = false;
      }
    }
    setInterval(checkLiveSyncStatus, 3500);

    // 3. Tự động cập nhật ngay khi người dùng chuyển lại tab tra cứu
    let lastVisibilityCheck = Date.now();
    function refreshOnTabActive() {
      if (Date.now() - lastVisibilityCheck > 1000) {
        lastVisibilityCheck = Date.now();
        fetchProducts();
        loadStats();
        checkLiveSyncStatus();
      }
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        refreshOnTabActive();
      }
    });

    window.addEventListener('focus', () => {
      refreshOnTabActive();
    });
  }

  // Apply Theme (Light / Dark)
  function applyTheme(theme) {
    if (theme !== 'light') theme = 'denim';
    currentTheme = theme;
    localStorage.setItem('cobe_theme', theme);
    document.documentElement.setAttribute('data-theme', theme);

    if (themeIconSun && themeIconMoon) {
      if (theme === 'light') {
        themeIconSun.style.display = 'none';
        themeIconMoon.style.display = 'block';
        btnThemeToggle.setAttribute('title', 'Chuyển sang giao diện Tối');
      } else {
        themeIconSun.style.display = 'block';
        themeIconMoon.style.display = 'none';
        btnThemeToggle.setAttribute('title', 'Chuyển sang giao diện Sáng');
      }
    }
  }

  // Render Skeletons for Instant Perceived Performance
  function renderSkeletons() {
    productsContainer.innerHTML = Array(6).fill(0).map(() => `
      <div class="skeleton-card">
        <div class="sk-top">
          <div class="sk-thumb skeleton-shimmer"></div>
          <div class="sk-meta">
            <div class="sk-line-sm skeleton-shimmer"></div>
            <div class="sk-line-lg skeleton-shimmer"></div>
            <div class="sk-line-md skeleton-shimmer"></div>
          </div>
        </div>
        <div class="sk-body skeleton-shimmer"></div>
        <div class="sk-footer skeleton-shimmer"></div>
      </div>
    `).join('');
  }

  // Fetch Products API
  async function fetchProducts() {
    try {
      const params = new URLSearchParams({
        q: currentSearch,
        brand: activeBrand,
        status: activeStatus,
        category: activeCategory,
        size: activeSize,
        sort: activeSort,
        page: currentPage,
        limit: pageSize
      });

      const res = await fetch(`/api/products?${params.toString()}`);
      const data = await res.json();

      if (data.success) {
        allProducts = data.products || [];
        currentBrands = data.brands || [];
        currentCategories = data.categories || [];
        currentPage = data.page || 1;
        totalPages = data.totalPages || 1;
        totalProductsCount = data.total || 0;

        updateBrandTabs(currentBrands);
        updateCategoryChips(currentCategories);
        renderProducts(allProducts);
        updateResultsCount(data.total);
        renderPagination();
      } else {
        productsContainer.innerHTML = `<div class="empty-view"><p>Lỗi: ${data.message}</p></div>`;
        if (paginationContainer) paginationContainer.style.display = 'none';
      }
    } catch (err) {
      console.error(err);
      productsContainer.innerHTML = `
        <div class="empty-view">
          <svg class="empty-view-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <h3>Không thể kết nối máy chủ</h3>
          <p>Vui lòng kiểm tra lại đường truyền hoặc thử lại sau.</p>
        </div>
      `;
      if (paginationContainer) paginationContainer.style.display = 'none';
    }
  }

  // Load Stats API
  async function loadStats() {
    try {
      const res = await fetch('/api/stats');
      const data = await res.json();
      if (data.success) {
        statTotalModels.textContent = data.totalProducts;
        statTotalStock.textContent = data.totalStockQuantity;

        const syncDate = new Date(data.lastSyncTime);
        const timeFormatted = syncDate.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
        const dateFormatted = syncDate.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
        statusSyncText.textContent = `Kho trực tuyến • Cập nhật lúc ${timeFormatted} ngày ${dateFormatted}`;

        modalLastSyncTime.textContent = `${timeFormatted} — ${dateFormatted}`;
        modalTotalItems.textContent = `${data.totalProducts} mẫu (${data.totalStockQuantity} chiếc)`;
      }
    } catch (err) {
      statusSyncText.textContent = 'Kho trực tuyến Cobe Denim';
    }
  }

  // Brand Tabs Update
  function updateBrandTabs(brands) {
    if (!brandTabs) return;
    const totalCount = brands.reduce((acc, b) => acc + (b.count || 0), 0);

    let html = `
      <button class="brand-btn ${activeBrand === 'all' ? 'active' : ''}" data-brand="all">
        Tất cả <span class="badge-count">${totalCount}</span>
      </button>
    `;

    brands.forEach(b => {
      const isActive = activeBrand.toLowerCase() === b.name.toLowerCase() ? 'active' : '';
      html += `
        <button class="brand-btn ${isActive}" data-brand="${b.name}">
          ${b.name} <span class="badge-count">${b.count}</span>
        </button>
      `;
    });

    brandTabs.innerHTML = html;
  }

  // Category Pills Update
  function updateCategoryChips(categories) {
    const totalCatCount = categories.reduce((acc, c) => acc + (c.count || 0), 0);

    let html = `
      <button class="pill-btn ${activeCategory === 'all' ? 'active' : ''}" data-category="all">
        Tất cả <span class="badge-count">${totalCatCount}</span>
      </button>
    `;

    categories.forEach(cat => {
      const catName = typeof cat === 'object' ? cat.name : cat;
      const catCount = typeof cat === 'object' && cat.count !== undefined ? cat.count : null;
      const isActive = activeCategory.toLowerCase() === catName.toLowerCase() ? 'active' : '';
      html += `
        <button class="pill-btn ${isActive}" data-category="${catName}">
          ${catName} ${catCount !== null ? `<span class="badge-count">${catCount}</span>` : ''}
        </button>
      `;
    });

    categoryChips.innerHTML = html;
  }

  function updateResultsCount(count) {
    let text = `Hiển thị ${count} mẫu`;
    if (activeSize !== 'all') {
      text += ` (Size ${activeSize})`;
    }
    if (currentSearch) {
      text += ` khớp với "${currentSearch}"`;
    }
    if (totalPages > 1 && pageSize !== 'all') {
      text += ` • Trang ${currentPage}/${totalPages}`;
    }
    resultsCount.textContent = text;
  }

  // Render Dynamic Pagination Bar
  function renderPagination() {
    if (!paginationContainer || !paginationNav) return;

    if (totalProductsCount <= 0) {
      paginationContainer.style.display = 'none';
      return;
    }

    paginationContainer.style.display = 'flex';

    // Update range info
    if (pageTotalCount) pageTotalCount.textContent = totalProductsCount;
    if (pageRangeStart && pageRangeEnd) {
      if (pageSize === 'all') {
        pageRangeStart.textContent = '1';
        pageRangeEnd.textContent = totalProductsCount;
      } else {
        const start = (currentPage - 1) * pageSize + 1;
        const end = Math.min(currentPage * pageSize, totalProductsCount);
        pageRangeStart.textContent = start;
        pageRangeEnd.textContent = end;
      }
    }

    if (pageSize === 'all' || totalPages <= 1) {
      paginationNav.innerHTML = '';
      return;
    }

    // Build page buttons list
    let html = '';

    // Previous button
    const prevDisabled = currentPage <= 1 ? 'disabled' : '';
    html += `
      <button class="page-btn" data-page="${currentPage - 1}" ${prevDisabled} title="Trang trước" aria-label="Trang trước">
        ◀ Trước
      </button>
    `;

    // Smart page numbers
    const pages = [];
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      if (currentPage > 4) {
        pages.push('...');
      }

      const start = Math.max(2, currentPage - 1);
      const end = Math.min(totalPages - 1, currentPage + 1);

      for (let i = start; i <= end; i++) {
        if (!pages.includes(i)) pages.push(i);
      }

      if (currentPage < totalPages - 3) {
        pages.push('...');
      }
      if (!pages.includes(totalPages)) {
        pages.push(totalPages);
      }
    }

    pages.forEach(p => {
      if (p === '...') {
        html += `<span class="page-ellipsis">...</span>`;
      } else {
        const activeClass = p === currentPage ? 'active' : '';
        html += `
          <button class="page-btn ${activeClass}" data-page="${p}" aria-label="Trang ${p}">
            ${p}
          </button>
        `;
      }
    });

    // Next button
    const nextDisabled = currentPage >= totalPages ? 'disabled' : '';
    html += `
      <button class="page-btn" data-page="${currentPage + 1}" ${nextDisabled} title="Trang sau" aria-label="Trang sau">
        Sau ▶
      </button>
    `;

    paginationNav.innerHTML = html;
  }

  // Render Product Cards
  function renderProducts(products) {
    if (!products || products.length === 0) {
      productsContainer.innerHTML = `
        <div class="empty-view">
          <svg class="empty-view-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
          </svg>
          <h3>Không tìm thấy mẫu phù hợp</h3>
          <p>Thử tìm bằng mã ngắn hơn (QJ, AK, CV) hoặc chọn lại danh mục "Tất cả".</p>
        </div>
      `;
      return;
    }

    productsContainer.innerHTML = products.map(product => {
      // Group variants by color
      const colorGroups = {};
      (product.variants || []).forEach(v => {
        const color = v.color || 'Tiêu Chuẩn';
        if (!colorGroups[color]) colorGroups[color] = [];
        colorGroups[color].push(v);
      });

      // Stock status label (Only 2 states: in_stock vs out_of_stock)
      const isAvailable = Number(product.totalStock) > 0;
      const stockHeadlineClass = isAvailable ? 'in_stock' : 'out_of_stock';
      const stockHeadlineText = isAvailable 
        ? `<svg class="status-svg in-stock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="m8.5 12 2.5 2.5 5-5"></path></svg> <span>Còn hàng (${product.totalStock} chiếc)</span>`
        : `<svg class="status-svg out-stock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><line x1="5.64" y1="5.64" x2="18.36" y2="18.36"></line></svg> <span>Hết hàng</span>`;

      const retailPriceFmt = new Intl.NumberFormat('vi-VN').format(product.retailPrice) + 'đ';

      // Colors & Sizes HTML (Hide sizes that are out of stock)
      const matrixHtml = Object.keys(colorGroups).map(color => {
        const sizes = colorGroups[color];
        const inStockSizes = sizes.filter(v => Number(v.stock) > 0);

        let sizePillsHtml = '';
        if (inStockSizes.length > 0) {
          sizePillsHtml = inStockSizes.map(v => {
            const isTarget = activeSize !== 'all' && String(v.size || '').toUpperCase().trim() === activeSize.toUpperCase().trim();
            const targetClass = isTarget ? 'active-target-size' : '';
            const fullVariantSku = v.skuVariant || `${product.sku}-${v.size}`;
            return `
              <div class="size-pill in-stock ${targetClass}" 
                   onclick="copySizeSku(this, '${fullVariantSku}')"
                   title="Bấm để copy mã: ${fullVariantSku} (Còn ${v.stock} chiếc)">
                <span>${v.size}</span>
                <span class="qty-number">${v.stock}</span>
              </div>
            `;
          }).join('');
        } else {
          sizePillsHtml = `<span class="out-stock-label"><svg class="status-svg out-stock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><line x1="5.64" y1="5.64" x2="18.36" y2="18.36"></line></svg> Hết hàng</span>`;
        }

        return `
          <div class="color-row-card">
            <div class="color-title-row">
              <span class="color-text">
                <span class="color-indicator-dot"></span>
                ${color}
              </span>
            </div>
            <div class="sizes-cluster">
              ${sizePillsHtml}
            </div>
          </div>
        `;
      }).join('');

      return `
        <article class="product-card" data-sku="${product.sku}">
          <!-- Card Upper: Media & Info -->
          <div class="card-hero">
            <div class="product-photo-link is-loading" onclick="openLightboxBySku('${product.sku}')">
              <img 
                src="${product.imageUrl}" 
                alt="${product.name}" 
                loading="lazy"
                onload="this.classList.add('loaded'); this.parentElement.classList.remove('is-loading');"
                onerror="this.classList.add('loaded'); this.parentElement.classList.remove('is-loading'); if(!this.dataset.tried){this.dataset.tried='1';if(this.src.includes('.png'))this.src=this.src.replace('.png','.jpg');else if(this.src.includes('.jpg'))this.src=this.src.replace('.jpg','.png');}else{this.src='https://images.unsplash.com/photo-1541099649105-f69ad21f3246?auto=format&fit=crop&w=400&q=80';}"
              >
              <div class="zoom-overlay-badge">
                <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5">
                  <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="M11 8v6M8 11h6"/>
                </svg>
                Zoom
              </div>
            </div>

            <div class="card-info">
              <div>
                <div class="card-eyebrow">
                  <span class="sku-code-badge" onclick="copySku('${product.sku}')" title="Bấm để copy mã SP">
                    ${product.sku}
                    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2">
                      <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
                      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
                    </svg>
                  </span>
                  <div class="eyebrow-tags">
                    ${product.brand ? `<span class="brand-tag">${product.brand}</span>` : ''}
                    <span class="category-name">${product.category}</span>
                  </div>
                </div>
                <h2 class="product-name-heading" title="${product.name}">${product.name}</h2>
              </div>

              <div>
                <div class="pricing-strip">
                  <span class="retail-amount">${retailPriceFmt}</span>
                </div>
                <div class="stock-headline ${stockHeadlineClass}">
                  ${stockHeadlineText}
                </div>
              </div>
            </div>
          </div>

          <!-- Card Mid: Variant Matrix -->
          <div class="card-variants-board">
            <div class="matrix-header">
              <span>Phân loại & Số lượng</span>
              <span>Theo Size</span>
            </div>
            ${matrixHtml}
          </div>

          <!-- Card Lower: Actions -->
          <div class="card-action-bar">
            <button class="btn-card-tool btn-copy-msg" onclick="copyStockMessage('${product.sku}')">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
              Sao chép báo khách
            </button>
            <button class="btn-card-tool btn-photo-tool" onclick="openLightboxBySku('${product.sku}')">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
                <rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>
                <circle cx="9" cy="9" r="2"/>
                <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>
              </svg>
              Xem & Tải ảnh
            </button>
          </div>
        </article>
      `;
    }).join('');
  }

  // Copy SKU
  window.copySku = function(sku) {
    copyToClipboard(sku, `Đã copy mã: ${sku}`);
  };

  // Copy Full Variant SKU (e.g. 3QNC01-MON04-L) when clicking Size Pill with visual "Copied" effect
  window.copySizeSku = function(pillEl, fullSku) {
    if (!pillEl || pillEl.dataset.isCopying === '1') return;

    // 1. Copy exact full SKU including size
    copyToClipboard(fullSku, `Đã copy: ${fullSku}`);

    // 2. Visual feedback: change to green and show "Copied"
    pillEl.dataset.isCopying = '1';
    const originalContent = pillEl.innerHTML;
    pillEl.classList.add('is-copied');
    pillEl.innerHTML = `<span class="copied-label">Copied ✓</span>`;

    // 3. Restore back after 1.5s
    setTimeout(() => {
      pillEl.classList.remove('is-copied');
      pillEl.innerHTML = originalContent;
      delete pillEl.dataset.isCopying;
    }, 1500);
  };

  // Copy Stock Summary for Customer Messaging
  window.copyStockMessage = function(sku) {
    const product = allProducts.find(p => p.sku === sku);
    if (!product) return;

    const lines = [];
    lines.push(`👖 Cobe Denim — ${product.name}`);
    lines.push(`🏷️ Mã SP: ${product.sku}`);
    lines.push(`💵 Giá bán: ${new Intl.NumberFormat('vi-VN').format(product.retailPrice)}đ`);
    lines.push(`📦 Báo tồn chi tiết:`);

    const colorGroups = {};
    (product.variants || []).forEach(v => {
      const color = v.color || 'Tiêu chuẩn';
      if (!colorGroups[color]) colorGroups[color] = [];
      colorGroups[color].push(v);
    });

    Object.keys(colorGroups).forEach(color => {
      const inStockSizes = colorGroups[color].filter(v => Number(v.stock) > 0);
      if (inStockSizes.length > 0) {
        const sizeStrs = inStockSizes.map(v => `${v.size}: còn ${v.stock}`);
        lines.push(`• ${color}: [${sizeStrs.join(', ')}]`);
      } else {
        lines.push(`• ${color}: [Hết hàng]`);
      }
    });

    const fullMessage = lines.join('\n');
    copyToClipboard(fullMessage, `Đã copy báo tồn mã ${sku} để gửi khách!`);
  };

  // Open Lightbox by SKU
  window.openLightboxBySku = function(sku) {
    const product = allProducts.find(p => p.sku === sku);
    if (!product) return;
    currentLightboxProduct = product;

    lightboxImg.src = product.imageUrl;
    lightboxTitle.textContent = product.name;
    lightboxSku.textContent = `Mã: ${product.sku}`;
    lightboxDesc.textContent = product.description || 'Sản phẩm denim chính hãng Cobe Denim.';
    btnDownloadImg.href = product.imageUrl;
    btnDownloadImg.setAttribute('download', `${product.sku}-cobe-denim.jpg`);

    imageLightbox.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  };

  function closeLightbox() {
    imageLightbox.style.display = 'none';
    document.body.style.overflow = '';
  }

  // Admin Modal Logic
  function openSyncModal() {
    syncModal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    startProgressPolling('auto');
    checkSessionStatus({ silent: true });
  }

  function closeSyncModal() {
    syncModal.style.display = 'none';
    document.body.style.overflow = '';
  }

  // Helper: Live Progress & UI Step Synchronizer
  function updateSyncProgressUI({ title, percent, detail, elapsed, step }) {
    if (!syncProgressCard) return;
    syncProgressCard.style.display = 'block';
    if (title && syncProgressTitle) syncProgressTitle.textContent = title;
    if (percent !== undefined) {
      const clamped = Math.min(100, Math.max(0, Math.round(percent)));
      if (syncProgressPercent) syncProgressPercent.textContent = `${clamped}%`;
      if (syncProgressBar) syncProgressBar.style.width = `${clamped}%`;
      const btnPercent = document.getElementById('btnSyncPercentBadge');
      if (btnPercent) {
        btnPercent.textContent = `${clamped}%`;
        btnPercent.style.display = 'inline-block';
      }
    }
    if (detail && syncProgressDetail) syncProgressDetail.textContent = detail;
    if (elapsed !== undefined && syncProgressElapsed) syncProgressElapsed.textContent = `${elapsed}s`;

    // Dynamic Step Pills (1 to 4)
    if (step) {
      for (let i = 1; i <= 4; i++) {
        const pill = document.getElementById(`syncStepPill${i}`);
        if (pill) {
          pill.classList.remove('active', 'done');
          if (i < step) pill.classList.add('done');
          else if (i === step) pill.classList.add('active');
        }
      }
    }
  }

  // Real-time Progress Polling Function
  function startProgressPolling(mode = 'auto') {
    if (progressPollingTimer) clearInterval(progressPollingTimer);

    async function poll() {
      try {
        const res = await fetch('/api/sync/progress');
        const data = await res.json();
        if (!data.success) return;

        const sync = data.sync;
        const images = data.images;
        const isSyncRunning = sync && sync.running;
        const isImagesRunning = images && images.running;

        if (isImagesRunning) {
          syncProgressCard.style.display = 'block';
          syncProgressTitle.textContent = '🖼️ Đang quét & nạp ảnh thật lên Cloudinary...';
          syncProgressPercent.textContent = `${images.percent}%`;
          syncProgressBar.style.width = `${images.percent}%`;
          syncProgressDetail.textContent = images.currentSku 
            ? `Mã: ${images.currentSku} — ${images.message}` 
            : images.message;
          syncProgressElapsed.textContent = `${images.elapsedSec || 0}s`;

          syncImageExtraRow.style.display = 'grid';
          statImgProcessed.textContent = `${images.processed} / ${images.total}`;
          statImgFilled.textContent = images.filled;
          statImgSkipped.textContent = images.skipped;

          if (btnStartFillImages) {
            btnStartFillImages.disabled = true;
            btnStartFillImages.textContent = '⏳ Đang quét & nạp ảnh...';
          }
        } else if (isSyncRunning) {
          const elapsed = sync.startedAt 
            ? Math.max(0, Math.round((Date.now() - new Date(sync.startedAt).getTime()) / 1000))
            : 0;

          updateSyncProgressUI({
            title: `⚡ [Bước ${sync.step || 1}/${sync.totalSteps || 4}] ${sync.stepTitle || 'Đang đồng bộ...'}`,
            percent: sync.percent || 10,
            detail: sync.detail || 'Đang xử lý dữ liệu từ MShopKeeper...',
            elapsed,
            step: sync.step || 1
          });
          syncImageExtraRow.style.display = 'none';
        } else {
          // If neither is running
          if (btnStartFillImages) {
            btnStartFillImages.disabled = false;
            btnStartFillImages.textContent = '🚀 Bắt Đầu Quét & Nạp Ảnh Lên Cloudinary';
          }

          if (images && images.finishedAt && images.total > 0 && mode === 'images') {
            syncProgressCard.style.display = 'block';
            syncProgressTitle.textContent = '✓ Hoàn tất nạp ảnh thật!';
            syncProgressPercent.textContent = '100%';
            syncProgressBar.style.width = '100%';
            syncProgressDetail.textContent = images.message;
            syncImageExtraRow.style.display = 'grid';
            statImgProcessed.textContent = `${images.processed} / ${images.total}`;
            statImgFilled.textContent = images.filled;
            statImgSkipped.textContent = images.skipped;
          } else if (sync && sync.finishedAt && sync.percent === 100 && mode === 'sync') {
            updateSyncProgressUI({
              title: '✓ Hoàn tất đồng bộ kho!',
              percent: 100,
              detail: sync.detail || 'Dữ liệu đã được nạp hoàn chỉnh.',
              step: 4
            });
          } else if (mode === 'auto') {
            // In auto mode, if neither was running, hide progress card
            syncProgressCard.style.display = 'none';
          }

          if (progressPollingTimer) {
            clearInterval(progressPollingTimer);
            progressPollingTimer = null;
          }
        }
      } catch (err) {
        console.warn('Lỗi polling progress:', err);
      }
    }

    poll();
    progressPollingTimer = setInterval(poll, 450);
  }

  function showSyncFeedback(msg, type) {
    syncFeedback.textContent = msg;
    syncFeedback.className = `feedback-banner ${type}`;
    syncFeedback.style.display = 'block';
  }

  function hideSyncFeedback() {
    syncFeedback.style.display = 'none';
  }

  // Clipboard Helper
  function copyToClipboard(text, successMessage) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        showToast(successMessage || 'Đã sao chép!');
        triggerHaptic();
      }).catch(() => {
        fallbackCopy(text, successMessage);
      });
    } else {
      fallbackCopy(text, successMessage);
    }
  }

  function fallbackCopy(text, successMessage) {
    const el = document.createElement('textarea');
    el.value = text;
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    try {
      document.execCommand('copy');
      showToast(successMessage || 'Đã sao chép!');
      triggerHaptic();
    } catch (e) {
      showToast('Không thể sao chép');
    }
    document.body.removeChild(el);
  }

  function showToast(message) {
    toastText.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toastEl.timer);
    toastEl.timer = setTimeout(() => {
      toastEl.classList.remove('show');
    }, 2200);
  }

  function triggerHaptic() {
    if (navigator.vibrate) {
      navigator.vibrate(30);
    }
  }
});

/**
 * COBE DENIM INVENTORY LOOKUP — APP CLIENT LOGIC
 * Refined under taste-skill directives: high visual density, tactile response, skeleton loaders
 */

document.addEventListener('DOMContentLoaded', () => {
  // State
  let allProducts = [];
  let currentBrands = [];
  let currentCategories = [];
  let showCtvPrice = localStorage.getItem('cobe_show_ctv_price') !== 'false';
  let currentTheme = localStorage.getItem('cobe_theme') || 'denim';
  let activeStatus = 'all';
  let activeBrand = 'all';
  let activeCategory = 'all';
  let activeSort = 'default';
  let currentSearch = '';
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
  const btnTogglePrice = document.getElementById('btnTogglePrice');
  const btnThemeToggle = document.getElementById('btnThemeToggle');
  const themeMenu = document.getElementById('themeMenu');
  const statusSyncText = document.getElementById('statusSyncText');
  const statTotalModels = document.getElementById('statTotalModels');
  const statTotalStock = document.getElementById('statTotalStock');
  const toastEl = document.getElementById('toast');
  const toastText = document.getElementById('toastText');

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
  const jsonImportInput = document.getElementById('jsonImportInput');
  const syncFeedback = document.getElementById('syncFeedback');

  // Initialize
  init();

  async function init() {
    applyTheme(currentTheme);
    updatePriceToggleUI();
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
      btnClearSearch.style.display = currentSearch ? 'flex' : 'none';
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        fetchProducts();
      }, 180);
    });

    btnClearSearch.addEventListener('click', () => {
      searchInput.value = '';
      currentSearch = '';
      btnClearSearch.style.display = 'none';
      searchInput.focus();
      fetchProducts();
    });

    // Quick suggestion chip clicks
    document.querySelectorAll('.chip-tag').forEach(btn => {
      btn.addEventListener('click', () => {
        const query = btn.dataset.query;
        searchInput.value = query;
        currentSearch = query;
        btnClearSearch.style.display = 'flex';
        fetchProducts();
      });
    });

    // Status segment tabs
    statusTabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.segment-btn');
      if (!btn) return;
      document.querySelectorAll('.segment-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeStatus = btn.dataset.status;
      fetchProducts();
    });

    // Sort dropdown
    sortSelect.addEventListener('change', (e) => {
      activeSort = e.target.value;
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
      fetchProducts();
    });

    // Toggle CTV Price Visibility
    btnTogglePrice.addEventListener('click', () => {
      showCtvPrice = !showCtvPrice;
      localStorage.setItem('cobe_show_ctv_price', showCtvPrice);
      updatePriceToggleUI();
      renderProducts(allProducts);
      showToast(showCtvPrice ? 'Đã hiển thị giá CTV' : 'Đã ẩn giá CTV (Bảo mật trước mặt khách)');
    });

    // Theme Switcher Dropdown
    btnThemeToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = themeMenu.style.display === 'flex';
      themeMenu.style.display = isOpen ? 'none' : 'flex';
    });

    document.querySelectorAll('.theme-opt').forEach(opt => {
      opt.addEventListener('click', () => {
        const theme = opt.dataset.theme;
        applyTheme(theme);
        themeMenu.style.display = 'none';
        const themeNames = {
          denim: 'Denim Indigo (Gốc)',
          light: 'Sáng Thanh Lịch',
          midnight: 'Đen Midnight OLED',
          vintage: 'Nâu Da Bò Retro',
          rose: 'Hồng Y2K Denim'
        };
        showToast(`Đã đổi giao diện sang ${themeNames[theme] || theme}`);
      });
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.theme-dropdown-wrap')) {
        themeMenu.style.display = 'none';
      }
    });

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

    // Sync modal events with Admin PIN protection
    btnOpenSync.addEventListener('click', async () => {
      const urlParams = new URLSearchParams(window.location.search);
      const isParamAdmin = urlParams.get('admin') === '1' || urlParams.get('admin') === 'cobe';
      const isSessionAuth = sessionStorage.getItem('cobe_admin_verified') === 'true';

      if (isParamAdmin || isSessionAuth) {
        openSyncModal();
        return;
      }

      const enteredPin = prompt('🔒 Nhập mã PIN Quản trị để mở Đồng bộ Kho (Mặc định: 1234):');
      if (enteredPin === null) return;

      try {
        const res = await fetch('/api/sync/verify-pin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin: enteredPin })
        });
        const data = await res.json();
        if (data.success) {
          sessionStorage.setItem('cobe_admin_verified', 'true');
          showToast('Xác thực Quản trị thành công!');
          openSyncModal();
        } else {
          showToast('Mã PIN không đúng. Khu vực này dành cho Quản lý.', 'error');
        }
      } catch (e) {
        showToast('Lỗi kết nối xác thực PIN', 'error');
      }
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
        btnTriggerDemoSync.textContent = '⚡ Cập Nhật Dữ Liệu Kho Ngay';
      }
    });

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

    // Auto-detect token from Chrome/Edge LevelDB
    const btnAutoDetectToken = document.getElementById('btnAutoDetectToken');
    if (btnAutoDetectToken) {
      btnAutoDetectToken.addEventListener('click', async () => {
        btnAutoDetectToken.disabled = true;
        btnAutoDetectToken.textContent = '⏳ Đang quét Chrome/Edge...';
        try {
          const res = await fetch('/api/sync/auto-token');
          const data = await res.json();
          if (data.success && data.token) {
            tokenInput.value = data.token;
            if (data.expired) {
              showSyncFeedback(`Tìm thấy token từ ${data.browser} nhưng đã hết hạn. Hãy mở tab mshopkeeper trên Chrome rồi bấm lại nhé!`, 'error');
            } else {
              showSyncFeedback(`Đã tìm thấy token từ ${data.browser}! Đang tiến hành đồng bộ...`, 'success');
              btnTriggerTokenSync.click();
            }
          } else {
            showSyncFeedback(data.message, 'error');
          }
        } catch (e) {
          showSyncFeedback('Lỗi kết nối máy chủ', 'error');
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

    // Trigger Token Sync
    btnTriggerTokenSync.addEventListener('click', async () => {
      const token = tokenInput.value.trim();
      if (!token) {
        showSyncFeedback('Vui lòng dán Access Token vào ô trên', 'error');
        return;
      }
      btnTriggerTokenSync.disabled = true;
      btnTriggerTokenSync.textContent = '⏳ Đang kết nối MShopKeeper...';
      try {
        const res = await fetch('/api/sync/mshopkeeper', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        });
        const data = await res.json();
        if (data.success) {
          showSyncFeedback(data.message, 'success');
          await loadStats();
          await fetchProducts();
          showToast('Đã kết nối kho MShopKeeper!');
        } else {
          showSyncFeedback(data.message, 'error');
        }
      } catch (err) {
        showSyncFeedback('Lỗi kết nối máy chủ', 'error');
      } finally {
        btnTriggerTokenSync.disabled = false;
        btnTriggerTokenSync.textContent = '🔗 Đồng Bộ Dữ Liệu Trực Tiếp';
      }
    });

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
  }

  // Apply Theme
  function applyTheme(theme) {
    currentTheme = theme;
    localStorage.setItem('cobe_theme', theme);
    document.documentElement.setAttribute('data-theme', theme);
    document.querySelectorAll('.theme-opt').forEach(opt => {
      opt.classList.toggle('active', opt.dataset.theme === theme);
    });
  }

  // Toggle Price UI
  function updatePriceToggleUI() {
    btnTogglePrice.classList.toggle('active', showCtvPrice);
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
        sort: activeSort
      });

      const res = await fetch(`/api/products?${params.toString()}`);
      const data = await res.json();

      if (data.success) {
        allProducts = data.products || [];
        currentBrands = data.brands || [];
        currentCategories = data.categories || [];
        updateBrandTabs(currentBrands);
        updateCategoryChips(currentCategories);
        renderProducts(allProducts);
        updateResultsCount(data.total);
      } else {
        productsContainer.innerHTML = `<div class="empty-view"><p>Lỗi: ${data.message}</p></div>`;
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
    if (currentSearch) {
      resultsCount.textContent = `Tìm thấy ${count} mẫu khớp với "${currentSearch}"`;
    } else {
      resultsCount.textContent = `Hiển thị ${count} mẫu trong kho`;
    }
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

      // Stock status label
      let stockHeadlineText = `Tổng tồn: ${product.totalStock} chiếc`;
      let stockHeadlineClass = product.status;
      if (product.totalStock === 0) {
        stockHeadlineText = `🔴 Hết hàng toàn bộ`;
      } else if (product.status === 'low_stock') {
        stockHeadlineText = `🟡 Sắp hết (${product.totalStock} chiếc)`;
      } else {
        stockHeadlineText = `🟢 Sẵn kho ${product.totalStock} chiếc`;
      }

      const retailPriceFmt = new Intl.NumberFormat('vi-VN').format(product.retailPrice) + 'đ';
      const ctvPriceFmt = new Intl.NumberFormat('vi-VN').format(product.ctvPrice) + 'đ';

      // Colors & Sizes HTML
      const matrixHtml = Object.keys(colorGroups).map(color => {
        const sizes = colorGroups[color];
        const sizePillsHtml = sizes.map(v => {
          let pillClass = 'in-stock';
          let displayQty = v.stock;
          if (v.stock === 0) {
            pillClass = 'out-stock';
            displayQty = '0';
          } else if (v.stock <= 2) {
            pillClass = 'low-stock';
          }
          return `
            <div class="size-pill ${pillClass}" title="Size ${v.size}: Còn ${v.stock} chiếc">
              <span>${v.size}</span>
              <span class="qty-number">${displayQty}</span>
            </div>
          `;
        }).join('');

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
            <div class="product-photo-link" onclick="openLightboxBySku('${product.sku}')">
              <img 
                src="${product.imageUrl}" 
                alt="${product.name}" 
                loading="lazy"
                onerror="this.src='https://images.unsplash.com/photo-1541099649105-f69ad21f3246?auto=format&fit=crop&w=400&q=80'"
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
                  ${product.brand ? `<span class="brand-tag">${product.brand}</span>` : ''}
                  <span class="category-name">${product.category}</span>
                </div>
                <h2 class="product-name-heading" title="${product.name}">${product.name}</h2>
              </div>

              <div>
                <div class="pricing-strip">
                  <span class="retail-amount">${retailPriceFmt}</span>
                  ${showCtvPrice ? `<span class="ctv-amount-badge">CTV: ${ctvPriceFmt}</span>` : ''}
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
      const sizeStrs = colorGroups[color].map(v => {
        if (v.stock === 0) return `${v.size}: Hết`;
        return `${v.size}: còn ${v.stock}`;
      });
      lines.push(`• ${color}: [${sizeStrs.join(', ')}]`);
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
  }

  function closeSyncModal() {
    syncModal.style.display = 'none';
    document.body.style.overflow = '';
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

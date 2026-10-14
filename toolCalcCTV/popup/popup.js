// popup/popup.js - Handles Excel Import/Export and SKU price management

document.addEventListener('DOMContentLoaded', async () => {
  // Elements
  const toggleEnabled = document.getElementById('toggle-enabled');
  const toggleSummaryBar = document.getElementById('toggle-summary-bar');
  const totalSkuBadge = document.getElementById('total-sku-badge');
  const excelFileInput = document.getElementById('excel-file-input');
  const btnExportExcel = document.getElementById('btn-export-excel');
  const btnDownloadTemplate = document.getElementById('btn-download-template');
  const importStatus = document.getElementById('import-status');
  const skuSearchInput = document.getElementById('sku-search-input');
  const skuTableBody = document.getElementById('sku-table-body');
  const emptyState = document.getElementById('empty-state');
  const btnClearAll = document.getElementById('btn-clear-all');

  // Modal elements
  const skuModal = document.getElementById('sku-modal');
  const modalTitle = document.getElementById('modal-title');
  const modalSkuInput = document.getElementById('modal-sku-input');
  const modalSkuHint = document.getElementById('modal-sku-normalized-hint');
  const modalPriceInput = document.getElementById('modal-price-input');
  const btnOpenAddModal = document.getElementById('btn-open-add-modal');
  const btnModalCancel = document.getElementById('btn-modal-cancel');
  const btnModalSave = document.getElementById('btn-modal-save');

  let editingOriginalSku = null;
  let ctvPricesCache = {};

  const KNOWN_SIZE_REGEX = /[-_/. ]+(?:XS|XXS|S|M|L|XL|XXL|2XL|3XL|4XL|5XL|XXXL|FS|FREE|FREESIZE|\d{2})(?:\s*)$/i;

  /**
   * Normalize SKU by keeping Product Code + Color, removing Size suffix
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

  /**
   * Parse user input into integer VND price
   */
  function parsePriceInput(inputStr) {
    if (!inputStr) return 0;
    let str = String(inputStr).trim().toLowerCase();
    str = str.replace(/,/g, '.');

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

  function showStatus(msg, type = 'success') {
    importStatus.className = `status-msg ${type}`;
    importStatus.textContent = msg;
    importStatus.style.display = 'block';
    setTimeout(() => {
      importStatus.style.display = 'none';
    }, 4500);
  }

  /**
   * Load data from chrome.storage
   */
  async function loadData() {
    const data = await chrome.storage.local.get(['ctvPrices', 'settings']);
    ctvPricesCache = data.ctvPrices || {};
    const settings = data.settings || {};

    toggleEnabled.checked = settings.enabled !== false;
    toggleSummaryBar.checked = settings.showSummaryBar !== false;

    renderTable();
  }

  /**
   * Render SKU Table
   */
  function renderTable() {
    const query = skuSearchInput.value.trim().toUpperCase();
    const skus = Object.keys(ctvPricesCache);
    totalSkuBadge.textContent = `${skus.length} mã`;

    const filteredSkus = skus.filter(sku => !query || sku.includes(query));

    skuTableBody.innerHTML = '';
    if (filteredSkus.length === 0) {
      emptyState.style.display = 'block';
      return;
    }

    emptyState.style.display = 'none';

    filteredSkus.sort().forEach(sku => {
      const price = ctvPricesCache[sku];
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="sku-code">${sku}</td>
        <td class="sku-price">${formatVND(price)}</td>
        <td class="action-btn-cell">
          <button class="icon-btn btn-edit" title="Sửa giá" data-sku="${sku}">✏️</button>
          <button class="icon-btn btn-delete" title="Xóa mã" data-sku="${sku}">🗑️</button>
        </td>
      `;

      tr.querySelector('.btn-edit').addEventListener('click', () => {
        openModal(sku, price);
      });

      tr.querySelector('.btn-delete').addEventListener('click', async () => {
        if (confirm(`Bạn có chắc muốn xóa mã ${sku}?`)) {
          delete ctvPricesCache[sku];
          await chrome.storage.local.set({ ctvPrices: ctvPricesCache });
          renderTable();
          showStatus(`Đã xóa mã ${sku}`);
        }
      });

      skuTableBody.appendChild(tr);
    });
  }

  // Live search
  skuSearchInput.addEventListener('input', renderTable);

  // Toggle settings
  toggleEnabled.addEventListener('change', async () => {
    const settings = (await chrome.storage.local.get('settings')).settings || {};
    settings.enabled = toggleEnabled.checked;
    await chrome.storage.local.set({ settings });
  });

  toggleSummaryBar.addEventListener('change', async () => {
    const settings = (await chrome.storage.local.get('settings')).settings || {};
    settings.showSummaryBar = toggleSummaryBar.checked;
    await chrome.storage.local.set({ settings });
  });

  // Modal Open / Save
  function openModal(sku = '', price = '') {
    editingOriginalSku = sku || null;
    modalTitle.textContent = sku ? `Sửa Giá Mã: ${sku}` : 'Thêm Mã CTV Mới';
    modalSkuInput.value = sku;
    modalPriceInput.value = price > 0 ? price : '';
    modalSkuHint.textContent = sku ? `Mã lưu: ${normalizeSkuKey(sku)}` : '';
    skuModal.classList.remove('hidden');
    modalSkuInput.focus();
  }

  function closeModal() {
    skuModal.classList.add('hidden');
    editingOriginalSku = null;
  }

  btnOpenAddModal.addEventListener('click', () => openModal());
  btnModalCancel.addEventListener('click', closeModal);

  modalSkuInput.addEventListener('input', () => {
    const normalized = normalizeSkuKey(modalSkuInput.value);
    modalSkuHint.textContent = normalized ? `Mã lưu (bỏ size): ${normalized}` : '';
  });

  // Real-time dot thousand separator formatting
  modalPriceInput.addEventListener('input', () => {
    const val = modalPriceInput.value;
    if (/[a-zA-Z]/.test(val)) return;

    const cleanDigits = val.replace(/[^\d]/g, '');
    if (!cleanDigits) {
      modalPriceInput.value = '';
      return;
    }

    const num = parseInt(cleanDigits, 10);
    if (!isNaN(num)) {
      modalPriceInput.value = num.toLocaleString('vi-VN');
    }
  });

  btnModalSave.addEventListener('click', async () => {
    const rawSku = modalSkuInput.value.trim();
    const normalizedSku = normalizeSkuKey(rawSku);
    const price = parsePriceInput(modalPriceInput.value);

    if (!normalizedSku) {
      alert('Vui lòng nhập mã SKU!');
      return;
    }

    if (editingOriginalSku && editingOriginalSku !== normalizedSku) {
      delete ctvPricesCache[editingOriginalSku];
    }

    ctvPricesCache[normalizedSku] = price;
    await chrome.storage.local.set({ ctvPrices: ctvPricesCache });

    closeModal();
    renderTable();
    showStatus(`Đã lưu mã ${normalizedSku}: ${formatVND(price)}`);
  });

  // Clear all
  btnClearAll.addEventListener('click', async () => {
    if (confirm('Bạn có chắc chắn muốn xóa TOÀN BỘ dữ liệu giá CTV đã lưu? Thao tác này không thể hoàn tác!')) {
      ctvPricesCache = {};
      await chrome.storage.local.set({ ctvPrices: {} });
      renderTable();
      showStatus('Đã xóa toàn bộ dữ liệu!');
    }
  });

  // ==========================================
  // EXCEL IMPORT / EXPORT LOGIC
  // ==========================================

  // Import Excel File
  excelFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const data = new Uint8Array(evt.target.result);
        const workbook = XLSX.read(data, { type: 'array' });

        // Get first sheet
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        const jsonRows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

        if (!jsonRows || jsonRows.length === 0) {
          showStatus('File Excel không có dữ liệu!', 'error');
          return;
        }

        // Find header columns or default to col 0 and col 1
        let skuColIdx = -1;
        let priceColIdx = -1;
        let startRowIdx = 0;

        const headerRow = jsonRows[0];
        if (headerRow && Array.isArray(headerRow)) {
          headerRow.forEach((cell, idx) => {
            const str = String(cell || '').toLowerCase().trim();
            if (str.includes('sku') || str.includes('mã') || str.includes('code') || str.includes('ma')) {
              skuColIdx = idx;
            } else if (str.includes('giá') || str.includes('gia') || str.includes('ctv') || str.includes('price')) {
              priceColIdx = idx;
            }
          });
        }

        // If found headers, start from row 1, otherwise row 0
        if (skuColIdx !== -1 && priceColIdx !== -1) {
          startRowIdx = 1;
        } else {
          skuColIdx = 0;
          priceColIdx = 1;
          startRowIdx = 0;
        }

        let importedCount = 0;

        for (let r = startRowIdx; r < jsonRows.length; r++) {
          const row = jsonRows[r];
          if (!row || row.length === 0) continue;

          const rawSku = row[skuColIdx];
          const rawPrice = row[priceColIdx];

          if (rawSku) {
            const normalizedSku = normalizeSkuKey(rawSku);
            const price = parsePriceInput(rawPrice);
            if (normalizedSku) {
              ctvPricesCache[normalizedSku] = price;
              importedCount++;
            }
          }
        }

        await chrome.storage.local.set({ ctvPrices: ctvPricesCache });
        renderTable();
        showStatus(`🎉 Nhập thành công ${importedCount} mã từ file Excel!`, 'success');
      } catch (err) {
        console.error('Lỗi đọc file Excel:', err);
        showStatus('Lỗi khi đọc file Excel! Vui lòng kiểm tra lại định dạng file.', 'error');
      } finally {
        excelFileInput.value = '';
      }
    };

    reader.readAsArrayBuffer(file);
  });

  // Export Excel File
  btnExportExcel.addEventListener('click', () => {
    const skus = Object.keys(ctvPricesCache);
    if (skus.length === 0) {
      alert('Chưa có mã nào để xuất!');
      return;
    }

    const data = skus.sort().map(sku => ({
      'Mã (Mã + Màu)': sku,
      'Giá CTV (VNĐ)': ctvPricesCache[sku]
    }));

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Bảng Giá CTV');

    const now = new Date();
    const dateStr = `${now.getDate()}_${now.getMonth() + 1}_${now.getFullYear()}`;
    XLSX.writeFile(wb, `Bang_Gia_CTV_${dateStr}.xlsx`);
    showStatus('Đã xuất file Excel thành công!');
  });

  // Download Sample Template Excel
  btnDownloadTemplate.addEventListener('click', () => {
    const sampleData = [
      { 'Mã (Mã + Màu)': 'DCC01-DE', 'Giá CTV (VNĐ)': 350000 },
      { 'Mã (Mã + Màu)': 'DCC01-TR', 'Giá CTV (VNĐ)': 350000 },
      { 'Mã (Mã + Màu)': 'AO-POLO-DEN', 'Giá CTV (VNĐ)': 180000 },
      { 'Mã (Mã + Màu)': 'QUAN-JEAN-XANH', 'Giá CTV (VNĐ)': 250000 }
    ];

    const ws = XLSX.utils.json_to_sheet(sampleData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Mẫu Bảng Giá CTV');

    XLSX.writeFile(wb, 'Mau_Bang_Gia_CTV.xlsx');
  });

  // Initialize
  await loadData();
});

// test_logic.js - Unit tests for SKU normalization and price parsing

const assert = require('assert');

const KNOWN_SIZE_REGEX = /[-_/. ]+(?:XS|XXS|S|M|L|XL|XXL|2XL|3XL|4XL|5XL|XXXL|FS|FREE|FREESIZE|\d{2})(?:\s*)$/i;

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

console.log('--- Testing SKU Normalization ---');
const skuTests = [
  { input: 'DCC01-DE-L', expected: 'DCC01-DE' },
  { input: 'DCC01-DE-M', expected: 'DCC01-DE' },
  { input: 'DCC01-DE-S', expected: 'DCC01-DE' },
  { input: 'DCC01-DE-XL', expected: 'DCC01-DE' },
  { input: 'DCC01-DE-2XL', expected: 'DCC01-DE' },
  { input: 'DCC01-DE-38', expected: 'DCC01-DE' },
  { input: 'DCC01-TR-L', expected: 'DCC01-TR' },
  { input: 'AO-POLO-DEN-FS', expected: 'AO-POLO-DEN' },
  { input: 'SP01-DO-L', expected: 'SP01-DO' },
  { input: 'DCC01-DE', expected: 'DCC01-DE' },
  { input: 'DCC01_DE_L', expected: 'DCC01_DE' }
];

skuTests.forEach(({ input, expected }) => {
  const actual = normalizeSkuKey(input);
  assert.strictEqual(actual, expected, `Failed on input "${input}": expected "${expected}", got "${actual}"`);
  console.log(`✓ SKU: "${input}" -> "${actual}"`);
});

console.log('\n--- Testing Price Parser ---');
const priceTests = [
  { input: '350k', expected: 350000 },
  { input: '350K', expected: 350000 },
  { input: '350.000', expected: 350000 },
  { input: '350,000', expected: 350000 },
  { input: '350000', expected: 350000 },
  { input: '1tr5', expected: 1500000 },
  { input: '1.2tr', expected: 1200000 },
  { input: '2tr', expected: 2000000 },
  { input: '0', expected: 0 },
  { input: '', expected: 0 }
];

priceTests.forEach(({ input, expected }) => {
  const actual = parsePriceInput(input);
  assert.strictEqual(actual, expected, `Failed on input "${input}": expected ${expected}, got ${actual}`);
  console.log(`✓ Price: "${input}" -> ${actual} VND`);
});

console.log('\n--- Testing Customer Cleaning & Duplicate Match Logic ---');

function cleanCustomerName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/^ctv\s*[-_:]*\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

assert.strictEqual(cleanCustomerName('CTV - Chiến'), 'chiến');
assert.strictEqual(cleanCustomerName('CTV Quách Toàn'), 'quách toàn');
assert.strictEqual(cleanCustomerName('Ngọc Hạnh CTV'), 'ngọc hạnh ctv');
console.log('✓ cleanCustomerName correctly cleans prefixes and whitespace');

// Mock duplicate test
const mockOrders = [
  { Customer: 'CTV - Chiến', SKUCode: 'DCC01-DE-L', RefNo: '2608010975', SaleStaff: 'Chi Thu' },
  { Customer: 'CTV Quách Toàn', SKUCode: 'QBC01-NBD01-30', RefNo: '2608010967', SaleStaff: 'Trang' }
];

function checkMatch(cust, sku) {
  const cleanCust = cleanCustomerName(cust);
  const normSku = normalizeSkuKey(sku);
  return mockOrders.some(ord => {
    const isCust = cleanCustomerName(ord.Customer).includes(cleanCust);
    const isSku = normalizeSkuKey(ord.SKUCode) === normSku;
    return isCust && isSku;
  });
}

assert.strictEqual(checkMatch('CTV - Chiến', 'DCC01-DE-M'), true);
assert.strictEqual(checkMatch('Khách Lạ', 'DCC01-DE-M'), false);
console.log('✓ Duplicate matching logic correctly identifies same customer + normalized SKU');

console.log('\n✅ ALL UNIT TESTS PASSED SUCCESSFULLY!');


// Parses a brand's Excel export into account records.
//
// Fixed columns A-G: Store Full Name, Store Number, Store Address, City,
// County, State, Zip Code. Every column from H onward is a SKU. A cell is
// SOLD if it holds anything other than "-" or blank; otherwise UNSOLD.

const FIXED_COLS = [
  'storeName', 'storeNumber', 'address', 'city', 'county', 'state', 'zip',
];

function normalizeCell(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function isSold(cellValue) {
  const v = normalizeCell(cellValue);
  if (v === '' || v === '-') return false;
  return true;
}

function makeAccountId(brandId, storeNumber, storeName, address) {
  const key = `${storeNumber || ''}|${storeName || ''}|${address || ''}`;
  return `${brandId}::${key}`;
}

// workbookArrayBuffer: ArrayBuffer from a File. Returns { accounts, skuList, warnings }.
export function parseBrandWorkbook(workbookArrayBuffer, brandId) {
  const wb = XLSX.read(workbookArrayBuffer, { type: 'array' });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  if (rows.length < 2) {
    throw new Error('Sheet has no data rows below the header.');
  }

  const header = rows[0];
  const skuNames = header.slice(7).map((h) => normalizeCell(h)).filter(Boolean);
  const skuColOffset = 7; // column H = index 7

  const accounts = [];
  const warnings = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((c) => normalizeCell(c) === '')) continue;

    const rec = {};
    FIXED_COLS.forEach((key, i) => { rec[key] = normalizeCell(row[i]); });

    if (!rec.storeName && !rec.storeNumber) {
      warnings.push(`Row ${r + 1}: no store name or store number, skipped.`);
      continue;
    }
    if (!rec.county) {
      warnings.push(`Row ${r + 1} (${rec.storeName || rec.storeNumber}): missing County, will not appear on the county map.`);
    }

    const skus = {};
    skuNames.forEach((sku, i) => {
      skus[sku] = isSold(row[skuColOffset + i]);
    });

    accounts.push({
      id: makeAccountId(brandId, rec.storeNumber, rec.storeName, rec.address),
      brandId,
      storeName: rec.storeName,
      storeNumber: rec.storeNumber,
      address: rec.address,
      city: rec.city,
      county: rec.county,
      state: rec.state || 'MI',
      zip: rec.zip,
      skus,
      lat: null,
      lon: null,
      geocodeStatus: 'pending', // pending | ok | failed | manual
      notes: '',
    });
  }

  return { accounts, skuList: skuNames, warnings };
}

// Aggregate sold/unsold counts for a brand's accounts.
export function brandStats(accounts) {
  const total = accounts.length;
  let anySold = 0;
  accounts.forEach((a) => {
    if (Object.values(a.skus).some(Boolean)) anySold += 1;
  });
  return {
    totalAccounts: total,
    soldAccounts: anySold,
    unsoldAccounts: total - anySold,
    penetrationPct: total ? Math.round((anySold / total) * 1000) / 10 : 0,
  };
}

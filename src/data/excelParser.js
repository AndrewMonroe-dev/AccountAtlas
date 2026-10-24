// Parses a brand's Excel export into account records.
//
// Fixed columns A-G: Store Full Name, Store Number, Store Address, City,
// County, State, Zip Code. Every column from H onward is a SKU. A cell is
// SOLD if it holds anything other than "-" or blank; otherwise UNSOLD. The
// cell's amount is also kept (qty) for the volume heatmap.

const FIXED_COLS = [
  'storeName', 'storeNumber', 'address', 'city', 'county', 'state', 'zip',
];

const SKU_FIRST_COL = 7; // column H

function normalizeCell(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function isSold(cellValue) {
  const v = normalizeCell(cellValue);
  if (v === '' || v === '-') return false;
  return true;
}

// The amount in a SKU cell, for the volume heatmap. Numbers as typed, text like
// "1,234" or "$480" cleaned, anything else (blank, "-", a marker) counts as 0.
function parseQty(cellValue) {
  if (typeof cellValue === 'number') return Number.isFinite(cellValue) ? cellValue : 0;
  const cleaned = normalizeCell(cellValue).replace(/[$,\s]/g, '');
  return /^-?(\d+\.?\d*|\.\d+)$/.test(cleaned) ? parseFloat(cleaned) : 0;
}

function makeAccountId(brandId, storeNumber, storeName, address) {
  const key = `${storeNumber || ''}|${storeName || ''}|${address || ''}`;
  return `${brandId}::${key}`;
}

// Key used to recognize "this is the same physical address" across brands
// and across re-uploads, independent of the account's id (which is scoped
// to one brand).
export function normalizeAddressKey(address, city, state, zip) {
  return [address, city, state, zip].map((v) => String(v || '').trim().toLowerCase()).join('|');
}

// workbookArrayBuffer: ArrayBuffer from a File.
// previousById: {accountId -> old account record}, from this SAME brand's
//   prior upload (if replacing one) -- lets an unchanged address keep its
//   coordinates instead of resetting to ungeocoded.
// addressIndex: {normalizedAddressKey -> {lat, lon}}, from ANY already-
//   geocoded account across ALL brands -- lets a new brand at a store
//   that's already mapped skip geocoding entirely.
// Returns { accounts, skuList, warnings }.
export function parseBrandWorkbook(workbookArrayBuffer, brandId, { previousById = {}, addressIndex = {} } = {}) {
  const wb = XLSX.read(workbookArrayBuffer, { type: 'array' });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  if (rows.length < 2) {
    throw new Error('Sheet has no data rows below the header.');
  }

  const header = rows[0];
  // Every non-blank header from column H onward is one SKU, remembered with its
  // own column index so a blank header cell never shifts the columns after it.
  // A repeated header gets " (2)", " (3)" so the columns stay separate.
  const skuNames = [];
  const skuCols = [];
  const seen = new Map();
  for (let c = SKU_FIRST_COL; c < header.length; c++) {
    const base = normalizeCell(header[c]);
    if (!base) continue;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    skuNames.push(n === 1 ? base : `${base} (${n})`);
    skuCols.push(c);
  }

  // Guard against a missing/deleted header row. Without it, row 1 of real
  // account data gets silently treated as the header -- that account
  // vanishes and every SKU column gets mislabeled with whatever text was in
  // that row instead of the real SKU names. Catch it here instead of
  // failing silently.
  //
  // Column A alone isn't a reliable signal ("store" also shows up in real
  // store names like "Store 1"). Address (col C) and Zip Code (col G) are
  // much safer anchors: real data in those columns is a street address or a
  // zip digit string, which will essentially never contain the literal
  // words "address" or "zip".
  const addressCol = normalizeCell(header[2]).toLowerCase();
  const zipCol = normalizeCell(header[6]).toLowerCase();
  if (!addressCol.includes('address') || !zipCol.includes('zip')) {
    throw new Error(
      `Row 1 doesn't look like a header (column C is "${header[2] || '(blank)'}", ` +
      `column G is "${header[6] || '(blank)'}" -- expected "Store Address" and ` +
      `"Zip Code"). If you deleted or moved the header row, add it back as row 1 ` +
      `(Store Full Name, Store Number, Store Address, City, County, State, Zip ` +
      `Code, then a SKU name per column from H onward) and re-upload.`
    );
  }
  if (!skuNames.length) {
    throw new Error(
      `Row 1 has no SKU names in column H onward, so no products would be ` +
      `tracked. If you deleted or moved the header row, add it back as row 1 ` +
      `with a SKU name per column starting at H, and re-upload.`
    );
  }

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
    const qty = {};
    skuNames.forEach((sku, i) => {
      skus[sku] = isSold(row[skuCols[i]]);
      qty[sku] = parseQty(row[skuCols[i]]);
    });

    const id = makeAccountId(brandId, rec.storeNumber, rec.storeName, rec.address);
    const prev = previousById[id];
    const addrKey = normalizeAddressKey(rec.address, rec.city, rec.state, rec.zip);
    const cached = addressIndex[addrKey];

    let lat = null;
    let lon = null;
    let geocodeStatus = 'pending';
    if (prev && prev.geocodeStatus === 'ok' && prev.lat !== null && prev.lon !== null) {
      // Same brand, same id (same store number/name/address) -- carry the
      // existing geocode forward instead of wiping it on re-upload.
      lat = prev.lat; lon = prev.lon; geocodeStatus = 'ok';
    } else if (cached) {
      // A different brand already geocoded this exact address.
      lat = cached.lat; lon = cached.lon; geocodeStatus = 'ok';
    }

    accounts.push({
      id,
      brandId,
      storeName: rec.storeName,
      storeNumber: rec.storeNumber,
      address: rec.address,
      city: rec.city,
      county: rec.county,
      state: rec.state || 'MI',
      zip: rec.zip,
      skus,
      qty, // amount per SKU, same keys as skus (absent on lists stored before 2026-10-22)
      lat,
      lon,
      geocodeStatus, // pending | ok | failed | manual
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

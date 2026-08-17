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

import { downloadBlob, safeFileName } from '../core/util.js?v=20261024f';

// CSV export for (a) addresses to hand to tools/geocode.mjs, and
// (b) the current filtered account view, for a real call-sheet export.

function csvField(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// bom: Excel only reads accents correctly in a CSV that starts with a byte
// order mark. The address file for the geocoder stays plain.
function downloadCsv(filename, rows, { bom = false } = {}) {
  const csv = rows.map((r) => r.map(csvField).join(',')).join('\r\n');
  downloadBlob(new Blob([bom ? '\uFEFF' + csv : csv], { type: 'text/csv;charset=utf-8' }), filename);
}

export function exportAddressesForGeocoding(brand, accounts) {
  const rows = accounts.map((a) => [a.id, a.address, a.city, a.state || 'MI', a.zip]);
  downloadCsv(`${safeFileName(brand.name)}-addresses.csv`, rows);
}

export async function importCoordinates(brandId, file, { getAllAccounts, putAccounts }) {
  const text = await file.text();
  let coords;
  try { coords = JSON.parse(text); } catch { throw new Error('That file is not valid JSON.'); }
  if (!coords || typeof coords !== 'object' || Array.isArray(coords)) throw new Error('That is not a coordinates file.');
  const accounts = (await getAllAccounts()).filter((a) => a.brandId === brandId);
  const updated = accounts.map((a) => {
    const c = coords[a.id];
    if (!c) return a;
    return {
      ...a,
      lat: c.matched ? c.lat : null,
      lon: c.matched ? c.lon : null,
      geocodeStatus: c.matched ? 'ok' : 'failed',
    };
  });
  await putAccounts(updated);
  return {
    matched: updated.filter((a) => a.geocodeStatus === 'ok').length,
    total: updated.length,
  };
}

export function exportFilteredAccounts(accounts, brandsById, filename = 'account-atlas-export.csv') {
  const header = ['Brand', 'Store Name', 'Store Number', 'Address', 'City', 'County', 'State', 'Zip', 'Status', 'Sold SKUs', 'Unsold SKUs'];
  const rows = accounts.map((a) => {
    const sold = Object.entries(a.skus).filter(([, v]) => v).map(([k]) => k);
    const unsold = Object.entries(a.skus).filter(([, v]) => !v).map(([k]) => k);
    return [
      brandsById[a.brandId]?.name || '',
      a.storeName, a.storeNumber, a.address, a.city, a.county, a.state, a.zip,
      sold.length ? 'Sold' : 'Unsold',
      sold.join('; '), unsold.join('; '),
    ];
  });
  downloadCsv(filename, [header, ...rows], { bom: true });
}

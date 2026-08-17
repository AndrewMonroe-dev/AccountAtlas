// CSV export for (a) addresses to hand to tools/geocode.mjs, and
// (b) the current filtered account view, for a real call-sheet export.

function csvField(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(filename, rows) {
  const csv = rows.map((r) => r.map(csvField).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportAddressesForGeocoding(brand, accounts) {
  const rows = accounts.map((a) => [a.id, a.address, a.city, a.state || 'MI', a.zip]);
  downloadCsv(`${brand.name.replace(/\s+/g, '-')}-addresses.csv`, rows);
}

export async function importCoordinates(brandId, file, { getAllAccounts, putAccounts }) {
  const text = await file.text();
  const coords = JSON.parse(text);
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
  downloadCsv(filename, [header, ...rows]);
}

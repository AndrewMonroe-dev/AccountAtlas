// Portable brand snapshot: everything for one brand (its record + every
// account, including resolved lat/lon) as a single JSON file. Built for
// moving fully-geocoded data from a machine that can run the local
// geocoding server to one that can't (e.g. a locked-down work computer
// with no installs allowed) -- geocode once wherever Node is available,
// then import the finished result anywhere with just a browser.

export function exportBrandSnapshot(brand, accounts) {
  const snapshot = {
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    brand,
    accounts,
  };
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${brand.name.replace(/\s+/g, '-')}-snapshot.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// Returns { brand, accounts }. Throws if the file isn't a recognizable
// snapshot.
export async function parseSnapshotFile(file) {
  const text = await file.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Not a valid JSON file.');
  }
  if (!data.brand || !Array.isArray(data.accounts)) {
    throw new Error('This file doesn\'t look like an Account Atlas brand snapshot.');
  }
  return { brand: data.brand, accounts: data.accounts };
}

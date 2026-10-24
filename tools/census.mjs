// Shared client for the U.S. Census Bureau batch geocoder (free, no API key).
// Used by tools/server.mjs (the one-click button) and tools/geocode.mjs (the
// command-line fallback). The Cloudflare relays carry their own copy of this
// logic because they are deployed as single files.

const CENSUS_BATCH_URL = 'https://geocoding.geo.census.gov/geocoder/locations/addressbatch';
const BATCH_SIZE = 9000; // Census caps a batch file at 10,000 records
const TIMEOUT_MS = 120000;

export function csvField(v) {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

export function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = !inQuotes; }
    } else if (c === ',' && !inQuotes) {
      out.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

// rows: [{ id, address, city, state, zip }] -> { [id]: { lat, lon, matched } }
export async function geocodeAddresses(rows, { onBatch } = {}) {
  const results = {};
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    if (onBatch) onBatch(i / BATCH_SIZE + 1, batch.length);
    const csvBody = batch.map((r) => [r.id, r.address, r.city, r.state || 'MI', r.zip].map(csvField).join(',')).join('\n');
    const form = new FormData();
    form.append('addressFile', new Blob([csvBody], { type: 'text/csv' }), 'addresses.csv');
    form.append('benchmark', 'Public_AR_Current');
    const res = await fetch(CENSUS_BATCH_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Census API returned ${res.status}`);
    const text = await res.text();
    text.split(/\r?\n/).forEach((line) => {
      if (!line.trim()) return;
      // Columns: id, input address, Match/No_Match/Tie, match type, matched address, "lon,lat", ...
      const [id, , status, , , coords] = parseCsvLine(line);
      const [lon, lat] = String(coords || '').split(',').map(Number);
      if (status === 'Match' && Number.isFinite(lat) && Number.isFinite(lon)) results[id] = { lat, lon, matched: true };
      else results[id] = { lat: null, lon: null, matched: false };
    });
  }
  return results;
}

// Cloudflare Pages Function -- same-origin replacement for the standalone
// tools/cloudflare-worker.js relay. Andrew, 2026-08-21: the standalone
// Worker lives on its own `*.workers.dev` domain, which his work computer's
// network was silently blocking ("Failed to fetch", no real error detail
// reachable -- his HP laptop maps F12 to a hardware key, not DevTools).
// A Pages Function is served from the SAME domain as the app itself
// (accountatlas.pages.dev/api/geocode) -- since that domain already loads
// fine at work (the app itself works there), the geocode call now rides
// the same allowed origin instead of hitting a separate, unfamiliar one.
// Same Census batch-geocoding logic as the Worker, ported directly; no CORS
// headers needed since this is same-origin, not a cross-origin relay.

const CENSUS_BATCH_URL = 'https://geocoding.geo.census.gov/geocoder/locations/addressbatch';
const BATCH_SIZE = 9000; // Census's own cap per batch file

function csvField(v) {
  const s = String(v ?? '');
  return `"${s.replace(/"/g, '""')}"`;
}

function parseCensusCsvLine(line) {
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

async function geocodeAddresses(rows) {
  const results = {};
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const csvBody = batch
      .map((r) => [r.id, r.address, r.city, r.state || 'MI', r.zip].map(csvField).join(','))
      .join('\n');
    const form = new FormData();
    form.append('addressFile', new Blob([csvBody], { type: 'text/csv' }), 'addresses.csv');
    form.append('benchmark', 'Public_AR_Current');

    const res = await fetch(CENSUS_BATCH_URL, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`Census API returned ${res.status}`);
    const text = await res.text();
    text.trim().split(/\r?\n/).forEach((line) => {
      if (!line) return;
      const [id, , matchStatus, , , coords] = parseCensusCsvLine(line);
      if (matchStatus === 'Match' && coords) {
        const [lon, lat] = coords.split(',').map(Number);
        results[id] = { lat, lon, matched: true };
      } else {
        results[id] = { lat: null, lon: null, matched: false };
      }
    });
  }
  return results;
}

export async function onRequestPost({ request }) {
  try {
    const { addresses } = await request.json();
    if (!Array.isArray(addresses) || !addresses.length) {
      return new Response(JSON.stringify({ error: 'No addresses provided.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const results = await geocodeAddresses(addresses);
    return new Response(JSON.stringify({ results }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

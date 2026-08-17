// Cloudflare Worker: a thin CORS-enabled relay in front of the U.S. Census
// Bureau's official batch geocoder. Nothing is stored -- every request is
// forwarded straight to Census and the response passed straight back.
//
// Why this exists: the Census API doesn't send Access-Control-Allow-Origin
// headers, so a browser can never call it directly, from any computer,
// with or without Node installed -- that's the actual wall. This relay
// exists purely to add that one missing header. Deployed once (free tier,
// no credit card), it works for every user of the app from then on -- no
// local server, no install, on any computer with a normal browser.
//
// --- Deploy steps (one-time, ~5 minutes) ---
// 1. Go to https://workers.cloudflare.com and sign up (free, no card).
// 2. Dashboard -> Workers & Pages -> Create -> "Create Worker".
// 3. Give it any name (e.g. "account-atlas-geocode").
// 4. Click "Edit code", delete the placeholder, paste this entire file in.
// 5. Click "Deploy". You'll get a URL like
//    https://account-atlas-geocode.YOUR-SUBDOMAIN.workers.dev
// 6. Send that URL back -- it gets wired into the app once, and every
//    future user of the app uses it automatically. No further setup ever.

const CENSUS_BATCH_URL = 'https://geocoding.geo.census.gov/geocoder/locations/addressbatch';
const BATCH_SIZE = 9000; // Census's own cap per batch file

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

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

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders() });
    }

    try {
      const { addresses } = await request.json();
      if (!Array.isArray(addresses) || !addresses.length) {
        return new Response(JSON.stringify({ error: 'No addresses provided.' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders() },
        });
      }
      const results = await geocodeAddresses(addresses);
      return new Response(JSON.stringify({ results }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }
  },
};

#!/usr/bin/env node
// Local geocoding helper. Run this after uploading a brand in the app and
// exporting its address list (Brand panel -> "Export addresses to geocode").
//
// Usage:
//   node tools/geocode.mjs path/to/brand-addresses.csv
//
// Produces path/to/brand-addresses.coords.json, which you drop back into the
// app via "Import coordinates" on that brand's panel.
//
// Why this runs locally instead of in the browser: the Census Bureau's
// geocoder does not return CORS headers, so a browser fetch() to it is
// blocked no matter what. Node has no such restriction. No API key needed --
// this is the free, official U.S. Census Bureau Batch Geocoder.

import fs from 'fs';

const CENSUS_BATCH_URL = 'https://geocoding.geo.census.gov/geocoder/locations/addressbatch';
const BATCH_SIZE = 9000; // Census caps batch files at 10,000 records

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  return lines.map((line) => {
    // simple CSV split, fields are pre-quoted by the app's exporter
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
  });
}

async function geocodeBatch(rows) {
  // Census batch format: Unique ID, Street address, City, State, ZIP
  const csvBody = rows.map((r) => r.map((f) => `"${(f || '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const form = new FormData();
  form.append('addressFile', new Blob([csvBody], { type: 'text/csv' }), 'addresses.csv');
  form.append('benchmark', 'Public_AR_Current');

  const res = await fetch(CENSUS_BATCH_URL, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Census API returned ${res.status}`);
  const text = await res.text();
  return parseCsv(text);
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: node tools/geocode.mjs path/to/brand-addresses.csv');
    process.exit(1);
  }

  const raw = fs.readFileSync(inputPath, 'utf8');
  const rows = parseCsv(raw).filter((r) => r.length >= 5 && r[0]);
  console.log(`Loaded ${rows.length} addresses from ${inputPath}`);

  const results = {};
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    console.log(`Geocoding batch ${i / BATCH_SIZE + 1} (${batch.length} addresses)...`);
    const parsed = await geocodeBatch(batch);
    parsed.forEach((r) => {
      // Census batch response columns:
      // id, input address, match(Match/No_Match/Tie), matchType, matched address, lon,lat, tigerLineId, side
      const [id, , matchStatus, , , coords] = r;
      if (matchStatus === 'Match' && coords) {
        const [lon, lat] = coords.split(',').map(Number);
        results[id] = { lat, lon, matched: true };
      } else {
        results[id] = { lat: null, lon: null, matched: false };
      }
    });
  }

  const matchedCount = Object.values(results).filter((r) => r.matched).length;
  console.log(`Matched ${matchedCount} of ${rows.length}.`);

  const outPath = inputPath.replace(/\.csv$/i, '') + '.coords.json';
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`Wrote ${outPath} -- import this file in the app.`);
}

main().catch((err) => {
  console.error('Geocoding failed:', err.message);
  process.exit(1);
});

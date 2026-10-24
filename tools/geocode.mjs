#!/usr/bin/env node
// Command-line geocoding fallback, for when the local server is not running.
//
// Usage:
//   node tools/geocode.mjs path/to/brand-addresses.csv
//
// Reads the address file the app exports and writes path/to/brand-addresses.coords.json,
// which you import back into the app. Uses the free U.S. Census Bureau batch geocoder,
// which a browser cannot call directly because it sends no CORS headers.

import fs from 'fs';
import { geocodeAddresses, parseCsvLine } from './census.mjs';

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: node tools/geocode.mjs path/to/brand-addresses.csv');
    process.exit(1);
  }
  // Export columns: id, address, city, state, zip
  const rows = fs.readFileSync(inputPath, 'utf8').replace(/^﻿/, '').split(/\r?\n/)
    .filter((line) => line.trim())
    .map(parseCsvLine)
    .filter((r) => r.length >= 5 && r[0])
    .map(([id, address, city, state, zip]) => ({ id, address, city, state, zip }));
  console.log(`Loaded ${rows.length} addresses from ${inputPath}`);

  const results = await geocodeAddresses(rows, { onBatch: (n, size) => console.log(`Geocoding batch ${n} (${size} addresses)...`) });
  console.log(`Matched ${Object.values(results).filter((r) => r.matched).length} of ${rows.length}.`);

  const outPath = inputPath.replace(/\.csv$/i, '') + '.coords.json';
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`Wrote ${outPath} -- import this file in the app.`);
}

main().catch((err) => {
  console.error('Geocoding failed:', err.message);
  process.exit(1);
});

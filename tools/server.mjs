#!/usr/bin/env node
// Local server: serves the app itself AND a same-origin geocoding endpoint,
// so the browser's "Geocode" button can call it directly with no CORS
// wall and no manual export/run-script/import steps.
//
// Usage:
//   node tools/server.mjs
// Then open http://localhost:8181 (not the GitHub Pages URL -- see README,
// "Why a local server" -- a browser can never launch a program on your
// machine, and a page served over https can't call plain http://localhost
// either, so the app has to be served BY this same process for the button
// to reach it).

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 8181;

const CENSUS_BATCH_URL = 'https://geocoding.geo.census.gov/geocoder/locations/addressbatch';
const BATCH_SIZE = 9000;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.geojson': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function csvField(v) {
  const s = String(v ?? '');
  return `"${s.replace(/"/g, '""')}"`;
}

function parseCensusCsvLine(line) {
  const out = [];
  let cur = ''; let inQuotes = false;
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
  // rows: [{id, address, city, state, zip}]
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

function serveStatic(req, res) {
  let reqPath = decodeURIComponent(req.url.split('?')[0]);
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(ROOT, reqPath);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/geocode') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const { addresses } = JSON.parse(body);
        console.log(`Geocoding ${addresses.length} addresses...`);
        const results = await geocodeAddresses(addresses);
        const matched = Object.values(results).filter((r) => r.matched).length;
        console.log(`Matched ${matched} of ${addresses.length}.`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results }));
      } catch (err) {
        console.error('Geocoding failed:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Account Atlas running at http://localhost:${PORT}`);
  console.log('The "Geocode" button on each brand row talks to this process directly.');
  console.log('Leave this window open while you use the app. Ctrl+C to stop.');
});

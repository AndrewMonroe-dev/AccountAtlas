#!/usr/bin/env node
// Local server: serves the app itself AND a same-origin geocoding endpoint, so
// the browser's "Geocode" button can call it directly with no CORS wall and no
// manual export/run-script/import steps.
//
// Usage:
//   node tools/server.mjs
// Then open http://localhost:8181. It listens on this computer only.

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { geocodeAddresses } from './census.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 8181;
const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 20 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.geojson': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function serveStatic(req, res) {
  let reqPath;
  try { reqPath = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); res.end('Bad request'); return; }
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.resolve(ROOT, '.' + reqPath);
  const rel = path.relative(ROOT, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('Request too large.')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/geocode') {
    try {
      const { addresses } = JSON.parse(await readBody(req));
      if (!Array.isArray(addresses) || !addresses.length) { sendJson(res, 400, { error: 'No addresses provided.' }); return; }
      console.log(`Geocoding ${addresses.length} addresses...`);
      const results = await geocodeAddresses(addresses);
      console.log(`Matched ${Object.values(results).filter((r) => r.matched).length} of ${addresses.length}.`);
      sendJson(res, 200, { results });
    } catch (err) {
      console.error('Geocoding failed:', err.message);
      sendJson(res, 500, { error: err.message });
    }
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end('Method not allowed'); return; }
  serveStatic(req, res);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Account Atlas may already be running: open http://localhost:${PORT}`);
  else console.error('Server error:', err.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Account Atlas running at http://localhost:${PORT}`);
  console.log('The "Geocode" button on each brand row talks to this process directly.');
  console.log('Leave this window open while you use the app. Ctrl+C to stop.');
});

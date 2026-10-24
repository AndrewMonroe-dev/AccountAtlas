#!/usr/bin/env node
// Bumps the cache-busting marker (?v=YYYYMMDDx) in index.html and every module
// import under src/, and the VERSION in sw.js, so browsers (and the offline
// cache) fetch the new files after a deploy.
//
// Usage:
//   node tools/bump.mjs            next marker for today (20261024a, then b, c ...)
//   node tools/bump.mjs 20261101a  use this exact marker

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = /(?:\?v=|VERSION = ')(\d{8}[a-z])/g;

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? files(full) : /\.(js|css)$/.test(e.name) ? [full] : [];
  });
}

const targets = [path.join(ROOT, 'index.html'), path.join(ROOT, 'sw.js'), ...files(path.join(ROOT, 'src'))];
const current = new Set();
targets.forEach((f) => [...fs.readFileSync(f, 'utf8').matchAll(MARKER)].forEach((m) => current.add(m[1])));

let next = process.argv[2];
if (!next) {
  const d = new Date();
  const today = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const letters = [...current].filter((m) => m.startsWith(today)).map((m) => m.charCodeAt(8));
  next = today + String.fromCharCode(letters.length ? Math.max(...letters) + 1 : 97);
}
if (!/^\d{8}[a-z]$/.test(next)) { console.error('Marker must look like 20261024a'); process.exit(1); }

let changed = 0;
targets.forEach((f) => {
  const text = fs.readFileSync(f, 'utf8');
  const out = text.replace(MARKER, (m, old) => m.replace(old, next));
  if (out !== text) { fs.writeFileSync(f, out); changed += 1; }
});
console.log(`Marker ${[...current].join(', ') || '(none)'} -> ${next} in ${changed} file(s).`);

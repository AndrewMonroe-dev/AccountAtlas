import './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Run sw.js in a bare sandbox just far enough to read what it will cache.
const self = { addEventListener() {}, location: { origin: 'https://example.test' } };
vm.runInNewContext(read('sw.js'), { self, caches: {}, Request: class {}, Response: {}, fetch() {}, URL, AbortController, setTimeout, clearTimeout });
const shell = self.AA_SHELL;

function sourceFiles(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    return e.isDirectory() ? sourceFiles(rel) : e.name.endsWith('.js') ? [rel] : [];
  });
}

test('every file the offline shell lists exists', () => {
  shell.forEach((entry) => {
    if (entry === './') return;
    const file = entry.split('?')[0];
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${entry} is listed in sw.js but missing`);
  });
});

test('every source module and stylesheet is in the offline shell', () => {
  const listed = new Set(shell.map((e) => e.split('?')[0]));
  sourceFiles('src').forEach((f) => assert.ok(listed.has(f), `${f} is not in the sw.js shell list`));
  ['tokens', 'app', 'map'].forEach((n) => assert.ok(listed.has(`assets/css/${n}.css`)));
  assert.ok(listed.has('index.html') && listed.has('manifest.webmanifest'));
});

test('versioned shell entries carry the current version', () => {
  shell.filter((e) => /^(src|assets\/css)\//.test(e)).forEach((e) => assert.ok(e.endsWith(`?v=${self.AA_VERSION}`), e));
});

test('sw.js version matches the markers in index.html and every import', () => {
  const markers = new Set();
  [read('index.html'), ...sourceFiles('src').map(read)].forEach((text) => [...text.matchAll(/\?v=(\d{8}[a-z])/g)].forEach((m) => markers.add(m[1])));
  assert.deepEqual([...markers], [self.AA_VERSION], 'run npm run bump so index.html, src/ and sw.js agree');
});

test('the nearby data version matches the map module', () => {
  const m = read('src/modules/mapView.js').match(/NEARBY_DATA_VERSION = '(\d+)'/);
  assert.equal(m[1], self.AA_NEARBY_VERSION);
  assert.ok(shell.some((e) => e.includes(`michigan-places.json?v=${m[1]}`)));
});

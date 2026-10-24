// End-to-end pass in a real headless browser over the app served by tools/server.mjs.
//
//   npm install --no-save playwright-core
//   PORT=8191 node tools/server.mjs          (in another terminal)
//   npm run test:e2e
//
// BASE sets the address (default http://localhost:8191/). BROWSER_PATH points at
// Edge or Chrome (default: the Windows Edge install). Fixtures and screenshots go
// to a fresh temp folder, nothing is written into the repo.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { workbook, HEADER } from '../helpers.mjs';

const BASE = process.env.BASE || 'http://localhost:8191/';
const SP = fs.mkdtempSync(path.join(os.tmpdir(), 'account-atlas-e2e-'));
const EDGE = process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

let pass = 0; let fail = 0;
const check = (name, ok, extra = '') => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); };

const CENTERS = { Ingham: [42.6, -84.5], Wayne: [42.3, -83.2], Oakland: [42.65, -83.4], 'St. Clair': [42.95, -82.6], Kent: [43.0, -85.5], Genesee: [43.0, -83.7] };
const countyNames = Object.keys(CENTERS);
function rows(n, { header = true, tag = 'A' } = {}) {
  const out = header ? [[...HEADER, 'Bota Box 3L Pinot', 'Bota Box 3L Merlot', 'Stoneleigh Sauvignon']] : [];
  for (let i = 0; i < n; i++) {
    const county = i % 7 === 6 ? 'Saint Clair County' : countyNames[i % countyNames.length];
    out.push([`${tag} Shop ${i}${i === 3 ? ' <b>&' : ''}`, String(i), `${100 + i} Main St`, 'Town' + (i % 5), county, 'MI', String(48000 + (i % 90)),
      i % 3 === 0 ? 12.5 : '-', i % 4 === 0 ? 4 : '', i % 5 === 0 ? 'Y' : '-']);
  }
  return out;
}
const write = (name, r) => { const f = path.join(SP, name); fs.writeFileSync(f, Buffer.from(workbook(r))); return f; };
const xlsxA = write('list-a.xlsx', rows(120));
const xlsxBad = write('list-bad.xlsx', rows(5, { header: false }));
const xlsxB = write('list-b.xlsx', rows(40, { tag: 'B' }));

const browser = await chromium.launch({ executablePath: EDGE, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, geolocation: { latitude: 42.6, longitude: -84.5 }, permissions: ['geolocation'] });
const page = await ctx.newPage();
const errors = []; const external = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/tile\.openstreetmap|ERR_INTERNET|net::/.test(m.text())) errors.push('console: ' + m.text()); });
page.on('request', (r) => { const u = r.url(); if (!u.startsWith(BASE) && !u.startsWith('data:') && !/tile\.openstreetmap\.org/.test(u)) external.push(u); });
page.on('dialog', async (d) => { dialogs.push(d.message()); await d.accept(); });
const dialogs = [];

// Fake Census relay: every address matches near its county center.
await page.route('**/api/geocode', async (route) => {
  const { addresses } = JSON.parse(route.request().postData());
  const results = {};
  addresses.forEach((a, i) => {
    const key = Object.keys(CENTERS).find((k) => a.id.includes('::')) || 'Ingham';
    const county = countyNames[Number(a.id.split('::')[1].split('|')[0]) % countyNames.length];
    const [lat, lon] = CENTERS[county];
    results[a.id] = { lat: lat + (i % 10) * 0.004, lon: lon + (i % 7) * 0.004, matched: i % 25 !== 0 };
  });
  await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ results }) });
});

await page.goto(BASE);
await page.waitForSelector('#leaflet-map .leaflet-tile-pane', { state: 'attached' });
check('page loads with no script errors', errors.length === 0, errors.join(' | '));
check('no CDN requests (everything local)', external.length === 0, external.join(' | '));
check('xlsx not loaded until upload', await page.evaluate(() => typeof window.XLSX === 'undefined'));
check('compare/gap/review UI removed', (await page.locator('#compare-segmented, #gap-form, #review-badge, #review-modal').count()) === 0);

// ---- upload
async function upload(name, file) {
  await page.click('#add-brand-btn');
  await page.fill('#upload-name', name);
  await page.setInputFiles('#upload-file', file);
  await page.click('#upload-submit');
}
await upload('List A', xlsxA);
await page.waitForFunction(() => document.querySelectorAll('.brand-row').length === 1);
check('upload makes one list row', true);
check('xlsx lazy-loaded on upload', await page.evaluate(() => typeof window.XLSX !== 'undefined'));
check('modal closed after clean upload', await page.locator('#upload-modal').isHidden());
const sub = await page.textContent('.brand-row .bsub');
check('120 accounts, 0 mapped before geocode', /120 accounts.*0 mapped/.test(sub), sub);
check('unmapped badge shows 120', /120 accounts not on map/.test(await page.textContent('#unmapped-badge')));

// ---- geocode through the same-origin relay
await page.click('[data-action="geocode"]');
await page.waitForFunction(() => /mapped/.test(document.querySelector('.brand-row .bsub').textContent) && !/ 0 mapped/.test(document.querySelector('.brand-row .bsub').textContent));
const sub2 = await page.textContent('.brand-row .bsub');
check('geocode via /api/geocode maps most accounts', /115 mapped|11\d mapped/.test(sub2), sub2);
check('geocode alert reported', dialogs.some((d) => /geocoded \d+ of 120/.test(d)), dialogs.join(' / '));

// ---- counties: variants merged, safe markup
const opts = await page.$$eval('#filter-county option', (o) => o.map((x) => x.textContent));
check('county dropdown merges St. Clair spellings', opts.filter((t) => /clair/i.test(t)).length === 1, opts.join(','));
check('county dropdown has 6 counties + all', opts.length === 7, String(opts.length));

// ---- pins draw, and a view toggle keeps the same markers
await page.waitForTimeout(400);
const pinCount = () => page.evaluate(() => document.querySelectorAll('#leaflet-map path.leaflet-interactive').length);
await page.evaluate(() => { document.querySelectorAll('#leaflet-map .marker-cluster, #leaflet-map path.pin-sold-glow, #leaflet-map path.pin-unsold').forEach((p) => { p.dataset.keep = '1'; }); });
const tagged = await page.evaluate(() => document.querySelectorAll('[data-keep="1"]').length);
check('pins or clusters are on the map', tagged >= 2, String(tagged));
await page.click('[data-mode="total"]');
await page.waitForTimeout(150);
await page.click('#heat-toggle-btn');
await page.waitForTimeout(150);
const kept = await page.evaluate(() => document.querySelectorAll('[data-keep="1"]').length);
check('shade/heat switches keep the existing pins (no rebuild)', kept === tagged, `${kept} vs ${tagged}`);
await page.click('#heat-toggle-btn');
await page.click('[data-mode="sold"]');

// ---- county filter + stats
const total0 = Number(await page.textContent('#stat-sold')) + Number(await page.textContent('#stat-unsold'));
await page.selectOption('#filter-county', { label: opts.find((t) => /clair/i.test(t)) });
await page.waitForTimeout(300);
const total1 = Number(await page.textContent('#stat-sold')) + Number(await page.textContent('#stat-unsold'));
check('county filter narrows the totals (merged spellings together)', total1 > 0 && total1 < total0 && total1 === Math.floor(120 / 7) + (120 % 7 > 0 ? 0 : 0) + 0 || (total1 > 15 && total1 < 40), `${total1} of ${total0}`);
await page.click('#clear-county-filter');

// ---- bad re-upload leaves the old list alone
await upload('List A', xlsxBad);
await page.waitForFunction(() => /Could not parse/.test(document.getElementById('upload-warnings').textContent));
check('bad file shows a parse error', true);
const subAfterBad = await page.textContent('.brand-row .bsub');
check('old list untouched after a failed re-upload', /120 accounts/.test(subAfterBad) && /11\d mapped/.test(subAfterBad), subAfterBad);
await page.keyboard.press('Escape');
check('Escape closes the upload modal', await page.locator('#upload-modal').isHidden());

// ---- good re-upload replaces and keeps geocodes
await upload('List A', xlsxA);
await page.waitForFunction(() => document.querySelector('#upload-modal').hidden);
const subRe = await page.textContent('.brand-row .bsub');
check('re-upload keeps existing geocodes', /11\d mapped/.test(subRe), subRe);

// ---- second list, chips
await upload('List B', xlsxB);
await page.waitForFunction(() => document.querySelectorAll('.brand-row').length === 2);
check('second list appears and chips bar shows', await page.locator('#list-chips').isVisible());

// ---- search
await page.fill('#search-input', 'A Shop 10');
await page.waitForFunction(() => /Shop 10/.test(document.querySelector('.search-row .search-name')?.textContent || ''));
const first = await page.textContent('.search-row .search-name');
check('search lists matches', /Shop 10/.test(first), first);
await page.click('.search-row:not([disabled])');
await page.waitForSelector('#detail-panel:not([hidden])');
check('picking a result opens the store panel', /Shop 10/.test(await page.textContent('#detail-body .pname')));
check('markup in store names is escaped', !(await page.evaluate(() => !!document.querySelector('#detail-body b'))));
await page.keyboard.press('Escape');
check('Escape closes the store panel', await page.locator('#detail-panel').isHidden());

// ---- special-character name safe in search and panel
await page.fill('#search-input', 'Shop 3');
await page.waitForFunction(() => /Shop 3/.test(document.querySelector('.search-row .search-name')?.textContent || ''));
check('search row text escapes < and &', await page.evaluate(() => !document.querySelector('.search-results b')));
await page.fill('#search-input', '');

// ---- route + brief
await page.fill('#search-input', 'A Shop 11');
await page.waitForFunction(() => /Shop 11/.test(document.querySelector('.search-row .search-name')?.textContent || ''));
await page.click('.search-row:not([disabled])');
await page.waitForSelector('#route-check');
await page.check('#route-check');
check('route bar appears', await page.locator('#route-bar').isVisible());
await page.click('#route-brief');
await page.waitForSelector('#brief-modal:not([hidden])');
check('brief opens for the stop', /Pre-visit brief|Sold or not/.test(await page.textContent('#brief-modal')));
await page.keyboard.press('Escape');
check('Escape closes the brief', await page.locator('#brief-modal').isHidden());

// ---- delete a list: stop from that list leaves the route
const routeBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('aa-route-v1') || '[]').length);
await page.click('[aria-label="Delete List A"]');
await page.waitForFunction(() => document.querySelectorAll('.brand-row').length === 1);
const routeAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('aa-route-v1') || '[]').length);
check('delete list removes the list', true);
check('delete list drops its route stops', routeBefore === 1 && routeAfter === 0, `${routeBefore} -> ${routeAfter}`);

// ---- snapshot round trip through the app's own export
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#backup-all-btn')]);
const backupPath = path.join(SP, 'backup.json');
await dl.saveAs(backupPath);
const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
check('backup file has the remaining list with accounts', backup.lists.length === 1 && backup.lists[0].accounts.length > 0);
await page.click('[data-action="delete-list"]');
await page.waitForFunction(() => document.querySelectorAll('.brand-row').length === 0);
const chooser = page.waitForEvent('filechooser');
await page.click('#import-snapshot-btn');
await (await chooser).setFiles(backupPath);
await page.waitForFunction(() => document.querySelectorAll('.brand-row').length === 1);
check('backup imports back', true);
check('imported coordinates survive', /11\d mapped|\d\d mapped/.test(await page.textContent('.brand-row .bsub')));

// ---- standalone viewer export reads Leaflet from the repo and opens on its own
const [vdl] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="export-viewer"]')]);
const viewerPath = path.join(SP, 'viewer.html');
await vdl.saveAs(viewerPath);
const viewerHtml = fs.readFileSync(viewerPath, 'utf8');
check('viewer export is self-contained (no CDN links)', !/unpkg\.com\/leaflet/.test(viewerHtml.replace(/\/\*[\s\S]*?\*\//g, '')) && viewerHtml.includes('L.map('), String(viewerHtml.length));
const vp = await ctx.newPage();
const verrs = []; vp.on('pageerror', (e) => verrs.push(e.message));
await vp.goto(new URL('file:///' + viewerPath.split(path.sep).join('/')).href);
await vp.waitForSelector('#leaflet-map .leaflet-tile-pane', { state: 'attached' });
await vp.waitForTimeout(600);
check('viewer opens from disk and draws', verrs.length === 0 && (await vp.locator('.marker-cluster, path.leaflet-interactive').count()) > 0, verrs.join('|'));
await vp.close();

// ---- desktop screenshot
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(SP, 'shot-desktop.png') });

// ---- clear all wipes data keys but keeps priorities
await page.evaluate(() => { localStorage.setItem('aa-route-v1', '[{"id":"x"}]'); });
await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#clear-all-btn')]);
await page.waitForSelector('#leaflet-map .leaflet-tile-pane', { state: 'attached' });
const keys = await page.evaluate(() => Object.keys(localStorage));
check('clear all removes the route key', !keys.includes('aa-route-v1'), keys.join(','));
check('clear all leaves no lists', (await page.locator('.brand-row').count()) === 0);

// ---- phone width
const mobile = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true });
const mp = await mobile.newPage();
await mp.goto(BASE);
await mp.waitForSelector('#leaflet-map .leaflet-tile-pane', { state: 'attached' });
check('390px: no horizontal overflow', await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
await mp.screenshot({ path: path.join(SP, 'shot-mobile.png') });

// ---- startup failure shows a banner instead of a dead page
const broken = await browser.newContext();
const bp = await broken.newPage();
await bp.route('**/vendor/leaflet/leaflet.js', (r) => r.abort());
await bp.goto(BASE);
await bp.waitForSelector('#app-error:not([hidden])', { timeout: 8000 }).catch(() => {});
check('missing map library shows an error banner', await bp.locator('#app-error').isVisible() && /could not start/i.test(await bp.textContent('#app-error')), await bp.textContent('#app-error'));

check('no page errors during the whole run', errors.length === 0, errors.join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);

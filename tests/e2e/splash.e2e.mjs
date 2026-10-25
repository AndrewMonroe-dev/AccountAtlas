// Launch splash checks in a real headless browser, over the app served by tools/server.mjs.
//
//   npm install --no-save playwright-core
//   PORT=8191 node tools/server.mjs          (in another terminal)
//   npm run test:splash
//
// BASE sets the address (default http://localhost:8191/). BROWSER_PATH points at
// Edge or Chrome (default: the Windows Edge install). Screenshots go to a fresh temp folder.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:8191/';
const EDGE = process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SP = fs.mkdtempSync(path.join(os.tmpdir(), 'account-atlas-splash-'));

let pass = 0; let fail = 0;
const check = (name, ok, extra = '') => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); };

const browser = await chromium.launch({ executablePath: EDGE });

for (const [name, viewport] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 780 }]]) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: 'commit' });

  // The animation is playing: the host holds the Lottie svg and the overlay is up.
  await page.waitForSelector('#lottie-host svg', { timeout: 5000 });
  check(`${name}: Lottie draws into the overlay`, await page.evaluate(() => !!document.querySelector('#splash #lottie-host svg')));
  await page.waitForTimeout(1800);
  await page.screenshot({ path: path.join(SP, `${name}-playing.png`) });
  const mid = await page.evaluate(() => ({
    up: !!document.getElementById('splash') && !document.getElementById('splash').classList.contains('flying'),
    hidden: getComputedStyle(document.getElementById('header-logo')).visibility === 'hidden',
  }));
  check(`${name}: still playing at 1.8 s, header logo not shown yet`, mid.up && mid.hidden, JSON.stringify(mid));

  // The flight: when the transition ends (just before the hand-over) the glyph the Lottie drew and the glyph in
  // the header logo must sit on the same spot. Glyph bounds inside each PNG were measured from the files.
  await page.waitForSelector('#splash.flying', { timeout: 8000 });
  const land = await page.evaluate(() => new Promise((resolve) => {
    const host = document.getElementById('lottie-host');
    const measure = () => {
      const img = host.querySelector('g image').getBoundingClientRect();           // 512 px Lottie canvas image
      const gl = document.querySelector('#header-logo .gl').getBoundingClientRect(); // 480 px full-square glyph layer
      const L = { x: img.x + img.width * 0.046875, w: img.width * 0.904297, y: img.y + img.height * 0.134766, h: img.height * 0.753906 };
      const H = { x: gl.x + gl.width * 0.129167, w: gl.width * 0.743750, y: gl.y + gl.height * 0.191667, h: gl.height * 0.620833 };
      resolve({ dx: Math.abs(L.x - H.x), dw: Math.abs(L.w - H.w), dy: Math.abs(L.y - H.y), dh: Math.abs(L.h - H.h), size: gl.width });
    };
    host.addEventListener('transitionend', measure, { once: true });
  }));
  const tol = Math.max(1, land.size * 0.03);
  check(`${name}: the flown glyph lands on the header glyph (off by ${land.dx.toFixed(2)}, ${land.dy.toFixed(2)} px, size ${land.dw.toFixed(2)}, ${land.dh.toFixed(2)})`,
    land.dx < tol && land.dy < tol && land.dw < tol && land.dh < tol, JSON.stringify(land));
  await page.waitForFunction(() => document.documentElement.classList.contains('logo-ready'), null, { timeout: 3000 });

  const end = await page.evaluate(() => {
    const logo = document.getElementById('header-logo').getBoundingClientRect();
    const nm = document.querySelector('.wordmark .name').getBoundingClientRect();
    return { splash: !!document.getElementById('splash'), visible: getComputedStyle(document.getElementById('header-logo')).visibility === 'visible', leftOfName: logo.right <= nm.left + 1 };
  });
  check(`${name}: overlay removed, header logo visible and left of the name`, !end.splash && end.visible && end.leftOfName, JSON.stringify(end));

  await page.reload();
  await page.waitForTimeout(500);
  const again = await page.evaluate(() => ({ splash: !!document.getElementById('splash'), visible: getComputedStyle(document.getElementById('header-logo')).visibility === 'visible' }));
  check(`${name}: a reload skips the splash and shows the logo`, !again.splash && again.visible, JSON.stringify(again));
  check(`${name}: no page errors`, errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// Reduced motion: no splash at all.
const rctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
const rpage = await rctx.newPage();
await rpage.goto(BASE);
await rpage.waitForTimeout(600);
const reduced = await rpage.evaluate(() => ({ splash: !!document.getElementById('splash'), visible: getComputedStyle(document.getElementById('header-logo')).visibility === 'visible' }));
check('reduced motion: no splash, logo shown', !reduced.splash && reduced.visible, JSON.stringify(reduced));
await rctx.close();

// Offline: after one online visit the splash files come from the cache and it still plays.
const octx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'allow' });
const opage = await octx.newPage();
await opage.goto(BASE + '?sw=1');
await opage.waitForFunction(() => navigator.serviceWorker.ready.then(() => true), null, { timeout: 8000 });
await opage.waitForTimeout(1500);
const cachedIntro = await opage.evaluate(async () => {
  const keys = await (await caches.open((await caches.keys())[0])).keys();
  const urls = keys.map((r) => r.url);
  return ['introAnimation.js', 'splash.js', 'lottie_light.min.js'].every((f) => urls.some((u) => u.includes(f)));
});
check('offline: the Lottie player, animation and splash script are in the shell cache', cachedIntro);
await octx.close();

await browser.close();
console.log(`\n${pass} passed, ${fail} failed (screenshots in ${SP})`);
process.exit(fail ? 1 : 0);

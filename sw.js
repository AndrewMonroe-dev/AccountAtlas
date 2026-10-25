// Offline shell: once the app has been opened with a connection, it opens again
// with none. The app code, the county shapes, the nearby-business snapshot and
// the libraries are cached. Map background tiles still need a signal. The data
// itself (lists, accounts, route) already lives in the browser and needs nothing.
//
// Strategy:
//   - page loads: network first (so a new version arrives at once), but after 4
//     seconds of silence fall back to the cached copy, which is what a weak
//     signal needs.
//   - everything else from this site: cache first. Files carry a ?v= marker or
//     never change within a version, and a new VERSION means a fresh cache.
//
// VERSION is rewritten by `npm run bump` together with the ?v= markers.

const VERSION = '20261024h';
const CACHE = `aa-shell-${VERSION}`;
const NEARBY_DATA_VERSION = '20261020'; // keep equal to NEARBY_DATA_VERSION in src/modules/mapView.js
const NETWORK_TIMEOUT_MS = 4000;

const v = (path) => `${path}?v=${VERSION}`;

const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  v('assets/css/tokens.css'),
  v('assets/css/app.css'),
  v('assets/css/map.css'),
  v('src/app.js'),
  v('src/core/db.js'),
  v('src/core/util.js'),
  v('src/data/csvTools.js'),
  v('src/data/diff.js'),
  v('src/data/excelParser.js'),
  v('src/data/snapshot.js'),
  v('src/modules/brief.js'),
  v('src/modules/heatmap.js'),
  v('src/modules/mapView.js'),
  v('src/modules/priorities.js'),
  v('src/modules/route.js'),
  v('src/modules/introAnimation.js'),
  v('src/modules/splash.js'),
  'vendor/lottie/lottie_light.min.js',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'vendor/markercluster/leaflet.markercluster.js',
  'vendor/markercluster/MarkerCluster.css',
  'vendor/markercluster/MarkerCluster.Default.css',
  'vendor/xlsx/xlsx.full.min.js',
  'data/geo/michigan-counties.geojson',
  `data/nearby/michigan-places.json?v=${NEARBY_DATA_VERSION}`,
  'assets/icons/favicon.ico',
  'assets/icons/icon-32.png',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/apple-touch-icon.png',
  'assets/icons/logo-square.png',
  'assets/icons/logo-glyph.png',
];

// Read by the unit test, which checks this list against the real files.
self.AA_SHELL = SHELL;
self.AA_VERSION = VERSION;
self.AA_NEARBY_VERSION = NEARBY_DATA_VERSION;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One missing file must not stop the rest from being cached. `reload` skips
    // the browser's own HTTP cache so a new version really fetches fresh files.
    await Promise.allSettled(SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('aa-shell-') && n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

// Only a plain, successful, same-site answer is worth keeping. A sign-in page
// from an access gateway arrives as a redirect and is never stored.
const cacheable = (res) => res && res.ok && res.type === 'basic' && !res.redirected;

function fetchWithTimeout(request, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(request, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetchWithTimeout(request, NETWORK_TIMEOUT_MS);
    if (cacheable(res)) cache.put(request, res.clone());
    return res;
  } catch {
    return (await cache.match(request)) || (await cache.match('./')) || (await cache.match('index.html')) || Response.error();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (cacheable(res)) cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // map tiles and the like go straight to the network
  event.respondWith(request.mode === 'navigate' ? networkFirst(request) : cacheFirst(request));
});

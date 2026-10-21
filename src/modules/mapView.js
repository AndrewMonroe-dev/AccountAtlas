// Leaflet map: county choropleth (statewide) + clustered pins (street level).
// Both live on the same map instance; Leaflet's own zoom handles the
// transition, no separate "view mode" toggle needed once real tiles are in.

let map = null;
let countyLayer = null;
let clusterGroup = null;
let countyGeoJson = null;
let onCountyClick = null;
let detailPanel = null;
let detailBody = null;

const MI_CENTER = [44.6, -85.4];
const MI_ZOOM = 6;
const PIN_TOLERANCE_PX = 22;
const COUNTY_FIT_PADDING = [40, 40];
let pinEntries = [];
let routeLayer = null;
let userLayer = null;
let onRouteToggle = null;   // (acct, wantOn) => boolean, false = refused
let routePosition = null;   // (accountId) => 1-based stop number, 0 if none
let currentPanel = null;    // { acct, brand } currently shown in the detail panel
// Once a pin is clicked the panel stays put: otherwise hovering across other
// pins on the way to the "Add to route" checkbox would swap the content out
// from under the cursor.
let panelPinned = false;

// County names typed into a real Excel by a real person rarely match the
// map's canonical Census spelling exactly -- "St. Clair" vs "Saint Clair"
// vs "st clair county" vs trailing whitespace. Every place county names
// from account data get matched against the map's own names goes through
// this instead of a raw ===.
function normalizeCountyName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\bcounty\b/g, '')
    .replace(/[.,]/g, '')
    .replace(/\bst\b/g, 'saint')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function initMap(containerId, { onCountyClickFn, onRouteToggleFn, routePositionFn } = {}) {
  onCountyClick = onCountyClickFn || null;
  onRouteToggle = onRouteToggleFn || null;
  routePosition = routePositionFn || null;

  detailPanel = document.getElementById('detail-panel');
  detailBody = document.getElementById('detail-body');
  const detailClose = document.getElementById('detail-close');
  if (detailClose) detailClose.addEventListener('click', hideDetailPanel);

  map = L.map(containerId, { zoomControl: false }).setView(MI_CENTER, MI_ZOOM);

  L.control.zoom({ position: 'bottomright' }).addTo(map);

  // Tapping bare map (outside every county shape, e.g. water) closes the store
  // panel. Pins, route badges and county shapes stop their own clicks from
  // reaching here, so opening a store is never undone by the same tap.
  map.on('click', (e) => {
    const hit = nearestPin(e.containerPoint);
    if (hit) { showDetailPanel(hit.acct, hit.brand, { pin: true }); return; }
    hideDetailPanel();
  });

  initNearby();

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  const res = await fetch('data/geo/michigan-counties.geojson');
  countyGeoJson = await res.json();

  clusterGroup = L.markerClusterGroup({
    maxClusterRadius: 50,
    spiderfyOnMaxZoom: true,
  });
  map.addLayer(clusterGroup);

  return map;
}

function countyColor(pct) {
  // pct: 0-1 penetration for the active comparison, null = no data
  if (pct === null || Number.isNaN(pct)) return 'var(--county-empty)';
  if (pct >= 0.75) return 'var(--sold)';
  if (pct >= 0.5) return 'var(--county-mid-high)';
  if (pct >= 0.25) return 'var(--county-mid-low)';
  return 'var(--unsold)';
}

// countyStats: Map<countyName, {sold, total}> -- countyName as typed in
// the source Excel, not necessarily matching the map's own spelling.
export function renderChoropleth(countyStats) {
  if (countyLayer) { map.removeLayer(countyLayer); }

  const normalizedStats = new Map();
  countyStats.forEach((v, k) => normalizedStats.set(normalizeCountyName(k), v));

  countyLayer = L.geoJSON(countyGeoJson, {
    style: (feature) => {
      const stats = normalizedStats.get(normalizeCountyName(feature.properties.name));
      const pct = stats && stats.total ? stats.sold / stats.total : null;
      return {
        color: 'var(--line)',
        weight: 1,
        fillColor: pct === null ? 'transparent' : realColor(pct),
        fillOpacity: pct === null ? 0.05 : 0.55,
      };
    },
    onEachFeature: (feature, layer) => {
      const name = feature.properties.name;
      const stats = normalizedStats.get(normalizeCountyName(name));
      const label = stats
        ? `<strong>${name} County</strong><br>${stats.sold} of ${stats.total} accounts sold`
        : `<strong>${name} County</strong><br>no accounts loaded`;
      layer.bindTooltip(label, { sticky: true, className: 'county-tooltip' });
      // Fat-finger friendly: a click that just misses a pin lands on the county
      // underneath. If a visible pin is within reach, open it instead of
      // treating the click as "navigate to this county".
      // With the store panel open, a tap on empty county space only closes it
      // (no zoom to the county in the same tap).
      layer.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        const hit = nearestPin(e.containerPoint);
        if (hit) { showDetailPanel(hit.acct, hit.brand, { pin: true }); return; }
        if (detailPanel && !detailPanel.hidden) { hideDetailPanel(); return; }
        if (onCountyClick) onCountyClick(name);
      });
      layer.on('mouseover', () => layer.setStyle({ weight: 2 }));
      layer.on('mouseout', () => layer.setStyle({ weight: 1 }));
    },
  }).addTo(map);
}

// Resolve CSS custom properties to real colors since Leaflet's canvas/SVG
// renderer doesn't understand var() the way DOM CSS does.
function realColor(pct) {
  const style = getComputedStyle(document.documentElement);
  const read = (name) => style.getPropertyValue(name).trim();
  if (pct >= 0.75) return read('--sold');
  if (pct >= 0.5) return read('--county-mid-high');
  if (pct >= 0.25) return read('--county-mid-low');
  return read('--unsold');
}

// accounts: array of account records with lat/lon set, plus brand info for
// pin color/shape and a rendered popup body.
export function renderPins(accounts, brandsById) {
  clusterGroup.clearLayers();
  pinEntries = [];
  pinCells = new Map();
  accounts.forEach((acct) => {
    if (acct.lat === null || acct.lon === null) return;
    const brand = brandsById[acct.brandId];
    const sold = Object.values(acct.skus).some(Boolean);
    const marker = L.circleMarker([acct.lat, acct.lon], {
      radius: sold ? 8 : 6,
      color: sold ? getCssVar('--pin-sold-stroke') : (brand ? brand.color : getCssVar('--pin-unsold-stroke')),
      weight: sold ? 1.5 : 2,
      fillColor: sold ? getCssVar('--pin-sold') : getCssVar('--pin-unsold'),
      fillOpacity: sold ? 0.95 : 0.85,
      className: sold ? 'pin-sold-glow' : 'pin-unsold',
    });
    marker.on('mouseover', () => showDetailPanel(acct, brand));
    marker.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      showDetailPanel(acct, brand, { pin: true });
    });
    clusterGroup.addLayer(marker);
    pinEntries.push({ marker, acct, brand });
    const cellKey = `${Math.floor(acct.lat * 1000)},${Math.floor(acct.lon * 1000)}`;
    if (!pinCells.has(cellKey)) pinCells.set(cellKey, []);
    pinCells.get(cellKey).push({ lat: acct.lat, lon: acct.lon });
  });
  // Accounts changed, so which businesses count as "already an account" did too.
  redrawNearby();
}

// Closest pin that is actually drawn on screen (not folded into a cluster;
// circle markers have no _icon so getVisibleParent cannot be used here)
// within PIN_TOLERANCE_PX of a container point, or null.
function nearestPin(containerPoint) {
  if (!map || !clusterGroup || !containerPoint) return null;
  let best = null;
  let bestDist = PIN_TOLERANCE_PX;
  for (const entry of pinEntries) {
    if (!map.hasLayer(entry.marker)) continue;
    const d = map.latLngToContainerPoint(entry.marker.getLatLng()).distanceTo(containerPoint);
    if (d <= bestDist) { best = entry; bestDist = d; }
  }
  return best;
}

function getCssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// The detail panel is deliberately sticky: it stays on screen until either
// the X is clicked or another store is hovered (which just overwrites the
// content below) -- no mouseout-hide, so it never disappears mid-look.
// Clicking a pin (pin: true) also locks it against hover swaps until the X
// or the next click, so the route checkbox is reachable.
function showDetailPanel(acct, brand, { pin = false } = {}) {
  if (!detailPanel || !detailBody) return;
  if (!pin && panelPinned) return;
  if (pin) panelPinned = true;
  currentPanel = { acct, brand };
  detailBody.innerHTML = detailHtml(acct, brand);
  detailPanel.hidden = false;
  const box = detailBody.querySelector('#route-check');
  if (box) {
    refreshRouteCheckbox();
    box.addEventListener('change', () => {
      const accepted = onRouteToggle ? onRouteToggle(acct, box.checked) : false;
      if (!accepted) box.checked = !box.checked;
      refreshRouteCheckbox();
    });
  }
}

function hideDetailPanel() {
  panelPinned = false;
  currentPanel = null;
  if (!detailPanel) return;
  detailPanel.hidden = true;
}

// Re-syncs the open panel's checkbox and "Stop N" label with the route, e.g.
// after a stop is removed from the route bar or the route is cleared.
export function refreshRouteCheckbox() {
  if (!detailBody || !currentPanel) return;
  const box = detailBody.querySelector('#route-check');
  const label = detailBody.querySelector('#route-stop-num');
  if (!box) return;
  const n = routePosition ? routePosition(currentPanel.acct.id) : 0;
  box.checked = n > 0;
  if (label) label.textContent = n > 0 ? `Stop ${n}` : '';
}

// Numbered badges (in route order) plus a dashed line joining them. They live
// in their own layer, outside the cluster group, so a stop never disappears
// into a cluster when the map is zoomed out.
export function renderRouteStops(stops) {
  if (!map) return;
  if (routeLayer) map.removeLayer(routeLayer);
  routeLayer = L.layerGroup().addTo(map);
  if (stops.length > 1) {
    L.polyline(stops.map((s) => [s.lat, s.lon]), {
      color: getCssVar('--accent'), weight: 3, opacity: 0.8, dashArray: '6 6', interactive: false,
    }).addTo(routeLayer);
  }
  stops.forEach((s, i) => {
    const icon = L.divIcon({
      className: 'route-badge', html: `<span>${i + 1}</span>`, iconSize: [26, 26], iconAnchor: [13, 13],
    });
    const badge = L.marker([s.lat, s.lon], { icon, zIndexOffset: 1000, title: s.name });
    badge.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      const entry = pinEntries.find((p) => p.acct.id === s.id);
      if (entry) showDetailPanel(entry.acct, entry.brand, { pin: true });
    });
    badge.addTo(routeLayer);
  });
  refreshRouteCheckbox();
}

export function showUserLocation(lat, lon) {
  if (!map) return;
  if (userLayer) map.removeLayer(userLayer);
  userLayer = L.circleMarker([lat, lon], {
    radius: 9, color: '#ffffff', weight: 3, fillColor: '#2a7fff', fillOpacity: 1, interactive: false,
  }).addTo(map);
}

export function fitToPoints(points, maxZoom = 13) {
  if (!map || !points.length) return;
  map.fitBounds(L.latLngBounds(points), { padding: [50, 50], maxZoom });
}

// Zoom to an account and open its panel (used by the Near me list).
export function focusAccount(accountId) {
  const entry = pinEntries.find((p) => p.acct.id === accountId);
  if (!entry || !map) return;
  map.flyTo([entry.acct.lat, entry.acct.lon], Math.max(map.getZoom(), 15));
  showDetailPanel(entry.acct, entry.brand, { pin: true });
}

// Andrew, 2026-08-21: tap-to-navigate, asked for once the mobile layout
// made it realistic someone would actually be standing near their phone
// wanting directions. Apple Maps' web link (maps.apple.com) only reliably
// opens the native app from Safari/iOS -- everywhere else (Android,
// desktop) it either fails or just shows a web preview, so this branches
// on a real iOS user-agent check rather than always using one link. Google
// Maps' `?api=1` search link is the documented universal form: opens the
// native app on Android, falls back to the web app anywhere else.
export function mapsUrlFor(acct) {
  const q = encodeURIComponent(`${acct.address}, ${acct.city}, ${acct.state || 'MI'} ${acct.zip || ''}`);
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  return isIOS ? `https://maps.apple.com/?q=${q}` : `https://www.google.com/maps/search/?api=1&query=${q}`;
}

function detailHtml(acct, brand) {
  const soldSkus = Object.entries(acct.skus).filter(([, v]) => v).map(([k]) => k);
  const unsoldSkus = Object.entries(acct.skus).filter(([, v]) => !v).map(([k]) => k);
  const chip = (name, cls) => `<span class="chip ${cls}">${name}</span>`;
  return `
    <div class="map-popup">
      <div class="pname">${escapeHtml(acct.storeName)}</div>
      <label class="route-add"><input type="checkbox" id="route-check"> <span>Add to route</span> <span class="route-stop-num" id="route-stop-num"></span></label>
      <a class="paddr" href="${mapsUrlFor(acct)}" target="_blank" rel="noopener" title="Open in Maps">${escapeHtml(acct.county || '')} County &middot; ${escapeHtml(acct.address)}, ${escapeHtml(acct.city)}</a>
      <div class="fam">${escapeHtml(brand ? brand.name : '')} &mdash; sold (${soldSkus.length})</div>
      <div class="chip-row">${soldSkus.length ? soldSkus.map((s) => chip(s, '')).join('') : '<span class="chip-empty">none</span>'}</div>
      <div class="fam">${escapeHtml(brand ? brand.name : '')} &mdash; unsold (${unsoldSkus.length})</div>
      <div class="chip-row">${unsoldSkus.length ? unsoldSkus.map((s) => chip(s, 'unsold')).join('') : '<span class="chip-empty">none</span>'}</div>
    </div>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// onlyZoomIn: used by map clicks so a stray click while already zoomed in
// tighter than the county view never zooms back out. The county dropdown
// leaves it off so it always navigates.
export function flyToCounty(countyName, { onlyZoomIn = false } = {}) {
  const target = normalizeCountyName(countyName);
  const feature = countyGeoJson.features.find((f) => normalizeCountyName(f.properties.name) === target);
  if (!feature) {
    console.warn(`No county on the map matches "${countyName}" (normalized: "${target}"). Map county names: ${countyGeoJson.features.map((f) => f.properties.name).join(', ')}`);
    return;
  }
  const bounds = L.geoJSON(feature).getBounds();
  if (onlyZoomIn) {
    const fitZoom = map.getBoundsZoom(bounds, false, L.point(COUNTY_FIT_PADDING[0] * 2, COUNTY_FIT_PADDING[1] * 2));
    if (map.getZoom() >= fitZoom) return;
  }
  map.fitBounds(bounds, { padding: COUNTY_FIT_PADDING });
}

// ---------------------------------------------------------------------------
// Nearby businesses (2026-10-21): at street zoom, stores and bars/restaurants
// from OpenStreetMap, drawn as small gray markers so they read as "not one of
// my accounts". Data comes from the public Overpass API, which is community
// run with fair-use limits, so this loads only when the map has stopped
// moving, never re-asks for an area it already has, and backs off for 30s on
// any failure. Only the visible map rectangle is sent, nothing from the
// account lists, and nothing is stored. A business within 40 m of one of the
// user's own account pins is hidden on the assumption it is that account.
// ---------------------------------------------------------------------------
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const NEARBY_KEY = 'aa-nearby-v1';
const NEARBY_MIN_ZOOM = 15;
const NEARBY_LABEL_ZOOM = 17;       // names beside the markers from here in
const NEARBY_LABEL_MAX_CHARS = 26;
const NEARBY_MAX = 300;
const NEARBY_HIDE_WITHIN_M = 40;
const NEARBY_RETRY_MS = 30000;
const NEARBY_PLACE_CAP = 3000;
const SHOP_LABELS = {
  alcohol: 'Liquor store', wine: 'Wine shop', supermarket: 'Supermarket',
  convenience: 'Convenience store', beverages: 'Beverage store',
};
const AMENITY_LABELS = { fuel: 'Gas station', bar: 'Bar', pub: 'Pub', restaurant: 'Restaurant' };

let nearbyOn = true;
let nearbyLayer = null;
let nearbyPlaces = new Map();   // osm id -> { id, name, kind, label, lat, lon, addr }
let nearbyCovered = [];         // [{ box, zoom, truncated }] areas already fetched
let nearbyBusy = false;
let nearbyAgain = false;
let nearbyBlockedUntil = 0;
let nearbyTimer = null;
let nearbyMsg = '';
let pinCells = new Map();       // spatial hash of account pins, ~100 m cells

function readNearbyPref() {
  try { return localStorage.getItem(NEARBY_KEY) !== 'off'; } catch { return true; }
}
function writeNearbyPref(on) {
  try { localStorage.setItem(NEARBY_KEY, on ? 'on' : 'off'); } catch { /* storage blocked */ }
}

function initNearby() {
  nearbyOn = readNearbyPref();
  nearbyLayer = L.layerGroup();
  const toggle = document.getElementById('nearby-toggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      nearbyOn = !nearbyOn;
      writeNearbyPref(nearbyOn);
      nearbyMsg = '';
      nearbyBlockedUntil = 0;
      syncNearby();
      redrawNearby();
      if (nearbyOn) loadNearby();
    });
  }
  map.on('moveend', () => { syncNearby(); redrawNearby(); scheduleNearby(); });
  syncNearby();
}

function scheduleNearby() {
  clearTimeout(nearbyTimer);
  nearbyTimer = setTimeout(loadNearby, 700);
}

// Shows or hides the layer for the current zoom, and keeps the toggle button
// and the small status line in step.
function syncNearby() {
  if (!map || !nearbyLayer) return;
  const zoomedIn = map.getZoom() >= NEARBY_MIN_ZOOM;
  const show = nearbyOn && zoomedIn;
  if (show && !map.hasLayer(nearbyLayer)) map.addLayer(nearbyLayer);
  if (!show && map.hasLayer(nearbyLayer)) map.removeLayer(nearbyLayer);
  const toggle = document.getElementById('nearby-toggle');
  if (toggle) {
    toggle.textContent = nearbyOn ? '\u{1F3EA} Nearby: on' : '\u{1F3EA} Nearby: off';
    toggle.setAttribute('aria-pressed', String(nearbyOn));
  }
  const status = document.getElementById('nearby-status');
  if (status) {
    const text = !nearbyOn ? '' : (nearbyMsg || (zoomedIn ? '' : 'Zoom in closer to see nearby businesses.'));
    status.textContent = text;
    status.hidden = !text;
  }
}

async function loadNearby() {
  if (!map || !nearbyOn || map.getZoom() < NEARBY_MIN_ZOOM) return;
  if (nearbyBusy) { nearbyAgain = true; return; }
  if (Date.now() < nearbyBlockedUntil) {
    // Panning during the back-off replaced the retry timer, so re-arm it for
    // the moment the back-off ends.
    clearTimeout(nearbyTimer);
    nearbyTimer = setTimeout(loadNearby, nearbyBlockedUntil - Date.now() + 500);
    return;
  }
  const view = map.getBounds();
  const zoom = map.getZoom();
  // A box that hit the cap only covers views at its own zoom or wider: a closer
  // view of it may hold businesses that were cut off.
  if (nearbyCovered.some((c) => (!c.truncated || zoom <= c.zoom) && c.box.contains(view))) return;

  const box = view.pad(0.25);
  const bbox = [box.getSouth(), box.getWest(), box.getNorth(), box.getEast()].map((v) => v.toFixed(5)).join(',');
  const query = '[out:json][timeout:20];('
    + `nwr["shop"~"^(alcohol|wine|supermarket|convenience|beverages)$"](${bbox});`
    + `nwr["amenity"~"^(fuel|bar|pub|restaurant)$"](${bbox});`
    + `);out center ${NEARBY_MAX};`;

  nearbyBusy = true;
  nearbyMsg = 'Loading nearby businesses...';
  syncNearby();
  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const elements = Array.isArray(data.elements) ? data.elements : [];
    // Overpass reports a server-side timeout as a normal 200 with a remark.
    if (data.remark && !elements.length) throw new Error(data.remark);
    if (nearbyPlaces.size > NEARBY_PLACE_CAP) { nearbyPlaces = new Map(); nearbyCovered = []; }
    addNearbyElements(elements);
    const truncated = elements.length >= NEARBY_MAX;
    nearbyCovered.push({ box, zoom, truncated });
    nearbyMsg = truncated ? `Dense area: showing the first ${NEARBY_MAX} businesses here. Zoom in for more.` : '';
  } catch (err) {
    nearbyBlockedUntil = Date.now() + NEARBY_RETRY_MS;
    nearbyMsg = 'Nearby businesses are unavailable right now. Retrying shortly.';
    clearTimeout(nearbyTimer);
    nearbyTimer = setTimeout(loadNearby, NEARBY_RETRY_MS + 500);
  } finally {
    clearTimeout(timeout);
    nearbyBusy = false;
  }
  syncNearby();
  redrawNearby();
  if (nearbyAgain) { nearbyAgain = false; scheduleNearby(); }
}

function addNearbyElements(elements) {
  elements.forEach((el) => {
    const tags = el.tags || {};
    const lat = el.lat !== undefined ? el.lat : (el.center && el.center.lat);
    const lon = el.lon !== undefined ? el.lon : (el.center && el.center.lon);
    if (!tags.name || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const label = SHOP_LABELS[tags.shop] || AMENITY_LABELS[tags.amenity];
    if (!label) return;
    const id = `${el.type}${el.id}`;
    if (nearbyPlaces.has(id)) return;
    const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
    const addr = [street, tags['addr:city']].filter(Boolean).join(', ');
    const kind = ['bar', 'pub', 'restaurant'].includes(tags.amenity) ? 'onprem' : 'store';
    nearbyPlaces.set(id, { id, name: tags.name, kind, label, lat, lon, addr });
  });
}

function nearAnAccount(lat, lon) {
  const ci = Math.floor(lat * 1000);
  const cj = Math.floor(lon * 1000);
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const cell = pinCells.get(`${ci + di},${cj + dj}`);
      if (!cell) continue;
      for (const p of cell) {
        if (map.distance([lat, lon], [p.lat, p.lon]) < NEARBY_HIDE_WITHIN_M) return true;
      }
    }
  }
  return false;
}

// Draws only what is near the current view, so the DOM stays small however
// much has been fetched while panning around.
function redrawNearby() {
  if (!map || !nearbyLayer) return;
  nearbyLayer.clearLayers();
  if (!nearbyOn || map.getZoom() < NEARBY_MIN_ZOOM) return;
  const view = map.getBounds().pad(0.5);
  const visible = [];
  nearbyPlaces.forEach((p) => {
    if (!view.contains([p.lat, p.lon]) || nearAnAccount(p.lat, p.lon)) return;
    visible.push(p);
  });
  const labelled = map.getZoom() >= NEARBY_LABEL_ZOOM ? pickNearbyLabels(visible) : new Set();
  visible.forEach((p) => {
    const label = labelled.has(p.id) ? `<b class="nearby-label">${escapeHtml(shortName(p.name))}</b>` : '';
    const icon = L.divIcon({
      className: `nearby-pin ${p.kind}`, html: `<span></span>${label}`, iconSize: [26, 26], iconAnchor: [13, 13],
    });
    const marker = L.marker([p.lat, p.lon], { icon, zIndexOffset: -500, title: p.name });
    marker.bindPopup(nearbyPopupHtml(p));
    marker.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      hideDetailPanel();
    });
    marker.addTo(nearbyLayer);
  });
}

function shortName(name) {
  return name.length > NEARBY_LABEL_MAX_CHARS ? name.slice(0, NEARBY_LABEL_MAX_CHARS - 1).trimEnd() + '…' : name;
}

// Which businesses get a name drawn beside their marker. Greedy, top to bottom:
// a label is skipped if it would cover another marker, one of the user's own
// account pins, or a label already placed. A skipped business keeps its marker
// and still shows its name in the tap popup.
function pickNearbyLabels(places) {
  const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const taken = [];
  places.forEach((p) => {
    const pt = map.latLngToContainerPoint([p.lat, p.lon]);
    taken.push({ x: pt.x - 8, y: pt.y - 8, w: 16, h: 16 });
  });
  const bounds = map.getBounds().pad(0.1);
  pinEntries.forEach((e) => {
    if (!bounds.contains([e.acct.lat, e.acct.lon])) return;
    const pt = map.latLngToContainerPoint([e.acct.lat, e.acct.lon]);
    taken.push({ x: pt.x - 10, y: pt.y - 10, w: 20, h: 20 });
  });
  const chosen = new Set();
  places
    .map((p) => ({ p, pt: map.latLngToContainerPoint([p.lat, p.lon]) }))
    .sort((a, b) => a.pt.y - b.pt.y || a.pt.x - b.pt.x)
    .forEach(({ p, pt }) => {
      const width = Math.min(170, shortName(p.name).length * 7.6 + 6);
      const rect = { x: pt.x + 12, y: pt.y - 9, w: width, h: 18 };
      if (taken.some((t) => overlaps(t, rect))) return;
      taken.push(rect);
      chosen.add(p.id);
    });
  return chosen;
}

function nearbyPopupHtml(p) {
  const link = `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lon}`;
  return `<div class="map-popup nearby-popup">
      <div class="pname">${escapeHtml(p.name)}</div>
      <div class="paddr">${escapeHtml(p.label)}${p.addr ? ' &middot; ' + escapeHtml(p.addr) : ''}</div>
      <div class="fam">Not in your lists</div>
      <a class="nearby-link" href="${link}" target="_blank" rel="noopener">Open in Google Maps</a>
    </div>`;
}

export function getMap() { return map; }

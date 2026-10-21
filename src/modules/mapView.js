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
  });
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

export function getMap() { return map; }

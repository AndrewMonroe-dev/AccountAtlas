// Leaflet map: county choropleth (statewide) + clustered pins (street level).
// Both live on the same map instance; Leaflet's own zoom handles the
// transition, no separate "view mode" toggle needed once real tiles are in.

import { formatAmount } from './heatmap.js?v=20261024b';
import { escapeHtml, normalizeCountyName } from '../core/util.js?v=20261024b';

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
let placing = null;         // callback while the next tap places an account, else null
let pinsVisible = true;
let routeLayer = null;
let userLayer = null;
let onRouteToggle = null;   // (acct, wantOn) => boolean, false = refused
let routePosition = null;   // (accountId) => 1-based stop number, 0 if none
let currentPanel = null;    // { acct, brand } currently shown in the detail panel
// Once a pin is clicked the panel stays put: otherwise hovering across other
// pins on the way to the "Add to route" checkbox would swap the content out
// from under the cursor.
let panelPinned = false;
let onPlaceToggle = null;   // (place, wantOn) => boolean, false = refused
let placePosition = null;   // (place) => 1-based stop number, 0 if none
let openPlace = null;       // gray business whose popup is open, { place, marker }

export async function initMap(containerId, {
  onCountyClickFn, onRouteToggleFn, routePositionFn, onPlaceToggleFn, placePositionFn,
} = {}) {
  onCountyClick = onCountyClickFn || null;
  onRouteToggle = onRouteToggleFn || null;
  routePosition = routePositionFn || null;
  onPlaceToggle = onPlaceToggleFn || null;
  placePosition = placePositionFn || null;

  detailPanel = document.getElementById('detail-panel');
  detailBody = document.getElementById('detail-body');
  const detailClose = document.getElementById('detail-close');
  if (detailClose) detailClose.addEventListener('click', hideDetailPanel);

  if (typeof L === 'undefined' || !L.markerClusterGroup) {
    throw new Error('The map library did not load. Check your connection and reload.');
  }
  map = L.map(containerId, { zoomControl: false }).setView(MI_CENTER, MI_ZOOM);

  L.control.zoom({ position: 'bottomright' }).addTo(map);

  // Tapping bare map (outside every county shape, e.g. water) closes the store
  // panel. Pins, route badges and county shapes stop their own clicks from
  // reaching here, so opening a store is never undone by the same tap.
  map.on('click', (e) => {
    if (takePlacement(e.latlng)) return;
    const hit = nearestPin(e.containerPoint);
    if (hit) { showDetailPanel(hit.acct, hit.brand, { pin: true }); return; }
    hideDetailPanel();
  });

  initNearby();
  wirePlacePopups();

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  const res = await fetch('data/geo/michigan-counties.geojson');
  if (!res.ok) throw new Error(`The county map file did not load (HTTP ${res.status}).`);
  countyGeoJson = await res.json();

  clusterGroup = L.markerClusterGroup({
    maxClusterRadius: 50,
    spiderfyOnMaxZoom: true,
  });
  map.addLayer(clusterGroup);

  return map;
}

// countyStats: Map<countyName, {sold, total}> -- keyed by any spelling, matched
// to the map through normalizeCountyName.
// heat (optional, volume heatmap): { values: Map<countyName, {volume, accounts,
// value}>, colorFor(value) } -- when given, counties are shaded by value
// instead of by sold percentage.
// shadeOn false: no shading at all (the "Heat: off" toggle), counties are
// see-through outlines that still show tooltips and take clicks.
//
// The county shapes are built once. Every later call only restyles them and
// swaps their tooltip text, which is far cheaper than rebuilding 83 polygons.
export function renderChoropleth(countyStats, heat = null, shadeOn = true) {
  const stats = new Map();
  countyStats.forEach((v, k) => stats.set(normalizeCountyName(k), v));
  const heatBy = new Map();
  if (heat) heat.values.forEach((v, k) => heatBy.set(normalizeCountyName(k), v));
  const palette = shadeOn && !heat ? readSoldPalette() : null;

  const styleFor = (feature) => {
    const key = normalizeCountyName(feature.properties.name);
    if (!shadeOn) return { color: 'var(--line)', weight: 1, fillColor: 'transparent', fillOpacity: 0.05 };
    if (heat) {
      const h = heatBy.get(key);
      return { color: 'var(--line)', weight: 1, fillColor: h ? heat.colorFor(h.value) : 'transparent', fillOpacity: h ? 0.85 : 0.05 };
    }
    const st = stats.get(key);
    const pct = st && st.total ? st.sold / st.total : null;
    return { color: 'var(--line)', weight: 1, fillColor: pct === null ? 'transparent' : palette(pct), fillOpacity: pct === null ? 0.05 : 0.55 };
  };

  const labelFor = (feature) => {
    const name = escapeHtml(feature.properties.name);
    const key = normalizeCountyName(feature.properties.name);
    const h = heat ? heatBy.get(key) : null;
    if (h) {
      return `<strong>${name} County</strong><br>${formatAmount(h.volume)} total &middot; ${h.accounts} account${h.accounts === 1 ? '' : 's'}<br>${formatAmount(h.accounts ? h.volume / h.accounts : 0)} per account`;
    }
    const st = stats.get(key);
    return st
      ? `<strong>${name} County</strong><br>${st.sold} of ${st.total} accounts sold`
      : `<strong>${name} County</strong><br>no accounts loaded`;
  };

  if (!countyLayer) {
    countyLayer = L.geoJSON(countyGeoJson, {
      style: styleFor,
      onEachFeature: (feature, layer) => {
        const name = feature.properties.name;
        layer.bindTooltip(labelFor(feature), { sticky: true, className: 'county-tooltip' });
        // Fat-finger friendly: a click that just misses a pin lands on the county
        // underneath. If a visible pin is within reach, open it instead of
        // treating the click as "navigate to this county".
        // With the store panel open, a tap on empty county space only closes it
        // (no zoom to the county in the same tap).
        layer.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          if (takePlacement(e.latlng)) return;
          const hit = nearestPin(e.containerPoint);
          if (hit) { showDetailPanel(hit.acct, hit.brand, { pin: true }); return; }
          if (detailPanel && !detailPanel.hidden) { hideDetailPanel(); return; }
          if (onCountyClick) onCountyClick(name);
        });
        layer.on('mouseover', () => layer.setStyle({ weight: 2 }));
        layer.on('mouseout', () => layer.setStyle({ weight: 1 }));
      },
    }).addTo(map);
    return;
  }
  countyLayer.eachLayer((layer) => {
    layer.setStyle(styleFor(layer.feature));
    layer.setTooltipContent(labelFor(layer.feature));
  });
}

// The map renderer does not resolve var() for fill colors, so the sold
// percentage palette is read from the CSS tokens once per render.
function readSoldPalette() {
  const colors = {
    high: getCssVar('--sold'), midHigh: getCssVar('--county-mid-high'),
    midLow: getCssVar('--county-mid-low'), low: getCssVar('--unsold'),
  };
  return (pct) => {
    if (pct >= 0.75) return colors.high;
    if (pct >= 0.5) return colors.midHigh;
    if (pct >= 0.25) return colors.midLow;
    return colors.low;
  };
}

// accounts: array of account records with lat/lon set, plus brand info for
// pin color/shape and a rendered popup body.
export function renderPins(accounts, brandsById) {
  // Nothing about the dots changed (the common case: a shade, Dots or Heat
  // switch), so keep the existing markers instead of rebuilding thousands.
  const same = accounts.length === pinEntries.length
    && accounts.every((a, i) => pinEntries[i].acct === a && pinEntries[i].brand === brandsById[a.brandId]);
  if (same) return;

  clusterGroup.clearLayers();
  pinEntries = [];
  pinCells = new Map();
  const c = {
    soldStroke: getCssVar('--pin-sold-stroke'), unsoldStroke: getCssVar('--pin-unsold-stroke'),
    sold: getCssVar('--pin-sold'), unsold: getCssVar('--pin-unsold'),
  };
  const markers = [];
  accounts.forEach((acct) => {
    if (acct.lat === null || acct.lon === null) return;
    const brand = brandsById[acct.brandId];
    const sold = Object.values(acct.skus).some(Boolean);
    const marker = L.circleMarker([acct.lat, acct.lon], {
      radius: sold ? 8 : 6,
      color: sold ? c.soldStroke : (brand ? brand.color : c.unsoldStroke),
      weight: sold ? 1.5 : 2,
      fillColor: sold ? c.sold : c.unsold,
      fillOpacity: sold ? 0.95 : 0.85,
      className: sold ? 'pin-sold-glow' : 'pin-unsold',
    });
    marker.on('mouseover', () => showDetailPanel(acct, brand));
    marker.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      if (takePlacement(e.latlng)) return;
      showDetailPanel(acct, brand, { pin: true });
    });
    markers.push(marker);
    pinEntries.push({ marker, acct, brand });
    const cellKey = `${Math.floor(acct.lat * 1000)},${Math.floor(acct.lon * 1000)}`;
    if (!pinCells.has(cellKey)) pinCells.set(cellKey, []);
    pinCells.get(cellKey).push({ lat: acct.lat, lon: acct.lon });
  });
  clusterGroup.addLayers(markers);
  // Accounts changed, so which businesses count as "already an account" did too.
  redrawNearby();
}

// Dots on/off (2026-10-22): hides every account pin and cluster so only the
// county shading shows. Route badges and nearby businesses are separate layers
// and stay.
export function setPinsVisible(on) {
  pinsVisible = on;
  if (!map || !clusterGroup) return;
  if (on && !map.hasLayer(clusterGroup)) map.addLayer(clusterGroup);
  if (!on && map.hasLayer(clusterGroup)) { map.removeLayer(clusterGroup); hideDetailPanel(); }
}

// Closest pin that is actually drawn on screen (not folded into a cluster;
// circle markers have no _icon so getVisibleParent cannot be used here)
// within PIN_TOLERANCE_PX of a container point, or null.
function nearestPin(containerPoint) {
  if (!map || !clusterGroup || !containerPoint || !pinsVisible) return null;
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

// Placing an account by hand: the next tap on the map (a county, an empty spot,
// a pin or a gray business) is handed to onDone as { lat, lon }. cancelPlacement
// hands it null instead.
export function beginPlacement(onDone) {
  if (!map) return;
  cancelPlacement();
  hideDetailPanel();
  placing = onDone;
  map.getContainer().classList.add('placing');
}

export function cancelPlacement() {
  if (!placing) return;
  const done = placing;
  placing = null;
  if (map) map.getContainer().classList.remove('placing');
  done(null);
}

export function isPlacing() { return !!placing; }

function takePlacement(latlng) {
  if (!placing) return false;
  const done = placing;
  placing = null;
  map.getContainer().classList.remove('placing');
  done({ lat: latlng.lat, lon: latlng.lng });
  return true;
}

export function closeDetailPanel() { hideDetailPanel(); }

export function isDetailOpen() { return !!detailPanel && !detailPanel.hidden; }

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
      else if (s.kind === 'place') { hideDetailPanel(); openPlacePopupAt(s); }
    });
    badge.addTo(routeLayer);
  });
  refreshRouteCheckbox();
  refreshPlaceButton();
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
  const chip = (name, cls) => `<span class="chip ${cls}">${escapeHtml(name)}</span>`;
  return `
    <div class="map-popup">
      <div class="pname">${escapeHtml(acct.storeName)}</div>
      <label class="route-add"><input type="checkbox" id="route-check"> <span>Add to route</span> <span class="route-stop-num" id="route-stop-num"></span></label>
      <a class="paddr" href="${mapsUrlFor(acct)}" target="_blank" rel="noopener" title="Open in Maps">${escapeHtml(acct.county || '')} County &middot; ${escapeHtml(acct.address)}, ${escapeHtml(acct.city)}</a>
      ${acct.geocodeStatus === 'manual' ? '<div class="placed-note">Placed by hand</div>' : ''}
      <div class="fam">${escapeHtml(brand ? brand.name : '')} &mdash; sold (${soldSkus.length})</div>
      <div class="chip-row">${soldSkus.length ? soldSkus.map((s) => chip(s, '')).join('') : '<span class="chip-empty">none</span>'}</div>
      <div class="fam">${escapeHtml(brand ? brand.name : '')} &mdash; unsold (${unsoldSkus.length})</div>
      <div class="chip-row">${unsoldSkus.length ? unsoldSkus.map((s) => chip(s, 'unsold')).join('') : '<span class="chip-empty">none</span>'}</div>
    </div>`;
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
// Nearby businesses (2026-10-21): at street zoom, stores, gas stations and
// bars/restaurants from OpenStreetMap, drawn as small gray markers so they read
// as "not one of my accounts". The data is a static snapshot built from the
// Michigan OpenStreetMap extract (tools/buildNearbyPlaces.py ->
// data/nearby/michigan-places.json), so there is no live server to be busy or
// blocked: one file, fetched the first time the layer is needed, then indexed
// in memory. Nothing about the user's map view or accounts leaves the device.
// A business within 40 m of one of the user's own account pins is hidden on the
// assumption it is that account.
//
// Data (c) OpenStreetMap contributors, ODbL 1.0. Bump NEARBY_DATA_VERSION
// whenever the file is rebuilt so browsers fetch the new copy.
// ---------------------------------------------------------------------------
const NEARBY_DATA_VERSION = '20261020';
const NEARBY_DATA_URL = `data/nearby/michigan-places.json?v=${NEARBY_DATA_VERSION}`;
const NEARBY_KEY = 'aa-nearby-v1';
const NEARBY_MIN_ZOOM = 15;
const NEARBY_LABEL_ZOOM = 17;       // names beside the markers from here in
const NEARBY_LABEL_MAX_CHARS = 26;
const NEARBY_MAX = 300;             // most markers drawn at once, nearest the view centre first
const NEARBY_HIDE_WITHIN_M = 40;
const NEARBY_RETRY_MS = 30000;
const NEARBY_CELL = 0.01;           // search-grid cell in degrees, about 1 km
const ON_PREMISE_LABELS = ['Bar', 'Pub', 'Restaurant'];

let nearbyOn = true;
let nearbyLayer = null;
let nearbyData = null;          // { asOf, grid: Map cellKey -> [place] }
let nearbyLoading = null;       // in-flight load, so it is only started once
let nearbyRetryAfter = 0;
let nearbyLoadMsg = '';         // "Loading..." or a load failure
let nearbyDenseMsg = '';        // set when more were in view than are drawn
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
      nearbyRetryAfter = 0;
      refreshNearby();
    });
  }
  map.on('moveend', refreshNearby);
  syncNearby();
}

// One entry point for "the map moved / the toggle changed": make sure the data
// is loaded when it is needed, then redraw for the current view.
function refreshNearby() {
  syncNearby();
  if (nearbyOn && map.getZoom() >= NEARBY_MIN_ZOOM && !nearbyData && Date.now() >= nearbyRetryAfter) {
    loadNearbyData().then(() => { syncNearby(); redrawNearby(); }).catch(() => syncNearby());
  }
  redrawNearby();
}

function loadNearbyData() {
  if (nearbyData) return Promise.resolve(nearbyData);
  if (nearbyLoading) return nearbyLoading;
  nearbyLoadMsg = 'Loading nearby businesses...';
  syncNearby();
  nearbyLoading = fetch(NEARBY_DATA_URL)
    .then((res) => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then((data) => {
      const labels = data.labels || [];
      const grid = new Map();
      (data.places || []).forEach((row, i) => {
        const [lat, lon, name, labelIdx, addr] = row;
        const label = labels[labelIdx];
        if (!name || !label || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
        const place = {
          id: i, name, label, lat, lon, addr: addr || '',
          kind: ON_PREMISE_LABELS.includes(label) ? 'onprem' : 'store',
        };
        const key = `${Math.floor(lat / NEARBY_CELL)},${Math.floor(lon / NEARBY_CELL)}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(place);
      });
      nearbyData = { asOf: data.asOf || '', grid };
      nearbyLoadMsg = '';
      return nearbyData;
    })
    .catch((err) => {
      nearbyRetryAfter = Date.now() + NEARBY_RETRY_MS;
      nearbyLoadMsg = 'Nearby businesses could not be loaded. They will be retried when you move the map.';
      throw err;
    })
    .finally(() => { nearbyLoading = null; });
  return nearbyLoading;
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
    const text = !nearbyOn ? '' : (nearbyLoadMsg || (zoomedIn ? nearbyDenseMsg : 'Zoom in closer to see nearby businesses.'));
    status.textContent = text;
    status.hidden = !text;
  }
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

// Everything in the data inside a lat/lon rectangle, via the search grid.
function nearbyPlacesIn(bounds) {
  const out = [];
  const i0 = Math.floor(bounds.getSouth() / NEARBY_CELL);
  const i1 = Math.floor(bounds.getNorth() / NEARBY_CELL);
  const j0 = Math.floor(bounds.getWest() / NEARBY_CELL);
  const j1 = Math.floor(bounds.getEast() / NEARBY_CELL);
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      const cell = nearbyData.grid.get(`${i},${j}`);
      if (!cell) continue;
      for (const p of cell) if (bounds.contains([p.lat, p.lon])) out.push(p);
    }
  }
  return out;
}

// Draws only what is in (or just outside) the current view, and never more than
// NEARBY_MAX markers, so the DOM stays small in a dense city.
function redrawNearby() {
  if (!map || !nearbyLayer) return;
  // Clearing the layer closes an open popup. Adding a stop can resize the map
  // (the route bar appears), which redraws this layer, so reopen that popup.
  const keepOpen = openPlace ? openPlace.place : null;
  nearbyLayer.clearLayers();
  nearbyDenseMsg = '';
  if (!nearbyOn || map.getZoom() < NEARBY_MIN_ZOOM || !nearbyData) { syncNearby(); return; }
  const centre = map.getCenter();
  let visible = nearbyPlacesIn(map.getBounds().pad(0.1)).filter((p) => !nearAnAccount(p.lat, p.lon));
  if (visible.length > NEARBY_MAX) {
    visible = visible
      .map((p) => ({ p, d: map.distance(centre, [p.lat, p.lon]) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, NEARBY_MAX)
      .map((x) => x.p);
    nearbyDenseMsg = `Dense area: showing the closest ${NEARBY_MAX} businesses. Zoom in for more.`;
  }
  syncNearby();
  const labelled = map.getZoom() >= NEARBY_LABEL_ZOOM ? pickNearbyLabels(visible) : new Set();
  visible.forEach((p) => {
    const label = labelled.has(p.id) ? `<b class="nearby-label">${escapeHtml(shortName(p.name))}</b>` : '';
    const icon = L.divIcon({
      className: `nearby-pin ${p.kind}`, html: `<span></span>${label}`, iconSize: [26, 26], iconAnchor: [13, 13],
    });
    const marker = L.marker([p.lat, p.lon], { icon, zIndexOffset: -500, title: p.name });
    marker.bindPopup(nearbyPopupHtml(p));
    marker.getPopup()._place = p;
    marker.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      // While placing an account, tapping a gray business puts it right there.
      if (takePlacement(marker.getLatLng())) return;
      hideDetailPanel();
    });
    marker.addTo(nearbyLayer);
    if (keepOpen && keepOpen.lat === p.lat && keepOpen.lon === p.lon && keepOpen.name === p.name) marker.openPopup();
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
    if (!pinsVisible || !bounds.contains([e.acct.lat, e.acct.lon])) return;
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

function nearbyAsOfText() {
  const d = nearbyData && nearbyData.asOf ? new Date(nearbyData.asOf + 'T00:00:00') : null;
  const when = d && !Number.isNaN(d.getTime())
    ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  return `OpenStreetMap data${when ? ' as of ' + escapeHtml(when) : ''}`;
}

// Popups for gray businesses carry their place in `_place`: opened from the
// gray marker, or from the route badge sitting on top of it. Wires the button.
function wirePlacePopups() {
  map.on('popupopen', (e) => {
    const p = e.popup._place;
    if (!p) return;
    openPlace = { place: p, popup: e.popup };
    const btn = e.popup.getElement().querySelector('.nearby-route');
    if (btn) {
      btn.addEventListener('click', () => {
        const on = placePosition ? placePosition(p) > 0 : false;
        if (onPlaceToggle) onPlaceToggle(p, !on);
        refreshPlaceButton();
      });
    }
    refreshPlaceButton();
  });
  map.on('popupclose', (e) => { if (openPlace && openPlace.popup === e.popup) openPlace = null; });
}

// The route badge sits on top of its gray marker, so a tap on the badge of a
// gray-business stop opens that business's popup (where it can be removed).
function openPlacePopupAt(stop) {
  const place = { name: stop.name, label: stop.label || '', addr: stop.addr || '', lat: stop.lat, lon: stop.lon };
  const popup = L.popup().setLatLng([stop.lat, stop.lon]).setContent(nearbyPopupHtml(place));
  popup._place = place;
  popup.openOn(map);
}

// Keeps the open gray-business popup's route button in step with the route,
// e.g. after the stop is removed from the route bar.
function refreshPlaceButton() {
  if (!openPlace) return;
  const popup = openPlace.popup;
  const btn = popup.getElement() && popup.getElement().querySelector('.nearby-route');
  if (!btn) return;
  const n = placePosition ? placePosition(openPlace.place) : 0;
  btn.textContent = n > 0 ? `Stop ${n} · Remove from route` : 'Add to route';
  btn.classList.toggle('on', n > 0);
}

function nearbyPopupHtml(p) {
  const link = `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lon}`;
  return `<div class="map-popup nearby-popup">
      <div class="pname">${escapeHtml(p.name)}</div>
      <div class="paddr">${escapeHtml(p.label)}${p.addr ? ' &middot; ' + escapeHtml(p.addr) : ''}</div>
      <div class="fam">Not in your lists</div>
      <button type="button" class="nearby-route">Add to route</button>
      <div class="nearby-asof">${nearbyAsOfText()}</div>
      <a class="nearby-link" href="${link}" target="_blank" rel="noopener">Open in Google Maps</a>
    </div>`;
}

export function getMap() { return map; }

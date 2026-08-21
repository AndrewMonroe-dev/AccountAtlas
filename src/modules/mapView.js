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

export async function initMap(containerId, { onCountyClickFn } = {}) {
  onCountyClick = onCountyClickFn || null;

  detailPanel = document.getElementById('detail-panel');
  detailBody = document.getElementById('detail-body');
  const detailClose = document.getElementById('detail-close');
  if (detailClose) detailClose.addEventListener('click', hideDetailPanel);

  map = L.map(containerId, { zoomControl: false }).setView(MI_CENTER, MI_ZOOM);

  L.control.zoom({ position: 'bottomright' }).addTo(map);

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
      layer.on('click', () => { if (onCountyClick) onCountyClick(name); });
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
    clusterGroup.addLayer(marker);
  });
}

function getCssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// The detail panel is deliberately sticky: it stays on screen until either
// the X is clicked or another store is hovered (which just overwrites the
// content below) -- no mouseout-hide, so it never disappears mid-look.
function showDetailPanel(acct, brand) {
  if (!detailPanel || !detailBody) return;
  detailBody.innerHTML = detailHtml(acct, brand);
  detailPanel.hidden = false;
}

function hideDetailPanel() {
  if (!detailPanel) return;
  detailPanel.hidden = true;
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

export function flyToCounty(countyName) {
  const target = normalizeCountyName(countyName);
  const feature = countyGeoJson.features.find((f) => normalizeCountyName(f.properties.name) === target);
  if (!feature) {
    console.warn(`No county on the map matches "${countyName}" (normalized: "${target}"). Map county names: ${countyGeoJson.features.map((f) => f.properties.name).join(', ')}`);
    return;
  }
  const layer = L.geoJSON(feature);
  map.fitBounds(layer.getBounds(), { padding: [40, 40] });
}

export function getMap() { return map; }

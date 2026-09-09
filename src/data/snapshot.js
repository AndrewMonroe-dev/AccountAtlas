// Portable brand snapshot: everything for one brand (its record + every
// account, including resolved lat/lon) as a single JSON file. Built for
// moving fully-geocoded data from a machine that can run the local
// geocoding server to one that can't (e.g. a locked-down work computer
// with no installs allowed) -- geocode once wherever Node is available,
// then import the finished result anywhere with just a browser.

export function exportBrandSnapshot(brand, accounts) {
  const snapshot = {
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    brand,
    accounts,
  };
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${brand.name.replace(/\s+/g, '-')}-snapshot.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// Standalone viewer: one self-contained .html file with a brand's map +
// data baked directly in (Leaflet/MarkerCluster still load from their own
// CDN, everything else inline). No server, no Cloudflare Access login, no
// Account Atlas install -- open it in any browser, on any computer,
// including one you don't control. Meant for sharing with someone who
// isn't (and won't be) an Access-allowed user, as an addition alongside
// the JSON snapshot above, not a replacement for it -- the JSON snapshot
// stays the format for moving data between your own computers/back into
// the real app; this is a save-and-reopen-anywhere leave-behind. Andrew
// can save the downloaded file and reopen it again later exactly like any
// other file on disk.
export async function exportStandaloneViewer(brand, accounts) {
  const geoRes = await fetch('data/geo/michigan-counties.geojson');
  const countyGeoJson = await geoRes.json();

  const mapped = accounts.filter((a) => a.lat !== null && a.lon !== null);
  const soldCount = accounts.filter((a) => Object.values(a.skus).some(Boolean)).length;

  const payload = {
    brand: { name: brand.name, color: brand.color, skuList: brand.skuList },
    accounts: mapped.map((a) => ({
      storeName: a.storeName, address: a.address, city: a.city, county: a.county,
      state: a.state, zip: a.zip, lat: a.lat, lon: a.lon, skus: a.skus,
    })),
    countyGeoJson,
    stats: { total: accounts.length, mapped: mapped.length, sold: soldCount },
    exportedAt: new Date().toISOString(),
  };

  const html = buildViewerHtml(brand.name, payload);
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${brand.name.replace(/\s+/g, '-')}-map-viewer.html`;
  a.click();
  URL.revokeObjectURL(url);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function buildViewerHtml(brandName, payload) {
  const dataJson = JSON.stringify(payload).replace(/</g, '\\u003c');
  const title = `${brandName} — Account Atlas (saved view)`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css" />
<link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css" />
<style>
:root {
  --bg: #eef1ee; --panel: #ffffff; --panel-2: #e4e8e3; --line: #ccd3cc;
  --ink: #1c2622; --ink-dim: #5b6b62; --accent: #a97a2e; --accent-ink: #ffffff;
  --sold: #4f7a4b; --sold-bg: #e2ebe0; --unsold: #a1442f; --unsold-bg: #f3e3de;
  --county-empty: #d9ddd7; --county-mid-high: #8fae7a; --county-mid-low: #c7a35a;
  --shadow: 0 1px 2px rgba(20,30,25,0.06), 0 6px 20px rgba(20,30,25,0.08);
  --pin-sold: #d4af37; --pin-sold-stroke: #8a6a1a; --pin-unsold: #8a9088; --pin-unsold-stroke: #5c625a;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #12181c; --panel: #1a2228; --panel-2: #212b32; --line: #2e3941;
    --ink: #e9e4d9; --ink-dim: #8fa0a8; --accent: #c8973f; --accent-ink: #1a1305;
    --sold: #7fae78; --sold-bg: #1e2a20; --unsold: #c96a4e; --unsold-bg: #2c1e1a;
    --county-empty: #232d2b; --county-mid-high: #5c7f52; --county-mid-low: #a17f3d;
    --shadow: 0 1px 2px rgba(0,0,0,0.3), 0 10px 30px rgba(0,0,0,0.4);
    --pin-sold: #f0c75e; --pin-sold-stroke: #c9a24b; --pin-unsold: #9aa39c; --pin-unsold-stroke: #6b756e;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; font-family: -apple-system, Segoe UI, Roboto, sans-serif; background: var(--bg); color: var(--ink); }
.app { display: flex; flex-direction: column; height: 100%; }
.topbar { display: flex; align-items: center; gap: 12px; padding: 12px 16px; background: var(--panel); border-bottom: 1px solid var(--line); flex: none; }
.topbar .name { font-weight: 700; font-size: 15px; }
.topbar .sub { font-size: 12px; color: var(--ink-dim); }
.map-pane { position: relative; flex: 1; min-height: 0; }
#leaflet-map { width: 100%; height: 100%; }
.legend { position: absolute; left: 14px; bottom: 14px; z-index: 500; background: var(--panel); border: 1px solid var(--line); border-radius: 9px; box-shadow: var(--shadow); padding: 10px 12px; font-size: 12px; display: flex; flex-direction: column; gap: 6px; }
.legend-row { display: flex; align-items: center; gap: 8px; color: var(--ink-dim); }
.legend-row .dot { width: 9px; height: 9px; border-radius: 999px; flex: none; }
.stats-note { position: absolute; top: 14px; left: 14px; z-index: 500; background: var(--panel); border: 1px solid var(--line); border-radius: 9px; box-shadow: var(--shadow); padding: 8px 12px; font-size: 11.5px; color: var(--ink-dim); }
.detail-panel { position: absolute; top: 0; right: 0; bottom: 0; width: min(300px, 92vw); z-index: 700; background: var(--panel); border-left: 1px solid var(--line); box-shadow: var(--shadow); overflow-y: auto; padding: 16px; }
.detail-panel[hidden] { display: none; }
.detail-close { position: absolute; top: 12px; right: 12px; width: 26px; height: 26px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel-2); color: var(--ink-dim); font-size: 16px; line-height: 1; cursor: pointer; }
.detail-close:hover { border-color: var(--accent); color: var(--accent); }
.pname { font-size: 13.5px; margin-bottom: 1px; font-weight: 600; }
.paddr { font-size: 11px; color: var(--ink-dim); margin-bottom: 9px; display: block; }
.fam { font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-dim); margin: 8px 0 5px; }
.chip-row { display: flex; flex-wrap: wrap; gap: 5px; }
.chip { font-size: 10.5px; padding: 3px 7px; border-radius: 999px; background: var(--sold-bg); color: var(--sold); }
.chip.unsold { background: var(--unsold-bg); color: var(--unsold); }
.chip-empty { font-size: 10.5px; color: var(--ink-dim); }
.leaflet-popup-content-wrapper { background: var(--panel); color: var(--ink); border-radius: 10px; box-shadow: var(--shadow); }
.leaflet-popup-tip { background: var(--panel); }
.county-tooltip { background: var(--panel); color: var(--ink); border: 1px solid var(--line); font-size: 12px; }
.pin-sold-glow { filter: drop-shadow(0 0 3px var(--pin-sold)) drop-shadow(0 0 7px var(--pin-sold)); }
.pin-unsold { filter: drop-shadow(0 0 1px rgba(0,0,0,0.3)); }
@media (max-width: 640px) { .detail-panel { width: 100vw; } }
</style>
</head>
<body>
<div class="app">
  <header class="topbar">
    <div>
      <div class="name">${escapeHtml(brandName)}</div>
      <div class="sub">Saved Account Atlas view — not live, won't reflect later changes</div>
    </div>
  </header>
  <div class="map-pane">
    <div id="leaflet-map"></div>
    <div class="stats-note" id="stats-note"></div>
    <div class="legend">
      <div class="legend-row"><span class="dot" style="background:var(--pin-sold)"></span> Sold account</div>
      <div class="legend-row"><span class="dot" style="background:var(--pin-unsold)"></span> Unsold account</div>
    </div>
    <aside class="detail-panel" id="detail-panel" hidden>
      <button class="detail-close" id="detail-close" title="Close" aria-label="Close">&times;</button>
      <div id="detail-body"></div>
    </aside>
  </div>
</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js"></script>
<script>
const DATA = ${dataJson};

function normalizeCountyName(name) {
  return String(name || '').toLowerCase().replace(/\\bcounty\\b/g, '').replace(/[.,]/g, '')
    .replace(/\\bst\\b/g, 'saint').replace(/\\s+/g, ' ').trim();
}
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function getCssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function mapsUrlFor(a) {
  const q = encodeURIComponent(\`\${a.address}, \${a.city}, \${a.state || 'MI'} \${a.zip || ''}\`);
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  return isIOS ? \`https://maps.apple.com/?q=\${q}\` : \`https://www.google.com/maps/search/?api=1&query=\${q}\`;
}
function detailHtml(a) {
  const soldSkus = Object.entries(a.skus).filter(([,v]) => v).map(([k]) => k);
  const unsoldSkus = Object.entries(a.skus).filter(([,v]) => !v).map(([k]) => k);
  const chip = (name, cls) => \`<span class="chip \${cls}">\${escapeHtml(name)}</span>\`;
  return \`
    <div class="pname">\${escapeHtml(a.storeName)}</div>
    <a class="paddr" href="\${mapsUrlFor(a)}" target="_blank" rel="noopener" title="Open in Maps">\${escapeHtml(a.county || '')} County &middot; \${escapeHtml(a.address)}, \${escapeHtml(a.city)}</a>
    <div class="fam">Sold (\${soldSkus.length})</div>
    <div class="chip-row">\${soldSkus.length ? soldSkus.map((s) => chip(s, '')).join('') : '<span class="chip-empty">none</span>'}</div>
    <div class="fam">Unsold (\${unsoldSkus.length})</div>
    <div class="chip-row">\${unsoldSkus.length ? unsoldSkus.map((s) => chip(s, 'unsold')).join('') : '<span class="chip-empty">none</span>'}</div>\`;
}

const detailPanel = document.getElementById('detail-panel');
const detailBody = document.getElementById('detail-body');
document.getElementById('detail-close').addEventListener('click', () => { detailPanel.hidden = true; });

document.getElementById('stats-note').textContent =
  \`\${DATA.stats.sold} of \${DATA.stats.total} sold · \${DATA.stats.mapped} of \${DATA.stats.total} mapped · saved \${new Date(DATA.exportedAt).toLocaleDateString()}\`;

const map = L.map('leaflet-map', { zoomControl: false }).setView([44.6, -85.4], 6);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);

const countyStats = new Map();
DATA.accounts.forEach((a) => {
  const key = normalizeCountyName(a.county);
  if (!key) return;
  const s = countyStats.get(key) || { sold: 0, total: 0 };
  s.total += 1;
  if (Object.values(a.skus).some(Boolean)) s.sold += 1;
  countyStats.set(key, s);
});
function realColor(pct) {
  if (pct === null) return getCssVar('--county-empty');
  if (pct >= 0.75) return getCssVar('--sold');
  if (pct >= 0.5) return getCssVar('--county-mid-high');
  if (pct >= 0.25) return getCssVar('--county-mid-low');
  return getCssVar('--unsold');
}
L.geoJSON(DATA.countyGeoJson, {
  style: (feature) => {
    const stats = countyStats.get(normalizeCountyName(feature.properties.name));
    const pct = stats && stats.total ? stats.sold / stats.total : null;
    return { color: getCssVar('--line'), weight: 1, fillColor: pct === null ? 'transparent' : realColor(pct), fillOpacity: pct === null ? 0.05 : 0.55 };
  },
  onEachFeature: (feature, layer) => {
    const name = feature.properties.name;
    const stats = countyStats.get(normalizeCountyName(name));
    const label = stats ? \`<strong>\${escapeHtml(name)} County</strong><br>\${stats.sold} of \${stats.total} accounts sold\` : \`<strong>\${escapeHtml(name)} County</strong><br>no accounts loaded\`;
    layer.bindTooltip(label, { sticky: true, className: 'county-tooltip' });
    layer.on('mouseover', () => layer.setStyle({ weight: 2 }));
    layer.on('mouseout', () => layer.setStyle({ weight: 1 }));
  },
}).addTo(map);

const clusterGroup = L.markerClusterGroup({ maxClusterRadius: 50, spiderfyOnMaxZoom: true });
DATA.accounts.forEach((a) => {
  const sold = Object.values(a.skus).some(Boolean);
  const marker = L.circleMarker([a.lat, a.lon], {
    radius: sold ? 8 : 6,
    color: sold ? getCssVar('--pin-sold-stroke') : getCssVar('--pin-unsold-stroke'),
    weight: sold ? 1.5 : 2,
    fillColor: sold ? getCssVar('--pin-sold') : getCssVar('--pin-unsold'),
    fillOpacity: sold ? 0.95 : 0.85,
    className: sold ? 'pin-sold-glow' : 'pin-unsold',
  });
  marker.on('mouseover', () => { detailBody.innerHTML = detailHtml(a); detailPanel.hidden = false; });
  clusterGroup.addLayer(marker);
});
map.addLayer(clusterGroup);
</script>
</body>
</html>`;
}

// Returns { brand, accounts }. Throws if the file isn't a recognizable
// snapshot.
export async function parseSnapshotFile(file) {
  const text = await file.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Not a valid JSON file.');
  }
  if (!data.brand || !Array.isArray(data.accounts)) {
    throw new Error('This file doesn\'t look like an Account Atlas brand snapshot.');
  }
  return { brand: data.brand, accounts: data.accounts };
}

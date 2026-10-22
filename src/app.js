import * as db from './core/db.js?v=20261022b';
import { parseBrandWorkbook, brandStats, normalizeAddressKey } from './data/excelParser.js?v=20261022b';
import { buildMatches } from './data/matcher.js?v=20261022b';
import { exportAddressesForGeocoding, importCoordinates, exportFilteredAccounts } from './data/csvTools.js?v=20261022b';
import { exportBrandSnapshot, exportAllLists, exportStandaloneViewer, parseSnapshotFile } from './data/snapshot.js?v=20261022b';
import {
  initMap, renderChoropleth, renderPins, flyToCounty, getMap, mapsUrlFor,
  renderRouteStops, showUserLocation, fitToPoints, focusAccount,
} from './modules/mapView.js?v=20261022b';
import {
  HEAT_STOPS, countyHeat, formatAmount, loadHeatMode, saveHeatMode, loadSkuOff, saveSkuOff,
} from './modules/heatmap.js?v=20261022b';
import {
  MAX_STOPS, haversineMiles, optimizeOrder, pathMiles, googleRouteUrl, stopFromAccount, stopFromPlace, placeStopId, loadRoute, saveRoute,
} from './modules/route.js?v=20261022b';

const BRAND_COLORS = ['#a97a2e', '#35748c', '#6f5a70', '#4f7a4b', '#a1442f', '#7a5a9e'];

// Andrew, 2026-08-21: was a separate `atlasviewer.vesvelid.workers.dev`
// Cloudflare Worker (tools/cloudflare-worker.js, kept as reference/backup
// deploy) -- his work computer's network silently blocked that domain
// ("Failed to fetch", no reachable error detail). Switched to a Cloudflare
// Pages Function (functions/api/geocode.js, same relay logic) served from
// the SAME origin as accountatlas.pages.dev -- rides that already-allowed
// domain at work instead of a separate, unfamiliar one.
//
// Andrew, 2026-08-21 (same day, second bug): that same-origin path only
// exists on Cloudflare Pages -- GitHub Pages (the separate public,
// no-login deploy used purely to hand the app to colleagues, see
// andrewmonroe-dev.github.io/AccountAtlas/) is a plain static host with
// no server-side functions at all, so /api/geocode 404s there. Resolve
// the relay by hostname instead of hardcoding one: the Pages Function on
// Cloudflare's own domain, the standalone Worker everywhere else.
const GEOCODE_RELAY_URL = location.hostname.endsWith('.pages.dev')
  ? '/api/geocode'
  : 'https://atlasviewer.vesvelid.workers.dev';

const state = {
  brands: [],           // [{id, name, color}]
  accounts: [],          // all accounts, all brands
  matchGroups: [],
  activeBrandIds: new Set(),
  compareMode: 'overlay', // 'overlay' | 'gap'
  gapHas: null,
  gapMissing: null,
  filterCounty: '',
  heatMode: loadHeatMode(), // 'sold' (penetration) | 'total' | 'avg' (volume heatmap)
};

function brandsById() {
  const map = {};
  state.brands.forEach((b) => { map[b.id] = b; });
  return map;
}

// Which lists (brands) are switched off is remembered between launches. The
// OFF set is what is stored, so a list added later defaults to on.
const OFF_LISTS_KEY = 'aa-lists-off-v1';
let offBrandIds = loadOffLists();

function loadOffLists() {
  try {
    const parsed = JSON.parse(localStorage.getItem(OFF_LISTS_KEY) || '[]');
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function saveOffLists() {
  try { localStorage.setItem(OFF_LISTS_KEY, JSON.stringify([...offBrandIds])); } catch { /* storage blocked */ }
}

function syncActiveBrands() {
  state.activeBrandIds = new Set(state.brands.filter((b) => !offBrandIds.has(b.id)).map((b) => b.id));
}

function setBrandActive(id, on) {
  if (on) offBrandIds.delete(id); else offBrandIds.add(id);
  saveOffLists();
  syncActiveBrands();
}

async function loadAll() {
  state.brands = await db.getAllBrands();
  state.accounts = await db.getAllAccounts();
  state.matchGroups = await db.getAllMatchGroups();
  syncActiveBrands();
}

function visibleAccounts() {
  let accts = state.accounts.filter((a) => state.activeBrandIds.has(a.brandId));
  if (state.filterCounty) accts = accts.filter((a) => a.county === state.filterCounty);

  if (state.compareMode === 'gap' && state.gapHas && state.gapMissing) {
    const hasAccts = state.accounts.filter((a) => a.brandId === state.gapHas);
    const missingAccts = new Set(
      state.accounts.filter((a) => a.brandId === state.gapMissing).map(matchKeyFor)
    );
    const matchedMissingIds = new Set();
    state.matchGroups.forEach((g) => {
      const members = g.memberIds.map((id) => state.accounts.find((a) => a.id === id)).filter(Boolean);
      const inHas = members.some((m) => m.brandId === state.gapHas);
      const inMissing = members.some((m) => m.brandId === state.gapMissing);
      if (inHas && inMissing) {
        members.filter((m) => m.brandId === state.gapHas).forEach((m) => matchedMissingIds.add(m.id));
      }
    });
    accts = hasAccts.filter((a) => !matchedMissingIds.has(a.id));
    if (state.filterCounty) accts = accts.filter((a) => a.county === state.filterCounty);
  }
  return accts;
}

function matchKeyFor(a) { return a.id; }

function countyStatsFor(accounts) {
  const map = new Map();
  accounts.forEach((a) => {
    if (!a.county) return;
    const cur = map.get(a.county) || { sold: 0, total: 0 };
    cur.total += 1;
    if (Object.values(a.skus).some(Boolean)) cur.sold += 1;
    map.set(a.county, cur);
  });
  return map;
}

// ---------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------

function render() {
  renderBrandList();
  renderListChips();
  renderGapForm();
  renderFilters();
  renderStats();
  renderUnmappedBadge();
  const accts = visibleAccounts();
  const { heat, note, brand } = computeHeat(accts);
  renderHeatBar(note, brand, heat);
  renderChoropleth(countyStatsFor(accts), heat);
  renderPins(accts.filter((a) => a.lat !== null), brandsById());
}

// ---------------------------------------------------------------
// Volume heatmap (2026-10-22)
// ---------------------------------------------------------------
// Shades counties by one brand's volume instead of sold percentage. The brand
// is the first list that is switched on. Total = sum of the chosen SKUs'
// amounts in the county, Per account = that total over the brand's accounts
// in the county. Lists stored before 2026-10-22 have no amounts and need a
// re-upload.

let skuPanelBrandId = null; // brand whose SKU panel is open, or null

function heatBrand() {
  return state.brands.find((b) => state.activeBrandIds.has(b.id)) || null;
}

function heatSkuSet(brand) {
  const off = loadSkuOff(brand.id);
  return new Set((brand.skuList || []).filter((s) => !off.has(s)));
}

function computeHeat(accts) {
  if (state.heatMode === 'sold') return { heat: null, note: '', brand: null };
  const brand = heatBrand();
  if (!brand) return { heat: null, note: 'Turn a list on to see its volume.', brand: null };
  const mine = accts.filter((a) => a.brandId === brand.id);
  if (!mine.some((a) => a.qty)) {
    return { heat: null, brand, note: `Showing sold % for now. Re-upload "${brand.name}" to see volume (the stored list only has sold or unsold).` };
  }
  const skus = heatSkuSet(brand);
  const heat = countyHeat(mine, skus, state.heatMode);
  const total = (brand.skuList || []).length;
  const parts = [`${brand.name}`, `${skus.size} of ${total} SKUs`];
  if (state.activeBrandIds.size > 1) parts.push(`first of ${state.activeBrandIds.size} lists on, turn the others off to pick another`);
  return { heat, brand, note: parts.join(' · ') };
}

function renderHeatBar(note, brand, heat) {
  const bar = document.getElementById('heat-bar');
  const wasHidden = bar.hidden;
  bar.hidden = state.brands.length === 0;
  const modes = [['sold', 'Sold %'], ['total', 'Volume total'], ['avg', 'Volume per account']];
  const legend = heat
    ? `<span class="heat-legend" title="Darker means more. Shading is on a square-root scale so one big county does not wash out the rest.">
         <span class="heat-low">0</span>
         <span class="heat-ramp" style="background:linear-gradient(90deg, ${HEAT_STOPS.join(', ')})"></span>
         <span class="heat-high">${formatAmount(heat.max)}</span>
       </span>`
    : '';
  const skuBtn = state.heatMode !== 'sold' && brand && heat
    ? '<button class="heat-btn sku-btn" id="sku-btn" aria-haspopup="dialog">SKUs</button>' : '';
  bar.innerHTML = `<span class="heat-label">Shade</span>`
    + modes.map(([m, label]) => `<button class="heat-btn${state.heatMode === m ? ' on' : ''}" data-mode="${m}" aria-pressed="${state.heatMode === m}">${label}</button>`).join('')
    + skuBtn + legend
    + (note ? `<span class="heat-note">${escapeHtml(note)}</span>` : '');
  bar.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.heatMode = btn.dataset.mode;
      saveHeatMode(state.heatMode);
      closeSkuPanel();
      render();
    });
  });
  const sb = document.getElementById('sku-btn');
  if (sb) sb.addEventListener('click', () => toggleSkuPanel(brand));
  if (skuPanelBrandId && (!brand || brand.id !== skuPanelBrandId || state.heatMode === 'sold')) closeSkuPanel();
  if (wasHidden !== bar.hidden && getMap()) getMap().invalidateSize();
}

function closeSkuPanel() {
  skuPanelBrandId = null;
  document.getElementById('sku-panel').hidden = true;
}

function toggleSkuPanel(brand) {
  if (skuPanelBrandId === brand.id) { closeSkuPanel(); return; }
  skuPanelBrandId = brand.id;
  const panel = document.getElementById('sku-panel');
  const skus = brand.skuList || [];
  panel.innerHTML = `
    <div class="sku-head"><strong>SKUs counted</strong> <span id="sku-count"></span>
      <button class="near-close" id="sku-close" aria-label="Close">&times;</button></div>
    <div class="sku-actions"><button class="ghost-btn" id="sku-all">All</button><button class="ghost-btn" id="sku-none">None</button></div>
    <div class="sku-list">${skus.map((s, i) => `<label class="sku-row"><input type="checkbox" data-i="${i}"> <span>${escapeHtml(s)}</span></label>`).join('')}</div>`;
  const boxes = [...panel.querySelectorAll('input[type="checkbox"]')];
  const sync = () => {
    const off = loadSkuOff(brand.id);
    boxes.forEach((b) => { b.checked = !off.has(skus[Number(b.dataset.i)]); });
    document.getElementById('sku-count').textContent = `${boxes.filter((b) => b.checked).length} of ${skus.length}`;
  };
  const apply = (offSet) => { saveSkuOff(brand.id, offSet); sync(); render(); };
  boxes.forEach((b) => b.addEventListener('change', () => {
    const off = loadSkuOff(brand.id);
    const sku = skus[Number(b.dataset.i)];
    if (b.checked) off.delete(sku); else off.add(sku);
    apply(off);
  }));
  document.getElementById('sku-all').addEventListener('click', () => apply(new Set()));
  document.getElementById('sku-none').addEventListener('click', () => apply(new Set(skus)));
  document.getElementById('sku-close').addEventListener('click', closeSkuPanel);
  sync();
  panel.hidden = false;
}

function renderBrandList() {
  const el = document.getElementById('brand-list');
  el.innerHTML = '';
  state.brands.forEach((b) => {
    const accts = state.accounts.filter((a) => a.brandId === b.id);
    const geocoded = accts.filter((a) => a.lat !== null).length;
    const row = document.createElement('div');
    row.className = 'brand-row';
    row.innerHTML = `
      <span class="swatch" style="background:${b.color}"></span>
      <div class="info">
        <div class="bname">${escapeHtml(b.name)}</div>
        <div class="bsub">${accts.length} accounts &middot; ${geocoded} mapped</div>
      </div>
      <button class="icon-btn geocode-btn" title="Geocode this brand's accounts" data-action="geocode" data-id="${b.id}">&#128205;</button>
      <button class="icon-btn" title="Export a portable snapshot (data + coordinates) to move to another computer" data-action="export-snapshot" data-id="${b.id}">&#128190;</button>
      <button class="icon-btn" title="Export a standalone map viewer -- one HTML file, no login/install needed, safe to send to anyone" data-action="export-viewer" data-id="${b.id}">&#128506;</button>
      <button class="toggle ${state.activeBrandIds.has(b.id) ? 'on' : ''}" data-action="toggle-brand" data-id="${b.id}"></button>
    `;
    el.appendChild(row);
  });

  el.querySelectorAll('[data-action="toggle-brand"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      setBrandActive(id, !state.activeBrandIds.has(id));
      render();
    });
  });
  el.querySelectorAll('[data-action="geocode"]').forEach((btn) => {
    btn.addEventListener('click', () => geocodeBrandNow(btn.dataset.id, btn));
  });
  el.querySelectorAll('[data-action="export-snapshot"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const brand = state.brands.find((b) => b.id === btn.dataset.id);
      const accts = state.accounts.filter((a) => a.brandId === brand.id);
      exportBrandSnapshot(brand, accts);
    });
  });
  el.querySelectorAll('[data-action="export-viewer"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const brand = state.brands.find((b) => b.id === btn.dataset.id);
      const accts = state.accounts.filter((a) => a.brandId === brand.id);
      const originalLabel = btn.textContent;
      btn.disabled = true;
      btn.textContent = '…';
      try {
        await exportStandaloneViewer(brand, accts);
      } catch (err) {
        alert(`Couldn't build the standalone viewer: ${err.message}`);
      } finally {
        btn.disabled = false;
        btn.textContent = originalLabel;
      }
    });
  });

  const gapHasSel = document.getElementById('gap-has');
  const gapMissingSel = document.getElementById('gap-missing');
  [gapHasSel, gapMissingSel].forEach((sel) => {
    sel.innerHTML = state.brands.map((b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
  });
  if (state.brands.length) {
    state.gapHas = state.gapHas || state.brands[0].id;
    state.gapMissing = state.gapMissing || (state.brands[1] || state.brands[0]).id;
    gapHasSel.value = state.gapHas;
    gapMissingSel.value = state.gapMissing;
  }
}

// Chip bar above the map: one tap switches a list on or off, any combination.
// Hidden with fewer than two lists, since there is nothing to choose between.
function renderListChips() {
  const bar = document.getElementById('list-chips');
  const wasHidden = bar.hidden;
  bar.hidden = state.brands.length < 2;
  // The bar takes its own row above the map, so the map has to re-measure
  // whenever the bar appears or disappears -- after the chips are in it, not
  // before, or it measures the still-empty bar.
  const remeasure = () => { if (wasHidden !== bar.hidden && getMap()) getMap().invalidateSize(); };
  if (bar.hidden) { remeasure(); return; }
  const chips = state.brands.map((b) => {
    const total = state.accounts.filter((a) => a.brandId === b.id).length;
    const on = state.activeBrandIds.has(b.id);
    return `<button class="list-chip${on ? ' on' : ''}" data-id="${escapeHtml(String(b.id))}" aria-pressed="${on}" style="--chip-color:${escapeHtml(b.color)}">`
      + `<span class="chip-dot"></span><span class="chip-name">${escapeHtml(b.name)}</span><span class="chip-count">${total}</span></button>`;
  });
  const allOn = state.brands.every((b) => state.activeBrandIds.has(b.id));
  bar.innerHTML = `<button class="list-chip all${allOn ? ' on' : ''}" data-all="1">All</button>` + chips.join('');
  bar.querySelectorAll('.list-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      if (chip.dataset.all) {
        state.brands.forEach((b) => offBrandIds.delete(b.id));
        saveOffLists();
        syncActiveBrands();
      } else {
        setBrandActive(chip.dataset.id, !state.activeBrandIds.has(chip.dataset.id));
      }
      render();
    });
  });
  remeasure();
}

function renderGapForm() {
  document.getElementById('gap-form').style.display = state.compareMode === 'gap' ? 'flex' : 'none';
  document.querySelectorAll('#compare-segmented button').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === state.compareMode);
  });
}

function renderFilters() {
  const sel = document.getElementById('filter-county');
  const counties = [...new Set(state.accounts.map((a) => a.county).filter(Boolean))].sort();
  const cur = sel.value;
  sel.innerHTML = '<option value="">All counties</option>' + counties.map((c) => `<option value="${c}">${c}</option>`).join('');
  sel.value = state.filterCounty || cur || '';
  document.getElementById('clear-county-filter').hidden = !state.filterCounty;
}

function renderStats() {
  const accts = visibleAccounts();
  const stats = brandStats(accts);
  document.getElementById('stat-sold').textContent = stats.soldAccounts;
  document.getElementById('stat-unsold').textContent = stats.unsoldAccounts;
  document.getElementById('stat-bar').style.width = stats.penetrationPct + '%';
  document.getElementById('stat-pct').textContent = `${stats.penetrationPct}% penetration${state.compareMode === 'gap' ? ' gap' : ' (visible brands)'}`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------
// Route builder + Near me (2026-10-21)
// ---------------------------------------------------------------
// Tick "Add to route" on a store's panel and it becomes the next numbered
// stop. Start route opens Google Maps with no origin, so Maps starts from
// wherever the phone is standing. Optimize reorders by straight-line
// distance from the current location. The location is only used in the
// browser for that calculation, never stored or sent anywhere.

let routeStops = loadRoute();
let nearRows = [];   // [{ acct, miles }] from the last Near me search

function routePositionOf(id) {
  return routeStops.findIndex((s) => s.id === id) + 1;
}

function setRouteStatus(msg) {
  document.getElementById('route-status').textContent = msg || '';
}

// Returns false when the route is full so the checkbox can revert.
function toggleStop(id, wantOn, makeStop) {
  const idx = routeStops.findIndex((s) => s.id === id);
  if (wantOn && idx === -1) {
    if (routeStops.length >= MAX_STOPS) {
      setRouteStatus(`A route holds ${MAX_STOPS} stops at most (Google Maps' limit). Remove one to add another.`);
      return false;
    }
    routeStops.push(makeStop());
  } else if (!wantOn && idx !== -1) {
    routeStops.splice(idx, 1);
  }
  setRouteStatus('');
  commitRoute();
  return true;
}

function toggleRouteStop(acct, wantOn) {
  return toggleStop(acct.id, wantOn, () => stopFromAccount(acct));
}

// A gray nearby business (not one of the user's accounts) added from its popup.
function toggleRoutePlace(place, wantOn) {
  return toggleStop(placeStopId(place), wantOn, () => stopFromPlace(place));
}

function routePositionOfPlace(place) {
  return routePositionOf(placeStopId(place));
}

function commitRoute() {
  saveRoute(routeStops);
  renderRouteBar();
  renderRouteStops(routeStops);
  renderNearList();
}

function renderRouteBar() {
  const bar = document.getElementById('route-bar');
  bar.hidden = routeStops.length === 0;
  document.getElementById('route-count').textContent = `${routeStops.length} of ${MAX_STOPS} stops`;
  document.getElementById('route-list').innerHTML = routeStops.map((s, i) => `
    <li>
      <span class="rnum">${i + 1}</span>
      <span class="rname" title="${escapeHtml(s.query)}">${escapeHtml(s.name)}${s.kind === 'place' ? ` <em class="rtag">${escapeHtml(s.label ? s.label + ', ' : '')}not an account</em>` : ''}</span>
      <button class="rremove" data-id="${escapeHtml(String(s.id))}" aria-label="Remove stop ${i + 1}">&times;</button>
    </li>`).join('');
  document.querySelectorAll('#route-list .rremove').forEach((btn) => {
    btn.addEventListener('click', () => {
      routeStops = routeStops.filter((s) => String(s.id) !== btn.dataset.id);
      setRouteStatus('');
      commitRoute();
    });
  });
  document.getElementById('route-optimize').disabled = routeStops.length < 2;
  document.getElementById('route-start').disabled = routeStops.length === 0;
}

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('This browser has no location support.')); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => reject(new Error(err.code === 1
        ? 'Location access was blocked. Allow it for this site and try again.'
        : 'Could not get your location.')),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  });
}

async function optimizeRoute() {
  if (routeStops.length < 2) return;
  const btn = document.getElementById('route-optimize');
  btn.disabled = true;
  setRouteStatus('Getting your location...');
  let here = null;
  let why = '';
  try { here = await getPosition(); } catch (err) { why = err.message; }

  const identity = routeStops.map((_, i) => i);
  const before = pathMiles(routeStops, identity, here);
  routeStops = optimizeOrder(routeStops, here).map((i) => routeStops[i]);
  const after = pathMiles(routeStops, identity, here);
  if (here) showUserLocation(here.lat, here.lon);
  commitRoute();
  const miles = `${after.toFixed(1)} mi straight-line (was ${before.toFixed(1)})`;
  setRouteStatus(here
    ? `Reordered from your location: ${miles}. Real driving distance will differ.`
    : `${why} Stop 1 stays first. Reordered: ${miles}.`);
  btn.disabled = routeStops.length < 2;
}

function startRoute() {
  const url = googleRouteUrl(routeStops);
  if (!url) return;
  // Synthetic anchor click rather than window.open, which some browsers'
  // popup blockers silently kill (see the MacBane launcher fix, 2026-08-21).
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function renderNearList() {
  const panel = document.getElementById('near-panel');
  if (panel.hidden || !nearRows.length) return;
  const list = document.getElementById('near-list');
  list.innerHTML = nearRows.map(({ acct, miles }) => `
    <div class="near-row">
      <div class="near-info" data-focus="${escapeHtml(String(acct.id))}">
        <div class="near-name">${escapeHtml(acct.storeName)}</div>
        <div class="near-sub">${escapeHtml(acct.city)} &middot; ${miles.toFixed(1)} mi &middot; ${Object.values(acct.skus).some(Boolean) ? 'sold' : 'unsold'}</div>
      </div>
      <button data-add="${escapeHtml(String(acct.id))}" ${routePositionOf(acct.id) ? 'disabled' : ''}>${routePositionOf(acct.id) ? 'Stop ' + routePositionOf(acct.id) : '+ Route'}</button>
    </div>`).join('');
  list.querySelectorAll('[data-focus]').forEach((el) => {
    el.addEventListener('click', () => focusAccount(nearRows.find((r) => String(r.acct.id) === el.dataset.focus).acct.id));
  });
  list.querySelectorAll('[data-add]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const row = nearRows.find((r) => String(r.acct.id) === btn.dataset.add);
      if (row) toggleRouteStop(row.acct, true);
    });
  });
}

async function showNearMe() {
  const panel = document.getElementById('near-panel');
  const list = document.getElementById('near-list');
  panel.hidden = false;
  nearRows = [];
  list.innerHTML = '<div class="near-msg">Finding you...</div>';
  let here;
  try {
    here = await getPosition();
  } catch (err) {
    list.innerHTML = `<div class="near-msg">${escapeHtml(err.message)}</div>`;
    return;
  }
  showUserLocation(here.lat, here.lon);
  nearRows = visibleAccounts()
    .filter((a) => a.lat !== null && a.lon !== null)
    .map((acct) => ({ acct, miles: haversineMiles(here, { lat: acct.lat, lon: acct.lon }) }))
    .sort((x, y) => x.miles - y.miles)
    .slice(0, 10);
  if (!nearRows.length) {
    list.innerHTML = '<div class="near-msg">No accounts with a map point in the current view.</div>';
    return;
  }
  renderNearList();
  fitToPoints([[here.lat, here.lon], ...nearRows.map((r) => [r.acct.lat, r.acct.lon])]);
}

// ---------------------------------------------------------------
// Upload flow
// ---------------------------------------------------------------

function openUploadModal() {
  document.getElementById('upload-modal').hidden = false;
  document.getElementById('upload-warnings').textContent = '';
  document.getElementById('upload-name').value = '';
  document.getElementById('upload-file').value = '';
}
function closeUploadModal() { document.getElementById('upload-modal').hidden = true; }

async function handleUpload() {
  const name = document.getElementById('upload-name').value.trim();
  const fileInput = document.getElementById('upload-file');
  const file = fileInput.files[0];
  if (!name || !file) { alert('Brand name and a file are both required.'); return; }

  const existing = state.brands.find((b) => b.name.toLowerCase() === name.toLowerCase());

  // Build carry-forward data BEFORE anything is deleted: this brand's own
  // prior accounts (so an unchanged address keeps its geocode on replace),
  // plus every already-geocoded address across ALL brands (so a new brand
  // at an already-mapped store skips geocoding entirely).
  const previousById = {};
  if (existing) {
    const oldAccounts = await db.getAccountsByBrand(existing.id);
    oldAccounts.forEach((a) => { previousById[a.id] = a; });
  }
  const addressIndex = {};
  state.accounts.forEach((a) => {
    if (a.geocodeStatus === 'ok' && a.lat !== null && a.lon !== null) {
      addressIndex[normalizeAddressKey(a.address, a.city, a.state, a.zip)] = { lat: a.lat, lon: a.lon };
    }
  });

  if (existing) {
    const ok = confirm(`"${name}" already exists (${state.accounts.filter((a) => a.brandId === existing.id).length} accounts). Replace it?`);
    if (!ok) return;
    await db.deleteBrand(existing.id);
  }

  const buf = await file.arrayBuffer();
  const brandId = existing ? existing.id : crypto.randomUUID();
  let parsed;
  try {
    parsed = parseBrandWorkbook(buf, brandId, { previousById, addressIndex });
  } catch (err) {
    document.getElementById('upload-warnings').textContent = 'Could not parse file: ' + err.message;
    return;
  }

  const color = existing ? existing.color : BRAND_COLORS[state.brands.length % BRAND_COLORS.length];
  await db.putBrand({ id: brandId, name, color, skuList: parsed.skuList, uploadedAt: new Date().toISOString() });
  await db.putAccounts(parsed.accounts);

  if (parsed.warnings.length) {
    document.getElementById('upload-warnings').textContent = parsed.warnings.slice(0, 20).join('\n');
  } else {
    closeUploadModal();
  }

  offBrandIds.delete(brandId);
  saveOffLists();
  await loadAll();
  await recomputeMatches();
  render();
}

// ---------------------------------------------------------------
// Snapshot import -- brings in one or many lists (including already-
// resolved coordinates) from single-list snapshot files and/or an
// all-lists backup. No Excel, no geocoding, no Node needed on the machine
// doing the importing. Several files can be picked at once.
// ---------------------------------------------------------------

function importSnapshot() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.multiple = true;
  input.addEventListener('change', async () => {
    const files = [...input.files];
    if (!files.length) return;

    // Parse everything first. A bad file is reported and skipped, the rest still import.
    // A list name appearing twice in the batch keeps the last one.
    const incoming = new Map();
    const problems = [];
    for (const file of files) {
      try {
        (await parseSnapshotFile(file)).forEach((list) => incoming.set(list.brand.name.toLowerCase(), list));
      } catch (err) {
        problems.push(`${file.name}: ${err.message}`);
      }
    }
    const lists = [...incoming.values()];
    if (!lists.length) {
      alert('Could not import anything.\n' + problems.join('\n'));
      return;
    }

    const findExisting = (list) => state.brands.find((b) => b.name.toLowerCase() === list.brand.name.toLowerCase());
    const clashes = lists.filter(findExisting);
    let replaceClashes = false;
    if (clashes.length) {
      replaceClashes = confirm(
        `${clashes.length} of these lists already exist: ${clashes.map((l) => l.brand.name).join(', ')}.\n\n` +
        'OK replaces them with the imported copies. Cancel keeps your current copies and imports only the new lists.'
      );
    }

    const done = [];
    const skipped = [];
    const freshBrandIds = [];
    for (const list of lists) {
      const existing = findExisting(list);
      if (existing && !replaceClashes) { skipped.push(list.brand.name); continue; }
      if (existing) await db.deleteBrand(existing.id);

      const brandId = existing ? existing.id : (list.brand.id || crypto.randomUUID());
      const color = existing ? existing.color : BRAND_COLORS[(state.brands.length + freshBrandIds.length) % BRAND_COLORS.length];
      await db.putBrand({ ...list.brand, id: brandId, color });
      await db.putAccounts(list.accounts.map((a) => ({ ...a, brandId })));
      offBrandIds.delete(brandId);
      freshBrandIds.push(brandId);
      done.push(`${list.brand.name} (${list.accounts.length} accounts, ${list.accounts.filter((a) => a.lat !== null && a.lon !== null).length} mapped)`);
    }
    saveOffLists();

    await loadAll();
    await recomputeMatches();
    render();

    alert(
      (done.length ? `Imported ${done.length} list${done.length === 1 ? '' : 's'}:\n${done.join('\n')}` : 'Nothing was imported.') +
      (skipped.length ? `\n\nKept your current copy of: ${skipped.join(', ')}` : '') +
      (problems.length ? `\n\nCould not read:\n${problems.join('\n')}` : '')
    );
  });
  input.click();
}

// ---------------------------------------------------------------
// Geocoding -- one button, calls the Cloudflare Worker relay (see
// tools/cloudflare-worker.js). Works from any browser, any computer,
// no local server or install needed. Falls back to a manual export/
// run-script/import flow only if the relay itself is unreachable
// (e.g. no internet, or the relay was deleted/renamed).
// ---------------------------------------------------------------

async function geocodeBrandNow(brandId, btn) {
  const brand = state.brands.find((b) => b.id === brandId);
  const accts = state.accounts.filter((a) => a.brandId === brandId);
  const pending = accts.filter((a) => a.geocodeStatus !== 'ok');

  if (!pending.length) {
    alert(`${brand.name}: all ${accts.length} accounts are already mapped.`);
    return;
  }

  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = '…';

  try {
    const res = await fetch(GEOCODE_RELAY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        addresses: pending.map((a) => ({ id: a.id, address: a.address, city: a.city, state: a.state || 'MI', zip: a.zip })),
      }),
    });
    if (!res.ok) throw new Error(`relay returned ${res.status}`);
    const { results } = await res.json();

    const updated = accts.map((a) => {
      const c = results[a.id];
      if (!c) return a;
      return { ...a, lat: c.matched ? c.lat : null, lon: c.matched ? c.lon : null, geocodeStatus: c.matched ? 'ok' : 'failed' };
    });
    await db.putAccounts(updated);
    await loadAll();
    render();

    const matched = updated.filter((a) => a.geocodeStatus === 'ok').length;
    alert(`${brand.name}: geocoded ${matched} of ${accts.length} accounts.`);
  } catch (err) {
    const useManual = confirm(
      `Couldn't reach the geocoding service (${err.message}).\n\n` +
      `Check your internet connection and try again.\n\n` +
      `Click OK to use the manual export/run-script/import fallback instead.`
    );
    if (useManual) {
      exportAddressesForGeocoding(brand, pending);
      openImportCoordsDialog(brandId);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

// ---------------------------------------------------------------
// Coordinate import (manual fallback path only)
// ---------------------------------------------------------------

function openImportCoordsDialog(brandId) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    const result = await importCoordinates(brandId, file, { getAllAccounts: db.getAllAccounts, putAccounts: db.putAccounts });
    alert(`Matched coordinates for ${result.matched} of ${result.total} accounts.`);
    await loadAll();
    render();
  });
  input.click();
}

// ---------------------------------------------------------------
// Cross-brand matching
// ---------------------------------------------------------------

async function recomputeMatches() {
  const { groups, needsReview } = buildMatches(state.accounts);
  for (const g of groups) await db.putMatchGroup(g);
  state.matchGroups = await db.getAllMatchGroups();
  window.__pendingReview = needsReview;
  document.getElementById('review-badge').hidden = needsReview.length === 0;
  document.getElementById('review-badge').textContent = needsReview.length;
}

// ---------------------------------------------------------------
// Unmapped accounts -- anything with no lat/lon, whether it's never been
// geocoded yet or the geocoder genuinely couldn't match the address.
// ---------------------------------------------------------------

function unmappedAccounts() {
  return state.accounts.filter((a) => a.lat === null || a.lon === null);
}

function renderUnmappedBadge() {
  const badge = document.getElementById('unmapped-badge');
  const count = unmappedAccounts().length;
  badge.hidden = count === 0;
  badge.textContent = `${count} account${count === 1 ? '' : 's'} not on map →`;
}

function openUnmappedModal() {
  const list = document.getElementById('unmapped-list');
  const accts = unmappedAccounts();
  if (!accts.length) {
    list.innerHTML = '<div class="hint">Everything is mapped.</div>';
  } else {
    list.innerHTML = accts.map((a) => {
      const brand = brandsById()[a.brandId];
      const statusLabel = a.geocodeStatus === 'failed' ? 'Address not found' : 'Not yet geocoded';
      const statusClass = a.geocodeStatus === 'failed' ? 'unsold' : '';
      return `
        <div class="review-row">
          <div><strong>${escapeHtml(a.storeName)}</strong> (${escapeHtml(brand ? brand.name : '')})</div>
          <a class="hint" href="${mapsUrlFor(a)}" target="_blank" rel="noopener" title="Open in Maps -- worth a try even though our geocoder couldn't match it">${escapeHtml(a.address)}, ${escapeHtml(a.city)}, ${escapeHtml(a.state)} ${escapeHtml(a.zip)}</a>
          <div class="chip ${statusClass}" style="width:fit-content">${statusLabel}</div>
        </div>`;
    }).join('');
  }
  document.getElementById('unmapped-modal').hidden = false;
}

// Andrew, 2026-08-21: free fallback for whatever the Census batch geocoder
// (geocodeBrandNow above) couldn't match -- no API key, no billing, just
// OpenStreetMap's public Nominatim search endpoint. Its usage policy caps
// requests at 1/sec and requires they NOT run in parallel, so this is
// deliberately sequential with a throttle -- slow for a big batch (roughly
// 1 address/sec), but free and policy-compliant, which is the actual
// tradeoff Andrew chose over a paid Google Maps key.
const NOMINATIM_MIN_INTERVAL_MS = 1100;

async function geocodeOneViaNominatim(a) {
  const q = encodeURIComponent(`${a.address}, ${a.city}, ${a.state || 'MI'} ${a.zip || ''}`);
  const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&countrycodes=us&limit=1&q=${q}`);
  if (!res.ok) throw new Error(`Nominatim returned ${res.status}`);
  const results = await res.json();
  if (!results.length) return null;
  return { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon) };
}

async function retryUnmappedViaOsm() {
  const btn = document.getElementById('unmapped-retry-osm');
  const statusEl = document.getElementById('unmapped-retry-status');
  const targets = unmappedAccounts();
  if (!targets.length) return;

  btn.disabled = true;
  let matched = 0;
  for (let i = 0; i < targets.length; i++) {
    const a = targets[i];
    statusEl.textContent = `Checking ${i + 1} of ${targets.length} via OpenStreetMap (about 1/sec, please wait)...`;
    const t0 = performance.now();
    try {
      const coords = await geocodeOneViaNominatim(a);
      if (coords) {
        await db.putAccounts([{ ...a, lat: coords.lat, lon: coords.lon, geocodeStatus: 'ok' }]);
        matched++;
      }
    } catch (err) {
      statusEl.textContent = `Stopped early: ${err.message}. ${matched} of ${i} checked were matched so far.`;
      await loadAll();
      render();
      openUnmappedModal();
      btn.disabled = false;
      return;
    }
    // Policy-required throttle -- skip the wait after the very last request.
    const elapsed = performance.now() - t0;
    if (i < targets.length - 1 && elapsed < NOMINATIM_MIN_INTERVAL_MS) {
      await new Promise((r) => setTimeout(r, NOMINATIM_MIN_INTERVAL_MS - elapsed));
    }
  }

  await loadAll();
  render();
  openUnmappedModal();
  statusEl.textContent = `Matched ${matched} of ${targets.length} via OpenStreetMap.`;
  btn.disabled = false;
}

function openReviewModal() {
  const list = document.getElementById('review-list');
  const pending = window.__pendingReview || [];
  if (!pending.length) { list.innerHTML = '<div class="hint">No ambiguous matches right now.</div>'; }
  list.innerHTML = pending.map((r, i) => `
    <div class="review-row" data-idx="${i}">
      <div><strong>${escapeHtml(r.a.storeName)}</strong> (${escapeHtml(brandsById()[r.a.brandId]?.name || '')})<br>${escapeHtml(r.a.address)}</div>
      <div>vs.</div>
      <div><strong>${escapeHtml(r.b.storeName)}</strong> (${escapeHtml(brandsById()[r.b.brandId]?.name || '')})<br>${escapeHtml(r.b.address)}</div>
      <div class="conf">${r.confidence}% confidence match</div>
      <div class="review-actions">
        <button class="confirm" data-i="${i}" data-verdict="confirm">Same store</button>
        <button class="reject" data-i="${i}" data-verdict="reject">Different stores</button>
      </div>
    </div>`).join('');
  list.querySelectorAll('button[data-verdict]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const i = Number(btn.dataset.i);
      const r = pending[i];
      const overrides = JSON.parse(localStorage.getItem('aa-match-overrides') || '{}');
      overrides[`${r.a.id}::${r.b.id}`] = btn.dataset.verdict;
      localStorage.setItem('aa-match-overrides', JSON.stringify(overrides));
      pending.splice(i, 1);
      await recomputeMatches();
      openReviewModal();
      render();
    });
  });
  document.getElementById('review-modal').hidden = false;
}

// ---------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------

async function main() {
  // Clicking a county on the map navigates there ONLY -- it must never
  // silently filter the data too. That combination is exactly what made
  // pins vanish on zoom-out before: a stray click set an invisible county
  // filter, and zooming back out kept showing just that one county instead
  // of everything, with no on-screen sign the filter was even active.
  await initMap('leaflet-map', {
    onCountyClickFn: (name) => { flyToCounty(name, { onlyZoomIn: true }); },
    onRouteToggleFn: toggleRouteStop,
    routePositionFn: routePositionOf,
    onPlaceToggleFn: toggleRoutePlace,
    placePositionFn: routePositionOfPlace,
  });
  await loadAll();
  // A launch with every list remembered as off would open to a blank map.
  if (state.brands.length && state.activeBrandIds.size === 0) {
    offBrandIds.clear();
    saveOffLists();
    syncActiveBrands();
  }
  await recomputeMatches();
  render();
  renderRouteBar();
  renderRouteStops(routeStops);

  document.getElementById('near-me-btn').addEventListener('click', showNearMe);
  document.getElementById('near-close').addEventListener('click', () => { document.getElementById('near-panel').hidden = true; });
  document.getElementById('route-optimize').addEventListener('click', optimizeRoute);
  document.getElementById('route-start').addEventListener('click', startRoute);
  document.getElementById('route-clear').addEventListener('click', () => {
    routeStops = [];
    setRouteStatus('');
    commitRoute();
  });

  // Andrew, 2026-08-21: mobile-only off-canvas sidebar (see app.css's
  // max-width:820px block) -- toggle button opens/closes it, tapping the
  // backdrop closes it. No-op on desktop since the button is display:none
  // there, but the listeners are harmless either way.
  const sidebarEl = document.getElementById('sidebar');
  const backdropEl = document.getElementById('sidebar-backdrop');
  function closeSidebar() {
    sidebarEl.classList.remove('open');
    backdropEl.classList.remove('open');
    backdropEl.hidden = true;
  }
  document.getElementById('sidebar-toggle').addEventListener('click', () => {
    const opening = !sidebarEl.classList.contains('open');
    sidebarEl.classList.toggle('open', opening);
    backdropEl.classList.toggle('open', opening);
    backdropEl.hidden = !opening;
  });
  backdropEl.addEventListener('click', closeSidebar);

  document.getElementById('add-brand-btn').addEventListener('click', openUploadModal);
  document.getElementById('import-snapshot-btn').addEventListener('click', importSnapshot);
  document.getElementById('backup-all-btn').addEventListener('click', () => {
    if (!state.brands.length) { alert('There are no lists to back up yet.'); return; }
    exportAllLists(state.brands, state.accounts);
  });
  document.getElementById('upload-cancel').addEventListener('click', closeUploadModal);
  document.getElementById('upload-submit').addEventListener('click', handleUpload);

  document.querySelectorAll('#compare-segmented button').forEach((b) => {
    b.addEventListener('click', () => { state.compareMode = b.dataset.mode; render(); });
  });
  document.getElementById('gap-has').addEventListener('change', (e) => { state.gapHas = e.target.value; render(); });
  document.getElementById('gap-missing').addEventListener('change', (e) => { state.gapMissing = e.target.value; render(); });
  document.getElementById('filter-county').addEventListener('change', (e) => {
    state.filterCounty = e.target.value;
    render();
    if (state.filterCounty) flyToCounty(state.filterCounty);
  });
  document.getElementById('clear-county-filter').addEventListener('click', () => {
    state.filterCounty = '';
    document.getElementById('filter-county').value = '';
    render();
  });

  document.getElementById('review-badge').addEventListener('click', openReviewModal);
  document.getElementById('review-close').addEventListener('click', () => { document.getElementById('review-modal').hidden = true; });

  document.getElementById('unmapped-badge').addEventListener('click', openUnmappedModal);
  document.getElementById('unmapped-close').addEventListener('click', () => { document.getElementById('unmapped-modal').hidden = true; });
  document.getElementById('unmapped-export').addEventListener('click', () => {
    exportFilteredAccounts(unmappedAccounts(), brandsById(), 'account-atlas-unmapped.csv');
  });
  document.getElementById('unmapped-retry-osm').addEventListener('click', retryUnmappedViaOsm);

  document.getElementById('clear-all-btn').addEventListener('click', async () => {
    const total = state.accounts.length;
    const ok = confirm(
      `Delete everything stored in this browser -- ${state.brands.length} brand(s), ${total} account(s), all coordinates?\n\n` +
      `This cannot be undone. Click OK to delete, or Cancel to stop.`
    );
    if (!ok) return;
    await db.clearAllData();
    localStorage.removeItem('aa-match-overrides');
    location.reload();
  });

  document.getElementById('export-view-btn').addEventListener('click', () => {
    exportFilteredAccounts(visibleAccounts(), brandsById());
  });

  document.getElementById('search-input').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (!q) { render(); return; }
    const match = state.accounts.find((a) => a.storeName.toLowerCase().includes(q));
    if (match && match.lat !== null) {
      getMap().flyTo([match.lat, match.lon], 14);
    }
  });
}

main();

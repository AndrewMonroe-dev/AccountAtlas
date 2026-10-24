import * as db from './core/db.js?v=20261024c';
import { escapeHtml, normalizeCountyName, loadScriptOnce, newId, parseLatLon, inMichigan } from './core/util.js?v=20261024c';
import { parseBrandWorkbook, brandStats, normalizeAddressKey } from './data/excelParser.js?v=20261024c';
import { diffLists, describeDiff } from './data/diff.js?v=20261024c';
import { exportAddressesForGeocoding, importCoordinates, exportFilteredAccounts } from './data/csvTools.js?v=20261024c';
import { exportBrandSnapshot, exportAllLists, exportStandaloneViewer, parseSnapshotFile } from './data/snapshot.js?v=20261024c';
import {
  initMap, renderChoropleth, renderPins, flyToCounty, getMap, mapsUrlFor,
  renderRouteStops, showUserLocation, fitToPoints, focusAccount, setPinsVisible, closeDetailPanel, isDetailOpen,
  beginPlacement, cancelPlacement, isPlacing,
} from './modules/mapView.js?v=20261024c';
import {
  countyHeat, formatAmount, loadHeatMode, saveHeatMode, loadHeatOn, saveHeatOn, loadDotsOn, saveDotsOn, loadSkuOff, saveSkuOff,
} from './modules/heatmap.js?v=20261024c';
import {
  IGNORE, norm, defaultPriorities, loadPriorities, savePriorities, cleanPriorities, flatOrder, todayString, matchSkus, moveEntry, addEntry, removeEntry, setOnPremise,
} from './modules/priorities.js?v=20261024c';
import { buildBriefs, splitRows, shortSku, rankBestBets } from './modules/brief.js?v=20261024c';
import {
  MAX_STOPS, LEG_SIZE, haversineMiles, optimizeOrder, pathMiles, googleRouteUrl, routeLegs, legUrl, stopFromAccount, stopFromPlace, placeStopId, loadRoute, saveRoute,
} from './modules/route.js?v=20261024c';

const BRAND_COLORS = ['#a97a2e', '#35748c', '#6f5a70', '#4f7a4b', '#a1442f', '#7a5a9e'];

// Where the Geocode button sends addresses. Anything running this app's own
// server (the local helper, Cloudflare Pages) answers /api/geocode on the same
// origin. GitHub Pages is a plain static host with no server code, so it uses
// the standalone Cloudflare Worker relay (tools/cloudflare-worker.js) instead.
const GEOCODE_RELAY_URL = location.hostname.endsWith('.github.io')
  ? 'https://atlasviewer.vesvelid.workers.dev'
  : '/api/geocode';

// Browser storage keys that belong to the data, wiped by "Clear all data".
// View preferences (shade mode, dots, nearby) and brand priorities stay.
const DATA_STORAGE_KEYS = ['aa-route-v1', 'aa-lists-off-v1', 'aa-heat-skus-v1', 'aa-match-overrides'];

const state = {
  brands: [],           // [{id, name, color}]
  accounts: [],          // all accounts, all brands
  activeBrandIds: new Set(),
  filterCounty: '',      // normalized county key, '' = every county
  heatMode: loadHeatMode(), // 'sold' (penetration) | 'total' | 'avg' (volume heatmap)
  heatOn: loadHeatOn(),     // county shading drawn on the map
  dotsOn: loadDotsOn(),     // account dots drawn on the map
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

// Lists come back from storage in random id order, so they are sorted by when
// they were first added. That keeps "the first list that is on" (the heatmap
// list) and the automatic master list the same from one launch to the next.
function byCreation(a, b) {
  const when = (x) => x.createdAt || x.uploadedAt || '';
  return when(a).localeCompare(when(b)) || a.name.localeCompare(b.name);
}

async function loadAll() {
  [state.brands, state.accounts] = await Promise.all([db.getAllBrands(), db.getAllAccounts()]);
  state.brands.sort(byCreation);
  syncActiveBrands();
}

function visibleAccounts() {
  let accts = state.accounts.filter((a) => state.activeBrandIds.has(a.brandId));
  if (state.filterCounty) accts = accts.filter((a) => normalizeCountyName(a.county) === state.filterCounty);
  return accts;
}

function countyStatsFor(accounts) {
  const map = new Map();
  accounts.forEach((a) => {
    const key = normalizeCountyName(a.county);
    if (!key) return;
    const cur = map.get(key) || { sold: 0, total: 0 };
    cur.total += 1;
    if (Object.values(a.skus).some(Boolean)) cur.sold += 1;
    map.set(key, cur);
  });
  return map;
}

// ---------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------

function render() {
  renderBrandList();
  renderListChips();
  renderFilters();
  const accts = visibleAccounts();
  renderStats(accts);
  renderUnmappedBadge();
  const { heat, note, brand } = computeHeat(accts);
  renderHeatBar(note, brand, heat);
  renderChoropleth(countyStatsFor(accts), heat, state.heatOn);
  renderPins(accts.filter((a) => a.lat !== null && a.lon !== null), brandsById());
  setPinsVisible(state.dotsOn);
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
  if (!state.heatOn || state.heatMode === 'sold') return { heat: null, note: '', brand: null };
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
  bar.hidden = state.brands.length === 0;
  const modes = [['sold', 'Sold %'], ['total', 'Volume total'], ['avg', 'Volume per account']];
  const bandLabel = (l) => (l.min === l.max ? formatAmount(l.min) : `${formatAmount(l.min)} to ${formatAmount(l.max)}`);
  const legend = heat
    ? `<span class="heat-legend" title="Darker means more. Counties are sorted into up to 7 bands holding about the same number of counties each, so the colors stay distinct.">`
      + heat.legend.map((l) => `<span class="heat-band"><i style="background:${l.color}"></i>${bandLabel(l)}</span>`).join('')
      + '</span>'
    : '';
  const heatBtn = `<button class="heat-btn" id="heat-toggle-btn" aria-pressed="${state.heatOn}" title="Show or hide the county shading">Heat: ${state.heatOn ? 'on' : 'off'}</button>`;
  const dotsBtn = `<button class="heat-btn" id="dots-btn" aria-pressed="${state.dotsOn}" title="Show or hide the account dots so only the county shading shows">Dots: ${state.dotsOn ? 'on' : 'off'}</button>`;
  const skuBtn = state.heatMode !== 'sold' && brand && heat
    ? '<button class="heat-btn sku-btn" id="sku-btn" aria-haspopup="dialog">SKUs</button>' : '';
  bar.innerHTML = `<span class="heat-label">Shade</span>`
    + modes.map(([m, label]) => `<button class="heat-btn${state.heatMode === m ? ' on' : ''}" data-mode="${m}" aria-pressed="${state.heatMode === m}">${label}</button>`).join('')
    + heatBtn + dotsBtn + skuBtn
    + '<button class="heat-btn" id="prio-btn" title="Your brand priority order and focus periods">Priorities</button>' + legend
    + (note ? `<span class="heat-note">${escapeHtml(note)}</span>` : '');
  document.getElementById('heat-toggle-btn').addEventListener('click', () => {
    state.heatOn = !state.heatOn;
    saveHeatOn(state.heatOn);
    closeSkuPanel();
    render();
  });
  document.getElementById('prio-btn').addEventListener('click', openPrioPanel);
  document.getElementById('dots-btn').addEventListener('click', () => {
    state.dotsOn = !state.dotsOn;
    saveDotsOn(state.dotsOn);
    render();
  });
  bar.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.heatMode = btn.dataset.mode;
      saveHeatMode(state.heatMode);
      // Picking a shade means you want to see it, so it turns the heat back on.
      state.heatOn = true;
      saveHeatOn(true);
      closeSkuPanel();
      render();
    });
  });
  const sb = document.getElementById('sku-btn');
  if (sb) sb.addEventListener('click', () => toggleSkuPanel(brand));
  if (skuPanelBrandId && (!brand || brand.id !== skuPanelBrandId || state.heatMode === 'sold')) closeSkuPanel();
  // The bar can change height (the legend wraps on a narrow window), so the map
  // re-measures every time, not only when the bar appears.
  if (getMap()) getMap().invalidateSize();
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
  const counts = new Map();
  state.accounts.forEach((a) => {
    const c = counts.get(a.brandId) || { total: 0, mapped: 0 };
    c.total += 1;
    if (a.lat !== null) c.mapped += 1;
    counts.set(a.brandId, c);
  });
  document.getElementById('brand-list').innerHTML = state.brands.map((b) => {
    const c = counts.get(b.id) || { total: 0, mapped: 0 };
    const id = escapeHtml(String(b.id));
    return `
      <div class="brand-row">
        <span class="swatch" style="background:${escapeHtml(b.color)}"></span>
        <div class="info">
          <div class="bname">${escapeHtml(b.name)}</div>
          <div class="bsub">${c.total} accounts &middot; ${c.mapped} mapped</div>
        </div>
        <button class="toggle ${state.activeBrandIds.has(b.id) ? 'on' : ''}" role="switch" aria-checked="${state.activeBrandIds.has(b.id)}" aria-label="Show ${escapeHtml(b.name)} on the map" data-action="toggle-brand" data-id="${id}"></button>
        <div class="brand-actions">
          <button class="icon-btn geocode-btn" title="Geocode this list's accounts" aria-label="Geocode ${escapeHtml(b.name)}" data-action="geocode" data-id="${id}">&#128205;</button>
          <button class="icon-btn" title="Export a portable snapshot (data + coordinates) to move to another computer" aria-label="Export snapshot of ${escapeHtml(b.name)}" data-action="export-snapshot" data-id="${id}">&#128190;</button>
          <button class="icon-btn" title="Export a standalone map viewer: one HTML file, no login or install needed, safe to send to anyone" aria-label="Export map viewer of ${escapeHtml(b.name)}" data-action="export-viewer" data-id="${id}">&#128506;</button>
          <button class="icon-btn" title="Delete this list from this browser" aria-label="Delete ${escapeHtml(b.name)}" data-action="delete-list" data-id="${id}">&#128465;</button>
        </div>
      </div>`;
  }).join('');
}

// One listener for the whole list (set up once), so re-rendering the rows never
// has to re-attach anything.
async function brandListClick(ev) {
  const btn = ev.target.closest('[data-action]');
  if (!btn) return;
  const id = btn.dataset.id;
  const brand = state.brands.find((b) => String(b.id) === id);
  if (!brand) return;
  const action = btn.dataset.action;
  if (action === 'toggle-brand') {
    setBrandActive(brand.id, !state.activeBrandIds.has(brand.id));
    render();
  } else if (action === 'geocode') {
    geocodeBrandNow(brand.id, btn);
  } else if (action === 'export-snapshot') {
    exportBrandSnapshot(brand, state.accounts.filter((a) => a.brandId === brand.id));
  } else if (action === 'export-viewer') {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';
    try {
      await exportStandaloneViewer(brand, state.accounts.filter((a) => a.brandId === brand.id));
    } catch (err) {
      alert(`Couldn't build the standalone viewer: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  } else if (action === 'delete-list') {
    deleteList(brand.id);
  }
}

async function deleteList(brandId) {
  const brand = state.brands.find((b) => b.id === brandId);
  if (!brand) return;
  const mine = state.accounts.filter((a) => a.brandId === brandId);
  if (!confirm(`Delete the list "${brand.name}" and its ${mine.length} accounts from this browser?\n\nThis cannot be undone. Re-upload the Excel file to bring it back.`)) return;
  try {
    await db.deleteBrand(brandId);
  } catch (err) {
    alert(`Could not delete the list: ${err.message}`);
    return;
  }
  const gone = new Set(mine.map((a) => a.id));
  routeStops = routeStops.filter((s) => !gone.has(s.id));
  commitRoute();
  offBrandIds.delete(brandId);
  saveOffLists();
  saveSkuOff(brandId, new Set());
  if (prio.masterBrandId === brandId) setPrio({ ...prio, masterBrandId: null });
  if (skuPanelBrandId === brandId) closeSkuPanel();
  await loadAll();
  render();
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

function renderFilters() {
  const sel = document.getElementById('filter-county');
  // One entry per county however it was spelled, labelled with its commonest spelling.
  const spellings = new Map();
  state.accounts.forEach((a) => {
    const key = normalizeCountyName(a.county);
    if (!key) return;
    const counts = spellings.get(key) || new Map();
    counts.set(a.county.trim(), (counts.get(a.county.trim()) || 0) + 1);
    spellings.set(key, counts);
  });
  if (state.filterCounty && !spellings.has(state.filterCounty)) state.filterCounty = '';
  const options = [...spellings.entries()]
    .map(([key, counts]) => [key, [...counts.entries()].sort((x, y) => y[1] - x[1])[0][0]])
    .sort((x, y) => x[1].localeCompare(y[1]));
  sel.innerHTML = '<option value="">All counties</option>'
    + options.map(([key, label]) => `<option value="${escapeHtml(key)}">${escapeHtml(label)}</option>`).join('');
  sel.value = state.filterCounty;
  document.getElementById('clear-county-filter').hidden = !state.filterCounty;
}

function renderStats(accts) {
  const stats = brandStats(accts);
  document.getElementById('stat-sold').textContent = stats.soldAccounts;
  document.getElementById('stat-unsold').textContent = stats.unsoldAccounts;
  document.getElementById('stat-bar').style.width = stats.penetrationPct + '%';
  document.getElementById('stat-pct').textContent = `${stats.penetrationPct}% penetration (visible lists)`;
}

// ---------------------------------------------------------------
// Brand priorities (2026-10-23)
// ---------------------------------------------------------------
// Andrew's base brand order, focus periods that bump a few brands to the top
// for a while, and the rules that match each brand to SKU headers in the
// master sold/unsold list. Saved in the browser and carried in the all-lists
// backup. The route Brief (below) reads it.

let prio = loadPriorities();
const prioRuleOpen = new Set();   // entry ids whose rule box is expanded
let prioMsg = '';

function setPrio(next) {
  prio = next;
  savePriorities(prio);
  renderPrioPanel();
  refreshNear();
}

// The master sold/unsold list: the one Andrew picked, else the list with the
// most SKUs (his all-brands file).
function masterBrand() {
  const chosen = state.brands.find((b) => b.id === prio.masterBrandId);
  if (chosen) return chosen;
  return [...state.brands].sort((a, b) => (b.skuList || []).length - (a.skuList || []).length)[0] || null;
}

function masterMatches() {
  const master = masterBrand();
  return master ? matchSkus(prio, master.skuList || []) : { byEntry: new Map(), unmatched: [] };
}

function openPrioPanel() {
  prioMsg = '';
  document.getElementById('prio-modal').hidden = false;
  renderPrioPanel();
}

function closePrioPanel() {
  document.getElementById('prio-modal').hidden = true;
}

function entryLabel(entry) {
  const parent = entry.parentId ? prio.entries.find((x) => x.id === entry.parentId) : null;
  return parent ? `${parent.name} / ${entry.name}` : entry.name;
}

function renderPrioPanel() {
  const body = document.getElementById('prio-body');
  if (!body || document.getElementById('prio-modal').hidden) return;
  body.className = 'prio-body';
  const master = masterBrand();
  const matches = masterMatches();
  const flat = flatOrder(prio.entries);
  const today = todayString();
  const preset = prio.presets.find((x) => x.id === prio.activePresetId) || null;
  const expired = preset && preset.endDate && today > preset.endDate;

  // 1. Source list
  const srcOptions = ['<option value="">Automatic (list with the most SKUs)</option>']
    .concat(state.brands.map((b) => `<option value="${escapeHtml(String(b.id))}"${b.id === prio.masterBrandId ? ' selected' : ''}>${escapeHtml(b.name)} (${(b.skuList || []).length} SKUs)</option>`)).join('');
  const source = `<div class="prio-section"><h3>Sold / unsold source</h3>
    <div class="prio-row-inline"><select id="prio-master" aria-label="Master list">${srcOptions}</select></div>
    <div class="prio-note">${master
    ? `Using <strong>${escapeHtml(master.name)}</strong>: ${(master.skuList || []).length} SKU columns, ${[...matches.byEntry.values()].reduce((n, a) => n + a.length, 0)} matched to a priority brand, ${matches.unmatched.length} need a home.`
    : 'Upload your all-brands sold / unsold file first.'}</div></div>`;

  // 2. Focus period
  const presetOptions = ['<option value="">Base order (no focus)</option>']
    .concat(prio.presets.map((x) => `<option value="${escapeHtml(x.id)}"${x.id === prio.activePresetId ? ' selected' : ''}>${escapeHtml(x.name)}${x.endDate ? ' (ends ' + escapeHtml(x.endDate) + ')' : ''}</option>`)).join('');
  let focus = `<div class="prio-section"><h3>Focus period</h3>
    <div class="prio-row-inline"><select id="prio-preset" aria-label="Focus period">${presetOptions}</select>
      <button class="prio-btn" data-act="new-preset">New focus</button></div>`;
  if (preset) {
    const bumpRows = preset.bump.map((id, i) => {
      const entry = prio.entries.find((x) => x.id === id);
      return entry ? `<div class="prio-row" data-bump="${escapeHtml(id)}"><span class="prio-num">${i + 1}</span><span class="prio-name">${escapeHtml(entryLabel(entry))}</span>
        <button class="prio-btn" data-act="bump-up" aria-label="Move ${escapeHtml(entry.name)} up in the focus"${i === 0 ? ' disabled' : ''}>&#9650;</button>
        <button class="prio-btn" data-act="bump-down" aria-label="Move ${escapeHtml(entry.name)} down in the focus"${i === preset.bump.length - 1 ? ' disabled' : ''}>&#9660;</button>
        <button class="prio-btn danger" data-act="bump-remove" aria-label="Remove ${escapeHtml(entry.name)} from the focus">&times;</button></div>` : '';
    }).join('');
    const addOptions = flat.filter((x) => !preset.bump.includes(x.id))
      .map((x) => `<option value="${escapeHtml(x.id)}">${escapeHtml(entryLabel(x))}</option>`).join('');
    focus += `<div class="prio-row-inline">
        <input type="text" id="prio-preset-name" value="${escapeHtml(preset.name)}" aria-label="Focus name">
        <label class="prio-note" for="prio-preset-end">Ends</label>
        <input type="date" id="prio-preset-end" value="${escapeHtml(preset.endDate)}" aria-label="Focus end date">
        <button class="prio-btn danger" data-act="del-preset">Delete focus</button></div>
      <div class="prio-note">${expired ? 'This focus has ended, so the base order is in use. Change the end date to bring it back.' : 'These brands are bumped to the top, in this order. Everything else stays in the base order.'}</div>
      <div class="prio-list">${bumpRows || '<div class="prio-note">No brands bumped yet.</div>'}</div>
      <div class="prio-row-inline"><select id="prio-bump-add" aria-label="Brand to bump"><option value="">Bump a brand...</option>${addOptions}</select></div>`;
  }
  focus += '</div>';

  // 3. Base order
  let n = 0;
  const rows = flat.map((entry) => {
    const child = !!entry.parentId;
    if (!child) n += 1;
    const sibs = prio.entries.filter((x) => (x.parentId || null) === (entry.parentId || null));
    const at = sibs.indexOf(entry);
    const count = (matches.byEntry.get(entry.id) || []).length;
    const open = prioRuleOpen.has(entry.id);
    const tags = entry.tags.map((t) => `<span class="prio-tag">${t === 'on' ? 'On-premise' : 'Off-premise'}</span>`).join('');
    return `<div class="prio-row${child ? ' child' : ''}" data-id="${escapeHtml(entry.id)}">
      <span class="prio-num">${child ? '' : n}</span>
      <span class="prio-name">${escapeHtml(entry.name)}${tags}</span>
      <span class="prio-count${master && !count ? ' zero' : ''}">${master ? `${count} SKU${count === 1 ? '' : 's'}` : ''}</span>
      <label class="prio-onprem" title="Tag as an On-Premise focus brand"><input type="checkbox" data-tag-on="${escapeHtml(entry.id)}" aria-label="${escapeHtml(entry.name)} is an On-Premise focus"${entry.tags.includes('on') ? ' checked' : ''}> On-prem</label>
      <button class="prio-btn" data-act="up" aria-label="Move ${escapeHtml(entry.name)} up"${at === 0 ? ' disabled' : ''}>&#9650;</button>
      <button class="prio-btn" data-act="down" aria-label="Move ${escapeHtml(entry.name)} down"${at === sibs.length - 1 ? ' disabled' : ''}>&#9660;</button>
      <button class="prio-btn" data-act="top" aria-label="Move ${escapeHtml(entry.name)} to the top"${at === 0 ? ' disabled' : ''}>Top</button>
      <button class="prio-btn" data-act="rule" aria-expanded="${open}">Rule</button>
      <button class="prio-btn danger" data-act="remove" aria-label="Remove ${escapeHtml(entry.name)}">&times;</button>
      ${open ? `<div class="prio-rule"><textarea data-rule="${escapeHtml(entry.id)}" aria-label="Matching rule for ${escapeHtml(entry.name)}">${escapeHtml(entry.ruleText)}</textarea>
        <div class="prio-note">One line per must-have word. Put alternatives on a line with | between them. A line starting with not: lists words that rule the SKU out.${(matches.byEntry.get(entry.id) || []).length ? ' Matches now: ' + escapeHtml((matches.byEntry.get(entry.id) || []).slice(0, 4).join(', ')) + ((matches.byEntry.get(entry.id) || []).length > 4 ? ', ...' : '') : ''}</div></div>` : ''}
    </div>`;
  }).join('');
  const order = `<div class="prio-section"><h3>Base order</h3>
    <div class="prio-list">${rows}</div>
    <div class="prio-row-inline"><input type="text" id="prio-add-name" placeholder="New brand name" aria-label="New brand name"><button class="prio-btn" data-act="add">Add brand</button></div>
    <div class="prio-note">A new brand goes to the bottom, with a rule that looks for its name in the SKU headers. Use Top, Up and Down to place it.</div></div>`;

  // 4. Needs a home
  const homeOptions = flat.map((x) => `<option value="${escapeHtml(x.id)}">${escapeHtml(entryLabel(x))}</option>`).join('');
  const needs = matches.unmatched.length
    ? `<div class="prio-section"><h3>Needs a home (${matches.unmatched.length})</h3>
        <div class="prio-note">These SKU columns matched no brand. Pick the brand each belongs to, or ignore it. The Brief skips ignored SKUs.</div>
        ${matches.unmatched.map((sku) => `<div class="prio-row" data-sku="${escapeHtml(sku)}"><span class="prio-name">${escapeHtml(sku)}</span>
          <select data-assign="${escapeHtml(norm(sku))}" aria-label="Brand for ${escapeHtml(sku)}"><option value="">Choose...</option>${homeOptions}<option value="${IGNORE}">Ignore this SKU</option></select></div>`).join('')}</div>`
    : '';

  body.innerHTML = (prioMsg ? `<div class="prio-note">${escapeHtml(prioMsg)}</div>` : '') + source + focus + order + needs;
}

function prioClick(ev) {
  const btn = ev.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const row = btn.closest('[data-id]');
  const id = row ? row.dataset.id : null;
  const preset = prio.presets.find((x) => x.id === prio.activePresetId);
  const withPreset = (fn) => setPrio({ ...prio, presets: prio.presets.map((x) => (x.id === prio.activePresetId ? fn(x) : x)) });
  if (act === 'up' || act === 'down' || act === 'top') {
    setPrio(moveEntry(prio, id, act === 'top' ? 'top' : (act === 'up' ? -1 : 1)));
  } else if (act === 'rule') {
    if (prioRuleOpen.has(id)) prioRuleOpen.delete(id); else prioRuleOpen.add(id);
    renderPrioPanel();
  } else if (act === 'remove') {
    const entry = prio.entries.find((x) => x.id === id);
    const kids = prio.entries.filter((x) => x.parentId === id).length;
    if (entry && confirm(`Remove ${entry.name}${kids ? ` and its ${kids} sub-brand${kids === 1 ? '' : 's'}` : ''} from your priority list?`)) setPrio(removeEntry(prio, id));
  } else if (act === 'add') {
    const input = document.getElementById('prio-add-name');
    const next = addEntry(prio, input.value);
    if (next === prio) { input.focus(); return; }
    setPrio(next);
  } else if (act === 'new-preset') {
    const name = (prompt('Name for this focus period (for example Holiday push):') || '').trim();
    if (!name) return;
    const idNew = 'f-' + Date.now().toString(36);
    setPrio({ ...prio, presets: [...prio.presets, { id: idNew, name, endDate: '', bump: [] }], activePresetId: idNew });
  } else if (act === 'del-preset' && preset) {
    if (confirm(`Delete the focus "${preset.name}"?`)) setPrio({ ...prio, presets: prio.presets.filter((x) => x.id !== preset.id), activePresetId: null });
  } else if (act === 'bump-up' || act === 'bump-down') {
    const bid = btn.closest('[data-bump]').dataset.bump;
    withPreset((x) => {
      const list = x.bump.slice();
      const i = list.indexOf(bid);
      const j = i + (act === 'bump-up' ? -1 : 1);
      if (i < 0 || j < 0 || j >= list.length) return x;
      [list[i], list[j]] = [list[j], list[i]];
      return { ...x, bump: list };
    });
  } else if (act === 'bump-remove') {
    const bid = btn.closest('[data-bump]').dataset.bump;
    withPreset((x) => ({ ...x, bump: x.bump.filter((b) => b !== bid) }));
  }
}

function prioChange(ev) {
  const t = ev.target;
  if (t.id === 'prio-master') {
    setPrio({ ...prio, masterBrandId: t.value || null });
  } else if (t.id === 'prio-preset') {
    setPrio({ ...prio, activePresetId: t.value || null });
  } else if (t.id === 'prio-preset-name') {
    const name = t.value.trim();
    if (name) setPrio({ ...prio, presets: prio.presets.map((x) => (x.id === prio.activePresetId ? { ...x, name } : x)) });
  } else if (t.id === 'prio-preset-end') {
    setPrio({ ...prio, presets: prio.presets.map((x) => (x.id === prio.activePresetId ? { ...x, endDate: t.value } : x)) });
  } else if (t.id === 'prio-bump-add') {
    if (t.value) setPrio({ ...prio, presets: prio.presets.map((x) => (x.id === prio.activePresetId ? { ...x, bump: [...x.bump, t.value] } : x)) });
  } else if (t.dataset && t.dataset.rule) {
    setPrio({ ...prio, entries: prio.entries.map((x) => (x.id === t.dataset.rule ? { ...x, ruleText: t.value } : x)) });
  } else if (t.dataset && t.dataset.tagOn) {
    setPrio(setOnPremise(prio, t.dataset.tagOn, t.checked));
  } else if (t.dataset && t.dataset.assign) {
    if (t.value) setPrio({ ...prio, assign: { ...prio.assign, [t.dataset.assign]: t.value } });
  }
}

// ---------------------------------------------------------------
// Pre-visit Brief (2026-10-23)
// ---------------------------------------------------------------
// One section per route stop: which priority brands the store is missing (in
// Andrew's order, focus period first) and which it carries. Built on the phone
// from data already stored there, nothing leaves the browser.

function briefAddressKey(a) {
  return normalizeAddressKey(a.address, a.city, a.state, a.zip);
}

function briefRowHtml(r) {
  const tags = r.entry.tags.map((t) => `<span class="prio-tag">${t === 'on' ? 'On-premise' : 'Off-premise'}</span>`).join('');
  const star = r.bumped ? '<span class="brief-star" title="In your current focus">&#9733;</span>' : '';
  const cases = r.cases > 0 ? ` &middot; ${formatAmount(r.cases)} cases` : '';
  let detail;
  if (r.status === 'missing') {
    detail = `Not carried (0 of ${r.total} SKU${r.total === 1 ? '' : 's'})`;
  } else if (r.status === 'partial') {
    const names = r.missing.slice(0, 3).map(shortSku).map(escapeHtml).join(', ');
    detail = `Carries ${r.soldCount} of ${r.total}. Missing: ${names}${r.missing.length > 3 ? ` and ${r.missing.length - 3} more` : ''}`;
  } else {
    detail = `Carries ${r.total === 1 ? 'its 1 SKU' : `all ${r.total} SKUs`}`;
  }
  return `<li class="brief-row ${r.status}"><div class="brief-name">${star}${escapeHtml(r.entry.name)}${tags}</div><div class="brief-detail">${detail}${cases}</div></li>`;
}

function briefStopHtml(item, index) {
  const name = escapeHtml(item.stop.name);
  const open = index === 0 ? ' open' : '';
  if (item.kind === 'place') {
    return `<details class="brief-stop"${open}><summary>${index + 1}. ${name}<span class="brief-sub">nearby business</span></summary>
      <div class="brief-inner"><div class="brief-warn">This is a nearby business from the map, not one of your accounts, so there is no sold or unsold data to show.</div></div></details>`;
  }
  if (item.kind === 'gone') {
    return `<details class="brief-stop"${open}><summary>${index + 1}. ${name}</summary>
      <div class="brief-inner"><div class="brief-warn">This account is no longer in your lists.</div></div></details>`;
  }
  const a = item.account;
  const addr = `<div class="brief-addr">${escapeHtml([a.address, a.city].filter(Boolean).join(', '))}${a.county ? ' &middot; ' + escapeHtml(a.county) + ' County' : ''}</div>`;
  if (item.kind === 'nomaster') {
    const withCases = item.rows.filter((r) => r.cases > 0);
    return `<details class="brief-stop"${open}><summary>${index + 1}. ${name}<span class="brief-sub">not in the master list</span></summary>
      <div class="brief-inner">${addr}<div class="brief-warn">This store was not found in your master list, so whether it carries each brand is unknown.</div>
      ${withCases.length ? `<div class="brief-h">Cases on file</div><ul class="brief-list">${withCases.map((r) => `<li class="brief-row"><div class="brief-name">${escapeHtml(r.entry.name)}</div><div class="brief-detail">${formatAmount(r.cases)} cases</div></li>`).join('')}</ul>` : ''}</div></details>`;
  }
  const { gaps, carrying, otherGaps, otherCarrying } = splitRows(item.rows, briefOnPrem);
  const head = gaps.slice(0, 8);
  const rest = gaps.slice(8);
  const gapHtml = gaps.length
    ? `<div class="brief-h">Pitch first (${gaps.length})</div><ul class="brief-list">${head.map(briefRowHtml).join('')}</ul>
       ${rest.length ? `<details class="brief-more"><summary>${rest.length} more gap${rest.length === 1 ? '' : 's'}</summary><ul class="brief-list">${rest.map(briefRowHtml).join('')}</ul></details>` : ''}`
    : `<div class="brief-warn">No gaps: this store carries every ${briefOnPrem ? 'on-premise focus' : 'priority'} brand that has SKUs in your master list.</div>`;
  const carryHtml = carrying.length
    ? `<details class="brief-more"><summary>Already carrying (${carrying.length})</summary><ul class="brief-list">${carrying.map(briefRowHtml).join('')}</ul></details>` : '';
  // On-premise mode: every other brand stays one tap away, in the same order.
  const otherHtml = briefOnPrem && (otherGaps.length || otherCarrying.length)
    ? `<details class="brief-more"><summary>Other brands (${otherGaps.length} gap${otherGaps.length === 1 ? '' : 's'}, ${otherCarrying.length} carrying)</summary>
        ${otherGaps.length ? `<div class="brief-h">Gaps</div><ul class="brief-list">${otherGaps.map(briefRowHtml).join('')}</ul>` : ''}
        ${otherCarrying.length ? `<div class="brief-h">Carrying</div><ul class="brief-list">${otherCarrying.map(briefRowHtml).join('')}</ul>` : ''}</details>` : '';
  return `<details class="brief-stop"${open}><summary>${index + 1}. ${name}<span class="brief-sub">${gaps.length} gap${gaps.length === 1 ? '' : 's'} &middot; ${carrying.length} carrying${briefOnPrem ? ' (on-premise focus)' : ''}</span></summary>
    <div class="brief-inner">${addr}${gapHtml}${carryHtml}${otherHtml}</div></details>`;
}

function openBrief() {
  const body = document.getElementById('brief-body');
  const master = masterBrand();
  let html;
  if (!master) {
    html = '<div class="brief-warn">Upload your all-brands sold / unsold file first. The Brief needs it to know what each store carries.</div>';
  } else if (!routeStops.length) {
    html = '<div class="brief-warn">Add stops to your route first.</div>';
  } else {
    const result = buildBriefs({
      stops: routeStops, accounts: state.accounts, brands: state.brands, prio, master, addressKey: briefAddressKey, today: todayString(),
    });
    const h = result.header;
    const lines = [`Sold or not comes from <strong>${escapeHtml(h.master)}</strong>.`];
    lines.push(h.focus
      ? `Focus: <strong>${escapeHtml(h.focus.name)}</strong>${h.focus.endDate ? ' (ends ' + escapeHtml(h.focus.endDate) + ')' : ''}. Bumped to the top: ${escapeHtml(h.focus.bumped.join(', ') || 'none yet')}.`
      : 'Your base priority order, no focus period in force.');
    if (h.noSkus.length) lines.push(`${h.noSkus.length} priority brand${h.noSkus.length === 1 ? ' has' : 's have'} no SKUs in this list and are left out: ${escapeHtml(h.noSkus.slice(0, 6).join(', '))}${h.noSkus.length > 6 ? ` and ${h.noSkus.length - 6} more` : ''}.`);
    if (h.needsHome) lines.push(`${h.needsHome} SKU${h.needsHome === 1 ? '' : 's'} need a home. Open Priorities to place ${h.needsHome === 1 ? 'it' : 'them'}.`);
    if (briefOnPrem) lines.push('On-premise focus brands come first. Every other brand is under Other brands on each stop.');
    html = `<label class="brief-toggle"><input type="checkbox" id="brief-onprem"${briefOnPrem ? ' checked' : ''}> On-premise focus first</label>`
      + `<div class="brief-head">${lines.map((l) => `<div>${l}</div>`).join('')}</div>`
      + result.stops.map(briefStopHtml).join('');
  }
  body.innerHTML = html;
  document.getElementById('brief-modal').hidden = false;
}

// Whether the Brief puts the On-Premise focus brands first (remembered).
let briefOnPrem = (() => { try { return localStorage.getItem('aa-brief-onprem-v1') === 'on'; } catch { return false; } })();

function briefChange(ev) {
  if (ev.target.id !== 'brief-onprem') return;
  briefOnPrem = ev.target.checked;
  try { localStorage.setItem('aa-brief-onprem-v1', briefOnPrem ? 'on' : 'off'); } catch { /* storage blocked */ }
  openBrief();
  refreshNear();
}

function closeBrief() {
  document.getElementById('brief-modal').hidden = true;
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
let legIndex = 0;   // next leg to open when Short legs is on
const LEGS_KEY = 'aa-route-legs-v1';
let legsOn = (() => { try { return localStorage.getItem(LEGS_KEY) === 'on'; } catch { return false; } })();
let nearRows = [];   // rows shown in the Near me panel: { acct, miles, gaps?, brief? }
let nearPool = [];   // the 30 nearest mapped accounts from the last search: { acct, miles }
let nearHere = null; // where that search was made
let nearMessage = '';
const NEAR_MODE_KEY = 'aa-near-mode-v1';
let nearMode = (() => { try { return localStorage.getItem(NEAR_MODE_KEY) === 'best' ? 'best' : 'closest'; } catch { return 'closest'; } })();

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
  legIndex = 0;
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
  document.getElementById('route-brief').disabled = routeStops.length === 0;
  document.getElementById('route-start').disabled = routeStops.length === 0;
  document.getElementById('route-legs').checked = legsOn;
  updateStartButton();
}

// With Short legs on and more than one leg, the button opens the next leg.
function legCount() {
  return legsOn && routeStops.length > LEG_SIZE ? routeLegs(routeStops).length : 1;
}

function updateStartButton() {
  const btn = document.getElementById('route-start');
  const n = legCount();
  if (n === 1) { btn.textContent = 'Start route'; return; }
  const from = legIndex * LEG_SIZE + 1;
  const to = Math.min(routeStops.length, (legIndex + 1) * LEG_SIZE);
  btn.textContent = `Start leg ${legIndex + 1} of ${n} (stops ${from} to ${to})`;
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
  let url;
  if (legCount() > 1) {
    url = legUrl(routeStops, legIndex);
    legIndex = (legIndex + 1) % legCount();
    updateStartButton();
  } else {
    url = googleRouteUrl(routeStops);
  }
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

// Rebuilds the rows from the pool. Closest is the first 10 by distance. Best
// bets reads each store's gaps against the master list (the same logic as the
// Brief) and ranks by what is worth pitching, discounted by distance.
function buildNearRows() {
  nearMessage = '';
  if (nearMode === 'best') {
    const master = masterBrand();
    if (!master) {
      nearRows = [];
      nearMessage = 'Upload your all-brands sold / unsold file first. Best bets needs it to know what each store carries.';
      return;
    }
    const result = buildBriefs({
      stops: nearPool.map(({ acct }) => ({ id: acct.id, name: acct.storeName })),
      accounts: state.accounts, brands: state.brands, prio, master, addressKey: briefAddressKey, today: todayString(),
    });
    nearRows = rankBestBets(nearPool.map((c, i) => ({ ...c, brief: result.stops[i] })), briefOnPrem).slice(0, 10);
  } else {
    nearRows = nearPool.slice(0, 10);
  }
}

function pitchText(row) {
  if (!row.brief || row.brief.kind !== 'ok') return 'not in the master list';
  if (!row.gaps.length) return 'no gaps';
  const names = row.gaps.slice(0, 3).map((r) => r.entry.name).join(', ');
  return `Pitch: ${escapeHtml(names)}${row.gaps.length > 3 ? ` +${row.gaps.length - 3} more` : ''}`;
}

function renderNearList() {
  const panel = document.getElementById('near-panel');
  if (panel.hidden) return;
  const list = document.getElementById('near-list');
  const best = nearMode === 'best';
  document.getElementById('near-tab-closest').classList.toggle('on', !best);
  document.getElementById('near-tab-closest').setAttribute('aria-pressed', String(!best));
  document.getElementById('near-tab-best').classList.toggle('on', best);
  document.getElementById('near-tab-best').setAttribute('aria-pressed', String(best));
  const hint = document.getElementById('near-hint');
  hint.hidden = !best || !!nearMessage;
  hint.textContent = 'Ranked by the priority brands each store is missing, closer stores first. Uses your Priorities and the On-premise switch in the Brief.';
  if (nearMessage) { list.innerHTML = `<div class="near-msg">${escapeHtml(nearMessage)}</div>`; return; }
  if (!nearRows.length) return;
  list.innerHTML = nearRows.map((row) => {
    const { acct, miles } = row;
    const sub = best ? pitchText(row) : (Object.values(acct.skus).some(Boolean) ? 'sold' : 'unsold');
    return `
    <div class="near-row">
      <div class="near-info" data-focus="${escapeHtml(String(acct.id))}">
        <div class="near-name">${escapeHtml(acct.storeName)}</div>
        <div class="near-sub">${escapeHtml(acct.city)} &middot; ${miles.toFixed(1)} mi &middot; ${sub}</div>
      </div>
      <button data-add="${escapeHtml(String(acct.id))}" ${routePositionOf(acct.id) ? 'disabled' : ''}>${routePositionOf(acct.id) ? 'Stop ' + routePositionOf(acct.id) : '+ Route'}</button>
    </div>`;
  }).join('');
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

// Called when something that changes the ranking changes (priorities, the
// On-premise switch, the tab).
function refreshNear() {
  if (document.getElementById('near-panel').hidden || !nearPool.length) return;
  buildNearRows();
  renderNearList();
}

function setNearMode(mode) {
  nearMode = mode;
  try { localStorage.setItem(NEAR_MODE_KEY, mode); } catch { /* storage blocked */ }
  refreshNear();
  if (nearHere && nearRows.length) fitToPoints([[nearHere.lat, nearHere.lon], ...nearRows.map((r) => [r.acct.lat, r.acct.lon])]);
}

async function showNearMe() {
  const panel = document.getElementById('near-panel');
  const list = document.getElementById('near-list');
  panel.hidden = false;
  nearRows = [];
  nearPool = [];
  nearMessage = '';
  renderNearList();
  list.innerHTML = '<div class="near-msg">Finding you...</div>';
  let here;
  try {
    here = await getPosition();
  } catch (err) {
    list.innerHTML = `<div class="near-msg">${escapeHtml(err.message)}</div>`;
    return;
  }
  nearHere = here;
  showUserLocation(here.lat, here.lon);
  nearPool = visibleAccounts()
    .filter((a) => a.lat !== null && a.lon !== null)
    .map((acct) => ({ acct, miles: haversineMiles(here, { lat: acct.lat, lon: acct.lon }) }))
    .sort((x, y) => x.miles - y.miles)
    .slice(0, 30);
  if (!nearPool.length) {
    list.innerHTML = '<div class="near-msg">No accounts with a map point in the current view.</div>';
    return;
  }
  buildNearRows();
  renderNearList();
  if (nearRows.length) fitToPoints([[here.lat, here.lon], ...nearRows.map((r) => [r.acct.lat, r.acct.lon])]);
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
  const file = document.getElementById('upload-file').files[0];
  const message = document.getElementById('upload-warnings');
  if (!name || !file) { message.textContent = 'A list name and an Excel file are both required.'; return; }

  const submit = document.getElementById('upload-submit');
  submit.disabled = true;
  try {
    message.textContent = 'Reading the file...';
    // The spreadsheet reader is large and only needed here, so it loads now.
    await loadScriptOnce('vendor/xlsx/xlsx.full.min.js');

    const existing = state.brands.find((b) => b.name.toLowerCase() === name.toLowerCase());
    // Carry-forward data: this list's own prior accounts (an unchanged address
    // keeps its geocode on replace) and every geocoded address across ALL lists
    // (a new list at an already-mapped store skips geocoding).
    const previousById = {};
    if (existing) state.accounts.filter((a) => a.brandId === existing.id).forEach((a) => { previousById[a.id] = a; });
    const addressIndex = {};
    state.accounts.forEach((a) => {
      if ((a.geocodeStatus === 'ok' || a.geocodeStatus === 'manual') && a.lat !== null && a.lon !== null) {
        addressIndex[normalizeAddressKey(a.address, a.city, a.state, a.zip)] = { lat: a.lat, lon: a.lon };
      }
    });

    // Parse BEFORE anything is replaced: a bad file must never cost the old list.
    const brandId = existing ? existing.id : newId();
    let parsed;
    try {
      parsed = parseBrandWorkbook(await file.arrayBuffer(), brandId, { previousById, addressIndex });
    } catch (err) {
      message.textContent = 'Could not parse file: ' + err.message;
      return;
    }

    const diff = existing ? diffLists(Object.values(previousById), existing.skuList || [], parsed.accounts, parsed.skuList) : null;
    if (existing && !confirm(`"${name}" already exists. Replace it with this file?\n\n${describeDiff(diff)}`)) {
      message.textContent = '';
      return;
    }

    const color = existing ? existing.color : BRAND_COLORS[state.brands.length % BRAND_COLORS.length];
    const now = new Date().toISOString();
    const createdAt = existing ? (existing.createdAt || existing.uploadedAt || now) : now;
    await db.replaceBrand({ id: brandId, name, color, skuList: parsed.skuList, uploadedAt: now, createdAt }, parsed.accounts);

    offBrandIds.delete(brandId);
    saveOffLists();
    await loadAll();
    render();

    if (parsed.warnings.length) {
      const shown = parsed.warnings.slice(0, 20);
      if (parsed.warnings.length > shown.length) shown.push(`...and ${parsed.warnings.length - shown.length} more.`);
      message.textContent = `Uploaded ${parsed.accounts.length} accounts.\n` + shown.join('\n');
    } else {
      closeUploadModal();
    }
  } catch (err) {
    message.textContent = 'Upload failed: ' + err.message;
  } finally {
    submit.disabled = false;
  }
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
    try {
      await importSnapshotFiles(files);
    } catch (err) {
      alert(`Import failed: ${err.message}`);
    }
  });
  input.click();
}

async function importSnapshotFiles(files) {
  // Parse everything first. A bad file is reported and skipped, the rest still import.
  // A list name appearing twice in the batch keeps the last one.
  const incoming = new Map();
  const problems = [];
  let importedPrio = null;
  for (const file of files) {
    try {
      const parsed = await parseSnapshotFile(file);
      if (parsed.priorities) importedPrio = parsed.priorities;
      parsed.forEach((list) => incoming.set(list.brand.name.toLowerCase(), list));
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
  let added = 0;
  for (const list of lists) {
    const existing = findExisting(list);
    if (existing && !replaceClashes) { skipped.push(list.brand.name); continue; }
    const brandId = existing ? existing.id : (list.brand.id || newId());
    const color = existing ? existing.color : BRAND_COLORS[(state.brands.length + added) % BRAND_COLORS.length];
    const createdAt = (existing && (existing.createdAt || existing.uploadedAt)) || list.brand.createdAt || list.brand.uploadedAt || new Date().toISOString();
    await db.replaceBrand({ ...list.brand, id: brandId, color, createdAt }, list.accounts.map((a) => ({ ...a, brandId })));
    offBrandIds.delete(brandId);
    if (!existing) added += 1;
    done.push(`${list.brand.name} (${list.accounts.length} accounts, ${list.accounts.filter((a) => a.lat !== null && a.lon !== null).length} mapped)`);
  }
  saveOffLists();
  await loadAll();

  // Brand priorities in a backup: applied silently over untouched defaults,
  // otherwise only after a confirm, so a restore never wipes edits unasked.
  let prioNote = '';
  if (importedPrio) {
    const incomingPrio = cleanPriorities(importedPrio);
    const wanted = String(importedPrio.masterBrandName || '').toLowerCase();
    const master = wanted ? state.brands.find((b) => b.name.toLowerCase() === wanted) : null;
    incomingPrio.masterBrandId = master ? master.id : null;
    const untouched = JSON.stringify({ ...prio, masterBrandId: null }) === JSON.stringify({ ...defaultPriorities(), masterBrandId: null });
    if (untouched || confirm('This backup includes your brand priorities. OK replaces your current priorities with the backup\'s. Cancel keeps your current ones.')) {
      prio = incomingPrio;
      savePriorities(prio);
      prioNote = '\n\nBrand priorities restored from the backup.';
    } else {
      prioNote = '\n\nKept your current brand priorities.';
    }
  }
  render();

  alert(
    (done.length ? `Imported ${done.length} list${done.length === 1 ? '' : 's'}:\n${done.join('\n')}` : 'Nothing was imported.') + prioNote +
    (skipped.length ? `\n\nKept your current copy of: ${skipped.join(', ')}` : '') +
    (problems.length ? `\n\nCould not read:\n${problems.join('\n')}` : '')
  );
}

// ---------------------------------------------------------------
// Geocoding: the 📍 button sends a list's unmapped addresses to the relay
// (GEOCODE_RELAY_URL), which asks the Census Bureau's batch geocoder. If the
// relay cannot be reached, the old manual export / run script / import path
// is offered instead.
// ---------------------------------------------------------------

async function geocodeBrandNow(brandId, btn) {
  const brand = state.brands.find((b) => b.id === brandId);
  const accts = state.accounts.filter((a) => a.brandId === brandId);
  const pending = accts.filter((a) => a.geocodeStatus !== 'ok' && a.geocodeStatus !== 'manual');

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
      signal: AbortSignal.timeout(180000),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error || ''; } catch { /* not JSON */ }
      throw new Error(detail || `relay returned ${res.status}`);
    }
    const { results } = await res.json();
    if (!results || typeof results !== 'object') throw new Error('the relay sent back something unexpected');

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
    try {
      const result = await importCoordinates(brandId, file, { getAllAccounts: db.getAllAccounts, putAccounts: db.putAccounts });
      alert(`Matched coordinates for ${result.matched} of ${result.total} accounts.`);
      await loadAll();
      render();
    } catch (err) {
      alert(`Could not import coordinates: ${err.message}`);
    }
  });
  input.click();
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
  const brands = brandsById();
  if (!accts.length) {
    list.innerHTML = '<div class="hint">Everything is mapped.</div>';
  } else {
    list.innerHTML = accts.map((a) => {
      const brand = brands[a.brandId];
      const failed = a.geocodeStatus === 'failed';
      return `
        <div class="review-row">
          <div><strong>${escapeHtml(a.storeName)}</strong> (${escapeHtml(brand ? brand.name : '')})</div>
          <a class="hint" href="${escapeHtml(mapsUrlFor(a))}" target="_blank" rel="noopener" title="Open in Maps -- worth a try even though our geocoder couldn't match it">${escapeHtml(a.address)}, ${escapeHtml(a.city)}, ${escapeHtml(a.state)} ${escapeHtml(a.zip)}</a>
          <div class="chip ${failed ? 'unsold' : ''}" style="width:fit-content">${failed ? 'Address not found' : 'Not yet geocoded'}</div>
          <div class="place-row">
            <input type="text" class="place-input" data-id="${escapeHtml(String(a.id))}" placeholder="lat, lon" aria-label="Coordinates for ${escapeHtml(a.storeName)}" autocomplete="off">
            <button class="prio-btn" data-place="set" data-id="${escapeHtml(String(a.id))}">Set</button>
            <button class="prio-btn" data-place="pick" data-id="${escapeHtml(String(a.id))}">Pick on map</button>
          </div>
        </div>`;
    }).join('');
  }
  document.getElementById('unmapped-modal').hidden = false;
}

// Places an account by hand. A typo that lands outside Michigan asks first.
async function placeAccount(id, lat, lon) {
  const acct = state.accounts.find((a) => String(a.id) === String(id));
  if (!acct) return false;
  if (!inMichigan(lat, lon) && !confirm(`${lat.toFixed(5)}, ${lon.toFixed(5)} is outside Michigan. Place ${acct.storeName} there anyway?`)) return false;
  try {
    await db.putAccounts([{ ...acct, lat, lon, geocodeStatus: 'manual' }]);
    await loadAll();
    render();
  } catch (err) {
    alert(`Could not save the position: ${err.message}`);
    return false;
  }
  return true;
}

async function unmappedListClick(ev) {
  const btn = ev.target.closest('[data-place]');
  if (!btn) return;
  const id = btn.dataset.id;
  const acct = state.accounts.find((a) => String(a.id) === id);
  if (!acct) return;
  if (btn.dataset.place === 'set') {
    const input = [...document.querySelectorAll('#unmapped-list .place-input')].find((x) => x.dataset.id === id);
    const point = parseLatLon(input ? input.value : '');
    if (!point) {
      document.getElementById('unmapped-retry-status').textContent = `Could not read coordinates for ${acct.storeName}. Type them as lat, lon, for example 42.7325, -84.5555.`;
      if (input) input.focus();
      return;
    }
    const keep = [...document.querySelectorAll('#unmapped-list .place-input')].filter((x) => x.value && x.dataset.id !== id).map((x) => [x.dataset.id, x.value]);
    if (await placeAccount(id, point.lat, point.lon)) {
      openUnmappedModal();
      // Anything typed into other rows is put back after the list redraws.
      keep.forEach(([otherId, value]) => {
        const box = [...document.querySelectorAll('#unmapped-list .place-input')].find((x) => x.dataset.id === otherId);
        if (box) box.value = value;
      });
      document.getElementById('unmapped-retry-status').textContent = `Placed ${acct.storeName}.`;
    }
  } else if (btn.dataset.place === 'pick') {
    document.getElementById('unmapped-modal').hidden = true;
    startPlacing(acct);
  }
}

function startPlacing(acct) {
  const bar = document.getElementById('place-bar');
  document.getElementById('place-text').textContent = `Tap the map where ${acct.storeName} is. Zoom in first if you need to.`;
  bar.hidden = false;
  beginPlacement(async (point) => {
    bar.hidden = true;
    if (!point) return;
    if (await placeAccount(acct.id, point.lat, point.lon)) focusAccount(acct.id);
  });
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
  const found = [];
  let stoppedWith = '';
  for (let i = 0; i < targets.length; i++) {
    statusEl.textContent = `Checking ${i + 1} of ${targets.length} via OpenStreetMap (about 1/sec, please wait)...`;
    const t0 = performance.now();
    try {
      const coords = await geocodeOneViaNominatim(targets[i]);
      if (coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lon)) {
        found.push({ ...targets[i], lat: coords.lat, lon: coords.lon, geocodeStatus: 'ok' });
      }
    } catch (err) {
      stoppedWith = err.message;
      break;
    }
    // Policy-required throttle -- skip the wait after the very last request.
    const elapsed = performance.now() - t0;
    if (i < targets.length - 1 && elapsed < NOMINATIM_MIN_INTERVAL_MS) {
      await new Promise((r) => setTimeout(r, NOMINATIM_MIN_INTERVAL_MS - elapsed));
    }
  }

  // Saved in one write, and also when the run stopped early, so no match is lost.
  if (found.length) {
    try {
      await db.putAccounts(found);
      await loadAll();
      render();
    } catch (err) {
      stoppedWith = stoppedWith || `could not save: ${err.message}`;
    }
  }
  openUnmappedModal();
  statusEl.textContent = stoppedWith
    ? `Stopped early: ${stoppedWith}. ${found.length} matched before that.`
    : `Matched ${found.length} of ${targets.length} via OpenStreetMap.`;
  btn.disabled = false;
}

// ---------------------------------------------------------------
// Search: type a store name, city or address, tap a result to jump to it
// ---------------------------------------------------------------

function wireSearch() {
  const input = document.getElementById('search-input');
  const box = document.getElementById('search-results');
  let results = [];
  let timer = null;

  const hide = () => { clearTimeout(timer); box.hidden = true; box.innerHTML = ''; results = []; };

  function run() {
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) { hide(); return; }
    const brands = brandsById();
    results = state.accounts
      .filter((a) => state.activeBrandIds.has(a.brandId)
        && [a.storeName, a.city, a.address, a.storeNumber].some((f) => String(f || '').toLowerCase().includes(q)))
      .sort((x, y) => (y.lat !== null) - (x.lat !== null) || x.storeName.localeCompare(y.storeName))
      .slice(0, 8);
    if (!results.length) {
      box.innerHTML = '<div class="search-empty">No matching accounts in the lists that are on.</div>';
    } else {
      box.innerHTML = results.map((a) => {
        const mapped = a.lat !== null && a.lon !== null;
        const brand = brands[a.brandId];
        return `<button type="button" class="search-row" data-id="${escapeHtml(String(a.id))}"${mapped ? '' : ' disabled'}>
          <span class="search-name">${escapeHtml(a.storeName)}</span>
          <span class="search-sub">${escapeHtml(a.city)}${brand ? ' &middot; ' + escapeHtml(brand.name) : ''}${mapped ? '' : ' &middot; not on map'}</span></button>`;
      }).join('');
    }
    box.hidden = false;
  }

  function pick(id) {
    const acct = results.find((a) => String(a.id) === id);
    if (!acct || acct.lat === null) return;
    hide();
    input.blur();
    closeSidebar();
    if (state.filterCounty && normalizeCountyName(acct.county) !== state.filterCounty) {
      state.filterCounty = '';
      render();
    }
    focusAccount(acct.id);
  }

  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 120); });
  input.addEventListener('focus', () => { if (input.value.trim().length >= 2 && !results.length) run(); });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      const first = results.find((a) => a.lat !== null);
      if (first) pick(String(first.id));
    } else if (ev.key === 'Escape' && (!box.hidden || input.value)) {
      ev.stopPropagation();
      input.value = '';
      hide();
    }
  });
  box.addEventListener('click', (ev) => {
    const row = ev.target.closest('.search-row');
    if (row && !row.disabled) pick(row.dataset.id);
  });
  document.addEventListener('click', (ev) => { if (!ev.target.closest('.search')) hide(); });
}

// ---------------------------------------------------------------
// Errors the person should see instead of a silently dead page
// ---------------------------------------------------------------

let errorTimer = null;

function showAppError(message, { sticky = false } = {}) {
  const el = document.getElementById('app-error');
  if (!el) { alert(message); return; }
  el.querySelector('.app-error-text').textContent = message;
  el.hidden = false;
  clearTimeout(errorTimer);
  if (!sticky) errorTimer = setTimeout(() => { el.hidden = true; }, 15000);
}

window.addEventListener('unhandledrejection', (ev) => {
  showAppError(`Something went wrong: ${(ev.reason && ev.reason.message) || ev.reason}`);
});
window.addEventListener('error', (ev) => {
  if (!ev.message || ev.message === 'Script error.' || /ResizeObserver/.test(ev.message)) return;
  showAppError(`Something went wrong: ${ev.message}`);
});

// ---------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  const backdrop = document.getElementById('sidebar-backdrop');
  backdrop.classList.remove('open');
  backdrop.hidden = true;
}

const MODAL_CLOSERS = {
  'upload-modal': closeUploadModal,
  'prio-modal': closePrioPanel,
  'brief-modal': closeBrief,
  'unmapped-modal': () => { document.getElementById('unmapped-modal').hidden = true; },
};

// Escape closes the top-most thing that is open.
function onEscape(ev) {
  if (ev.key !== 'Escape') return;
  if (isPlacing()) { cancelPlacement(); return; }
  const modal = [...document.querySelectorAll('.modal-backdrop')].find((m) => !m.hidden);
  if (modal) { (MODAL_CLOSERS[modal.id] || (() => { modal.hidden = true; }))(); return; }
  if (!document.getElementById('sku-panel').hidden) { closeSkuPanel(); return; }
  if (!document.getElementById('near-panel').hidden) { document.getElementById('near-panel').hidden = true; return; }
  if (isDetailOpen()) { closeDetailPanel(); return; }
  closeSidebar();
}

function wireUi() {
  document.getElementById('brand-list').addEventListener('click', brandListClick);
  document.getElementById('near-me-btn').addEventListener('click', showNearMe);
  document.getElementById('near-tab-closest').addEventListener('click', () => setNearMode('closest'));
  document.getElementById('near-tab-best').addEventListener('click', () => setNearMode('best'));
  document.getElementById('near-close').addEventListener('click', () => { document.getElementById('near-panel').hidden = true; });
  document.getElementById('route-optimize').addEventListener('click', optimizeRoute);
  document.getElementById('route-brief').addEventListener('click', openBrief);
  document.getElementById('brief-close').addEventListener('click', closeBrief);
  document.getElementById('brief-body').addEventListener('change', briefChange);
  document.getElementById('brief-modal').addEventListener('click', (ev) => { if (ev.target.id === 'brief-modal') closeBrief(); });
  document.getElementById('route-start').addEventListener('click', startRoute);
  document.getElementById('route-legs').addEventListener('change', (ev) => {
    legsOn = ev.target.checked;
    try { localStorage.setItem(LEGS_KEY, legsOn ? 'on' : 'off'); } catch { /* storage blocked */ }
    legIndex = 0;
    updateStartButton();
  });
  document.getElementById('route-clear').addEventListener('click', () => {
    routeStops = [];
    setRouteStatus('');
    commitRoute();
  });

  // Mobile: the sidebar is an off-canvas drawer (see app.css, max-width 820px).
  const sidebarEl = document.getElementById('sidebar');
  const backdropEl = document.getElementById('sidebar-backdrop');
  document.getElementById('sidebar-toggle').addEventListener('click', () => {
    const opening = !sidebarEl.classList.contains('open');
    sidebarEl.classList.toggle('open', opening);
    backdropEl.classList.toggle('open', opening);
    backdropEl.hidden = !opening;
  });
  backdropEl.addEventListener('click', closeSidebar);

  document.getElementById('prio-close').addEventListener('click', closePrioPanel);
  document.getElementById('prio-modal').addEventListener('click', (ev) => { if (ev.target.id === 'prio-modal') closePrioPanel(); });
  const prioBody = document.getElementById('prio-body');
  prioBody.addEventListener('click', prioClick);
  prioBody.addEventListener('change', prioChange);
  document.getElementById('add-brand-btn').addEventListener('click', openUploadModal);
  document.getElementById('import-snapshot-btn').addEventListener('click', importSnapshot);
  document.getElementById('backup-all-btn').addEventListener('click', () => {
    if (!state.brands.length) { alert('There are no lists to back up yet.'); return; }
    const master = state.brands.find((b) => b.id === prio.masterBrandId);
    exportAllLists(state.brands, state.accounts, { ...prio, masterBrandName: master ? master.name : '' });
  });
  document.getElementById('upload-cancel').addEventListener('click', closeUploadModal);
  document.getElementById('upload-submit').addEventListener('click', handleUpload);

  document.getElementById('filter-county').addEventListener('change', (e) => {
    state.filterCounty = e.target.value;
    render();
    if (state.filterCounty) flyToCounty(state.filterCounty);
  });
  document.getElementById('clear-county-filter').addEventListener('click', () => {
    state.filterCounty = '';
    render();
  });

  document.getElementById('unmapped-badge').addEventListener('click', openUnmappedModal);
  document.getElementById('unmapped-list').addEventListener('click', unmappedListClick);
  document.getElementById('unmapped-list').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target.classList.contains('place-input')) {
      ev.preventDefault();
      const btn = [...document.querySelectorAll('#unmapped-list [data-place="set"]')].find((b) => b.dataset.id === ev.target.dataset.id);
      if (btn) btn.click();
    }
  });
  document.getElementById('place-cancel').addEventListener('click', cancelPlacement);
  document.getElementById('unmapped-close').addEventListener('click', MODAL_CLOSERS['unmapped-modal']);
  document.getElementById('unmapped-export').addEventListener('click', () => {
    exportFilteredAccounts(unmappedAccounts(), brandsById(), 'account-atlas-unmapped.csv');
  });
  document.getElementById('unmapped-retry-osm').addEventListener('click', retryUnmappedViaOsm);

  document.getElementById('clear-all-btn').addEventListener('click', async () => {
    const ok = confirm(
      `Delete everything stored in this browser -- ${state.brands.length} list(s), ${state.accounts.length} account(s), all coordinates, and the current route?\n\n` +
      `Your brand priorities stay. This cannot be undone. Click OK to delete, or Cancel to stop.`
    );
    if (!ok) return;
    try {
      await db.clearAllData();
    } catch (err) {
      alert(`Could not clear the data: ${err.message}`);
      return;
    }
    DATA_STORAGE_KEYS.forEach((key) => { try { localStorage.removeItem(key); } catch { /* storage blocked */ } });
    location.reload();
  });

  document.getElementById('export-view-btn').addEventListener('click', () => {
    exportFilteredAccounts(visibleAccounts(), brandsById());
  });
  document.getElementById('app-error-close').addEventListener('click', () => { document.getElementById('app-error').hidden = true; });

  wireSearch();
  document.addEventListener('keydown', onEscape);
}

// The offline shell (sw.js). Not used on this computer's own address, where a
// cached copy would hide edits while developing, and any old one is removed.
// Add ?sw=1 to the address to test it there.
function registerOffline() {
  if (!('serviceWorker' in navigator)) return;
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (local && !/[?&]sw=1\b/.test(location.search)) {
    navigator.serviceWorker.getRegistrations().then((list) => list.forEach((r) => r.unregister())).catch(() => {});
    return;
  }
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline mode simply stays off */ });
}

async function start() {
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
  render();
  renderRouteBar();
  renderRouteStops(routeStops);
  wireUi();
  registerOffline();

  // Once there is data worth protecting, ask the browser not to evict it.
  if (state.brands.length && navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }
}

async function main() {
  try {
    await start();
  } catch (err) {
    console.error(err);
    showAppError(`Account Atlas could not start: ${err.message}`, { sticky: true });
  }
}

main();

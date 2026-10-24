import * as db from './core/db.js?v=20261024a';
import { parseBrandWorkbook, brandStats, normalizeAddressKey } from './data/excelParser.js?v=20261024a';
import { buildMatches } from './data/matcher.js?v=20261024a';
import { exportAddressesForGeocoding, importCoordinates, exportFilteredAccounts } from './data/csvTools.js?v=20261024a';
import { exportBrandSnapshot, exportAllLists, exportStandaloneViewer, parseSnapshotFile } from './data/snapshot.js?v=20261024a';
import {
  initMap, renderChoropleth, renderPins, flyToCounty, getMap, mapsUrlFor,
  renderRouteStops, showUserLocation, fitToPoints, focusAccount, setPinsVisible,
} from './modules/mapView.js?v=20261024a';
import {
  countyHeat, formatAmount, loadHeatMode, saveHeatMode, loadHeatOn, saveHeatOn, loadDotsOn, saveDotsOn, loadSkuOff, saveSkuOff,
} from './modules/heatmap.js?v=20261024a';
import {
  IGNORE, norm, defaultPriorities, loadPriorities, savePriorities, cleanPriorities, flatOrder, todayString, matchSkus, moveEntry, addEntry, removeEntry, setOnPremise,
} from './modules/priorities.js?v=20261024a';
import { buildBriefs, splitRows, shortSku } from './modules/brief.js?v=20261024a';
import {
  MAX_STOPS, haversineMiles, optimizeOrder, pathMiles, googleRouteUrl, stopFromAccount, stopFromPlace, placeStopId, loadRoute, saveRoute,
} from './modules/route.js?v=20261024a';

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
  renderChoropleth(countyStatsFor(accts), heat, state.heatOn);
  renderPins(accts.filter((a) => a.lat !== null), brandsById());
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
  document.getElementById('route-brief').disabled = routeStops.length === 0;
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
  document.getElementById('route-brief').addEventListener('click', openBrief);
  document.getElementById('brief-close').addEventListener('click', closeBrief);
  document.getElementById('brief-body').addEventListener('change', briefChange);
  document.getElementById('brief-modal').addEventListener('click', (ev) => { if (ev.target.id === 'brief-modal') closeBrief(); });
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

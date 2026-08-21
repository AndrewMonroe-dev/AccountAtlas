import * as db from './core/db.js?v=20260817b';
import { parseBrandWorkbook, brandStats, normalizeAddressKey } from './data/excelParser.js?v=20260817b';
import { buildMatches } from './data/matcher.js?v=20260817b';
import { exportAddressesForGeocoding, importCoordinates, exportFilteredAccounts } from './data/csvTools.js?v=20260817b';
import { exportBrandSnapshot, parseSnapshotFile } from './data/snapshot.js?v=20260817b';
import { initMap, renderChoropleth, renderPins, flyToCounty, getMap } from './modules/mapView.js?v=20260817b';

const BRAND_COLORS = ['#a97a2e', '#35748c', '#6f5a70', '#4f7a4b', '#a1442f', '#7a5a9e'];

// Andrew, 2026-08-21: was a separate `atlasviewer.vesvelid.workers.dev`
// Cloudflare Worker (tools/cloudflare-worker.js, kept as reference/backup
// deploy) -- his work computer's network silently blocked that domain
// ("Failed to fetch", no reachable error detail). Switched to a Cloudflare
// Pages Function (functions/api/geocode.js, same relay logic) served from
// this SAME origin -- since the app itself already loads at work, the
// geocode call now rides that same allowed domain instead of a separate,
// unfamiliar one.
const GEOCODE_RELAY_URL = '/api/geocode';

const state = {
  brands: [],           // [{id, name, color}]
  accounts: [],          // all accounts, all brands
  matchGroups: [],
  activeBrandIds: new Set(),
  compareMode: 'overlay', // 'overlay' | 'gap'
  gapHas: null,
  gapMissing: null,
  filterCounty: '',
};

function brandsById() {
  const map = {};
  state.brands.forEach((b) => { map[b.id] = b; });
  return map;
}

async function loadAll() {
  state.brands = await db.getAllBrands();
  state.accounts = await db.getAllAccounts();
  state.matchGroups = await db.getAllMatchGroups();
  if (state.activeBrandIds.size === 0) {
    state.brands.forEach((b) => state.activeBrandIds.add(b.id));
  }
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
  renderGapForm();
  renderFilters();
  renderStats();
  renderLegend();
  renderUnmappedBadge();
  const accts = visibleAccounts();
  renderChoropleth(countyStatsFor(accts));
  renderPins(accts.filter((a) => a.lat !== null), brandsById());
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
      <button class="toggle ${state.activeBrandIds.has(b.id) ? 'on' : ''}" data-action="toggle-brand" data-id="${b.id}"></button>
    `;
    el.appendChild(row);
  });

  el.querySelectorAll('[data-action="toggle-brand"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      if (state.activeBrandIds.has(id)) state.activeBrandIds.delete(id); else state.activeBrandIds.add(id);
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

function renderLegend() {
  const el = document.getElementById('legend-brands');
  el.innerHTML = [...state.activeBrandIds].map((id) => {
    const b = state.brands.find((x) => x.id === id);
    if (!b) return '';
    return `<div class="legend-row"><span class="legend-swatch" style="background:${b.color}"></span> ${escapeHtml(b.name)}</div>`;
  }).join('');
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

  await loadAll();
  state.activeBrandIds.add(brandId);
  await recomputeMatches();
  render();
}

// ---------------------------------------------------------------
// Snapshot import -- brings in a brand's full data (including already-
// resolved coordinates) exported from another computer. No Excel, no
// geocoding, no Node needed on the machine doing the importing.
// ---------------------------------------------------------------

function importSnapshot() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;

    let parsed;
    try {
      parsed = await parseSnapshotFile(file);
    } catch (err) {
      alert('Could not import: ' + err.message);
      return;
    }

    const incomingBrand = parsed.brand;
    const existing = state.brands.find((b) => b.name.toLowerCase() === incomingBrand.name.toLowerCase());
    if (existing) {
      const ok = confirm(`"${incomingBrand.name}" already exists (${state.accounts.filter((a) => a.brandId === existing.id).length} accounts). Replace it with this snapshot?`);
      if (!ok) return;
      await db.deleteBrand(existing.id);
    }

    const brandId = existing ? existing.id : (incomingBrand.id || crypto.randomUUID());
    const color = existing ? existing.color : BRAND_COLORS[state.brands.length % BRAND_COLORS.length];
    await db.putBrand({ ...incomingBrand, id: brandId, color });
    await db.putAccounts(parsed.accounts.map((a) => ({ ...a, brandId })));

    await loadAll();
    state.activeBrandIds.add(brandId);
    await recomputeMatches();
    render();

    const mapped = parsed.accounts.filter((a) => a.lat !== null && a.lon !== null).length;
    alert(`Imported "${incomingBrand.name}": ${parsed.accounts.length} accounts, ${mapped} already mapped.`);
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
          <div class="hint">${escapeHtml(a.address)}, ${escapeHtml(a.city)}, ${escapeHtml(a.state)} ${escapeHtml(a.zip)}</div>
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
  await initMap('leaflet-map', { onCountyClickFn: (name) => { flyToCounty(name); } });
  await loadAll();
  await recomputeMatches();
  render();

  document.getElementById('add-brand-btn').addEventListener('click', openUploadModal);
  document.getElementById('import-snapshot-btn').addEventListener('click', importSnapshot);
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

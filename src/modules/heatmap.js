// Volume heatmap logic for one brand: pure functions plus localStorage for the
// remembered mode and per-brand SKU choice. No DOM and no Leaflet in here so
// the arithmetic can be tested on its own.
//
// An account's volume is the sum of its `qty` amounts over the chosen SKUs. A
// county's "total" is the sum over its accounts, its "average" is that total
// divided by ALL the brand's accounts in the county (sold or not).

const MODE_KEY = 'aa-heat-v1';
const SKU_OFF_KEY = 'aa-heat-skus-v1';

export const HEAT_MODES = ['sold', 'total', 'avg'];

// Low to high. Evenly spaced stops, light yellow to dark red-brown.
export const HEAT_STOPS = ['#fbeec1', '#efb24a', '#c9531a', '#6b1d07'];

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// t in 0..1 -> color along HEAT_STOPS.
export function heatColor(t) {
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (HEAT_STOPS.length - 1);
  const i = Math.min(HEAT_STOPS.length - 2, Math.floor(x));
  const f = x - i;
  const a = hexToRgb(HEAT_STOPS[i]);
  const b = hexToRgb(HEAT_STOPS[i + 1]);
  const c = a.map((v, k) => Math.round(v + (b[k] - v) * f));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

// Colors use a square-root scale so one huge county does not turn every other
// county the palest shade.
export function heatShade(value, max) {
  if (!(max > 0) || !(value > 0)) return heatColor(0);
  return heatColor(Math.sqrt(value / max));
}

export function accountVolume(acct, skuSet) {
  if (!acct.qty) return 0;
  let sum = 0;
  skuSet.forEach((sku) => { sum += Number(acct.qty[sku]) || 0; });
  return sum;
}

// accounts: one brand's accounts. skuSet: Set of SKU names to count.
// Returns { values: Map<county, {volume, accounts, value}>, max }.
export function countyHeat(accounts, skuSet, measure) {
  const values = new Map();
  accounts.forEach((a) => {
    if (!a.county) return;
    const cur = values.get(a.county) || { volume: 0, accounts: 0, value: 0 };
    cur.accounts += 1;
    cur.volume += accountVolume(a, skuSet);
    values.set(a.county, cur);
  });
  let max = 0;
  values.forEach((v) => {
    v.value = measure === 'avg' ? (v.accounts ? v.volume / v.accounts : 0) : v.volume;
    if (v.value > max) max = v.value;
  });
  return { values, max, measure };
}

export function formatAmount(n) {
  if (!Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
}

export function loadHeatMode() {
  try {
    const m = localStorage.getItem(MODE_KEY);
    return HEAT_MODES.includes(m) ? m : 'sold';
  } catch {
    return 'sold';
  }
}

export function saveHeatMode(mode) {
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* storage blocked */ }
}

function loadSkuOffAll() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SKU_OFF_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// The OFF set is what is stored, so a SKU added by a later upload defaults to on.
export function loadSkuOff(brandId) {
  const list = loadSkuOffAll()[brandId];
  return new Set(Array.isArray(list) ? list : []);
}

export function saveSkuOff(brandId, offSet) {
  try {
    const all = loadSkuOffAll();
    if (offSet.size) all[brandId] = [...offSet]; else delete all[brandId];
    localStorage.setItem(SKU_OFF_KEY, JSON.stringify(all));
  } catch {
    // Storage blocked: the choice still works for this session.
  }
}

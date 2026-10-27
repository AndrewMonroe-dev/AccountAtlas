// Volume heatmap logic for one brand: pure functions plus localStorage for the
// remembered mode and per-brand SKU choice. No DOM and no Leaflet in here so
// the arithmetic can be tested on its own.
//
// An account's volume is the sum of its `qty` amounts over the chosen SKUs. A
// county's "total" is the sum over its accounts, its "average" is that total
// divided by ALL the brand's accounts in the county (sold or not).

import { normalizeCountyName } from '../core/util.js?v=20261027a';

const MODE_KEY = 'aa-heat-v1';
const SKU_OFF_KEY = 'aa-heat-skus-v1';

export const HEAT_MODES = ['sold', 'total', 'avg'];

// Seven clearly different shades, palest to darkest. Counties are sorted into
// bands (not shaded on a smooth scale) so neighbouring totals still get
// colors you can tell apart.
export const HEAT_PALETTE = ['#fff1b8', '#fbd05a', '#f7a23a', '#ee6a24', '#d2321f', '#9a1414', '#4d0a0a'];
// A county with accounts but no volume in the chosen SKUs.
export const HEAT_ZERO_COLOR = '#e4dfd3';

// Splits county values into up to 7 bands holding about the same number of
// counties each. Equal values always share a band. Returns
// { colorFor(value), legend: [{ color, min, max }] } with legend palest first,
// preceded by a zero entry when any county has none.
export function heatBands(valueList) {
  const positives = valueList.filter((v) => v > 0).sort((x, y) => x - y);
  const n = positives.length;
  const distinct = [...new Set(positives)];
  const k = Math.min(HEAT_PALETTE.length, distinct.length);
  const bandOfValue = new Map();
  distinct.forEach((v) => {
    const first = positives.indexOf(v);
    bandOfValue.set(v, Math.min(k - 1, Math.floor((first * k) / n)));
  });
  // Spread the bands over the whole palette so the extremes use the palest
  // and darkest shades even with only a few bands.
  const colorOfBand = (band) => HEAT_PALETTE[k <= 1 ? 0 : Math.round((band * (HEAT_PALETTE.length - 1)) / (k - 1))];
  const ranges = new Map();
  distinct.forEach((v) => {
    const band = bandOfValue.get(v);
    const r = ranges.get(band) || { color: colorOfBand(band), min: v, max: v };
    r.min = Math.min(r.min, v);
    r.max = Math.max(r.max, v);
    ranges.set(band, r);
  });
  const legend = [...ranges.keys()].sort((x, y) => x - y).map((b) => ranges.get(b));
  if (valueList.some((v) => !(v > 0))) legend.unshift({ color: HEAT_ZERO_COLOR, min: 0, max: 0 });
  return {
    legend,
    colorFor: (value) => (value > 0 && bandOfValue.has(value) ? colorOfBand(bandOfValue.get(value)) : HEAT_ZERO_COLOR),
  };
}

export function accountVolume(acct, skuSet) {
  if (!acct.qty) return 0;
  let sum = 0;
  skuSet.forEach((sku) => { sum += Number(acct.qty[sku]) || 0; });
  return sum;
}

// accounts: one brand's accounts. skuSet: Set of SKU names to count.
// Returns { values: Map<normalized county, {volume, accounts, value}>, max, measure, colorFor, legend }.
export function countyHeat(accounts, skuSet, measure) {
  const values = new Map();
  accounts.forEach((a) => {
    const key = normalizeCountyName(a.county);
    if (!key) return;
    const cur = values.get(key) || { volume: 0, accounts: 0, value: 0 };
    cur.accounts += 1;
    cur.volume += accountVolume(a, skuSet);
    values.set(key, cur);
  });
  let max = 0;
  values.forEach((v) => {
    v.value = measure === 'avg' ? (v.accounts ? v.volume / v.accounts : 0) : v.volume;
    if (v.value > max) max = v.value;
  });
  const bands = heatBands([...values.values()].map((v) => v.value));
  return { values, max, measure, colorFor: bands.colorFor, legend: bands.legend };
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

// Whether the county shading is drawn at all. On unless the user turned it off.
export function loadHeatOn() {
  try { return localStorage.getItem('aa-heatshade-v1') !== 'off'; } catch { return true; }
}

export function saveHeatOn(on) {
  try { localStorage.setItem('aa-heatshade-v1', on ? 'on' : 'off'); } catch { /* storage blocked */ }
}

// Whether the account dots are drawn. On unless the user turned them off.
export function loadDotsOn() {
  try { return localStorage.getItem('aa-dots-v1') !== 'off'; } catch { return true; }
}

export function saveDotsOn(on) {
  try { localStorage.setItem('aa-dots-v1', on ? 'on' : 'off'); } catch { /* storage blocked */ }
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

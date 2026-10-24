import './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { haversineMiles, optimizeOrder, pathMiles, googleRouteUrl, loadRoute, saveRoute, stopFromPlace, placeStopId, MAX_STOPS } from '../src/modules/route.js';
import { heatBands, countyHeat, formatAmount, HEAT_ZERO_COLOR } from '../src/modules/heatmap.js';

const pts = [[42.7, -84.5], [42.9, -84.7], [42.6, -84.2], [43.0, -84.1], [42.5, -84.9]].map(([lat, lon]) => ({ lat, lon }));
function perms(a) { return a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((r) => [x, ...r])); }

test('haversine sanity', () => {
  assert.ok(Math.abs(haversineMiles({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) - 69.09) < 0.2);
  assert.equal(haversineMiles(pts[0], pts[0]), 0);
});

test('optimizeOrder equals brute force from a start and with first stop fixed', () => {
  const start = { lat: 42.4, lon: -84.0 };
  const best = Math.min(...perms([0, 1, 2, 3, 4]).map((o) => pathMiles(pts, o, start)));
  assert.ok(Math.abs(pathMiles(pts, optimizeOrder(pts, start), start) - best) < 1e-9);
  const order = optimizeOrder(pts, null);
  assert.equal(order[0], 0);
  assert.equal(new Set(order).size, 5);
  const bestFixed = Math.min(...perms([1, 2, 3, 4]).map((o) => pathMiles(pts, [0, ...o], null)));
  assert.ok(Math.abs(pathMiles(pts, order, null) - bestFixed) < 1e-9);
});

test('route url sends coordinates, last stop is the destination', () => {
  const url = googleRouteUrl([{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }, { lat: 5, lon: 6 }]);
  assert.match(url, /destination=5\.000000%2C6\.000000/);
  assert.match(url, /waypoints=1\.000000%2C2\.000000%7C3\.000000%2C4\.000000/);
  assert.equal(googleRouteUrl([]), null);
});

test('route persistence filters bad stops and caps length', () => {
  const stops = Array.from({ length: 14 }, (_, i) => ({ id: 'a' + i, name: 'n', lat: 1, lon: 2, query: 'q' }));
  saveRoute([...stops, { id: 'bad', lat: 'x' }]);
  assert.equal(loadRoute().length, MAX_STOPS);
  localStorage.setItem('aa-route-v1', '{oops');
  assert.deepEqual(loadRoute(), []);
});

test('a stop with an empty query still loads', () => {
  saveRoute([{ id: 'a', name: 'Shop', lat: 1, lon: 2, query: '' }]);
  assert.equal(loadRoute().length, 1);
});

test('place stop id is stable and tagged', () => {
  const p = { name: 'Bar', lat: 42.1234567, lon: -84.1, label: 'Bar', addr: '' };
  assert.equal(placeStopId(p), placeStopId({ ...p }));
  assert.equal(stopFromPlace(p).kind, 'place');
});

test('heat bands: zero gets the neutral color, at most 7 bands, ties share one', () => {
  const vals = Array.from({ length: 20 }, (_, i) => i * 10);
  const b = heatBands(vals);
  assert.equal(b.colorFor(0), HEAT_ZERO_COLOR);
  assert.ok(new Set(vals.filter((v) => v > 0).map(b.colorFor)).size <= 7);
  assert.equal(heatBands([5, 5, 5]).legend.length, 1);
});

test('countyHeat total and per-account average', () => {
  const accts = [
    { county: 'Wayne', qty: { a: 10, b: 5 } }, { county: 'Wayne', qty: { a: 0, b: 0 } }, { county: 'Ingham', qty: { a: 100, b: 0 } },
  ];
  assert.equal(countyHeat(accts, new Set(['a', 'b']), 'total').values.get('wayne').volume, 15);
  const avg = countyHeat(accts, new Set(['a']), 'avg');
  assert.equal(avg.values.get('wayne').value, 5);
  assert.equal(avg.values.get('ingham').value, 100);
});

test('county spellings are grouped together', () => {
  const accts = [{ county: 'St. Clair', qty: { a: 1 } }, { county: 'Saint Clair County', qty: { a: 2 } }, { county: ' st clair ', qty: { a: 3 } }];
  const h = countyHeat(accts, new Set(['a']), 'total');
  assert.equal(h.values.size, 1);
  assert.equal(h.values.get('saint clair').volume, 6);
});

test('formatAmount', () => {
  assert.equal(formatAmount(1234.5), '1,235');
  assert.equal(formatAmount(12.34), '12.3');
  assert.equal(formatAmount(1.234), '1.23');
  assert.equal(formatAmount(NaN), '0');
});

test('route legs: 4 stops each, later legs start at the previous destination', async () => {
  const { routeLegs, legUrl, LEG_SIZE } = await import('../src/modules/route.js');
  const stops = Array.from({ length: 10 }, (_, i) => ({ id: 's' + i, lat: 42 + i, lon: -84 }));
  assert.equal(LEG_SIZE, 4);
  assert.deepEqual(routeLegs(stops).map((l) => l.length), [4, 4, 2]);
  const first = legUrl(stops, 0);
  assert.ok(!first.includes('origin='));
  assert.match(first, /destination=45\.000000%2C-84\.000000/);
  assert.equal((first.match(/%7C/g) || []).length, 2);
  const second = legUrl(stops, 1);
  assert.match(second, /origin=45\.000000%2C-84\.000000/);
  assert.match(second, /destination=49\.000000%2C-84\.000000/);
  assert.match(legUrl(stops, 2), /origin=49\.000000%2C-84\.000000&|origin=49\.000000%2C-84\.000000$/);
  assert.equal(legUrl(stops, 3), null);
  assert.equal(routeLegs([]).length, 0);
});

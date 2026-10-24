import './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBriefs, splitRows, shortSku } from '../src/modules/brief.js';
import { defaultPriorities } from '../src/modules/priorities.js';
import { normalizeAddressKey } from '../src/data/excelParser.js';

const addressKey = (a) => normalizeAddressKey(a.address, a.city, a.state, a.zip);
const prio = defaultPriorities();

const master = { id: 'm', name: 'All Brands', skuList: ['Bota Box Nighthawk 3L 3L3', 'Bota Box Breeze 3L 3L4', 'Stoneleigh Sauvignon 750', 'Relax Riesling 750'] };
const acct = (over) => ({ id: 'm::1', brandId: 'm', storeName: 'Shop', address: '1 Main St', city: 'Lansing', state: 'MI', zip: '48906', ...over });

function brief(account, extra = {}) {
  return buildBriefs({
    stops: [{ id: account.id, name: account.storeName }], accounts: [account], brands: [master], prio, master, addressKey, today: '2026-10-24', ...extra,
  });
}

test('gaps and carried brands come back in priority order with SKU counts', () => {
  const a = acct({ skus: { 'Bota Box Nighthawk 3L 3L3': true, 'Bota Box Breeze 3L 3L4': false, 'Stoneleigh Sauvignon 750': false, 'Relax Riesling 750': true }, qty: {} });
  const out = brief(a);
  const rows = out.stops[0].rows;
  const status = (id) => rows.find((r) => r.entry.id === id).status;
  assert.equal(status('bota-nighthawk'), 'carries');
  assert.equal(status('bota-breeze'), 'missing');
  assert.equal(status('stoneleigh'), 'missing');
  assert.equal(status('relax'), 'carries');
  assert.equal(status('bota'), 'noskus'); // its SKUs sit under the sub-brands
  const { gaps, carrying } = splitRows(rows);
  assert.deepEqual(gaps.map((r) => r.entry.id).slice(0, 2), ['bota-breeze', 'stoneleigh']);
  assert.ok(carrying.some((r) => r.entry.id === 'relax'));
});

test('on-premise mode keeps the focus brands first and the rest below', () => {
  const a = acct({ skus: { 'Bota Box Nighthawk 3L 3L3': false, 'Bota Box Breeze 3L 3L4': false, 'Stoneleigh Sauvignon 750': false, 'Relax Riesling 750': false }, qty: {} });
  const split = splitRows(brief(a).stops[0].rows, true);
  assert.deepEqual(split.gaps.map((r) => r.entry.id), ['stoneleigh']);
  assert.ok(split.otherGaps.some((r) => r.entry.id === 'bota-nighthawk'));
});

test('a focus period moves its brands to the top and stars them', () => {
  const p = { ...prio, presets: [{ id: 'f', name: 'Push', endDate: '', bump: ['relax'] }], activePresetId: 'f' };
  const a = acct({ skus: { 'Relax Riesling 750': false }, qty: {} });
  const out = brief(a, { prio: p });
  assert.equal(out.stops[0].rows[0].entry.id, 'relax');
  assert.ok(out.stops[0].rows[0].bumped);
  assert.deepEqual(out.header.focus.bumped, ['Relax']);
});

test('a store missing from the master list is flagged, places and removed accounts too', () => {
  const other = acct({ id: 'v::9', brandId: 'v', address: '9 Elm St', skus: { x: true } });
  const out = buildBriefs({
    stops: [{ id: 'v::9', name: 'Other' }, { id: 'osm:1', name: 'Bar', kind: 'place' }, { id: 'gone', name: 'Gone' }],
    accounts: [other], brands: [master, { id: 'v', name: 'Vol', skuList: ['x'] }], prio, master, addressKey, today: '2026-10-24',
  });
  assert.deepEqual(out.stops.map((s) => s.kind), ['nomaster', 'place', 'gone']);
});

test('cases come from a volume list when one covers the brand, never added to the master', () => {
  const m = acct({ skus: { 'Relax Riesling 750': true }, qty: { 'Relax Riesling 750': 5 } });
  const vol = { id: 'v', name: 'Relax volume', skuList: ['Relax Riesling 750'] };
  const v = acct({ id: 'v::1', brandId: 'v', skus: { 'Relax Riesling 750': true }, qty: { 'Relax Riesling 750': 20 } });
  const out = buildBriefs({ stops: [{ id: 'm::1', name: 'Shop' }], accounts: [m, v], brands: [master, vol], prio, master, addressKey, today: '2026-10-24' });
  assert.equal(out.stops[0].rows.find((r) => r.entry.id === 'relax').cases, 20);
});

test('shortSku drops a trailing item code', () => {
  assert.equal(shortSku('Bota Box 3L Pinot Grigio 3L3'), 'Bota Box 3L Pinot Grigio');
  assert.equal(shortSku('Relax 750'), 'Relax 750');
});

import { gapScore, rankBestBets } from '../src/modules/brief.js';

const row = (id, status) => ({ entry: { id, name: id, tags: [] }, status });

test('gap score weighs earlier brands more and partial gaps half', () => {
  const rows = [row('a', 'missing'), row('b', 'carries'), row('c', 'partial'), row('d', 'missing')];
  const { score, gaps } = gapScore(rows);
  assert.deepEqual(gaps.map((r) => r.entry.id), ['a', 'c', 'd']);
  assert.equal(score, 1 * (4 / 4) + 0.5 * (2 / 4) + 1 * (1 / 4));
  assert.equal(gapScore([row('a', 'carries'), row('b', 'carries')]).score, 0);
});

test('brands with no SKUs in the master do not dilute the score', () => {
  const a = gapScore([row('x', 'noskus'), row('a', 'missing')]).score;
  const b = gapScore([row('a', 'missing')]).score;
  assert.equal(a, b);
});

test('on-premise mode counts only the focus brands', () => {
  const rows = [
    { entry: { id: 'off', name: 'off', tags: [] }, status: 'missing' },
    { entry: { id: 'on', name: 'on', tags: ['on'] }, status: 'missing' },
  ];
  assert.deepEqual(gapScore(rows, true).gaps.map((r) => r.entry.id), ['on']);
  assert.ok(gapScore(rows, false).score > gapScore(rows, true).score);
});

test('best bets: a close store with a good pitch beats a far one, unknown stores go last', () => {
  const ok = (rows) => ({ kind: 'ok', rows });
  const strong = [row('a', 'missing'), row('b', 'missing'), row('c', 'missing')];
  const weak = [row('a', 'carries'), row('b', 'carries'), row('c', 'missing')];
  const ranked = rankBestBets([
    { acct: { id: 'far' }, miles: 100, brief: ok(strong) },
    { acct: { id: 'near-weak' }, miles: 0.5, brief: ok(weak) },
    { acct: { id: 'near-strong' }, miles: 1, brief: ok(strong) },
    { acct: { id: 'nomaster' }, miles: 0.1, brief: { kind: 'nomaster', rows: [] } },
  ]);
  assert.deepEqual(ranked.map((r) => r.acct.id), ['near-strong', 'near-weak', 'far', 'nomaster']);
  assert.ok(ranked[0].gaps.length === 3);
});

import './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultPriorities, matchSkus, moveEntry, addEntry, removeEntry, setOnPremise, effectiveOrder,
  cleanPriorities, parseRule, flatOrder, IGNORE,
} from '../src/modules/priorities.js';

test('rule matching: size beats sub-brand, item codes split Diamond Prosecco', () => {
  const p = defaultPriorities();
  const { byEntry } = matchSkus(p, [
    'Bota Box Nighthawk 3L 3L3', 'Bota Box Mini 500ml', 'Bota Box Lil Mini 187', 'Diamond Collection Prosecco 712', 'Diamond Collection Prosecco 187 103',
  ]);
  assert.deepEqual(byEntry.get('bota-nighthawk'), ['Bota Box Nighthawk 3L 3L3']);
  assert.deepEqual(byEntry.get('bota-mini'), ['Bota Box Mini 500ml']);
  assert.deepEqual(byEntry.get('bota-lilmini'), ['Bota Box Lil Mini 187']);
  assert.deepEqual(byEntry.get('diamond-prosecco750'), ['Diamond Collection Prosecco 712']);
  assert.deepEqual(byEntry.get('diamond-prosecco187'), ['Diamond Collection Prosecco 187 103']);
});

test('rule words match at a word start only', () => {
  assert.deepEqual(parseRule('3l').groups, [['3l']]);
  const p = { ...defaultPriorities(), entries: [{ id: 'x', name: 'x', parentId: null, tags: [], ruleText: '3l' }] };
  assert.equal(matchSkus(p, ['Foo 13L']).unmatched.length, 1);
  assert.equal(matchSkus(p, ['Foo 3L1']).unmatched.length, 0);
});

test('unmatched SKUs, manual assign and ignore', () => {
  const p = defaultPriorities();
  assert.deepEqual(matchSkus(p, ['Mystery Wine']).unmatched, ['Mystery Wine']);
  const q = { ...p, assign: { 'mystery wine': 'relax' } };
  assert.deepEqual(matchSkus(q, ['Mystery Wine']).byEntry.get('relax'), ['Mystery Wine']);
  const r = { ...p, assign: { 'mystery wine': IGNORE } };
  assert.equal(matchSkus(r, ['Mystery Wine']).unmatched.length, 0);
});

test('moveEntry keeps sub-brands under their brand and top works', () => {
  const p = defaultPriorities();
  const before = flatOrder(p.entries).map((x) => x.id);
  const ids = flatOrder(moveEntry(p, 'diamond', 1).entries).map((x) => x.id);
  assert.equal(ids.indexOf('diamond-prosecco750'), ids.indexOf('diamond') + 1);
  assert.equal(ids.indexOf('diamond'), before.indexOf('diamond') + 4 - 3);
  const top = moveEntry(p, 'stoneleigh', 'top');
  assert.equal(flatOrder(top.entries)[0].id, 'stoneleigh');
});

test('add, remove and on-premise tag', () => {
  let p = defaultPriorities();
  p = addEntry(p, 'New Brand');
  assert.equal(p.entries.at(-1).name, 'New Brand');
  assert.equal(addEntry(p, '   '), p);
  p = setOnPremise(p, 'relax', true);
  assert.ok(p.entries.find((x) => x.id === 'relax').tags.includes('on'));
  p = { ...p, presets: [{ id: 'f', name: 'F', endDate: '', bump: ['bota-mini', 'relax'] }] };
  p = removeEntry(p, 'bota');
  assert.ok(!p.entries.some((x) => x.id.startsWith('bota')));
  assert.deepEqual(p.presets[0].bump, ['relax']);
});

test('focus preset bumps brands and expires', () => {
  const p = { ...defaultPriorities(), presets: [{ id: 'f', name: 'Holiday', endDate: '2026-12-31', bump: ['relax', 'gnarly'] }], activePresetId: 'f' };
  let o = effectiveOrder(p, '2026-11-01');
  assert.deepEqual(o.slice(0, 2).map((x) => x.entry.id), ['relax', 'gnarly']);
  assert.ok(o[0].bumped && !o[2].bumped);
  o = effectiveOrder(p, '2027-01-01');
  assert.equal(o[0].entry.id, 'bota');
});

test('cleanPriorities repairs bad data', () => {
  assert.equal(cleanPriorities(null).entries.length, defaultPriorities().entries.length);
  const c = cleanPriorities({ entries: [{ id: 'a', name: 'A', parentId: 'zzz' }], presets: [{ id: 'p', name: 'P', endDate: 'bad', bump: ['a', 'q'] }] });
  assert.equal(c.entries[0].parentId, null);
  assert.equal(c.presets[0].endDate, '');
  assert.deepEqual(c.presets[0].bump, ['a']);
});

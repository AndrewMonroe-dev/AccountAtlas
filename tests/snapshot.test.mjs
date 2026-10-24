import './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSnapshotFile, cleanAccounts } from '../src/data/snapshot.js';

const file = (obj) => ({ text: async () => (typeof obj === 'string' ? obj : JSON.stringify(obj)) });
const acct = (over = {}) => ({ id: 'b::1', brandId: 'b', storeName: 'Shop', address: '1 Main', city: 'Lansing', county: 'Ingham', state: 'MI', zip: '48906', skus: { A: true }, lat: 42.7, lon: -84.5, ...over });

test('single snapshot and all-lists backup both parse', async () => {
  const one = await parseSnapshotFile(file({ brand: { name: 'Bota' }, accounts: [acct()] }));
  assert.equal(one.length, 1);
  const many = await parseSnapshotFile(file({ lists: [{ brand: { name: 'A' }, accounts: [acct()] }, { brand: { name: 'B' }, accounts: [acct()] }], priorities: { entries: [] } }));
  assert.equal(many.length, 2);
  assert.ok(many.priorities);
});

test('bad files are rejected with a message', async () => {
  await assert.rejects(parseSnapshotFile(file('{nope')), /valid JSON/);
  await assert.rejects(parseSnapshotFile(file({ hello: 1 })), /doesn't look like/);
  await assert.rejects(parseSnapshotFile(file({ lists: [] })), /no lists/);
  await assert.rejects(parseSnapshotFile(file('null')), /doesn't look like/);
});

test('cleanAccounts drops unusable rows and repairs coordinates', () => {
  const out = cleanAccounts([
    acct(),
    null,
    { id: 'x' },
    acct({ id: 'b::2', lat: '42.5', lon: '-84.1' }),
    acct({ id: 'b::3', lat: 'abc', lon: null }),
    acct({ id: 'b::4', lat: 42, lon: null }),
  ]);
  assert.equal(out.length, 4);
  assert.equal(out[1].lat, 42.5);
  assert.equal(out[2].lat, null);
  assert.equal(out[2].geocodeStatus, 'pending');
  assert.equal(out[3].lat, null);
});

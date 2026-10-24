import './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsvLine, csvField, geocodeAddresses } from '../tools/census.mjs';

test('csv line parsing handles quotes and commas', () => {
  assert.deepEqual(parseCsvLine('"a","b, c","d ""q"""'), ['a', 'b, c', 'd "q"']);
  assert.equal(csvField('x"y'), '"x""y"');
});

test('geocodeAddresses reads Match and No_Match rows', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    text: async () => '"1","1 Main St, Lansing, MI, 48906","Match","Exact","1 MAIN ST, LANSING, MI, 48906","-84.5,42.7","1","L"\n"2","x","No_Match"\n\n',
  });
  try {
    const r = await geocodeAddresses([{ id: '1' }, { id: '2' }]);
    assert.deepEqual(r['1'], { lat: 42.7, lon: -84.5, matched: true });
    assert.equal(r['2'].matched, false);
  } finally { globalThis.fetch = realFetch; }
});

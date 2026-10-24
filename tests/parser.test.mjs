import { workbook, HEADER } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBrandWorkbook, brandStats, normalizeAddressKey } from '../src/data/excelParser.js';

const rows = (extra = []) => [
  [...HEADER, 'Bota 3L', 'Bota Mini'],
  ['Shop A', '1', '1 Main St', 'Lansing', 'Ingham', 'MI', '48906', 5, '-'],
  ['Shop B', '2', '2 Main St', 'Lansing', 'Ingham', 'MI', '48906', '-', ''],
  ['Shop C', '3', '3 Main St', 'Detroit', '', 'MI', '48201', '$1,200', 2.5],
  ...extra,
];

test('parses sold, unsold and amounts', () => {
  const r = parseBrandWorkbook(workbook(rows()), 'b1');
  assert.equal(r.accounts.length, 3);
  assert.deepEqual(r.skuList, ['Bota 3L', 'Bota Mini']);
  assert.equal(r.accounts[0].skus['Bota 3L'], true);
  assert.equal(r.accounts[0].skus['Bota Mini'], false);
  assert.equal(r.accounts[2].qty['Bota 3L'], 1200);
  assert.equal(r.accounts[2].qty['Bota Mini'], 2.5);
  assert.ok(r.warnings.some((w) => /missing County/.test(w)));
  assert.deepEqual(brandStats(r.accounts), { totalAccounts: 3, soldAccounts: 2, unsoldAccounts: 1, penetrationPct: 66.7 });
});

test('missing header row is rejected with a clear message', () => {
  assert.throws(() => parseBrandWorkbook(workbook(rows().slice(1)), 'b1'), /doesn't look like a header/);
});

test('a blank SKU header does not shift the columns after it', () => {
  const r = parseBrandWorkbook(workbook([
    [...HEADER, 'Alpha', '', 'Gamma'],
    ['Shop A', '1', '1 Main St', 'Lansing', 'Ingham', 'MI', '48906', 1, 1, '-'],
  ]), 'b1');
  assert.deepEqual(r.skuList, ['Alpha', 'Gamma']);
  assert.equal(r.accounts[0].skus.Alpha, true);
  assert.equal(r.accounts[0].skus.Gamma, false);
});

test('duplicate SKU headers stay separate columns', () => {
  const r = parseBrandWorkbook(workbook([
    [...HEADER, 'Wine', 'Wine'],
    ['Shop A', '1', '1 Main St', 'Lansing', 'Ingham', 'MI', '48906', 1, '-'],
  ]), 'b1');
  assert.equal(r.skuList.length, 2);
  assert.notEqual(r.skuList[0], r.skuList[1]);
  assert.equal(r.accounts[0].skus[r.skuList[0]], true);
  assert.equal(r.accounts[0].skus[r.skuList[1]], false);
});

test('geocodes carry forward from the previous upload and from other brands', () => {
  const first = parseBrandWorkbook(workbook(rows()), 'b1');
  first.accounts[0].lat = 42.7; first.accounts[0].lon = -84.5; first.accounts[0].geocodeStatus = 'ok';
  const prev = Object.fromEntries(first.accounts.map((a) => [a.id, a]));
  const again = parseBrandWorkbook(workbook(rows()), 'b1', { previousById: prev });
  assert.equal(again.accounts[0].lat, 42.7);
  const idx = { [normalizeAddressKey('2 Main St', 'Lansing', 'MI', '48906')]: { lat: 1, lon: 2 } };
  const other = parseBrandWorkbook(workbook(rows()), 'b2', { addressIndex: idx });
  assert.equal(other.accounts[1].lat, 1);
  assert.equal(other.accounts[1].geocodeStatus, 'ok');
});

test('a point placed by hand survives a re-upload and is never marked pending', () => {
  const first = parseBrandWorkbook(workbook(rows()), 'b1');
  first.accounts[2].lat = 42.1; first.accounts[2].lon = -84.2; first.accounts[2].geocodeStatus = 'manual';
  const prev = Object.fromEntries(first.accounts.map((a) => [a.id, a]));
  const again = parseBrandWorkbook(workbook(rows()), 'b1', { previousById: prev });
  assert.equal(again.accounts[2].lat, 42.1);
  assert.equal(again.accounts[2].geocodeStatus, 'manual');
});

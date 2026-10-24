import './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLists, describeDiff, isUnchanged } from '../src/data/diff.js';

const a = (id, skus) => ({ id, skus });

test('counts new and gone accounts', () => {
  const d = diffLists([a('1', { X: true }), a('2', { X: false })], ['X'], [a('2', { X: false }), a('3', { X: true })], ['X']);
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
  assert.equal(d.oldTotal, 2);
  assert.equal(d.newTotal, 2);
});

test('reports added and dropped SKU columns, and compares only shared SKUs', () => {
  const d = diffLists([a('1', { X: true, Y: true })], ['X', 'Y'], [a('1', { X: true, Z: true })], ['X', 'Z']);
  assert.deepEqual(d.skusAdded, ['Z']);
  assert.deepEqual(d.skusRemoved, ['Y']);
  assert.equal(d.newlySold, 0);
  assert.equal(d.noLongerSold, 0);
});

test('counts cells and stores that flipped between sold and unsold', () => {
  const d = diffLists(
    [a('1', { X: false, Y: false }), a('2', { X: true, Y: true }), a('3', { X: true, Y: false })], ['X', 'Y'],
    [a('1', { X: true, Y: false }), a('2', { X: false, Y: false }), a('3', { X: true, Y: true })], ['X', 'Y'],
  );
  assert.equal(d.newlySold, 2);
  assert.equal(d.noLongerSold, 2);
  assert.equal(d.startedSelling, 1);
  assert.equal(d.stoppedSelling, 1);
});

test('identical lists say so', () => {
  const list = [a('1', { X: true })];
  const d = diffLists(list, ['X'], list, ['X']);
  assert.ok(isUnchanged(d));
  assert.match(describeDiff(d), /No changes/);
});

test('describeDiff names SKUs and shortens long lists', () => {
  const many = ['A', 'B', 'C', 'D', 'E', 'F'];
  const text = describeDiff(diffLists([a('1', {})], [], [a('1', {})], many));
  assert.match(text, /New SKU columns \(6\): A, B, C, D and 2 more/);
  assert.match(text, /Accounts: 1 now, 1 in the file \(0 new, 0 gone\)/);
});

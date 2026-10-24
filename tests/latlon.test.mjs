import './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLatLon, inMichigan } from '../src/core/util.js';

test('plain, spaced and bracketed coordinates parse', () => {
  assert.deepEqual(parseLatLon('42.7325, -84.5555'), { lat: 42.7325, lon: -84.5555 });
  assert.deepEqual(parseLatLon('42.7325 -84.5555'), { lat: 42.7325, lon: -84.5555 });
  assert.deepEqual(parseLatLon('(42.7325,-84.5555)'), { lat: 42.7325, lon: -84.5555 });
  assert.deepEqual(parseLatLon('  42.73\t-84.55  '), { lat: 42.73, lon: -84.55 });
});

test('a Google Maps style paste with a degree sign or label parses', () => {
  assert.deepEqual(parseLatLon('Lat 42.7325 Lon -84.5555'), { lat: 42.7325, lon: -84.5555 });
  assert.deepEqual(parseLatLon('42.7325° N, 84.5555° W'), { lat: 42.7325, lon: -84.5555 });
});

test('longitude first is swapped back when only that order lands in Michigan', () => {
  assert.deepEqual(parseLatLon('-84.5555, 42.7325'), { lat: 42.7325, lon: -84.5555 });
});

test('junk and out-of-range values are rejected', () => {
  assert.equal(parseLatLon(''), null);
  assert.equal(parseLatLon('hello'), null);
  assert.equal(parseLatLon('42.7'), null);
  assert.equal(parseLatLon('42.7, -84.5, 3'), null);
  assert.equal(parseLatLon('142.7, -84.5'), null);
  assert.equal(parseLatLon('42.7, -284.5'), null);
});

test('inMichigan is a rough box that includes both peninsulas', () => {
  assert.ok(inMichigan(42.73, -84.55));
  assert.ok(inMichigan(46.5, -87.4));
  assert.ok(!inMichigan(41.0, -87.6));
  assert.ok(!inMichigan(34.0, -118.2));
});

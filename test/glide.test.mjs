import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultState } from '../src/shared/schema.js';
import { displayed, glideValue, restartGlide } from '../src/engine/index.js';

test('glideValue: linear, clamped, zero duration jumps', () => {
  assert.equal(glideValue(100, 200, 0, 1000, 500), 150);
  assert.equal(glideValue(100, 200, 0, 1000, -50), 100);
  assert.equal(glideValue(100, 200, 0, 1000, 5000), 200);
  assert.equal(glideValue(100, 200, 0, 0, 0), 200);
});

test('displayed follows the glide and restartGlide starts where the numbers are', () => {
  const s = defaultState(0);
  s.patient.hr = 120;
  s.glide = { startedAt: 0, durationMs: 4000, from: { ...s.glide.from, hr: 80 } };
  assert.equal(displayed(s, 2000).hr, 100);
  const g = restartGlide(s, 2000, 3000);
  assert.equal(g.from.hr, 100);
  assert.equal(g.startedAt, 2000);
  assert.equal(g.durationMs, 3000);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultState } from '../src/shared/schema.js';
import { displayed, glideValue, pulseless, restartGlide, shown } from '../src/engine/index.js';

test('glideValue: linear, clamped, zero duration jumps', () => {
  assert.equal(glideValue(100, 200, 0, 1000, 500), 150);
  assert.equal(glideValue(100, 200, 0, 1000, -50), 100);
  assert.equal(glideValue(100, 200, 0, 1000, 5000), 200);
  assert.equal(glideValue(100, 200, 0, 0, 0), 200);
});

test('displayed follows the glide and restartGlide starts where the numbers are', () => {
  const s = defaultState(0).patients[0];
  s.hr = 120;
  s.glide = { startedAt: 0, durationMs: 4000, from: { ...s.glide.from, hr: 80 } };
  assert.equal(displayed(s, 2000).hr, 100);
  const g = restartGlide(s, 2000, 3000);
  assert.equal(g.from.hr, 100);
  assert.equal(g.startedAt, 2000);
  assert.equal(g.durationMs, 3000);
});

test('pulseless rhythms blank SpO2 and ABP and restore on a perfusing rhythm', () => {
  const p = defaultState(0).patients[0];
  assert.equal(shown(p, 0).spo2, 98);
  for (const r of ['vf', 'asystole', 'pea']) {
    p.rhythm = r;
    assert.ok(pulseless(p));
    assert.equal(shown(p, 0).spo2, null);
    assert.equal(shown(p, 0).abp, null);
  }
  p.rhythm = 'vt';
  assert.ok(!pulseless(p));
  p.pulse = false;
  assert.ok(pulseless(p));
  p.rhythm = 'sinus';
  assert.ok(!pulseless(p));
  assert.equal(shown(p, 0).spo2, 98);
  assert.deepEqual(shown(p, 0).abp, { sys: 120, dia: 75 });
});

test('sensor-off flags show null for that sensor only', () => {
  const p = defaultState(0).patients[0];
  p.off.spo2 = true;
  p.off.nibp = true;
  const v = shown(p, 0);
  assert.equal(v.spo2, null);
  assert.equal(v.nibp, null);
  assert.equal(v.hr, 80);
  p.off.ecg = true;
  assert.equal(shown(p, 0).hr, null);
});

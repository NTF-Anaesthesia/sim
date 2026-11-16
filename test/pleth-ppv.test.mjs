import test from 'node:test';
import assert from 'node:assert/strict';
import { BeatScheduler } from '../src/engine/beats.js';
import { BreathScheduler } from '../src/engine/breaths.js';
import { breathPhase, plethSample, PLETH_DELAY } from '../src/waves/shapes.js';

const params = (o = {}) => ({
  rhythm: 'sinus', hr: 60, flutterRatio: 2, pvcPerMin: 0, st: 0, pulse: true, sbp: 120, dbp: 80, sbp2: 130, dbp2: 70, rr: 14, ...o,
});
function source(o = {}, secs = 40, rr = 14) {
  const beats = new BeatScheduler(3);
  const breaths = new BreathScheduler(5);
  for (let t = 0; t <= secs; t += 0.1) {
    beats.advance(t, params(o));
    breaths.advance(t, { rr, ie: 2, etco2: 38, shape: 'normal' });
  }
  return { beats: beats.beats, breaths: breaths.breaths, base: beats.base, atrial: beats.atrial };
}
const trace = (f, from, to, step = 0.01) => { const a = []; for (let t = from; t < to; t += step) a.push(f(t)); return a; };
/** Highest pleth value in the upstroke window of each beat between `from` and `to`. */
const peaks = (src, ppv, from, to) => src.beats.filter((b) => b.t > from && b.t < to && b.pulse).map((b) => ({
  t: b.t,
  v: Math.max(...trace((t) => plethSample(src, t, 'good', ppv), b.t + PLETH_DELAY, b.t + PLETH_DELAY + 0.3, 0.002)),
}));

test('pleth with ppv 0 is exactly the pleth without the argument', () => {
  const src = source();
  for (const q of ['good', 'poor']) {
    assert.deepEqual(trace((t) => plethSample(src, t, q, 0), 8, 14), trace((t) => plethSample(src, t, q), 8, 14));
  }
});

test('pleth swings with the breath when ppv is set: taller in inspiration, about 1.4 x the set percent', () => {
  const src = source({}, 50);
  const ps = peaks(src, 15, 10, 48);
  const insp = ps.reduce((a, p) => (breathPhase(src.breaths, p.t) > breathPhase(src.breaths, a.t) ? p : a));
  const exp = ps.reduce((a, p) => (breathPhase(src.breaths, p.t) < breathPhase(src.breaths, a.t) ? p : a));
  assert.ok(insp.v > exp.v * 1.1, `${insp.v} vs ${exp.v}`);
  const v = ps.map((p) => p.v);
  const max = Math.max(...v);
  const min = Math.min(...v);
  const swing = ((max - min) / ((max + min) / 2)) * 100;
  assert.ok(swing > 15 && swing < 30, `swing ${swing}% for ppv 15 (aim ~21%)`);
  const flat = peaks(src, 0, 10, 48).map((p) => p.v);
  assert.ok(Math.max(...flat) - Math.min(...flat) < 0.02, 'no swing at ppv 0');
});

test('pleth ppv has nothing to follow in apnoea: same as ppv 0', () => {
  const src = source({}, 20, 0);
  assert.equal(src.breaths.length, 0);
  assert.deepEqual(trace((t) => plethSample(src, t, 'good', 20), 8, 14), trace((t) => plethSample(src, t, 'good', 0), 8, 14));
});

test('pleth stays a flat 0 line without a pulse, even with ppv set', () => {
  const src = source({ pulse: false });
  assert.ok(src.beats.length > 0);
  for (const v of trace((t) => plethSample(src, t, 'good', 30), 8, 14)) assert.equal(v, 0);
});

test('pleth swing never makes a beat taller than the lane allows', () => {
  const src = source({ sbp: 200, dbp: 60, hr: 50 }, 30);
  const a = trace((t) => plethSample(src, t, 'good', 40), 8, 28);
  assert.ok(Math.max(...a) < 1.47, String(Math.max(...a)));
  assert.ok(Math.min(...a) > -0.17, String(Math.min(...a)));
});

test('fast, wide pulses stay inside the pleth lane and still return towards baseline', () => {
  for (const [hr, ppv] of [[150, 0], [180, 0], [150, 40], [200, 0]]) {
    const src = source({ sbp: 210, dbp: 55, hr }, 30);
    const a = trace((t) => plethSample(src, t, 'good', ppv), 8, 28, 0.004);
    assert.ok(Math.max(...a) < 1.4, `hr ${hr} ppv ${ppv}: max ${Math.max(...a)}`);
    assert.ok(Math.min(...a) < 0.5, `hr ${hr} ppv ${ppv}: trough ${Math.min(...a)}`);
  }
});

test('normal rates keep the same pleth shape', () => {
  const src = source({ hr: 72 }, 30);
  const a = trace((t) => plethSample(src, t, 'good', 0), 8, 28, 0.004);
  assert.ok(Math.max(...a) < 1.1 && Math.max(...a) > 0.8, String(Math.max(...a)));
});

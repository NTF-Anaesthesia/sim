import test from 'node:test';
import assert from 'node:assert/strict';
import { BeatScheduler } from '../src/engine/beats.js';
import { pacing, pulseless, shown } from '../src/engine/rhythm.js';
import { defaultPatient, defaultState, fillDefaults, validatePace, validatePatch } from '../src/shared/schema.js';
import { createModuleRegistry, registerBuiltinModules } from '../src/monitor/modules.js';
import { DEFAULT_THEME } from '../src/theme/default.js';
import { makeHub, msg } from './fake.mjs';

const params = (o = {}) => ({
  rhythm: 'sinus', hr: 60, flutterRatio: 2, pvcPerMin: 0, st: 0, pulse: true, sbp: 120, dbp: 80, rr: 14, ...o,
});
const run = (s, p, from, to, step = 0.1) => { for (let t = from; t <= to + 1e-9; t += step) s.advance(t, p); };
const kinds = (s, k) => s.beats.filter((b) => b.kind === k);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const gaps = (b) => b.map((x, i) => (i ? x.t - b[i - 1].t : 0)).slice(1);

test('pacing(): needs pads on; capture needs output at or above threshold', () => {
  const p = { ...defaultPatient('p1'), paceOn: true, paceMa: 80, paceThreshold: 60 };
  assert.deepEqual(pacing(p), { on: true, capture: true });
  assert.deepEqual(pacing({ ...p, paceMa: 40 }), { on: true, capture: false });
  assert.deepEqual(pacing({ ...p, paceMa: 60 }), { on: true, capture: true });
  assert.equal(pacing({ ...p, paceOn: false }).on, false);
  assert.equal(pacing({ ...p, off: { pads: true } }).on, false);
  assert.equal(pacing({ ...p, rhythm: 'vf' }).capture, false);
});

test('capture gives wide paced beats with a pulse at the set rate', () => {
  const s = new BeatScheduler(1);
  run(s, params({ rhythm: 'asystole', hr: 0, pulse: false, pace: { rate: 80, capture: true, fixed: false } }), 0, 30);
  const paced = kinds(s, 'paced');
  assert.ok(paced.length >= 35);
  assert.ok(paced.every((b) => b.pulse));
  assert.ok(Math.abs(60 / mean(gaps(paced)) - 80) < 3);
});

test('no capture gives spikes with no complex and no pulse', () => {
  const s = new BeatScheduler(1);
  run(s, params({ rhythm: 'asystole', hr: 0, pulse: false, pace: { rate: 70, capture: false, fixed: false } }), 0, 30);
  assert.equal(kinds(s, 'paced').length, 0);
  const sp = kinds(s, 'spike');
  assert.ok(sp.length >= 30);
  assert.ok(sp.every((b) => !b.pulse));
  assert.ok(Math.abs(60 / mean(gaps(sp)) - 70) < 3);
});

test('demand pacing is inhibited by a faster intrinsic rhythm; fixed and failure to sense are not', () => {
  const demand = new BeatScheduler(2);
  run(demand, params({ hr: 90, pace: { rate: 50, capture: true, fixed: false } }), 0, 30);
  assert.equal(kinds(demand, 'spike').length + kinds(demand, 'paced').length, 0);
  for (const label of ['fixed']) {
    const s = new BeatScheduler(2);
    run(s, params({ hr: 90, pace: { rate: 50, capture: false, fixed: true } }), 0, 30);
    assert.ok(kinds(s, 'spike').length >= 20, label);
  }
});

test('a pacer faster than the patient takes over', () => {
  const s = new BeatScheduler(3);
  run(s, params({ hr: 50, pace: { rate: 80, capture: true, fixed: false } }), 0, 40);
  const late = s.beats.filter((b) => b.t > 20 && b.kind !== 'spike');
  assert.ok(late.every((b) => b.kind === 'paced'));
});

test('junctional has an inverted P after the QRS; bigeminy and trigeminy keep the rate', () => {
  const j = new BeatScheduler(4);
  run(j, params({ rhythm: 'junctional', hr: 55 }), 0, 20);
  assert.ok(j.beats.some((b) => b.inv));
  for (const [r, n] of [['bigeminy', 2], ['trigeminy', 3]]) {
    const s = new BeatScheduler(5);
    run(s, params({ rhythm: r, hr: 80 }), 0, 60);
    const b = s.beats.filter((x) => x.kind !== 'dropped');
    assert.ok(Math.abs(b.length - 80) < 8, `${r} count ${b.length}`);
    const pvc = b.filter((x) => x.kind === 'pvc');
    assert.ok(Math.abs(pvc.length - b.length / n) <= 3, `${r} pvcs ${pvc.length}`);
    assert.ok(pvc.every((x) => x.qrsWidth > 0.11));
  }
});

test('capture makes a pulse and shows the paced rate; no capture does not', () => {
  const p = { ...defaultPatient('p1'), rhythm: 'asystole', hr: 0, paceOn: true, paceRate: 75, paceMa: 90, paceThreshold: 60 };
  assert.equal(pulseless(p), false);
  assert.equal(shown(p).hr, 75);
  const q = { ...p, paceMa: 30 };
  assert.equal(pulseless(q), true);
});

test('validatePace and the new patch fields', () => {
  assert.equal(validatePace({ t: 'pace', p: 'p1', on: true, rate: 80, ma: 70, mode: 'fixed' }).ok, true);
  assert.equal(validatePace({ t: 'pace', p: 'p1' }).ok, false);
  assert.equal(validatePace({ t: 'pace', p: 'p1', rate: 10 }).ok, false);
  assert.equal(validatePace({ t: 'pace', p: 'p1', ma: 500 }).ok, false);
  assert.equal(validatePace({ t: 'pace', p: 'p1', mode: 'wild' }).ok, false);
  assert.equal(validatePatch({ patient: { paceThreshold: 80, paceNoSense: true } }).ok, true);
  assert.equal(validatePatch({ patient: { paceThreshold: 1 } }).ok, false);
  assert.equal(validatePatch({ patient: { paceNoSense: 1 } }).ok, false);
});

test('old rooms get the pacing defaults', () => {
  const old = defaultPatient('p1');
  for (const k of ['paceOn', 'paceRate', 'paceMa', 'paceMode', 'paceThreshold', 'paceNoSense']) delete old[k];
  const st = defaultState();
  st.patients = [old];
  fillDefaults(st);
  const f = st.patients[0];
  assert.equal(f.paceOn, false);
  assert.equal(f.paceMa, 0);
  assert.equal(f.paceMode, 'demand');
});

test('hub: pace message sets fields, logs one event, refuses with pads off', async () => {
  const { hub } = makeHub();
  const r = await hub.onMessage('c-1', msg({ t: 'pace', p: 'p1', on: true, rate: 80, ma: 70, mode: 'demand' }));
  assert.ok(r.broadcast, JSON.stringify(r));
  const s = (await hub.onMessage('c-1', msg({ t: 'hello' }))).reply.state;
  assert.equal(s.patients[0].paceOn, true);
  assert.equal(s.patients[0].paceRate, 80);
  const ev = s.events.at(-1);
  assert.equal(ev.kind, 'pace');
  assert.match(ev.what, /on 80\/min 70mA demand/);
  await hub.onMessage('c-1', msg({ t: 'pace', p: 'p1', on: false }));
  await hub.onMessage('c-1', msg({ t: 'set', patch: { patient: { off: { pads: true } } } }));
  const bad = await hub.onMessage('c-1', msg({ t: 'pace', p: 'p1', on: true }));
  assert.ok(!bad.broadcast);
});

test('second ECG lead: module, wave and theme labels exist', () => {
  const reg = createModuleRegistry();
  registerBuiltinModules(reg);
  assert.ok(reg.get('ecg2'));
  assert.equal(DEFAULT_THEME.labels.wave.ecg2, 'V1');
});

test('a fast intrinsic rhythm is not thinned by a pacer that does not capture', () => {
  const off = new BeatScheduler(6);
  run(off, params({ rhythm: 'svt', hr: 220 }), 0, 30);
  const on = new BeatScheduler(6);
  run(on, params({ rhythm: 'svt', hr: 220, pace: { rate: 60, capture: false, fixed: true } }), 0, 30);
  const n = (s) => s.beats.filter((b) => b.kind !== 'spike' && b.kind !== 'dropped').length;
  assert.ok(Math.abs(n(on) - n(off)) <= 3, `${n(on)} vs ${n(off)}`);
});

test('failure to sense: spikes keep their own rate over an intrinsic rhythm; a captured beat never lands in the refractory period', () => {
  const s = new BeatScheduler(7);
  run(s, params({ hr: 90, pace: { rate: 60, capture: true, fixed: true } }), 0, 40);
  const sp = s.beats.filter((b) => b.kind === 'spike' || b.kind === 'paced');
  assert.ok(sp.length >= 35 && sp.length <= 45, `spikes ${sp.length}`);
  const qrs = s.beats.filter((b) => b.kind !== 'spike' && b.kind !== 'dropped');
  for (let i = 1; i < qrs.length; i++) assert.ok(qrs[i].t - qrs[i - 1].t >= 0.29, `gap ${qrs[i].t - qrs[i - 1].t}`);
});

test('hub: changing the rate with the pacer off is not logged as off', async () => {
  const { hub } = makeHub();
  await hub.onMessage('c-1', msg({ t: 'pace', p: 'p1', rate: 90 }));
  const s = (await hub.onMessage('c-1', msg({ t: 'hello' }))).reply.state;
  assert.match(s.events.at(-1).what, /^set 90\/min/);
});

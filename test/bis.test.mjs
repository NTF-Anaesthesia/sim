import test from 'node:test';
import assert from 'node:assert/strict';
import { burstEnvelope, eegSample, hashNoise } from '../src/waves/eeg.js';
import { createWaveRegistry, registerBuiltinWaves } from '../src/waves/index.js';
import { createModuleRegistry, registerBuiltinModules, BIS_MIN_SQI } from '../src/monitor/modules.js';
import { evaluateAlarms } from '../src/engine/alarms.js';
import { displayed } from '../src/engine/glide.js';
import { shown } from '../src/engine/rhythm.js';
import { DEFAULT_THEME } from '../src/theme/default.js';
import { defaultPatient, defaultState, fillDefaults, validatePatch } from '../src/shared/schema.js';

const q = (o = {}) => ({ bis: 95, sr: 0, emg: 0, sqi: 100, ...o });
const trace = (f, from, to, step = 0.0025) => { const a = []; for (let t = from; t < to; t += step) a.push(f(t)); return a; };
/** Sign changes per second: a rough measure of how fast the trace is. */
const crossings = (a, step = 0.0025) => { let n = 0; for (let i = 1; i < a.length; i++) if ((a[i - 1] < 0) !== (a[i] < 0)) n++; return n / (a.length * step); };
const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);

test('the EEG strip is fast when awake and slow and large when deep', () => {
  const awake = trace((t) => eegSample(t, q({ bis: 95 })), 0, 20);
  const deep = trace((t) => eegSample(t, q({ bis: 20 })), 0, 20);
  assert.ok(crossings(awake) > 2.5 * crossings(deep), `${crossings(awake)} vs ${crossings(deep)}`);
  assert.ok(rms(deep) > 1.8 * rms(awake), `${rms(deep)} vs ${rms(awake)}`);
});

test('the trace gets slower step by step as the depth number falls', () => {
  const rate = (bis) => crossings(trace((t) => eegSample(t, q({ bis })), 0, 20));
  assert.ok(rate(95) > rate(65) && rate(65) > rate(40) && rate(40) > rate(15), [95, 65, 40, 15].map(rate).join());
});

test('the trace is deterministic in time and stays inside the lane range', () => {
  assert.equal(eegSample(3.1234, q({ bis: 50, sr: 30, emg: 20 })), eegSample(3.1234, q({ bis: 50, sr: 30, emg: 20 })));
  assert.equal(hashNoise(42), hashNoise(42));
  for (const bis of [0, 30, 60, 100]) for (const v of trace((t) => eegSample(t, q({ bis, sr: 40, emg: 100, sqi: 0 })), 0, 12, 0.01)) assert.ok(Math.abs(v) <= 1.4);
});

test('burst suppression: quiet share follows the suppression ratio, none at zero', () => {
  const quietShare = (sr) => {
    const env = trace((t) => burstEnvelope(t, sr), 0, 240, 0.05);
    return env.filter((e) => e < 0.5).length / env.length;
  };
  assert.equal(quietShare(0), 0);
  for (const sr of [20, 50, 80]) assert.ok(Math.abs(quietShare(sr) - sr / 100) < 0.1, `${sr}: ${quietShare(sr)}`);
  assert.ok(quietShare(100) > 0.95);
  // a small ratio is a brief pause, not a wide dip
  for (const sr of [1, 5, 10]) assert.ok(Math.abs(quietShare(sr) - sr / 100) < 0.04, `${sr}: ${quietShare(sr)}`);
  for (const t of trace((x) => x, 0, 60, 0.05)) assert.ok(burstEnvelope(t, 0.4) >= 0.03 && burstEnvelope(t, 99.9) >= 0.03);
  const deepBurst = trace((t) => eegSample(t, q({ bis: 15, sr: 60 })), 0, 60);
  const quiet = deepBurst.filter((v, i) => burstEnvelope(i * 0.0025, 60) < 0.1);
  const loud = deepBurst.filter((v, i) => burstEnvelope(i * 0.0025, 60) > 0.9);
  assert.ok(quiet.length > 1000 && loud.length > 1000);
  assert.ok(rms(loud) > 8 * rms(quiet));
});

test('muscle activity and poor contact make the line ragged', () => {
  const smooth = trace((t) => eegSample(t, q({ bis: 50 })), 0, 10);
  const emg = trace((t) => eegSample(t, q({ bis: 50, emg: 80 })), 0, 10);
  const poor = trace((t) => eegSample(t, q({ bis: 50, sqi: 10 })), 0, 10);
  assert.ok(crossings(emg) > 2 * crossings(smooth));
  assert.ok(crossings(poor) > 2 * crossings(smooth));
});

test('eeg is a registered wave; blank only when the BIS sensor is off', () => {
  const reg = createWaveRegistry();
  registerBuiltinWaves(reg);
  const wd = reg.get('eeg');
  assert.ok(wd);
  const p = defaultPatient('p1', 'Bed 1', 0);
  assert.equal(wd.blank({ patient: p, perfusing: true, tSec: 0 }), false);
  p.off.bis = true;
  assert.equal(wd.blank({ patient: p, perfusing: true, tSec: 0 }), true);
  const [lo, hi] = wd.range(1);
  assert.ok(lo < -1 && hi > 1);
  assert.equal(typeof wd.sample({ beats: [], breaths: [], base: /** @type {any} */ ({}) }, 2, { patient: p, perfusing: true, tSec: 2 }), 'number');
});

test('the bis module shows BIS, SQI, EMG and SR; poor signal and sensor off blank the number', () => {
  const mods = createModuleRegistry();
  registerBuiltinModules(mods);
  const def = mods.get('bis');
  assert.equal(def?.wave, 'eeg');
  const state = defaultState(0);
  const patient = Object.assign(defaultPatient('p1', 'Bed 1', 0), { bisSqi: 91, bisEmg: 12, bisSr: 7 });
  const view = (v, p = patient) => def.parts.numeric({ patient: p, state, v: { bis: v }, nibp: {}, nowMs: 0, units: { co2: 'mmHg', temp: 'C' }, theme: DEFAULT_THEME });
  const ok = view(46.4);
  assert.equal(ok.main, '46');
  assert.equal(ok.label, 'BIS');
  assert.match(ok.small, /SQI 91/);
  assert.match(ok.small, /EMG 12/);
  assert.match(ok.small, /SR 7/);
  const poor = view(46, { ...patient, bisSqi: BIS_MIN_SQI - 1 });
  assert.equal(poor.main, '---');
  assert.match(poor.small, /POOR SIGNAL/);
  const off = view(null);
  assert.equal(off.main, '---');
  assert.equal(off.small, 'SENSOR OFF');
});

test('depth glides like the other numerics and goes null with the sensor off', () => {
  const p = defaultPatient('p1', 'Bed 1', 0);
  p.glide = { startedAt: 0, durationMs: 1000, from: { ...p.glide.from, bis: 90 } };
  p.bis = 40;
  assert.equal(displayed(p, 500).bis, 65);
  assert.equal(shown(p, 1000).bis, 40);
  p.off.bis = true;
  assert.equal(shown(p, 1000).bis, null);
});

test('BIS alarms need the module; sensor off is a low-priority alarm', () => {
  const s = defaultState(0);
  const p = defaultPatient('p1', 'Bed 1', 0);
  const v = { hr: 80, spo2: 98, etco2: 38, rr: 14, temp: 36.8, nibpSys: 120, abpSys: 120, bis: 10 };
  assert.ok(!evaluateAlarms(p, s, v, 0).some((a) => a.param === 'bis'));
  s.modules = [...s.modules, 'bis'];
  assert.ok(evaluateAlarms(p, s, v, 0).some((a) => a.id === 'bis-low'));
  p.bisSqi = BIS_MIN_SQI - 1;
  assert.ok(evaluateAlarms(p, s, v, 0).some((a) => a.id === 'bis-sqi'));
  assert.ok(!evaluateAlarms(p, s, v, 0).some((a) => a.id === 'bis-low'));
  p.off.bis = true;
  assert.ok(evaluateAlarms(p, s, v, 0).some((a) => a.id === 'bis-off'));
});

test('patch validation: BIS fields in range, whole numbers; the module id is allowed', () => {
  const ok = validatePatch({ patient: { bis: 41.6, bisSqi: 80, bisEmg: 3, bisSr: 25, off: { bis: true } }, modules: ['ecg', 'bis'] });
  assert.ok(ok.ok, ok.msg);
  assert.equal(ok.patch.patient.bis, 42);
  for (const bad of [{ bis: 101 }, { bis: -1 }, { bisSr: 120 }, { bisSqi: 'x' }, { bisEmg: NaN }]) assert.equal(validatePatch({ patient: bad }).ok, false, JSON.stringify(bad));
});

test('an older saved room gets the BIS fields and keeps schema 1; V1 rooms keep their modules', () => {
  const s = defaultState(0);
  const p = /** @type {any} */ (s.patients[0]);
  for (const k of ['bis', 'bisSqi', 'bisEmg', 'bisSr']) delete p[k];
  delete p.off.bis;
  delete p.glide.from.bis;
  delete s.alarms.limits.bis;
  const before = [...s.modules];
  fillDefaults(s);
  assert.deepEqual([p.bis, p.bisSqi, p.bisEmg, p.bisSr, p.off.bis, p.glide.from.bis], [95, 98, 5, 0, false, 95]);
  assert.deepEqual(s.alarms.limits.bis, [20, 100]);
  assert.equal(s.schema, 1);
  assert.deepEqual(s.modules, before);
  assert.ok(!s.modules.includes('bis'), 'off by default');
});

test('themes carry the bis cells and labels', () => {
  assert.ok(DEFAULT_THEME.layout.cells.some((c) => c.module === 'bis' && c.part === 'wave'));
  assert.ok(DEFAULT_THEME.layout.cells.some((c) => c.module === 'bis' && c.part === 'numeric'));
  assert.equal(DEFAULT_THEME.labels.bis, 'BIS');
  assert.ok(DEFAULT_THEME.colors.eeg && DEFAULT_THEME.colors.bis && DEFAULT_THEME.waves.eeg);
});

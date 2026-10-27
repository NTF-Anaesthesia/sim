import test from 'node:test';
import assert from 'node:assert/strict';
import { BeatScheduler, MOBITZ2_CONDUCTED } from '../src/engine/beats.js';
import { BreathScheduler } from '../src/engine/breaths.js';
import { AlarmTracker, burstDue, evaluateAlarms, SILENCE_MS } from '../src/engine/alarms.js';
import { NibpMachine, ageText, cuffPressure, mapOf, nibpCycleDue, nibpJitter, DEFLATE_STEP } from '../src/engine/nibp.js';
import { JITTER_AMP, jittered } from '../src/engine/jitter.js';
import { burstPattern, spo2PitchHz } from '../src/monitor/audio.js';
import { resolveTheme, waveSettings } from '../src/theme/resolve.js';
import { layoutCells } from '../src/theme/layout.js';
import { DEFAULT_THEME } from '../src/theme/default.js';
import { createModuleRegistry, registerBuiltinModules } from '../src/monitor/modules.js';
import { createSettings } from '../src/monitor/settings.js';
import { defaultPatient, defaultState } from '../src/shared/schema.js';

const params = (o = {}) => ({
  rhythm: 'sinus', hr: 60, flutterRatio: 2, pvcPerMin: 0, st: 0, pulse: true, sbp: 120, dbp: 80, rr: 14, ...o,
});
// the schedulers run in real time (a jump of more than a couple of seconds counts as a pause): step like frames do
const run = (s, p, from, to, step = 0.1) => { for (let t = from; t <= to + 1e-9; t += step) s.advance(t, p); };
const rs = (beats) => beats.map((b, i) => (i ? b.t - beats[i - 1].t : null)).slice(1);
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const R = (beats) => beats.filter((b) => b.kind !== 'dropped');

test('beat rate follows HR', () => {
  for (const hr of [40, 75, 150]) {
    const s = new BeatScheduler(3);
    run(s, params({ hr }), 0, 60);
    const b = R(s.beats);
    assert.ok(Math.abs(60 / mean(rs(b)) - hr) < hr * 0.05, `hr ${hr}`);
  }
});

test('a rhythm change takes effect at the next beat, not before', () => {
  const s = new BeatScheduler(3);
  run(s, params({ hr: 60 }), 0, 20);
  const n = s.beats.length;
  run(s, params({ rhythm: 'vt', hr: 180 }), 20.1, 40);
  const added = s.beats.slice(n);
  // anything already scheduled keeps its time; new beats start from the last scheduled beat
  assert.ok(added[0].t > s.beats[n - 1].t);
  assert.ok(added.some((b) => b.qrsWidth >= 0.15), 'wide complexes after the change');
  assert.ok(added[added.length - 1].t > 30, 'keeps scheduling to the horizon');
});

test('AF is irregular, sinus is regular', () => {
  const sd = (r) => Math.sqrt(mean(r.map((x) => (x - mean(r)) ** 2)));
  const a = new BeatScheduler(5); run(a, params({ rhythm: 'af', hr: 90 }), 0, 120);
  const n = new BeatScheduler(5); run(n, params({ hr: 90 }), 0, 120);
  assert.ok(sd(rs(R(a.beats))) > 4 * sd(rs(R(n.beats))));
});

test('Mobitz II drops a beat after fixed conducted beats; complete block keeps ventricular rate', () => {
  const m = new BeatScheduler(2); run(m, params({ rhythm: 'mobitz2', hr: 60 }), 0, 120);
  const kinds = m.beats.map((b) => b.kind);
  assert.ok(kinds.includes('dropped'));
  const i = kinds.indexOf('dropped');
  assert.ok(i >= MOBITZ2_CONDUCTED || i > 0);
  const c = new BeatScheduler(2); run(c, params({ rhythm: 'chb', hr: 35 }), 0, 120);
  const v = R(c.beats);
  assert.ok(Math.abs(60 / mean(rs(v)) - 35) < 4);
});

test('PVCs appear at about the set rate and only where the rhythm allows', () => {
  const s = new BeatScheduler(9); run(s, params({ hr: 70, pvcPerMin: 12 }), 0, 300);
  const n = s.beats.filter((b) => b.kind === 'pvc').length;
  assert.ok(n >= 25 && n <= 75, `pvc count ${n}`);
  const v = new BeatScheduler(9); run(v, params({ rhythm: 'vt', hr: 180, pvcPerMin: 12 }), 0, 120);
  assert.equal(v.beats.filter((b) => b.kind === 'pvc').length, 0);
});

test('asystole has no beats and flutter 2:1 conducts every second flutter wave', () => {
  const a = new BeatScheduler(1); run(a, params({ rhythm: 'asystole', hr: 0 }), 0, 30);
  assert.equal(R(a.beats).length, 0);
  const f = new BeatScheduler(1); run(f, params({ rhythm: 'flutter', hr: 150, flutterRatio: 2 }), 0, 60);
  assert.ok(Math.abs(60 / mean(rs(R(f.beats))) - 150) < 10);
});

test('breaths follow RR and stop when RR, EtCO2 or the shape says so', () => {
  const b = new BreathScheduler(1); run(b, { rr: 12, ie: 0.5, etco2: 38, shape: 'normal' }, 0, 60);
  assert.ok(Math.abs(b.breaths.length - 12) <= 1);
  assert.ok(b.breaths[0].ti < 5 && b.breaths[0].ti > 0);
  for (const bad of [{ rr: 0, etco2: 38, shape: 'normal' }, { rr: 12, etco2: 0, shape: 'normal' }, { rr: 12, etco2: 38, shape: 'none' }]) {
    const x = new BreathScheduler(1); run(x, { ie: 0.5, ...bad }, 0, 60);
    assert.equal(x.breaths.length, 0);
  }
});

test('jitter stays small, leaves null and zero alone, and caps SpO2', () => {
  for (let t = 0; t < 120; t += 0.7) {
    assert.ok(Math.abs(jittered(80, 'hr', 'a', t) - 80) <= JITTER_AMP.hr + 1e-9);
    assert.ok(jittered(99.8, 'spo2', 'a', t, { max: 100 }) <= 100);
  }
  assert.equal(jittered(null, 'hr', 'a', 3), null);
  assert.equal(jittered(0, 'hr', 'a', 3), 0);
});

const world = () => {
  const st = defaultState(0);
  return { st, p: st.patients[0] };
};
const vals = (o = {}) => ({ hr: 70, spo2: 98, etco2: 38, rr: 14, temp: 36.8, nibpSys: 120, abpSys: null, ...o });

test('alarms: limits give medium, lethal rhythms high, sensor off low, silence floor and expiry', () => {
  const { st, p } = world();
  assert.equal(evaluateAlarms(p, st, vals(), 1000).length, 0);
  const lo = evaluateAlarms(p, st, vals({ spo2: 85 }), 1000);
  assert.equal(lo[0].priority, 2);
  p.rhythm = 'vf';
  assert.equal(evaluateAlarms(p, st, vals(), 1000).sort((a, b) => b.priority - a.priority)[0].priority, 3);
  p.rhythm = 'sinus';
  p.off.spo2 = true;
  assert.equal(evaluateAlarms(p, st, vals({ spo2: null }), 1000)[0].priority, 1);

  const t = new AlarmTracker();
  const med = [{ id: 'x', param: 'spo2', priority: 2, text: 'SPO2 LOW' }];
  const hi = [{ id: 'y', param: 'hr', priority: 3, text: 'VENT FIB' }];
  const cfg = (until) => ({ enabled: true, silencedUntil: until });
  assert.equal(t.update(med, cfg(1000 + SILENCE_MS), 1000).silenced, true);
  assert.equal(t.update(med, cfg(1000 + SILENCE_MS), 5000).silenced, true);
  assert.equal(t.update([...med, ...hi], cfg(1000 + SILENCE_MS), 6000).silenced, false, 'a higher priority breaks the silence');
  assert.equal(t.update(med, cfg(1000 + SILENCE_MS), 7000).silenced, false, 'and it stays broken');
  assert.equal(new AlarmTracker().update(med, cfg(1000 + SILENCE_MS), 1000 + SILENCE_MS + 1).silenced, false, 'expires');
  assert.equal(t.update(med, { enabled: false, silencedUntil: 0 }, 9000).master, false);
});

test('tone bursts repeat by priority and restart for a higher one', () => {
  assert.equal(burstDue(0, false, { lastAt: 0, lastPriority: 0 }, 1e6), false);
  assert.equal(burstDue(2, true, { lastAt: 0, lastPriority: 0 }, 1e6), false);
  assert.equal(burstDue(2, false, { lastAt: 0, lastPriority: 0 }, 1000), true);
  assert.equal(burstDue(2, false, { lastAt: 1000, lastPriority: 2 }, 5000), false);
  assert.equal(burstDue(2, false, { lastAt: 1000, lastPriority: 2 }, 13500), true);
  assert.equal(burstDue(3, false, { lastAt: 1000, lastPriority: 2 }, 1500), true);
  assert.ok(burstPattern(3).length > burstPattern(1).length);
});

test('SpO2 pitch is log-scaled, rises with SpO2 and clamps low', () => {
  const a = spo2PitchHz(100), b = spo2PitchHz(95), c = spo2PitchHz(90), lo = spo2PitchHz(40), lower = spo2PitchHz(10);
  assert.ok(a > b && b > c && c > lo);
  assert.equal(lo, lower);
});

test('NIBP machine: existing reading is a result, a new one plays inflate, measure, result; cuff off fails', () => {
  const m = new NibpMachine({ inflateMs: 1000, measureMs: 2000 });
  const r1 = { sys: 120, dia: 75, at: 1000 };
  assert.equal(m.tick(r1, false, 5000).phase, 'result');
  const r2 = { sys: 130, dia: 80, at: 6000 };
  assert.equal(m.tick(r2, false, 6000).phase, 'inflating');
  assert.equal(m.tick(r2, false, 7500).phase, 'measuring');
  const done = m.tick(r2, false, 9500);
  assert.equal(done.phase, 'result');
  assert.equal(done.sys, 130);
  assert.equal(m.tick({ ...r2, at: 12000 }, true, 12000).phase, 'failed');
  assert.equal(new NibpMachine().tick({ sys: 1, dia: 1, at: 5 }, false, 5).phase, 'result');
});

test('NIBP cuff pressure: pumps above systolic, bleeds down in steps to below diastolic, shown while cuffing', () => {
  const r = { sys: 150, dia: 90 };
  assert.equal(cuffPressure(r, 'inflating', 0), 0);
  assert.equal(cuffPressure(r, 'inflating', 1), 180);
  assert.equal(cuffPressure({ sys: 100, dia: 60 }, 'inflating', 1), 160); // never starts below 160
  assert.equal(cuffPressure(r, 'measuring', 0), 180);
  assert.equal(cuffPressure(r, 'measuring', 1), 80);
  let prev = 999;
  for (let p = 0; p <= 1; p += 0.01) {
    const c = cuffPressure(r, 'measuring', p);
    assert.ok(c <= prev && (prev === 999 || prev - c === 0 || prev - c <= DEFLATE_STEP), `steps down at ${p}`);
    prev = c;
  }
  const m = new NibpMachine({ inflateMs: 1000, measureMs: 2000 });
  m.tick({ sys: 120, dia: 75, at: 0 }, false, 0);
  assert.equal(m.tick({ sys: 150, dia: 90, at: 100 }, false, 100).cuff, 0);
  const t = m.tick({ sys: 150, dia: 90, at: 100 }, false, 1100);
  assert.equal(t.phase, 'measuring');
  assert.equal(t.cuff, 180);
  assert.equal(m.tick({ sys: 150, dia: 90, at: 100 }, false, 4000).cuff, null);
});

test('NIBP jitter: small bell-shaped error, never zero spread', () => {
  assert.deepEqual(nibpJitter(120, 75, () => 0.5), { sys: 120, dia: 75 });
  assert.deepEqual(nibpJitter(120, 75, () => 1), { sys: 124, dia: 78 });
  assert.deepEqual(nibpJitter(120, 75, () => 0), { sys: 116, dia: 72 });
  assert.equal(nibpJitter(40, 38, () => 0.5).dia, 30);
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const j = nibpJitter(120, 75);
    assert.ok(Math.abs(j.sys - 120) <= 4 && Math.abs(j.dia - 75) <= 3);
    seen.add(j.sys);
  }
  assert.ok(seen.size > 3, 'readings vary');
});

test('NIBP helpers: MAP, cycle due, reading age', () => {
  assert.equal(mapOf(120, 75), 90);
  assert.equal(nibpCycleDue({ mode: 'manual', cycleSec: 60, at: 0 }, 1e9), null);
  assert.equal(nibpCycleDue({ mode: 'cycle', cycleSec: 60, at: 1000 }, 30000), null);
  assert.equal(nibpCycleDue({ mode: 'cycle', cycleSec: 60, at: 1000 }, 61000), 1000);
  assert.equal(ageText(20000), 'just now');
  assert.equal(ageText(150000), '2 min ago');
});

test('theme: defaults fill gaps, bad values are dropped with a note, bad cells are dropped', () => {
  const ok = resolveTheme({ name: 'x', colors: { ecg: '#ffffff' } });
  assert.equal(ok.theme.colors.ecg, '#ffffff');
  assert.equal(ok.theme.colors.spo2, DEFAULT_THEME.colors.spo2);
  assert.equal(ok.problems.length, 0);
  const bad = resolveTheme({ colors: { ecg: 5 }, layout: { cells: [{ module: 'ecg', part: 'wave', x: 0, y: 0, w: 99, h: 1 }] } });
  assert.equal(bad.theme.colors.ecg, DEFAULT_THEME.colors.ecg);
  assert.ok(bad.problems.length >= 2);
  assert.equal(bad.theme.layout.cells.length, 0);
  assert.equal(resolveTheme(null).theme.name, DEFAULT_THEME.name);
  assert.deepEqual(waveSettings(DEFAULT_THEME, 'etco2'), { speed: 12.5, gain: 1 });
  assert.deepEqual(waveSettings({ waves: { speedMmPerSec: 50 } }, 'zzz'), { speed: 50, gain: 1 });
});

test('layout: a module that is off hands its space to the others in the stack', () => {
  const on = (mods) => (c) => mods.includes(c.module) && !(c.module === 'etco2' && c.part === 'numeric2' && mods.includes('rr'));
  const wave = (cells) => cells.filter((c) => c.part === 'wave');
  const all = layoutCells(DEFAULT_THEME, on(['ecg', 'spo2', 'abp', 'etco2', 'rr']));
  const noAbp = layoutCells(DEFAULT_THEME, on(['ecg', 'spo2', 'etco2', 'rr']));
  const span = (cells) => Math.max(...wave(cells).map((c) => c.y + c.h)) - Math.min(...wave(cells).map((c) => c.y));
  assert.equal(wave(all).length, 4);
  assert.equal(wave(noAbp).length, 3);
  assert.ok(Math.abs(span(all) - span(noAbp)) < 1e-9, 'the same area is shared');
  assert.ok(wave(noAbp).every((c, i, a) => !i || Math.abs(c.y - (a[i - 1].y + a[i - 1].h)) < 1e-9), 'no gaps');
});

test('module registry: built-ins register and a new module can slot in', () => {
  const reg = createModuleRegistry();
  assert.deepEqual(reg.ids(), []);
  registerBuiltinModules(reg);
  for (const id of ['ecg', 'spo2', 'etco2', 'nibp', 'rr', 'temp', 'abp']) assert.ok(reg.get(id), id);
  reg.register({ id: 'cvp', parts: { numeric: () => ({ label: 'CVP', color: 'text', main: '8', sub: '', unit: 'mmHg', param: 'cvp', limits: null, off: false, small: '' }) } });
  assert.equal(reg.get('cvp')?.parts.numeric({}).main, '8');
  assert.equal(reg.get('etco2')?.skip?.('numeric2', ['rr']), true);
});

test('settings: namespaced, JSON, survives broken storage', () => {
  const mem = new Map();
  const st = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  const s = createSettings(st);
  assert.equal(s.get('units', { co2: 'mmHg' }).co2, 'mmHg');
  s.set('units', { co2: 'kPa' });
  assert.ok(mem.has('sim.settings.units'));
  assert.equal(s.get('units', {}).co2, 'kPa');
  s.remove('units');
  assert.equal(s.get('units', 1), 1);
  const boom = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
  const b = createSettings(boom);
  b.set('a', 1);
  assert.equal(b.get('a', 7), 7);
  assert.equal(createSettings(null).get('a', 5), 5);
});

test('defaultPatient is usable by the waves layer', () => {
  assert.equal(defaultPatient('p9', 'x', 0).id, 'p9');
});

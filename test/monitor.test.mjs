import test from 'node:test';
import assert from 'node:assert/strict';
import { BeatScheduler, MOBITZ2_CONDUCTED } from '../src/engine/beats.js';
import { BreathScheduler } from '../src/engine/breaths.js';
import { AlarmTracker, burstDue, evaluateAlarms, SILENCE_MS } from '../src/engine/alarms.js';
import { NibpMachine, ageText, cuffPressure, mapOf, nibpCycleDue, nibpJitter, DEFLATE_STEP } from '../src/engine/nibp.js';
import { JITTER_AMP, jittered } from '../src/engine/jitter.js';
import { alarmPattern, AudioMixer as Mixer, IEC_HARMONICS, IEC_MAX_HZ, IEC_MIN_HZ, PULSE_EDGE_SEC, spo2PitchHz } from '../src/monitor/audio.js';
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
  // a cancelled silence (silencedUntil back to 0) sounds again at once, and a new silence then holds again
  const c = new AlarmTracker();
  assert.equal(c.update(med, cfg(1000 + SILENCE_MS), 1000).silenced, true);
  const back = c.update(med, cfg(0), 2000);
  assert.equal(back.silenced, false, 'cancel ends the silence at once');
  assert.equal(burstDue(back.priority, back.silenced, { lastAt: 0, lastPriority: 0 }, 2000), true, 'tones play again');
  assert.equal(c.update(med, cfg(3000 + SILENCE_MS), 3000).silenced, true, 'a new silence works after a cancel');
});

test('silence: any NEW alarm condition breaks it (same priority too); ones silenced stay silent; higher priority still breaks', () => {
  const { st, p } = world();
  const until = 1000 + SILENCE_MS;
  const cfg = { enabled: true, silencedUntil: until };
  const hrLow = evaluateAlarms(p, st, vals({ hr: 45 }), 1000);
  assert.deepEqual(hrLow.map((a) => [a.id, a.priority]), [['hr-low', 2]]);
  const both = evaluateAlarms(p, st, vals({ hr: 45, spo2: 88 }), 1000);
  assert.deepEqual(both.map((a) => [a.id, a.priority]), [['hr-low', 2], ['spo2-low', 2]]);

  // HR low silenced, then SpO2 low at the same (medium) priority sounds
  const t = new AlarmTracker();
  assert.equal(t.update(hrLow, cfg, 1000).silenced, true);
  assert.equal(t.update(hrLow, cfg, 30000).silenced, true, 'the same condition stays silent');
  assert.equal(t.update(hrLow, cfg, 30000).broke, 0);
  const v = t.update(both, cfg, 31000);
  assert.equal(v.silenced, false, 'a new condition at the same priority breaks the silence');
  assert.equal(v.silenceLeftMs, 0);
  assert.equal(v.broke, until, 'names the silence it broke, for the room');
  assert.equal(burstDue(v.priority, v.silenced, { lastAt: 0, lastPriority: 0 }, 31000), true, 'tones play again');
  assert.equal(t.update(hrLow, cfg, 32000).silenced, false, 'stays broken when the new one clears');

  // a low-priority new condition breaks it too
  const lowNew = new AlarmTracker();
  lowNew.update(hrLow, cfg, 1000);
  assert.equal(lowNew.update([...hrLow, ...evaluateAlarms({ ...p, off: { ecg: false, spo2: true } }, st, vals({ hr: 45 }), 1000).filter((a) => a.id === 'spo2-off')], cfg, 2000).silenced, false);

  // a condition that clears and comes back during the silence counts as new
  const back = new AlarmTracker();
  back.update(hrLow, cfg, 1000);
  assert.equal(back.update([], cfg, 5000).silenced, true);
  assert.equal(back.update(hrLow, cfg, 9000).silenced, false, 'HR low again after clearing sounds');

  // the same condition rising to a higher priority (HR 45 -> 35) still breaks it
  const up = new AlarmTracker();
  up.update(hrLow, cfg, 1000);
  const hrHigh = evaluateAlarms(p, st, vals({ hr: 35 }), 1000);
  assert.deepEqual(hrHigh.map((a) => [a.id, a.priority]), [['hr-low', 3]]);
  assert.equal(up.update(hrHigh, cfg, 2000).silenced, false, 'higher priority breaks the silence');
  // falling back to a lower priority of a silenced condition does not
  const down = new AlarmTracker();
  down.update(hrHigh, cfg, 1000);
  assert.equal(down.update(hrLow, cfg, 2000).silenced, true);

  // a fresh silence after a break holds again for what is active then
  assert.equal(t.update(both, { enabled: true, silencedUntil: 40000 + SILENCE_MS }, 40000).silenced, true);
  assert.equal(t.update(both, { enabled: true, silencedUntil: 40000 + SILENCE_MS }, 41000).broke, 0);
});

test('tone bursts repeat by priority and restart for a higher one', () => {
  assert.equal(burstDue(0, false, { lastAt: 0, lastPriority: 0 }, 1e6), false);
  assert.equal(burstDue(2, true, { lastAt: 0, lastPriority: 0 }, 1e6), false);
  assert.equal(burstDue(2, false, { lastAt: 0, lastPriority: 0 }, 1000), true);
  assert.equal(burstDue(2, false, { lastAt: 1000, lastPriority: 2 }, 5000), false);
  assert.equal(burstDue(2, false, { lastAt: 1000, lastPriority: 2 }, 8500), true, 'medium repeats every 7.5 s');
  assert.equal(burstDue(3, false, { lastAt: 1000, lastPriority: 2 }, 1500), true);
  assert.equal(burstDue(3, false, { lastAt: 1000, lastPriority: 3 }, 5900), false);
  assert.equal(burstDue(3, false, { lastAt: 1000, lastPriority: 3 }, 6000), true, 'high repeats every 5 s');
  assert.equal(burstDue(1, false, { lastAt: 1000, lastPriority: 1 }, 20900), false);
  assert.equal(burstDue(1, false, { lastAt: 1000, lastPriority: 1 }, 21000), true, 'low repeats every 20 s');
  assert.equal(burstDue(2, false, { lastAt: 1000, lastPriority: 2 }, 8500, 'classic'), false, 'classic keeps 12 s');
  assert.equal(burstDue(2, false, { lastAt: 1000, lastPriority: 2 }, 13000, 'classic'), true);
});

test('IEC alarm pattern: high 3 + 2, medium 3 even, low 2; pitch in range, high not below medium', () => {
  const style = DEFAULT_THEME.alarmStyle;
  const hi = alarmPattern(3, style), med = alarmPattern(2, style), lo = alarmPattern(1, style);
  assert.equal(hi.length, 5);
  assert.equal(med.length, 3);
  assert.equal(lo.length, 2);
  // gaps between the end of one pulse and the start of the next
  const gaps = (ps) => ps.slice(1).map((p, i) => p.startMs - (ps[i].startMs + ps[i].durMs));
  const g = gaps(hi);
  assert.equal(g[0], g[1], 'first three evenly spaced');
  assert.equal(g[3], g[0], 'last two at the same spacing');
  assert.ok(g[2] > g[0] * 2, 'a short pause between the 3 and the 2');
  assert.ok(g[2] < 1000, 'the pause is short, not a new burst');
  const gm = gaps(med);
  assert.equal(gm[0], gm[1], 'medium pulses evenly spaced');
  for (const ps of [hi, med, lo]) {
    assert.equal(ps[0].startMs, 0);
    for (const p of ps) {
      assert.ok(p.freq >= IEC_MIN_HZ && p.freq <= IEC_MAX_HZ, `${p.freq} Hz in range`);
      assert.ok(p.durMs >= 75 && p.durMs <= 250, 'pulse 75-250 ms');
      assert.ok(p.durMs >= 2 * PULSE_EDGE_SEC * 1000, 'room for the soft edges');
    }
    const last = ps[ps.length - 1];
    assert.ok(last.startMs + last.durMs < 2000, 'a burst ends well before the next one');
  }
  assert.ok(hi[0].freq >= med[0].freq, 'high pitch at or above medium');
  assert.deepEqual(hi.map((p) => p.freq), [960, 960, 960, 960, 960], 'the theme pitch is used');
  // a theme's own pitch is kept when in range, held to 150-1000 Hz when not, high raised to medium
  assert.equal(alarmPattern(2, { toneHz: { medium: 700 } })[0].freq, 700);
  assert.equal(alarmPattern(2, { toneHz: { medium: 1800 } })[0].freq, IEC_MAX_HZ);
  assert.equal(alarmPattern(1, { toneHz: { low: 100 } })[0].freq, IEC_MIN_HZ);
  assert.equal(alarmPattern(3, { toneHz: { high: 500, medium: 700 } })[0].freq, 700);
  assert.equal(alarmPattern(3, {}).length, 5, 'no style: built-in pitches');
  assert.deepEqual(alarmPattern(0, style), []);
  assert.ok(IEC_HARMONICS.length >= 5, 'fundamental plus at least four harmonics');
  for (const a of IEC_HARMONICS.slice(1)) assert.ok(20 * Math.log10(a) > -15, 'harmonics within 15 dB');
});

test('classic alarm pattern keeps the earlier bursts and the theme pitch as written', () => {
  const hi = alarmPattern(3, { pattern: 'classic', toneHz: { high: 1500 } });
  assert.equal(hi.length, 10);
  assert.equal(hi[0].freq, 1500);
  assert.equal(hi[5].startMs - hi[4].startMs, 560);
  assert.equal(alarmPattern(2, { pattern: 'classic' }).length, 3);
  assert.equal(alarmPattern(1, { pattern: 'classic' }).length, 2);
});

test('AudioMixer.burst plays harmonic pulses with 20 ms edges, sine for soft tones', async () => {
  const oscs = [];
  const ramps = [];
  let waves = 0;
  const ctx = {
    state: 'running', destination: {}, currentTime: 10,
    createGain: () => ({ gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime: (v, t) => ramps.push([v, t]) }, connect: (n) => n }),
    createOscillator: () => {
      const o = { type: 'sine', wave: null, frequency: { value: 0 }, setPeriodicWave(w) { this.wave = w; }, connect: (n) => n, start() {}, stop() {} };
      oscs.push(o);
      return o;
    },
    createPeriodicWave: (real, imag) => { waves++; return { real, imag }; },
    async resume() {}, async suspend() {},
  };
  const a = new Mixer({ volume: () => 1, makeContext: () => /** @type {any} */ (ctx) });
  await a.enable();
  a.burst(3, DEFAULT_THEME.alarmStyle);
  assert.equal(oscs.length, 5);
  assert.ok(oscs.every((o) => o.wave && o.frequency.value === 960));
  assert.equal(waves, 1, 'the wave is made once');
  assert.equal(Array.from(oscs[0].wave.imag).filter((x) => x > 0).length, 5);
  assert.ok(Math.abs(ramps[0][1] - 10 - PULSE_EDGE_SEC) < 1e-9, 'soft 20 ms attack');
  oscs.length = 0;
  a.burst(2, { ...DEFAULT_THEME.alarmStyle, tones: 'soft' });
  assert.equal(oscs.length, 3);
  assert.ok(oscs.every((o) => !o.wave && o.type === 'sine'));
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

// --- link banner and wake (src/monitor/link.js) ---
import { LINK_GRACE_MS, clockText, linkBanner, watchWake } from '../src/monitor/link.js';
import { AudioMixer } from '../src/monitor/audio.js';

test('link banner: hidden while open, after a 3 s blip; shown after 6 s with the last update; cleared on open', () => {
  const lastStateAt = new Date(2026, 10, 16, 9, 5, 7).getTime();
  const downSince = lastStateAt + 1000;
  assert.equal(linkBanner({ status: 'open', downSince: 0, lastStateAt, now: downSince + 60000 }).show, false);
  assert.equal(linkBanner({ status: 'reconnecting', downSince, lastStateAt, now: downSince + 3000 }).show, false);
  const b = linkBanner({ status: 'reconnecting', downSince, lastStateAt, now: downSince + 6000 });
  assert.equal(b.show, true);
  assert.ok(b.show && b.kind === 'lost' && /Connection lost/.test(b.text) && b.sub === 'last update 09:05:07');
  assert.ok(b.show && /alarms continue/.test(b.text), 'the banner says alarms keep sounding');
  assert.equal(linkBanner({ status: 'open', downSince, lastStateAt, now: downSince + 7000 }).show, false);
  assert.equal(LINK_GRACE_MS, 5000);
  assert.equal(clockText(new Date(2026, 0, 1, 23, 0, 9).getTime()), '23:00:09');
});

test('link banner: first connection gets the same grace, then counts seconds', () => {
  assert.equal(linkBanner({ status: 'connecting', downSince: 1000, lastStateAt: 0, now: 5000 }).show, false);
  const b = linkBanner({ status: 'connecting', downSince: 1000, lastStateAt: 0, now: 8500 });
  assert.ok(b.show && b.kind === 'lost' && b.sub === 'not connected for 7 s');
});

test('link banner: full and expired show at once; expired is its own kind (the join link)', () => {
  const e = linkBanner({ status: 'expired', downSince: 1000, lastStateAt: 900, now: 1000 });
  assert.ok(e.show && e.kind === 'expired' && e.text === 'This room has expired');
  const f = linkBanner({ status: 'full', downSince: 1000, lastStateAt: 0, now: 1000 });
  assert.ok(f.show && f.kind === 'full' && f.text === 'Room is full');
});

/** @param {string} vis */
const fakeDoc = (vis) => Object.assign(new EventTarget(), { visibilityState: vis });

test('watchWake: becoming visible, pageshow, online and focus wake the client; hidden does not', () => {
  const doc = fakeDoc('hidden');
  const win = new EventTarget();
  let wakes = 0;
  let shown = 0;
  const off = watchWake({ wake: () => { wakes++; } }, { doc, win, onVisible: () => { shown++; } });
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(wakes, 0);
  doc.visibilityState = 'visible';
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(wakes, 1);
  assert.equal(shown, 1);
  for (const ev of ['pageshow', 'online', 'focus']) win.dispatchEvent(new Event(ev));
  assert.equal(wakes, 4);
  off();
  doc.dispatchEvent(new Event('visibilitychange'));
  win.dispatchEvent(new Event('online'));
  assert.equal(wakes, 4);
});

test('AudioMixer.resume: resumes a suspended context only when sound was turned on', async () => {
  let resumes = 0;
  const ctx = {
    state: 'running', destination: {},
    createGain: () => ({ gain: { value: 0 }, connect() {} }),
    async resume() { resumes++; this.state = 'running'; },
    async suspend() { this.state = 'suspended'; },
  };
  const a = new AudioMixer({ volume: () => 1, makeContext: () => /** @type {any} */ (ctx) });
  await a.resume();
  assert.equal(resumes, 0);
  await a.enable();
  assert.equal(resumes, 1);
  ctx.state = 'interrupted';
  await a.resume();
  assert.equal(resumes, 2);
  assert.equal(a.enabled, true);
  await a.disable();
  await a.resume();
  assert.equal(resumes, 2);
});

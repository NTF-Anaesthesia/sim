// Beat beep source (SpO2 on: from the pleth pulse; off: from the QRS) and the alarm tone while the room link is lost.
import test from 'node:test';
import assert from 'node:assert/strict';
import { alarmToneStep, beatBeeps } from '../src/monitor/beeps.js';
import { AlarmTracker, evaluateAlarms, TONE_EVERY_MS } from '../src/engine/alarms.js';
import { displayed } from '../src/engine/glide.js';
import { shown } from '../src/engine/rhythm.js';
import { defaultPatient, defaultState } from '../src/shared/schema.js';
import { WaveSource } from '../src/waves/source.js';
import { PLETH_DELAY } from '../src/waves/shapes.js';

/** Beats for a patient run for `secs` display seconds through the real wave source (pulseless rule included). */
function beatsFor(patch = {}, secs = 20) {
  const p = { ...defaultPatient('p1', 'Bed 1', 0), ...patch };
  const src = new WaveSource(7);
  for (let t = 0; t <= secs; t += 0.05) src.update(t, p, displayed(p, 0));
  return src.beats;
}
/** Beeps heard frame by frame (60 Hz) from `from` to `to`, as the monitor's frame loop asks for them. */
function heard(beats, from, to, spo2Source) {
  const out = [];
  let last = from;
  for (let t = from; t <= to; t += 1 / 60) {
    out.push(...beatBeeps(beats, last, t, spo2Source));
    last = t;
  }
  return out;
}

test('SpO2 on: one beep per pleth pulse, PLETH_DELAY (about 0.25 s) after its R wave', () => {
  const beats = beatsFor();
  const pulsed = beats.filter((b) => b.pulse && b.t > 5 && b.t + PLETH_DELAY <= 15);
  const beeps = heard(beats, 5 + PLETH_DELAY, 15, true);
  assert.ok(pulsed.length >= 10, `${pulsed.length} beats`);
  assert.equal(beeps.length, pulsed.length);
  beeps.forEach((at, i) => assert.ok(Math.abs(at - pulsed[i].t - PLETH_DELAY) < 1e-9, `${at} vs ${pulsed[i].t}`));
  assert.ok(PLETH_DELAY >= 0.2 && PLETH_DELAY <= 0.3);
});

test('SpO2 off: the plain beep stays on the QRS (R wave time)', () => {
  const beats = beatsFor();
  const qrs = beats.filter((b) => b.t > 5 && b.t <= 15 && b.kind !== 'dropped' && b.kind !== 'spike');
  assert.deepEqual(heard(beats, 5, 15, false), qrs.map((b) => b.t));
});

test('no SpO2 beep without a pleth pulse: PEA, VF, asystole, pulseless VT, pacing with no capture', () => {
  for (const patch of [
    { rhythm: 'pea' }, { rhythm: 'vf' }, { rhythm: 'asystole' }, { rhythm: 'vt', pulse: false },
    { rhythm: 'asystole', paceOn: true, paceMa: 20, paceThreshold: 60 },
  ]) {
    const beats = beatsFor(patch);
    assert.deepEqual(heard(beats, 2, 20, true), [], JSON.stringify(patch));
  }
  // PEA still has QRS complexes on the ECG: with SpO2 off the QRS beep follows them as before
  assert.ok(heard(beatsFor({ rhythm: 'pea' }), 2, 20, false).length >= 10);
});

test('SpO2 on: dropped beats (Mobitz II) give no beep; captured pacing does', () => {
  const m2 = beatsFor({ rhythm: 'mobitz2' });
  const pulsed = m2.filter((b) => b.pulse && b.t > 2 && b.t + PLETH_DELAY <= 20);
  assert.ok(m2.some((b) => b.kind === 'dropped' && b.t > 2 && b.t < 20));
  assert.equal(heard(m2, 2 + PLETH_DELAY, 20, true).length, pulsed.length);
  const paced = beatsFor({ rhythm: 'asystole', paceOn: true, paceMa: 80, paceThreshold: 60 });
  assert.ok(heard(paced, 5, 20, true).length >= 10);
});

test('beatBeeps windows are half open: a beep is never heard twice or skipped across frames', () => {
  const beats = [{ t: 1, kind: 'normal', pulse: true }, { t: 2, kind: 'spike', pulse: false }, { t: 3, kind: 'normal', pulse: true }];
  const b = /** @type {any} */ (beats);
  assert.deepEqual(beatBeeps(b, 0, 1, false), [1]);
  assert.deepEqual(beatBeeps(b, 1, 3, false), [3]);
  assert.deepEqual(beatBeeps(b, 1, 1 + PLETH_DELAY, true), [1 + PLETH_DELAY]);
  assert.deepEqual(beatBeeps(b, 1 + PLETH_DELAY, 4, true), [3 + PLETH_DELAY]);
});

/**
 * The monitor's tick with the room link lost: no new state arrives, the server clock (local clock + offset) runs on.
 * Returns the server times a burst sounded.
 */
function offlineTicks(state, fromMs, toMs, st = { lastAt: 0, lastPriority: 0 }) {
  const tracker = new AlarmTracker();
  const p = state.patients[0];
  const bursts = [];
  for (let now = fromMs; now <= toMs; now += 250) {
    const s = shown(p, now);
    const alarms = evaluateAlarms(p, state, { hr: s.hr, spo2: s.spo2, etco2: s.etco2, rr: s.rr, temp: s.temp, nibpSys: null, abpSys: null }, now);
    const av = tracker.update(alarms, { enabled: state.alarms.enabled, silencedUntil: state.alarms.silencedUntil }, now);
    if (alarmToneStep(av, st, now, { audioOn: true })) bursts.push({ now, priority: av.priority });
  }
  return bursts;
}

test('connection lost: alarm tones keep sounding from the last known state', () => {
  // last state before the link dropped: SpO2 82 (below the 90 limit)
  const state = defaultState(0);
  state.patients[0].spo2 = 82;
  state.patients[0].glide = { ...state.patients[0].glide, from: { ...state.patients[0].glide.from, spo2: 82 } };
  const bursts = offlineTicks(state, 0, 60000);
  assert.ok(bursts.length >= 7, `${bursts.length} bursts in a minute offline`);
  const every = TONE_EVERY_MS[/** @type {1 | 2 | 3} */ (bursts[0].priority)];
  for (let i = 1; i < bursts.length; i++) assert.ok(bursts[i].now - bursts[i - 1].now < every + 300, 'repeats on schedule');
});

test('connection lost: a silence from the last state runs out on the monitor clock, then the tone resumes', () => {
  const state = defaultState(0);
  state.patients[0].rhythm = 'vf';
  state.alarms.silencedUntil = 20000;
  const bursts = offlineTicks(state, 0, 40000);
  assert.ok(bursts.length > 0 && bursts[0].now >= 20000 && bursts[0].now < 20500, JSON.stringify(bursts[0]));
  assert.equal(bursts[0].priority, 3);
});

test('alarmToneStep: no sound with audio off, nothing due while silenced, a higher priority sounds at once', () => {
  const st = { lastAt: 0, lastPriority: 0 };
  assert.equal(alarmToneStep({ priority: 3, silenced: false }, st, 1000, { audioOn: false }), false);
  assert.equal(alarmToneStep({ priority: 3, silenced: true }, st, 1000, { audioOn: true }), false);
  assert.equal(alarmToneStep({ priority: 2, silenced: false }, st, 1000, { audioOn: true }), true);
  assert.equal(alarmToneStep({ priority: 2, silenced: false }, st, 2000, { audioOn: true }), false);
  assert.equal(alarmToneStep({ priority: 3, silenced: false }, st, 2100, { audioOn: true }), true);
  assert.deepEqual(st, { lastAt: 2100, lastPriority: 3 });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { BeatScheduler } from '../src/engine/beats.js';
import { BreathScheduler } from '../src/engine/breaths.js';
import { artLineSample, cvpSample, flushShape, FLUSH_HOLD } from '../src/waves/lines.js';
import { ppvFactor } from '../src/waves/shapes.js';
import { evaluateAlarms } from '../src/engine/alarms.js';
import { defaultPatient, defaultState } from '../src/shared/schema.js';
import { makeHub, msg } from './fake.mjs';

const params = (o = {}) => ({
  rhythm: 'sinus', hr: 60, flutterRatio: 2, pvcPerMin: 0, st: 0, pulse: true, sbp: 120, dbp: 80, sbp2: 130, dbp2: 70, rr: 14, ...o,
});
function source(o = {}, secs = 20) {
  const beats = new BeatScheduler(3);
  const breaths = new BreathScheduler(5);
  for (let t = 0; t <= secs; t += 0.1) {
    beats.advance(t, params(o));
    breaths.advance(t, { rr: 14, ie: 2, etco2: 38, shape: 'normal' });
  }
  return { beats: beats.beats, breaths: breaths.breaths, base: beats.base, atrial: beats.atrial };
}
const trace = (f, from, to, step = 0.01) => { const a = []; for (let t = from; t < to; t += step) a.push(f(t)); return a; };
const range = (a) => Math.max(...a) - Math.min(...a);

test('CVP has a, v waves around its mean', () => {
  const src = source();
  const a = trace((t) => cvpSample(src, t, 8, 'normal'), 8, 16);
  assert.ok(range(a) > 3 && range(a) < 12);
  const mean = a.reduce((s, x) => s + x, 0) / a.length;
  assert.ok(Math.abs(mean - 8) < 2.5, String(mean));
});

test('giant v waves are taller than normal ones', () => {
  const src = source();
  const n = trace((t) => cvpSample(src, t, 8, 'normal'), 8, 16);
  const g = trace((t) => cvpSample(src, t, 8, 'giant'), 8, 16);
  assert.ok(Math.max(...g) > Math.max(...n) + 3);
});

test('no a wave in AF; cannon a waves in complete heart block', () => {
  const sinus = source();
  const af = source({ rhythm: 'af', hr: 80 });
  const chb = source({ rhythm: 'chb', hr: 35 });
  assert.equal(af.base.type, 'af');
  const peaks = (src) => trace((t) => cvpSample(src, t, 8, 'normal', 0), 8, 18);
  assert.ok(Math.max(...peaks(chb)) > Math.max(...peaks(sinus)) + 2, 'cannon a');
  // before each QRS the a wave is gone in AF: the trace right before the beat is below the sinus one on average
  const before = (src) => {
    const bs = src.beats.filter((b) => b.t > 8 && b.t < 18);
    return bs.reduce((s, b) => s + cvpSample(src, b.t - 0.06, 8, 'normal', 0), 0) / bs.length;
  };
  assert.ok(before(sinus) > before(af) + 1.5, 'a wave missing in AF');
});

test('PPV swing: pulse pressure varies with the breath by about the set percent', () => {
  const src = source({}, 40);
  const bs = src.beats.filter((b) => b.t > 10 && b.t < 38);
  const f = bs.map((b) => ppvFactor(src.breaths, b.t, 20));
  const max = Math.max(...f);
  const min = Math.min(...f);
  assert.ok(((max - min) / ((max + min) / 2)) * 100 > 12, 'swing visible');
  assert.ok(((max - min) / ((max + min) / 2)) * 100 < 22);
  assert.equal(ppvFactor(src.breaths, 12, 0), 1);
});

test('second art line carries its own pressures', () => {
  const src = source();
  const hi = (line) => Math.max(...trace((t) => artLineSample(src, t, line, 'normal', 0), 8, 14));
  assert.ok(hi('abp2') > hi('abp') + 5, 'abp2 sys 130 vs 120');
});

test('flush test: square wave, then ringing that matches the damping', () => {
  assert.equal(flushShape(0.5, 90, 'normal'), 300);
  const swings = (damping) => {
    let crossings = 0;
    let prev = flushShape(FLUSH_HOLD + 0.001, 90, damping) - 90;
    for (let x = FLUSH_HOLD + 0.002; x < FLUSH_HOLD + 2; x += 0.002) {
      const v = flushShape(x, 90, damping) - 90;
      if (Math.abs(v) > 4 && Math.abs(prev) > 4 && Math.sign(v) !== Math.sign(prev)) crossings++;
      if (Math.abs(v) > 4) prev = v;
    }
    return crossings / 2;
  };
  const over = swings('over');
  const normal = swings('normal');
  const under = swings('under');
  assert.equal(over, 0, 'over-damped: no ringing');
  assert.ok(normal >= 1 && normal <= 3.5, `normal ${normal}`);
  assert.ok(under > normal + 2, `under ${under}`);
});

test('the art line shows the flush from the event time and then recovers', () => {
  const src = { ...source(), flush: { abp: 10 } };
  assert.equal(artLineSample(src, 10.5, 'abp', 'normal', 0), 300);
  assert.equal(artLineSample(src, 10.5, 'abp2', 'normal', 0) < 200, true, 'other line unaffected');
  const after = artLineSample(src, 16, 'abp', 'normal', 0);
  assert.ok(after < 200);
});

test('alarms for CVP and the second line need their modules', () => {
  const s = defaultState(0);
  const p = defaultPatient('p1', 'Bed 1', 0);
  const v = { hr: 80, spo2: 98, etco2: 38, rr: 14, temp: 36.8, nibpSys: 120, abpSys: 120, cvp: 20, abp2Sys: 60 };
  assert.ok(!evaluateAlarms(p, s, v, 0).some((a) => a.param === 'cvp' || a.param === 'abp2'));
  s.modules = [...s.modules, 'cvp', 'abp2'];
  const ids = evaluateAlarms(p, s, v, 0).map((a) => a.id);
  assert.ok(ids.includes('cvp-high') && ids.includes('abp2-low'), ids.join());
});

test('hub: flush is an event only and rejects unknown lines', async () => {
  const { hub } = makeHub();
  const r = await hub.onMessage('c-1', msg({ t: 'flush', line: 'abp2' }));
  const ev = r.broadcast.state.events.at(-1);
  assert.equal(ev.kind, 'flush');
  assert.equal(ev.what, 'abp2');
  const bad = await hub.onMessage('c-1', msg({ t: 'flush', line: 'x' }));
  assert.ok(!bad.broadcast);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { ALARM_DELAY_MS, AlarmDelay, AlarmTracker, alarmDelayMs, evaluateAlarms } from '../src/engine/alarms.js';
import { defaultState } from '../src/shared/schema.js';

// A fake clock: the monitor passes performance.now(); here the test moves it by hand.
const clock = (start = 1000) => { let t = start; return { now: () => t, add: (ms) => { t += ms; return t; } }; };
const world = () => {
  const st = defaultState(0);
  st.modules = ['ecg', 'spo2', 'etco2', 'nibp', 'rr', 'temp'];
  const p = st.patients[0];
  p.nibpRead.at = 1e15; // NIBP never overdue in these tests
  return { st, p };
};
const vals = (o = {}) => ({ hr: 70, spo2: 98, etco2: 38, rr: 14, temp: 36.8, nibpSys: 120, abpSys: null, ...o });
const ids = (as) => as.map((a) => a.id).sort();

/** Drive the delay with one set of values from `from` for `ms`, in 250 ms ticks like the monitor; returns the last output. */
function hold(d, c, p, st, v, ms, on = true) {
  let out = d.filter(evaluateAlarms(p, st, v, 0), on, c.now());
  for (let t = 0; t < ms; t += 250) out = d.filter(evaluateAlarms(p, st, v, 0), on, c.add(250));
  return out;
}

test('delay table: one place, physiological 5 s, SpO2 8 s, apnoea 20 s', () => {
  assert.deepEqual({ ...ALARM_DELAY_MS }, { limit: 5000, spo2: 8000, apnea: 20000 });
  assert.ok(Object.isFrozen(ALARM_DELAY_MS));
  const a = (id, param, priority = 2) => alarmDelayMs({ id, param, priority, text: '' });
  assert.equal(a('hr-low', 'hr'), 5000);
  assert.equal(a('hr-high', 'hr', 3), 5000);
  assert.equal(a('nibp-high', 'nibp'), 5000);
  assert.equal(a('fio2-hypoxic', 'fio2', 3), 5000);
  assert.equal(a('spo2-low', 'spo2'), 8000);
  assert.equal(a('spo2-low', 'spo2', 3), 8000);
  assert.equal(a('apnea', 'rr', 3), 20000);
  for (const r of ['asystole', 'vf', 'vt', 'torsades']) assert.equal(a(`rhythm-${r}`, 'hr', 3), 0, r);
  for (const id of ['ecg-off', 'spo2-off', 'spo2-nopulse', 'nibp-overdue', 'bis-sqi']) assert.equal(a(id, 'x', 1), 0, id);
});

test('physiological limit alarm waits 5 s', () => {
  const { st, p } = world();
  const d = new AlarmDelay();
  const c = clock();
  d.filter([], true, c.now());
  const v = vals({ hr: 30 });
  assert.deepEqual(d.filter(evaluateAlarms(p, st, v, 0), true, c.now()), []);
  c.add(4999);
  assert.deepEqual(d.filter(evaluateAlarms(p, st, v, 0), true, c.now()), []);
  c.add(1);
  assert.deepEqual(ids(d.filter(evaluateAlarms(p, st, v, 0), true, c.now())), ['hr-low']);
});

test('SpO2 limit alarm waits 8 s, and a rise to high priority keeps the wait served', () => {
  const { st, p } = world();
  const d = new AlarmDelay();
  const c = clock();
  d.filter([], true, c.now());
  assert.deepEqual(hold(d, c, p, st, vals({ spo2: 88 }), 7000), []); // medium, 7 s in
  // drops into the critical band (same id, now high): not a new condition
  assert.deepEqual(d.filter(evaluateAlarms(p, st, vals({ spo2: 80 }), 0), true, c.add(500)), []);
  const out = d.filter(evaluateAlarms(p, st, vals({ spo2: 80 }), 0), true, c.add(500));
  assert.deepEqual(ids(out), ['spo2-low']);
  assert.equal(out[0].priority, 3);
});

test('apnoea waits 20 s; the RR LOW on the way down has its own 5 s', () => {
  const { st, p } = world();
  const d = new AlarmDelay();
  const c = clock();
  d.filter([], true, c.now());
  assert.deepEqual(hold(d, c, p, st, vals({ rr: 0, etco2: 0 }), 19750).filter((a) => a.id === 'apnea'), []);
  const out = d.filter(evaluateAlarms(p, st, vals({ rr: 0, etco2: 0 }), 0), true, c.add(250));
  assert.ok(ids(out).includes('apnea'));
});

test('a value that recovers before the delay ends never alarms, and its return starts the wait again', () => {
  const { st, p } = world();
  const d = new AlarmDelay();
  const c = clock();
  d.filter([], true, c.now());
  assert.deepEqual(hold(d, c, p, st, vals({ hr: 30 }), 4500), []);
  assert.deepEqual(d.filter(evaluateAlarms(p, st, vals(), 0), true, c.add(250)), []); // back in range
  assert.deepEqual(hold(d, c, p, st, vals({ hr: 30 }), 4500), []); // 9.25 s of low HR in all, never 5 s unbroken
  assert.deepEqual(ids(hold(d, c, p, st, vals({ hr: 30 }), 500)), ['hr-low']);
  // the same through the tracker: nothing to sound before the 5 s
  const d2 = new AlarmDelay();
  const t = new AlarmTracker();
  const c2 = clock();
  d2.filter([], true, c2.now());
  for (let i = 0; i < 16; i++) {
    const av = t.update(d2.filter(evaluateAlarms(p, st, vals({ spo2: 89 }), 0), true, c2.add(250)), { enabled: true, silencedUntil: 0 }, 0);
    assert.equal(av.priority, 0);
  }
  const av = t.update(d2.filter(evaluateAlarms(p, st, vals(), 0), true, c2.add(250)), { enabled: true, silencedUntil: 0 }, 0);
  assert.equal(av.priority, 0);
});

test('lethal rhythms and technical alarms stay immediate with the delay on', () => {
  const { st, p } = world();
  const c = clock();
  for (const r of ['asystole', 'vf', 'vt', 'torsades']) {
    const d = new AlarmDelay();
    d.filter([], true, c.now());
    p.rhythm = r;
    const out = d.filter(evaluateAlarms(p, st, vals({ hr: 0, spo2: null }), 0), true, c.add(250));
    assert.ok(ids(out).includes(`rhythm-${r}`), r);
    assert.ok(ids(out).includes('spo2-nopulse'), r);
  }
  p.rhythm = 'sinus';
  p.off.ecg = true;
  const d = new AlarmDelay();
  d.filter([], true, c.now());
  assert.deepEqual(ids(d.filter(evaluateAlarms(p, st, vals(), 0), true, c.add(250))), ['ecg-off']);
});

test('off: alarms pass through untouched, at every moment, exactly as without the option', () => {
  const { st, p } = world();
  const d = new AlarmDelay();
  const c = clock();
  const cases = [vals(), vals({ hr: 30 }), vals({ spo2: 80 }), vals({ rr: 0, etco2: 0 }), vals({ hr: 180, temp: 39.5, nibpSys: 200 })];
  for (const v of cases) {
    for (let i = 0; i < 5; i++) {
      const raw = evaluateAlarms(p, st, v, 0);
      const out = d.filter(raw, false, c.add(250));
      assert.equal(out, raw); // the same array
    }
  }
  // tracker output is identical to feeding the raw alarms
  const t1 = new AlarmTracker();
  const t2 = new AlarmTracker();
  const cfg = { enabled: true, silencedUntil: 0 };
  for (const v of cases) {
    const raw = evaluateAlarms(p, st, v, 0);
    assert.deepEqual(t1.update(d.filter(raw, false, c.add(250)), cfg, 0), t2.update(raw, cfg, 0));
  }
});

test('turning it on keeps an alarm already showing; turning it off shows a waiting one at once', () => {
  const { st, p } = world();
  const d = new AlarmDelay();
  const c = clock();
  const v = vals({ hr: 30 });
  assert.deepEqual(ids(d.filter(evaluateAlarms(p, st, v, 0), false, c.now())), ['hr-low']);
  assert.deepEqual(ids(d.filter(evaluateAlarms(p, st, v, 0), true, c.add(250))), ['hr-low']);
  // a new condition after it is on waits
  const v2 = vals({ hr: 30, temp: 39.5 });
  assert.deepEqual(ids(d.filter(evaluateAlarms(p, st, v2, 0), true, c.add(250))), ['hr-low']);
  assert.deepEqual(ids(d.filter(evaluateAlarms(p, st, v2, 0), false, c.add(250))), ['hr-low', 'temp-high']);
});

test('the delay uses the wall clock it is given, not the server time the alarms were judged at', () => {
  const { st, p } = world();
  const d = new AlarmDelay();
  d.filter([], true, 0);
  // server time leaps (a clock re-sync or a long replay) while the wall clock barely moves: still waiting
  assert.deepEqual(d.filter(evaluateAlarms(p, st, vals({ hr: 30 }), 0), true, 10), []);
  assert.deepEqual(d.filter(evaluateAlarms(p, st, vals({ hr: 30 }), 60 * 60000), true, 20), []);
  assert.deepEqual(ids(d.filter(evaluateAlarms(p, st, vals({ hr: 30 }), 60 * 60000), true, 5010)), ['hr-low']);
});

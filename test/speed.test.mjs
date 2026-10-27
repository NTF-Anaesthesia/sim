import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHub, msg } from './fake.mjs';
import { displayed } from '../src/engine/glide.js';
import { validateGlideMsBy, validateScenario, validateStep } from '../src/shared/scenario.js';

const send = (hub, o, id = 'c-1') => hub.onMessage(id, msg(o));
const shown = async (hub, now) => displayed((await hub.state()).patients[0], now);

test('one set glides each field at its own speed; the record keeps glideMs as the longest', async () => {
  const { hub, clock } = makeHub();
  const t0 = clock.t;
  const r = await send(hub, { t: 'set', patch: { patient: { hr: 135, spo2: 75 } }, glideMs: 10000, glideMsBy: { spo2: 60000 } });
  const g = r.broadcast.state.patients[0].glide;
  assert.equal(g.durationMs, 60000);
  assert.equal(g.glideMsBy.hr, 10000);
  assert.equal(g.glideMsBy.spo2, 60000);
  const hr0 = (await shown(hub, t0)).hr, sp0 = (await shown(hub, t0)).spo2;
  const d = await shown(hub, t0 + 10000);
  assert.equal(d.hr, 135, 'HR has landed');
  assert.ok(Math.abs(d.spo2 - (sp0 + (75 - sp0) / 6)) < 1e-9, 'SpO2 is one sixth of the way');
  assert.ok(hr0 < 135);
  assert.equal((await shown(hub, t0 + 60000)).spo2, 75);
});

test('a plain set writes no glideMsBy (old rooms and monitors see the same record)', async () => {
  const { hub } = makeHub();
  const r = await send(hub, { t: 'set', patch: { patient: { hr: 100 } }, glideMs: 5000 });
  assert.equal('glideMsBy' in r.broadcast.state.patients[0].glide, false);
  assert.equal(r.broadcast.state.patients[0].glide.durationMs, 5000);
});

test('a later change leaves a slow glide running with the time it had left', async () => {
  const { hub, clock } = makeHub();
  const t0 = clock.t;
  await send(hub, { t: 'set', patch: { patient: { spo2: 80 } }, glideMs: 60000, glideMsBy: { spo2: 60000 } });
  clock.t = t0 + 20000;
  const r = await send(hub, { t: 'set', patch: { patient: { hr: 120 } }, glideMs: 5000 });
  const g = r.broadcast.state.patients[0].glide;
  assert.equal(g.glideMsBy.spo2, 40000, 'SpO2 keeps its remaining 40 s');
  assert.equal(g.glideMsBy.hr, 5000);
  assert.equal((await shown(hub, t0 + 60000)).spo2, 80);
});

test('bad glideMsBy is refused whole', async () => {
  const { hub } = makeHub();
  const hr = (await hub.state()).patients[0].hr;
  for (const by of [{ spo2: -1 }, { spo2: 700000 }, { nope: 5 }, [1], 'x']) {
    const r = await send(hub, { t: 'set', patch: { patient: { hr: 100 } }, glideMsBy: by });
    assert.equal(r.reply.code, 'bad_patch');
  }
  assert.equal((await hub.state()).patients[0].hr, hr);
  assert.equal(validateGlideMsBy({ hr: 1000 }).ok, true);
});

test('steps carry glideMsBy and the runner applies it', async () => {
  const { hub, clock } = makeHub();
  const sc = { name: 'Slow sat', steps: [{ atSec: 0, patch: { patient: { hr: 110, spo2: 80 } }, glideMs: 10000, glideMsBy: { spo2: 90000 } }] };
  assert.equal(validateScenario(sc).ok, true);
  const r = await send(hub, { t: 'scenarioStart', scenario: sc });
  assert.equal(r.broadcast.state.patients[0].glide.glideMsBy.spo2, 90000);
  assert.equal(validateStep({ atSec: 1, patch: { patient: { hr: 1 } }, glideMsBy: { x: 1 } }, 's').ok, false);
  assert.ok(clock.t > 0);
});

const step = (hr, extra = {}) => ({ atSec: 10, patch: { patient: { hr } }, glideMs: 5000, ...extra });

test('queue: add starts a run, a second add appends, it runs with no phone connected', async () => {
  const { hub, storage, clock } = makeHub();
  const t0 = clock.t;
  let r = await send(hub, { t: 'queueAdd', step: step(100) });
  assert.equal(r.broadcast.state.scenario.queue, true);
  assert.equal(r.broadcast.state.scenario.step, 0);
  assert.equal(storage.alarm, t0 + 10000);
  r = await send(hub, { t: 'queueAdd', step: step(120) });
  r = await send(hub, { t: 'queueAdd', step: step(140) });
  assert.equal(r.broadcast.state.scenario.total, 3);
  assert.equal(r.broadcast.state.scenario.q.length, 3);
  for (let i = 1; i <= 3; i++) {
    clock.t = t0 + i * 10000;
    const a = await hub.onAlarm();
    assert.equal(a.broadcast.state.scenario.step, i);
  }
  const s = await hub.state();
  assert.equal(s.patients[0].hr, 140);
  assert.equal(s.scenario.done, true);
  // a fresh add after the end starts a new queue
  r = await send(hub, { t: 'queueAdd', step: step(90) });
  assert.equal(r.broadcast.state.scenario.total, 1);
  assert.equal(r.broadcast.state.scenario.step, 0);
});

test('queue: reorder and skip a step that has not run; the next due time follows', async () => {
  const { hub, clock } = makeHub();
  const t0 = clock.t;
  await send(hub, { t: 'queueAdd', step: step(100) });
  await send(hub, { t: 'queueAdd', step: { onTap: true, patch: { patient: { hr: 120 } }, glideMs: 0 } });
  await send(hub, { t: 'queueAdd', step: step(140) });
  let r = await send(hub, { t: 'queueMove', i: 1, dir: 1 });
  assert.deepEqual(r.broadcast.state.scenario.q.map((x) => x.patch.patient.hr), [100, 140, 120]);
  r = await send(hub, { t: 'queueMove', i: 0, dir: 1 });
  assert.deepEqual(r.broadcast.state.scenario.q.map((x) => x.patch.patient.hr), [140, 100, 120]);
  r = await send(hub, { t: 'queueRemove', i: 0 });
  assert.deepEqual(r.broadcast.state.scenario.q.map((x) => x.patch.patient.hr), [100, 120]);
  assert.equal(r.broadcast.state.scenario.nextAt, t0 + 10000);
  clock.t = t0 + 10000;
  await hub.onAlarm();
  r = await send(hub, { t: 'queueMove', i: 0, dir: 1 });
  assert.equal(r.reply.code, 'bad_patch', 'a step that has run cannot be moved');
  r = await send(hub, { t: 'queueRemove', i: 1 });
  assert.equal(r.broadcast.state.scenario.done, true, 'skipping the last step ends the queue');
});

test('queue: a running scenario needs replace; stop clears the queue', async () => {
  const { hub } = makeHub();
  const sc = { name: 'S', steps: [{ onTap: true, patch: { patient: { hr: 90 } }, glideMs: 0 }] };
  await send(hub, { t: 'scenarioStart', scenario: sc });
  let r = await send(hub, { t: 'queueAdd', step: step(100) });
  assert.equal(r.reply.code, 'bad_patch');
  r = await send(hub, { t: 'queueAdd', step: step(100), replace: true });
  assert.equal(r.broadcast.state.scenario.queue, true);
  r = await send(hub, { t: 'scenarioStop' });
  assert.equal(r.broadcast.state.scenario, undefined);
  assert.equal((await send(hub, { t: 'queueMove', i: 0, dir: 1 })).reply.code, 'bad_patch');
  assert.equal((await send(hub, { t: 'queueAdd', step: { patch: {} } })).reply.code, 'bad_patch');
});

test('tempo 2x halves the time left of the glide and of the next step', async () => {
  const { hub, clock } = makeHub();
  const t0 = clock.t;
  await send(hub, { t: 'set', patch: { patient: { hr: 135 } }, glideMs: 40000 });
  await send(hub, { t: 'queueAdd', step: step(100, { atSec: 100 }) });
  clock.t = t0 + 20000;
  const before = await shown(hub, clock.t);
  const r = await send(hub, { t: 'tempo', x: 2 });
  const s = r.broadcast.state;
  assert.equal(s.scenario.tempo, 2);
  assert.ok(Math.abs(displayed(s.patients[0], clock.t).hr - before.hr) < 1e-9, 'rescales from the value shown');
  assert.equal(s.patients[0].glide.durationMs, 10000, '20 s left becomes 10 s');
  assert.equal(s.scenario.nextAt, clock.t + (t0 + 100000 - clock.t) / 2);
  assert.equal(displayed(s.patients[0], clock.t + 10000).hr, 135);
  // 1x puts the pace back for what is left
  const r2 = await send(hub, { t: 'tempo', x: 1 });
  assert.equal(r2.broadcast.state.scenario.tempo, undefined);
  assert.equal(r2.broadcast.state.scenario.nextAt, r.broadcast.state.scenario.nextAt + (r.broadcast.state.scenario.nextAt - clock.t));
});

test('tempo 0.5x on a lone glide doubles the time left; a new queue starts at 1x', async () => {
  const { hub, clock } = makeHub();
  await send(hub, { t: 'set', patch: { patient: { hr: 135 } }, glideMs: 40000 });
  const r = await send(hub, { t: 'tempo', x: 0.5 });
  assert.equal(r.broadcast.state.patients[0].glide.durationMs, 80000);
  assert.equal(r.broadcast.state.scenario, undefined);
  await send(hub, { t: 'tempo', x: 2 });
  clock.t += 1000;
  const q = await send(hub, { t: 'queueAdd', step: { atSec: 0, patch: { patient: { hr: 60 } }, glideMs: 20000 } });
  assert.equal(q.broadcast.state.patients[0].glide.durationMs, 20000, 'a new queue starts at 1x');
});

test('finish now lands the glide and runs the rest of a queue at once', async () => {
  const { hub, clock } = makeHub();
  await send(hub, { t: 'queueAdd', step: step(100, { glideMs: 30000, glideMsBy: { spo2: 90000 } }) });
  await send(hub, { t: 'queueAdd', step: step(120, { patch: { patient: { hr: 120, spo2: 90 } } }) });
  clock.t += 10000;
  await hub.onAlarm();
  const r = await send(hub, { t: 'tempo', x: 'finish' });
  const s = r.broadcast.state;
  assert.equal(s.scenario.done, true);
  assert.equal(s.patients[0].hr, 120);
  assert.equal(displayed(s.patients[0], clock.t).hr, 120);
  assert.equal(displayed(s.patients[0], clock.t).spo2, 90);
  assert.equal(s.patients[0].glide.durationMs, 0);
  // and on a lone glide
  await send(hub, { t: 'set', patch: { patient: { hr: 60 } }, glideMs: 60000 });
  const r2 = await send(hub, { t: 'tempo', x: 'finish' });
  assert.equal(displayed(r2.broadcast.state.patients[0], clock.t).hr, 60);
  assert.equal((await send(hub, { t: 'tempo', x: 3 })).reply.code, 'bad_patch');
});

test('tempo while paused keeps the paused wait in proportion', async () => {
  const { hub, clock } = makeHub();
  const t0 = clock.t;
  await send(hub, { t: 'queueAdd', step: step(100, { atSec: 100 }) });
  clock.t = t0 + 40000;
  await send(hub, { t: 'scenarioPause' });
  await send(hub, { t: 'tempo', x: 2 });
  clock.t = t0 + 90000;
  const r = await send(hub, { t: 'scenarioResume' });
  assert.equal(r.broadcast.state.scenario.nextAt, clock.t + 30000, '60 s left at pause, halved');
});

test('old rooms: a glide record without glideMsBy still evaluates', async () => {
  const { hub } = makeHub();
  const s = await hub.state();
  assert.equal('glideMsBy' in s.patients[0].glide, false);
  assert.equal(displayed(s.patients[0], 0).hr, s.patients[0].hr);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHub, msg } from './fake.mjs';
import { IDLE_MS } from '../src/room/hub.js';
import { drugPatch, validateDrug, validateLibraryFile, validateScenario } from '../src/shared/scenario.js';
import { BUILTIN_DRUGS, BUILTIN_SCENARIOS } from '../src/controller/library.js';

const three = {
  name: 'Three steps',
  steps: [
    { atSec: 0, patch: { patient: { hr: 100 } }, glideMs: 5000 },
    { atSec: 30, patch: { patient: { hr: 120 } }, glideMs: 5000 },
    { atSec: 30, patch: { patient: { hr: 140 } }, glideMs: 0 },
  ],
};
const start = (hub, scenario = three, extra = {}) => hub.onMessage('c-1', msg({ t: 'scenarioStart', scenario, ...extra }));
const run = async (hub) => (await hub.state()).scenario;

test('a 3-step scenario runs on the alarm with nobody connected', async () => {
  const { hub, storage, clock } = makeHub();
  const t0 = clock.t;
  const r = await start(hub);
  assert.equal(r.broadcast.state.patients[0].hr, 100, 'step 1 at 0 s runs at once');
  assert.equal(r.broadcast.state.scenario.step, 1);
  assert.equal(storage.alarm, t0 + 30000, 'the alarm is set to the next step, before the idle expiry');
  clock.t = t0 + 30000;
  let a = await hub.onAlarm();
  assert.equal(a.broadcast.state.patients[0].hr, 120);
  assert.equal(a.broadcast.state.scenario.step, 2);
  assert.equal(storage.alarm, t0 + 60000);
  clock.t = t0 + 60000;
  a = await hub.onAlarm();
  assert.equal(a.broadcast.state.patients[0].hr, 140);
  assert.equal(a.broadcast.state.scenario.done, true);
  assert.equal(storage.alarm, clock.t + IDLE_MS, 'back to idle expiry only');
  assert.deepEqual(a.broadcast.state.events.filter((e) => e.kind === 'scenario').map((e) => e.what), ['start Three steps (step 1/3)', 'step 2/3', 'step 3/3 done']);
});

test('a late alarm catches up in order and keeps the timing', async () => {
  const { hub, storage, clock } = makeHub();
  const t0 = clock.t;
  await start(hub);
  clock.t = t0 + 75000; // both steps are due
  const a = await hub.onAlarm();
  assert.equal(a.broadcast.state.patients[0].hr, 140);
  assert.equal(a.broadcast.state.scenario.done, true);
  assert.match(a.broadcast.state.events.at(-1).what, /2 due/);
  assert.ok(storage.alarm > clock.t);
});

test('an alarm that fires early does nothing and re-arms', async () => {
  const { hub, storage, clock } = makeHub();
  const t0 = clock.t;
  await start(hub);
  clock.t = t0 + 29000;
  const a = await hub.onAlarm();
  assert.equal(a.broadcast, undefined);
  assert.equal(storage.alarm, t0 + 30000);
});

test('pause holds the countdown, resume continues with the time that was left', async () => {
  const { hub, storage, clock } = makeHub();
  const t0 = clock.t;
  await start(hub);
  clock.t = t0 + 10000;
  const p = await hub.onMessage('c-1', msg({ t: 'scenarioPause' }));
  assert.equal(p.broadcast.state.scenario.pausedAt, t0 + 10000);
  assert.equal(storage.alarm, t0 + 10000 + IDLE_MS, 'a paused scenario sets no step alarm');
  clock.t = t0 + 100000;
  assert.equal((await hub.onAlarm()).broadcast, undefined, 'nothing runs while paused');
  const r = await hub.onMessage('c-1', msg({ t: 'scenarioResume' }));
  assert.equal(r.broadcast.state.scenario.nextAt, t0 + 120000, '20 s were left at the pause');
  assert.equal(r.broadcast.state.scenario.pausedAt, 0);
  assert.equal(storage.alarm, t0 + 120000);
});

test('skip runs the next step now and times the one after from now', async () => {
  const { hub, clock } = makeHub();
  const t0 = clock.t;
  await start(hub);
  clock.t = t0 + 5000;
  const r = await hub.onMessage('c-1', msg({ t: 'scenarioNext' }));
  assert.equal(r.broadcast.state.patients[0].hr, 120);
  assert.equal(r.broadcast.state.scenario.step, 2);
  assert.equal(r.broadcast.state.scenario.nextAt, t0 + 35000);
  const end = await hub.onMessage('c-1', msg({ t: 'scenarioNext' }));
  assert.equal(end.broadcast.state.scenario.done, true);
  assert.equal(end.broadcast.state.patients[0].hr, 140);
  assert.equal((await hub.onMessage('c-1', msg({ t: 'scenarioNext' }))).reply.code, 'bad_patch', 'nothing left to run');
});

test('a tap step waits with no alarm until it is advanced', async () => {
  const { hub, storage, clock } = makeHub();
  const sc = { name: 'Tap', steps: [{ atSec: 0, patch: { patient: { hr: 90 } } }, { onTap: true, patch: { patient: { spo2: 80 } }, glideMs: 10000 }, { atSec: 10, patch: { patient: { spo2: 70 } } }] };
  const r = await start(hub, sc);
  assert.equal(r.broadcast.state.scenario.waiting, true);
  assert.equal(r.broadcast.state.scenario.nextAt, 0);
  assert.equal(storage.alarm, clock.t + IDLE_MS);
  clock.t += 600000;
  assert.equal((await hub.onAlarm()).broadcast, undefined);
  const n = await hub.onMessage('c-1', msg({ t: 'scenarioNext' }));
  assert.equal(n.broadcast.state.patients[0].spo2, 80);
  assert.equal(n.broadcast.state.scenario.nextAt, clock.t + 10000);
  assert.equal(storage.alarm, clock.t + 10000);
});

test('stop, replace, and a removed bed end the scenario', async () => {
  const { hub } = makeHub();
  await start(hub);
  assert.equal((await hub.onMessage('c-1', msg({ t: 'scenarioStop' }))).broadcast.state.scenario, undefined);
  assert.equal((await hub.onMessage('c-1', msg({ t: 'scenarioStop' }))).reply.code, 'bad_patch', 'none is running');
  await hub.onMessage('c-1', msg({ t: 'addPatient' }));
  await start(hub, three, { p: 'p2' });
  assert.equal((await run(hub)).p, 'p2');
  await start(hub, { name: 'Other', steps: [{ onTap: true, patch: { patient: { hr: 70 } } }] });
  assert.equal((await run(hub)).name, 'Other', 'a new start replaces the running one');
  await hub.onMessage('c-1', msg({ t: 'removePatient', p: 'p1' }));
  assert.equal(await run(hub), undefined);
});

test('the scenario survives a wake: a new hub on the same storage keeps running it', async () => {
  const { hub, storage, clock } = makeHub();
  const t0 = clock.t;
  await start(hub);
  const { RoomHub } = await import('../src/room/hub.js');
  const woke = new RoomHub(storage, () => clock.t);
  clock.t = t0 + 30000;
  assert.equal((await woke.onAlarm()).broadcast.state.patients[0].hr, 120);
});

test('bad scenarios are refused with a reason and change nothing', async () => {
  const { hub } = makeHub();
  const cases = [
    [{ name: '', steps: three.steps }, /name/],
    [{ name: 'x', steps: [] }, /at least one step/],
    [{ name: 'x', steps: [{ atSec: -1, patch: { patient: { hr: 1 } } }] }, /atSec/],
    [{ name: 'x', steps: [{ atSec: 1, onTap: true, patch: { patient: { hr: 1 } } }] }, /not both/],
    [{ name: 'x', steps: [{ atSec: 1, patch: { theme: 'custom' } }] }, /only change patient and alarms/],
    [{ name: 'x', steps: [{ atSec: 1, patch: { patient: { hr: 9999 } } }] }, /hr out of range/],
    [{ name: 'x', steps: [{ atSec: 1, patch: {} }] }, /non-empty/],
    [{ name: 'x', steps: Array(31).fill({ atSec: 1, patch: { patient: { hr: 70 } } }) }, /more than 30/],
  ];
  for (const [sc, re] of cases) {
    const r = await start(hub, sc);
    assert.equal(r.reply.code, 'bad_patch');
    assert.match(r.reply.msg, re);
  }
  assert.equal((await start(hub, three, { p: 'p9' })).reply.msg, 'unknown patient');
  const st = await hub.state();
  assert.equal(st.rev, 0);
  assert.equal(st.scenario, undefined);
});

test('drug: a relative change to the targets with a glide, clamped to the range', async () => {
  const { hub, clock } = makeHub();
  await hub.onMessage('c-1', msg({ t: 'set', patch: { patient: { hr: 100, nibp: { sys: 120, dia: 70 }, spo2: 99 } } }));
  const drug = { name: 'Test drug', glideMs: 15000, effects: { hr: { mul: 0.8 }, nibp: { sys: { add: -30 }, dia: { add: -20 } }, spo2: { add: 5 } } };
  clock.t += 1000;
  const r = await hub.onMessage('c-1', msg({ t: 'drug', drug }));
  const pt = r.broadcast.state.patients[0];
  assert.equal(pt.hr, 80);
  assert.deepEqual(pt.nibp, { sys: 90, dia: 50 });
  assert.equal(pt.spo2, 100, 'clamped to 100');
  assert.equal(pt.glide.durationMs, 15000);
  assert.equal(pt.glide.startedAt, clock.t);
  assert.equal(r.broadcast.state.events.at(-1).kind, 'drug');
  clock.t += 1000;
  const again = await hub.onMessage('c-1', msg({ t: 'drug', drug }));
  assert.equal(again.broadcast.state.patients[0].hr, 64, 'a second press stacks on the target');
});

test('bad drugs are refused with a reason', async () => {
  const { hub } = makeHub();
  for (const [drug, re] of [
    [{ name: 'x', effects: {} }, /non-empty/],
    [{ name: 'x', effects: { hr: { mul: 9 } } }, /mul must be 0-5/],
    [{ name: 'x', effects: { hr: { mul: 1, foo: 1 } } }, /unknown field/],
    [{ name: 'x', effects: { rhythm: { add: 1 } } }, /unknown effect/],
    [{ name: 'x', effects: { nibp: { map: { add: 1 } } } }, /unknown field nibp/],
    [{ name: 'x', glideMs: -1, effects: { hr: { add: 1 } } }, /glideMs/],
  ]) {
    const r = await hub.onMessage('c-1', msg({ t: 'drug', drug }));
    assert.equal(r.reply.code, 'bad_patch');
    assert.match(r.reply.msg, re);
  }
  assert.equal((await hub.state()).rev, 0);
});

test('drugPatch clamps and rounds', () => {
  const p = { hr: 3, temp: 36.8, cvp: 8, bis: 95, nibp: { sys: 10, dia: 5 } };
  assert.deepEqual(drugPatch(p, { hr: { add: -10 }, temp: { add: 0.34 }, cvp: { add: 0.7 }, bis: { add: -40.4 }, nibp: { sys: { mul: 0.5 } } }), { hr: 0, temp: 37.1, cvp: 8.5, bis: 55, nibp: { sys: 5 } });
});

test('library files: valid, and refused whole with a reason', () => {
  const ok = JSON.stringify({ sim: 'library', version: 1, scenarios: [three], drugs: [BUILTIN_DRUGS[0]] });
  const v = validateLibraryFile(ok);
  assert.ok(v.ok);
  assert.equal(v.scenarios.length, 1);
  const refused = (text, re) => { const r = validateLibraryFile(text); assert.equal(r.ok, false); assert.match(r.msg, re); };
  refused('nope', /not valid JSON/);
  refused('[]', /not a library file/);
  refused(JSON.stringify({ sim: 'library', version: 2, scenarios: [three] }), /unsupported version 2/);
  refused(JSON.stringify({ sim: 'library', version: 1 }), /no scenarios or drugs/);
  refused(JSON.stringify({ sim: 'library', version: 1, scenarios: [three, { ...three, steps: [{ atSec: 1, patch: { patient: { hr: -5 } } }] }] }), /hr out of range/);
  refused(JSON.stringify({ sim: 'library', version: 1, scenarios: [three, three] }), /two scenarios are named/);
  refused(JSON.stringify({ sim: 'library', version: 1, scenarios: [three], pad: 'x'.repeat(33000) }), /over 32 KB/);
});

test('built-in scenarios and drugs are valid and synthetic', () => {
  assert.equal(BUILTIN_SCENARIOS.length, 3);
  for (const s of BUILTIN_SCENARIOS) assert.ok(validateScenario(s).ok, s.name);
  for (const d of BUILTIN_DRUGS) {
    const v = validateDrug(d);
    assert.ok(v.ok, d.name);
    assert.ok(d.note, 'labelled with its teaching effect');
    assert.ok(!/\d+\s*(mg|mcg|ml|µg)/i.test(JSON.stringify(d)), 'no doses');
  }
});

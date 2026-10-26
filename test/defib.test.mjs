import test from 'node:test';
import assert from 'node:assert/strict';
import { BeatScheduler } from '../src/engine/beats.js';
import { shockEcg, shockPleth, SHOCK_SHOW } from '../src/waves/defib.js';
import { ecgSample } from '../src/waves/shapes.js';
import { createWaveRegistry, registerBuiltinWaves } from '../src/waves/index.js';
import { DefibModel, ENERGY_STEPS } from '../src/defib/model.js';
import { defaultPatient, validatePatch } from '../src/shared/schema.js';
import { makeHub, msg } from './fake.mjs';

const state = async (hub) => (await hub.onMessage('c-1', msg({ t: 'hello' }))).reply.state;
const shockReply = async (hub, o) => hub.onMessage('c-1', msg({ t: 'shock', ...o }));

test('hub: a shock logs one event and applies the postShock rhythm', async () => {
  const { hub } = makeHub();
  await hub.onMessage('c-1', msg({ t: 'set', patch: { patient: { rhythm: 'vf', postShock: 'sinus' } } }));
  const r = await shockReply(hub, { energy: 150, sync: false });
  assert.ok(r.broadcast, JSON.stringify(r));
  const s = await state(hub);
  const ev = s.events.at(-1);
  assert.equal(ev.kind, 'shock');
  assert.equal(ev.what, '150J');
  assert.equal(ev.p, 'p1');
  assert.equal(s.patients[0].rhythm, 'sinus');
});

test('hub: postShock defaults to no change; sync is in the log', async () => {
  const { hub } = makeHub();
  await hub.onMessage('c-1', msg({ t: 'set', patch: { patient: { rhythm: 'vt' } } }));
  assert.equal((await state(hub)).patients[0].postShock, 'none');
  await shockReply(hub, { energy: 100, sync: true });
  const s = await state(hub);
  assert.equal(s.patients[0].rhythm, 'vt');
  assert.equal(s.events.at(-1).what, '100J sync');
});

test('hub: pads off blocks the shock, nothing changes', async () => {
  const { hub } = makeHub();
  await hub.onMessage('c-1', msg({ t: 'set', patch: { patient: { rhythm: 'vf', postShock: 'sinus', off: { pads: true } } } }));
  const before = await state(hub);
  const r = await shockReply(hub, { energy: 200 });
  assert.equal(r.reply.t, 'error');
  assert.match(r.reply.msg, /pads/);
  const after = await state(hub);
  assert.equal(after.rev, before.rev);
  assert.equal(after.patients[0].rhythm, 'vf');
});

test('hub: bad energy and unknown bed are refused', async () => {
  const { hub } = makeHub();
  for (const o of [{ energy: 0 }, { energy: 361 }, { energy: 1.5 }, { energy: '150' }, {}, { energy: 150, p: 'p9' }]) {
    assert.equal((await shockReply(hub, o)).reply.t, 'error', JSON.stringify(o));
  }
});

test('schema: postShock and off.pads are checked; kind of a screen can be changed', async () => {
  assert.equal(validatePatch({ patient: { postShock: 'sinus', off: { pads: true } } }).ok, true);
  assert.equal(validatePatch({ patient: { postShock: 'nope' } }).ok, false);
  assert.equal(defaultPatient('p1', 'Bed 1', 0).postShock, 'none');
  const { hub } = makeHub();
  await hub.onMessage('m-1', msg({ t: 'addScreen', name: 'Defib' }));
  await hub.onMessage('c-1', msg({ t: 'set', patch: { screens: { s1: { kind: 'defib' } } } }));
  assert.equal((await state(hub)).screens.s1.kind, 'defib');
  const bad = await hub.onMessage('c-1', msg({ t: 'set', patch: { screens: { s1: { kind: 'x' } } } }));
  assert.equal(bad.reply.t, 'error');
});

test('shock artefact: a spike on the ECG and pleth, then the normal trace returns', () => {
  const src = { shock: 10 };
  assert.equal(shockEcg({}, 10), null);
  assert.equal(shockEcg(src, 9.9), null);
  assert.ok(Math.abs(shockEcg(src, 10.01)) > 2);
  assert.ok(shockEcg(src, 10.5) !== null && shockPleth(src, 10.5) !== null);
  assert.equal(shockEcg(src, 10 + SHOCK_SHOW + 0.01), null);
  assert.equal(shockPleth(src, 10 + SHOCK_SHOW + 0.01), null);
  const reg = createWaveRegistry();
  registerBuiltinWaves(reg);
  const beats = new BeatScheduler(3);
  for (let t = 0; t <= 20; t += 0.1) beats.advance(t, { rhythm: 'sinus', hr: 60, flutterRatio: 2, pvcPerMin: 0, st: 0, pulse: true, sbp: 120, dbp: 80, rr: 14 });
  const w = { beats: beats.beats, base: beats.base, breaths: [], shock: 12 };
  const ecg = reg.get('ecg');
  assert.equal(ecg.sample(w, 12.01, { patient: defaultPatient('p1', 'B', 0), perfusing: true, tSec: 12 }), shockEcg(w, 12.01));
  assert.equal(ecg.sample(w, 15, { patient: defaultPatient('p1', 'B', 0), perfusing: true, tSec: 15 }), ecgSample(w, 15));
});

test('defib model: energy, charge, ready, disarm', () => {
  const m = new DefibModel({ chargeMs: 1000, disarmMs: 5000 });
  assert.equal(m.energy, 150);
  m.step(1);
  assert.equal(m.energy, 170);
  m.step(-1); m.step(-1);
  assert.equal(m.energy, 120);
  m.energy = 360; m.step(1);
  assert.equal(m.energy, 360);
  assert.ok(ENERGY_STEPS.includes(m.energy));
  assert.equal(m.press(0, false), 'no'); // not charged
  m.charge(0);
  assert.equal(m.phase, 'charging');
  assert.equal(m.press(500, false), 'no');
  m.tick(1000, false);
  assert.equal(m.phase, 'ready');
  m.step(-1); // changing energy disarms
  assert.equal(m.phase, 'idle');
  m.charge(2000); m.tick(3000, false);
  m.tick(3000 + 5000, false);
  assert.equal(m.phase, 'idle');
  assert.match(m.msg, /Disarmed/);
});

test('defib model: pads off blocks; sync waits for an R wave or times out', () => {
  const m = new DefibModel({ chargeMs: 10, syncWaitMs: 1000, disarmMs: 60000 });
  m.charge(0); m.tick(20, false);
  assert.equal(m.press(30, true), 'no');
  assert.equal(m.phase, 'ready');
  assert.match(m.msg, /Pads off/);
  assert.equal(m.press(40, false), 'send');
  m.setSync(true);
  assert.equal(m.press(50, false), 'wait');
  assert.equal(m.tick(60, false), null);
  assert.equal(m.tick(70, true), 'send');
  m.delivered();
  assert.equal(m.phase, 'idle');
  m.charge(100); m.tick(120, false);
  m.press(130, false);
  m.tick(130 + 1000, false);
  assert.equal(m.waitingSince, 0);
  assert.match(m.msg, /No R wave/);
  assert.equal(m.phase, 'ready');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { macAt, macFraction, MAC40 } from '../src/engine/gas.js';
import { BreathScheduler } from '../src/engine/breaths.js';
import { gasSample } from '../src/waves/lines.js';
import { evaluateAlarms } from '../src/engine/alarms.js';
import { displayed } from '../src/engine/glide.js';
import { defaultPatient, defaultState, fillDefaults, validatePatch } from '../src/shared/schema.js';
import { paramList, buildPatch, hasModule, LIMIT_PARAMS, DEFAULT_UNITS } from '../src/controller/params.js';
import { groupsFor } from '../src/trends/series.js';
import { makeHub, msg } from './fake.mjs';

const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test('MAC: values at age 40 and about 6 % less per decade (Nickalls and Mapleson 2003)', () => {
  near(macAt('sevo', 40), 1.8);
  near(macAt('des', 40), 6.6);
  near(macAt('iso', 40), 1.17);
  near(macAt('n2o', 40), 104);
  near(macAt('sevo', 80), 1.8 * 10 ** (-0.00269 * 40), 1e-9);
  assert.ok(macAt('sevo', 80) < macAt('sevo', 40) && macAt('sevo', 0) > macAt('sevo', 40));
  near(macAt('iso', 50) / macAt('iso', 40), 0.94, 0.005);
  near(macAt('sevo', NaN), MAC40.sevo);
  near(macAt('sevo', 500), macAt('sevo', 110), 1e-9);
});

test('MAC fraction adds the agent and nitrous oxide, and follows age', () => {
  const young = { agent: 'sevo', age: 40 };
  near(macFraction(young, 1.8, 0), 1);
  near(macFraction(young, 0.9, 52), 1);
  assert.ok(macFraction({ agent: 'sevo', age: 80 }, 1.8, 0) > 1.2);
  near(macFraction({ agent: 'none', age: 40 }, 3, 0), 0);
});

test('gas waves: inspired baseline, expired plateau, flat when off the breath', () => {
  const b = new BreathScheduler(5);
  const gas = { fio2: 40, eto2: 35, fiag: 0.5, etag: 2 };
  for (let t = 0; t <= 20; t += 0.1) b.advance(t, { rr: 14, ie: 2, etco2: 38, shape: 'normal', gas });
  const src = { breaths: b.breaths };
  const a = [];
  for (let t = 8; t < 16; t += 0.01) a.push(gasSample(src, t, 'agent'));
  assert.ok(Math.max(...a) > 1.8 && Math.max(...a) <= 2.05, String(Math.max(...a)));
  assert.ok(Math.min(...a) >= 0.45 && Math.min(...a) < 0.7, String(Math.min(...a)));
  const o = [];
  for (let t = 8; t < 16; t += 0.01) o.push(gasSample(src, t, 'o2'));
  assert.ok(Math.min(...o) >= 34 && Math.max(...o) <= 41);
  assert.equal(gasSample({ breaths: [] }, 3, 'o2'), 0);
  // the scheduler stops: the trace holds the inspired level
  assert.equal(gasSample(src, 200, 'agent'), 0.5);
});

test('alarms: FiO2 and Et agent need their modules; hypoxic mixture is high; agent limit is in MAC', () => {
  const s = defaultState(0);
  const p = { ...defaultPatient('p1', 'Bed 1', 0), agent: 'sevo' };
  const v = { hr: 80, spo2: 98, etco2: 38, rr: 14, temp: 36.8, nibpSys: 120, abpSys: 120, fio2: 15, etagMac: 2 };
  assert.ok(!evaluateAlarms(p, s, v, 0).some((a) => a.param === 'fio2' || a.param === 'etagent'));
  s.modules = [...s.modules, 'gas'];
  const hi = evaluateAlarms(p, s, v, 0);
  assert.ok(hi.some((a) => a.id === 'fio2-hypoxic' && a.priority === 3));
  assert.ok(hi.some((a) => a.id === 'etagent-high'));
  const ok = evaluateAlarms(p, s, { ...v, fio2: 40, etagMac: 1 }, 0);
  assert.ok(!ok.some((a) => a.param === 'fio2' || a.param === 'etagent'));
  assert.ok(evaluateAlarms(p, s, { ...v, fio2: 40, etagMac: 0.3 }, 0).some((a) => a.id === 'etagent-low'));
  assert.ok(evaluateAlarms(p, s, { ...v, fio2: 25, etagMac: 1 }, 0).some((a) => a.id === 'fio2-low'));
  // no agent in use: no agent alarm; O2 alone follows only FiO2
  assert.ok(!evaluateAlarms({ ...p, agent: 'none' }, s, { ...v, fio2: 40, etagMac: 0 }, 0).some((a) => a.param === 'etagent'));
  s.modules = ['ecg', 'o2'];
  assert.ok(!evaluateAlarms(p, s, { ...v, fio2: 40, etagMac: 3 }, 0).some((a) => a.param === 'etagent'));
  p.off.gas = true;
  assert.ok(evaluateAlarms(p, s, v, 0).some((a) => a.id === 'gas-off'));
});

test('glide: Et agent glides between targets like the other numerics', () => {
  const p = defaultPatient('p1', 'Bed 1', 0);
  p.glide = { startedAt: 0, durationMs: 10000, from: { ...displayed(p, 0), etag: 0 } };
  p.etag = 2;
  near(displayed(p, 5000).etag, 1);
  near(displayed(p, 10000).etag, 2);
});

test('validatePatch: agent, age, gas numbers and tof', () => {
  assert.ok(validatePatch({ patient: { agent: 'des', age: 70, etag: 5.46, fiag: 6, fio2: 60.4 } }).ok);
  const r = validatePatch({ patient: { etag: 5.46, fio2: 60.4, age: 70.4 } });
  assert.equal(r.ok && r.patch.patient.etag, 5.5);
  assert.equal(r.ok && r.patch.patient.fio2, 60);
  assert.equal(r.ok && r.patch.patient.age, 70);
  assert.ok(!validatePatch({ patient: { agent: 'xenon' } }).ok);
  assert.ok(!validatePatch({ patient: { age: 120 } }).ok);
  assert.ok(!validatePatch({ patient: { etag: 30 } }).ok);
  assert.ok(validatePatch({ tof: { mode: 'cycle', cycleSec: 30 } }).ok);
  assert.ok(!validatePatch({ tof: { mode: 'sometimes' } }).ok);
  assert.ok(!validatePatch({ tof: { cycleSec: 99999 } }).ok);
  assert.ok(!validatePatch({ tof: { count: 2 } }).ok);
});

test('fillDefaults: a state from before gas gets the new fields, off and with no agent', () => {
  const s = defaultState(0);
  const p = s.patients[0];
  for (const k of ['fio2', 'eto2', 'fiag', 'etag', 'fin2o', 'etn2o']) delete p.glide.from[k];
  for (const k of ['age', 'agent', 'tofCount', 'tofRatio', 'tofRead']) delete p[k];
  delete p.off.gas;
  delete s.alarms.limits.fio2;
  delete s.alarms.limits.etagent;
  fillDefaults(s);
  assert.equal(p.agent, 'none');
  assert.equal(p.age, 40);
  assert.equal(p.off.gas, false);
  assert.equal(p.tofRead.count, 4);
  assert.equal(p.glide.from.etag, p.etag);
  assert.deepEqual(s.alarms.limits.etagent, [0.7, 1.5]);
  assert.ok(!s.modules.includes('gas') && !s.modules.includes('tof'));
});

test('hub: tof stamps the reading, stale "after" is ignored, interval patch sticks', async () => {
  const { hub, clock } = makeHub();
  await hub.onMessage('c-1', msg({ t: 'set', patch: { patient: { tofCount: 1, tofRatio: 0 } }, glideMs: 0 }));
  clock.t += 5;
  const r = await hub.onMessage('c-1', msg({ t: 'tof' }));
  const pt = r.broadcast.state.patients[0];
  assert.equal(pt.tofRead.count, 1);
  assert.equal(pt.tofRead.at, clock.t);
  assert.equal(r.broadcast.state.events.at(-1).kind, 'tof');
  const old = await hub.onMessage('c-2', msg({ t: 'tof', after: 1 }));
  assert.ok(!old.broadcast);
  const c = await hub.onMessage('c-1', msg({ t: 'set', patch: { tof: { mode: 'cycle', cycleSec: 60 } } }));
  assert.deepEqual([c.broadcast.state.patients[0].tofRead.mode, c.broadcast.state.patients[0].tofRead.cycleSec], ['cycle', 60]);
});

test('controller: gas rows follow the modules; Et agent limit is limit-only and never patched', () => {
  assert.ok(hasModule('gas|o2', ['o2']) && hasModule('gas|o2', ['gas']) && !hasModule('gas|o2', ['ecg']) && hasModule(undefined, []));
  const specs = paramList(DEFAULT_UNITS);
  const mac = specs.find((x) => x.id === 'etagMac');
  assert.ok(mac?.limitOnly);
  assert.ok(LIMIT_PARAMS.find((l) => l.name === 'etagent' && l.spec === 'etagMac'));
  const p = defaultPatient('p1', 'Bed 1', 0);
  assert.equal(buildPatch({ etagMac: 2 }, p, DEFAULT_UNITS), null);
  assert.deepEqual(buildPatch({ etag: 2.1, age: 70 }, p, DEFAULT_UNITS), { patient: { etag: 2.1, age: 70 } });
});

test('trends: gas groups appear with their modules', () => {
  const ids = (m) => groupsFor(m).map((g) => g.id);
  assert.ok(!ids(['ecg']).includes('agent') && !ids(['ecg']).includes('fio2'));
  assert.ok(ids(['o2']).includes('fio2') && !ids(['o2']).includes('agent'));
  assert.ok(ids(['gas']).includes('fio2') && ids(['gas']).includes('agent'));
});

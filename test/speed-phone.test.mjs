import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SPEEDS, customMs, customParts, speedLabel, spo2Speed, speedFor, timingFor, changedFields, stepSummary } from '../src/controller/speed.js';

test('speed labels and custom times', () => {
  assert.deepEqual(SPEEDS.map(speedLabel), ['Instant', '5 s', '10 s', '30 s', '1 min', '2 min', '3 min', '5 min']);
  assert.equal(customMs(90, 's'), 90000);
  assert.equal(customMs(2.5, 'min'), 150000);
  assert.equal(customMs(99, 'min'), 600000, 'clamped to 10 min');
  assert.equal(customMs(-3, 's'), 0);
  assert.equal(customMs(NaN, 's'), 0);
  assert.deepEqual(customParts(150000), { n: 150, unit: 's' });
  assert.deepEqual(customParts(180000), { n: 3, unit: 'min' });
});

test('SpO2 starts at 3x the speed, at least 30 s, at most 10 min', () => {
  assert.equal(spo2Speed(10000), 30000);
  assert.equal(spo2Speed(30000), 90000);
  assert.equal(spo2Speed(0), 0, 'Instant stays instant');
  assert.equal(spo2Speed(5000), 30000);
  assert.equal(spo2Speed(300000), 600000);
});

test('a rising SpO2 recovers at the base speed, 3x faster than it falls', () => {
  assert.equal(spo2Speed(10000, true), 10000);
  assert.equal(spo2Speed(0, true), 0);
  const pt = { spo2: 85 };
  assert.deepEqual(timingFor({ patient: { hr: 80, spo2: 98 } }, 30000, {}, pt), { glideMs: 30000 }, 'rising: no slower SpO2');
  assert.deepEqual(timingFor({ patient: { spo2: 70 } }, 30000, {}, pt), { glideMs: 30000, glideMsBy: { spo2: 90000 } }, 'falling: 3x');
  assert.deepEqual(timingFor({ patient: { spo2: 98 } }, 30000, { spo2: 60000 }, pt), { glideMs: 30000, glideMsBy: { spo2: 60000 } }, 'an own speed wins');
});

test('timingFor lists only fields that differ from the base speed', () => {
  const patch = { patient: { hr: 100, spo2: 90 } };
  assert.deepEqual(timingFor(patch, 30000), { glideMs: 30000, glideMsBy: { spo2: 90000 } });
  assert.deepEqual(timingFor({ patient: { hr: 100 } }, 30000), { glideMs: 30000 });
  assert.deepEqual(timingFor(patch, 30000, { hr: 5000, spo2: 30000 }), { glideMs: 30000, glideMsBy: { hr: 5000 } });
  assert.equal(speedFor('rr', 10000, { rr: 0 }), 0, 'an own Instant wins');
  assert.deepEqual(changedFields({ patient: { nibp: { sys: 1 }, rhythm: 'af' } }), ['nibp']);
  assert.deepEqual(changedFields(null), []);
});

test('stepSummary names the values', () => {
  assert.equal(stepSummary({ patch: { patient: { hr: 120, nibp: { sys: 80, dia: 40 } } } }), 'HR 120, NIBP 80/40');
});

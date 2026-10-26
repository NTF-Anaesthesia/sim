import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODE_ALPHABET, defaultState, isCode, newCode, normalizeCode, validatePatch } from '../src/shared/schema.js';

test('codes: 6 chars, no look-alikes, case-insensitive input', () => {
  for (let i = 0; i < 200; i++) assert.ok(isCode(newCode()));
  assert.ok(!/[01OIL]/.test(CODE_ALPHABET));
  assert.equal(normalizeCode(' abc234 '), 'ABC234');
  assert.ok(!isCode('ABC23'));
  assert.ok(!isCode('ABC0OI'));
});

test('default state matches the design defaults', () => {
  const s = defaultState(5);
  assert.equal(s.schema, 1);
  assert.deepEqual(s.modules, ['ecg', 'spo2', 'etco2', 'nibp', 'rr', 'temp']);
  assert.ok(!s.modules.includes('abp'), 'art line is off by default');
  assert.equal(s.alarms.enabled, true);
});

test('validatePatch accepts the documented paths', () => {
  const ok = validatePatch({
    patient: { hr: 100, temp: 37.26, nibp: { sys: 100, dia: 60 }, rhythm: 'vt', glideMs: 5000 },
    modules: ['ecg', 'abp'], alarms: { limits: { hr: [40, 130] }, enabled: false }, nibp: { mode: 'cycle', cycleSec: 180 }, theme: 'default',
  });
  assert.ok(ok.ok);
  assert.equal(ok.patch.patient.temp, 37.3);
});

test('validatePatch rejects low > high and non-numbers', () => {
  assert.ok(!validatePatch({ alarms: { limits: { hr: [130, 40] } } }).ok);
  assert.ok(!validatePatch({ patient: { hr: '80' } }).ok);
  assert.ok(!validatePatch({ patient: { hr: NaN } }).ok);
});

test('default patient: one Bed 1 with the new fields at their defaults', () => {
  const s = defaultState(5);
  assert.equal(s.patients.length, 1);
  const p = s.patients[0];
  assert.deepEqual([p.id, p.label], ['p1', 'Bed 1']);
  assert.deepEqual(p.off, { ecg: false, spo2: false, nibp: false, abp: false, etco2: false });
  assert.deepEqual([p.etco2Shape, p.spo2Quality, p.abpDamping], ['normal', 'good', 'normal']);
  assert.deepEqual([p.pvcPerMin, p.ie, p.pulse, p.flutterRatio, p.st], [0, 2, true, 2, 0]);
});

test('validatePatch: new patient fields, reserved rhythms, ranges', () => {
  const ok = validatePatch({
    patient: {
      off: { ecg: true, abp: false }, etco2Shape: 'obstructive', spo2Quality: 'poor', abpDamping: 'over',
      pvcPerMin: 12, ie: 1.5, pulse: false, flutterRatio: 3, st: -2, rhythm: 'torsades', label: ' ICU 2 ',
    },
  });
  assert.ok(ok.ok, ok.msg);
  assert.equal(ok.patch.patient.label, 'ICU 2');
  for (const r of ['first_degree_block', 'mobitz1', 'mobitz2', 'chb', 'torsades', 'paced', 'flutter']) {
    assert.ok(validatePatch({ patient: { rhythm: r } }).ok, r);
  }
  for (const bad of [
    { pvcPerMin: 31 }, { st: 4 }, { flutterRatio: 5 }, { etco2Shape: 'x' }, { spo2Quality: 'x' }, { abpDamping: 'x' },
    { off: { nope: true } }, { off: { ecg: 1 } }, { pulse: 'yes' }, { label: '' }, { id: 'p9' },
  ]) assert.ok(!validatePatch({ patient: bad }).ok, JSON.stringify(bad));
});

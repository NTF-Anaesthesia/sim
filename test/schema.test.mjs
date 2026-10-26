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

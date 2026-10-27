import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Recorder, gapSec } from '../src/controller/recorder.js';
import { LibraryStore } from '../src/controller/library.js';
import { validateScenario } from '../src/shared/scenario.js';

test('gaps round to 5 s and stay inside 0 to 3600', () => {
  assert.equal(gapSec(0), 0);
  assert.equal(gapSec(2400), 0);
  assert.equal(gapSec(2600), 5);
  assert.equal(gapSec(12000), 10);
  assert.equal(gapSec(99999999), 3600);
});

test('every change on the recorded bed becomes a step with its real gap and own speeds', () => {
  const rec = new Recorder('p1', 1000);
  assert.ok(rec.add({ patient: { hr: 100 } }, 'p1', 1000 + 12000, 10000));
  assert.ok(rec.add({ patient: { spo2: 80, hr: 90 } }, 'p1', 1000 + 12000 + 31000, 10000, { spo2: 120000 }));
  assert.deepEqual(rec.steps, [
    { atSec: 10, patch: { patient: { hr: 100 } }, glideMs: 10000 },
    { atSec: 30, patch: { patient: { spo2: 80, hr: 90 } }, glideMs: 10000, glideMsBy: { spo2: 120000 } },
  ]);
  assert.ok(validateScenario({ name: 'R', steps: rec.steps }).ok, 'a recording is a valid scenario');
});

test('other beds, screens and empty patches are not recorded; alarms and patient parts are kept', () => {
  const rec = new Recorder('p1', 0);
  assert.equal(rec.add({ patient: { hr: 100 } }, 'p2', 5000, 0), false, 'another bed');
  assert.equal(rec.add({ screens: { a: { name: 'x' } } }, 'p1', 5000, 0), false, 'not a step');
  assert.equal(rec.add({ modules: ['ecg'] }, 'p1', 5000, 0), false);
  assert.ok(rec.add({ patient: { hr: 60 }, screens: { a: { name: 'x' } } }, 'p1', 5000, 0));
  assert.deepEqual(rec.steps[0].patch, { patient: { hr: 60 } });
  assert.ok(rec.add({ alarms: { limits: { hr: [50, 120] } } }, 'p1', 10000, 0));
  assert.equal(rec.steps.length, 2);
});

test('past 30 steps changes are counted as skipped, not recorded', () => {
  const rec = new Recorder('p1', 0);
  for (let i = 0; i < 32; i++) rec.add({ patient: { hr: 60 + i } }, 'p1', i * 5000, 0);
  assert.equal(rec.steps.length, 30);
  assert.equal(rec.skipped, 2);
});

test('replaceScenario edits, renames and refuses clashes; built-ins stay untouched', () => {
  const lib = new LibraryStore(null);
  const steps = [{ atSec: 0, patch: { patient: { hr: 100 } }, glideMs: 0 }];
  assert.ok(lib.addScenario({ name: 'A', steps }).ok);
  assert.ok(lib.addScenario({ name: 'B', steps }).ok);
  assert.ok(lib.replaceScenario('A', { name: 'A2', objectives: 'Spot the bleed', steps: [{ ...steps[0], note: 'Ask for fluids' }] }).ok);
  assert.deepEqual(lib.scenarios.map((x) => x.name), ['A2', 'B']);
  assert.equal(lib.scenarios[0].objectives, 'Spot the bleed');
  assert.equal(lib.replaceScenario('A2', { name: 'B', steps }).ok, false, 'name taken');
  assert.equal(lib.replaceScenario('A2', { name: 'Slow bleed', steps }).ok, false, 'built-in name');
  assert.equal(lib.replaceScenario('Slow bleed', { name: 'X', steps }).ok, false, 'built-ins are not saved ones');
  assert.equal(lib.replaceScenario('A2', { name: 'A2', steps: [] }).ok, false, 'invalid');
  assert.equal(lib.scenarios[0].name, 'A2', 'a refused edit changes nothing');
});

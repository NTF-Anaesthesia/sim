import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHub, msg } from './fake.mjs';
import { validateScenario, MAX_NOTE, MAX_OBJECTIVES } from '../src/shared/scenario.js';
import { BUILTIN_SCENARIOS } from '../src/controller/library.js';
import { CURATED_SCENARIOS, SCENARIO_AUDIENCE } from '../src/controller/builtin-scenarios.js';

const AUDIENCES = ['anaesthetist', 'nurse-OT'];

test('the three original built-ins stay, with the curated set after them', () => {
  assert.deepEqual(BUILTIN_SCENARIOS.slice(0, 3).map((s) => s.name), ['Slow bleed', 'Apnoea on tap', 'Rhythm to arrest']);
  assert.equal(CURATED_SCENARIOS.length, 10);
  assert.equal(new Set(BUILTIN_SCENARIOS.map((s) => s.name)).size, BUILTIN_SCENARIOS.length, 'names are unique');
});

test('every built-in passes the validator unchanged', () => {
  for (const s of BUILTIN_SCENARIOS) {
    const v = validateScenario(s);
    assert.ok(v.ok, `${s.name}: ${v.ok ? '' : v.msg}`);
  }
});

test('curated scenarios have objectives, a note on every step, an audience tag, and no doses', () => {
  for (const s of CURATED_SCENARIOS) {
    assert.ok(s.objectives && s.objectives.length <= MAX_OBJECTIVES, `${s.name}: objectives`);
    for (const [i, st] of s.steps.entries()) assert.ok(st.note && st.note.length <= MAX_NOTE, `${s.name} step ${i + 1}: note`);
    const tags = SCENARIO_AUDIENCE[s.name];
    assert.ok(tags?.length && tags.every((t) => AUDIENCES.includes(t)), `${s.name}: audience`);
    assert.ok(!/\d+(\.\d+)?\s*(mg|mcg|µg|ug|ml|mmol|units?|iu|j|joules)\b/i.test(JSON.stringify(s)), `${s.name}: no doses`);
    assert.ok(!/patient name|mrn|\bdob\b/i.test(JSON.stringify(s)), `${s.name}: no patient details`);
  }
  for (const name of Object.keys(SCENARIO_AUDIENCE)) assert.ok(BUILTIN_SCENARIOS.some((s) => s.name === name), `${name} is a built-in`);
});

test('desaturation uses a slower SpO2 glide than the other fields', () => {
  const d = CURATED_SCENARIOS.find((s) => s.name === 'Induction desaturation');
  const dip = d.steps[1];
  assert.ok(dip.glideMsBy.spo2 >= 3 * dip.glideMs);
});

for (const sc of BUILTIN_SCENARIOS) {
  test(`${sc.name} runs to the end in a room with a fake clock`, async () => {
    const { hub, clock } = makeHub();
    const start = await hub.onMessage('c-1', msg({ t: 'scenarioStart', scenario: sc }));
    assert.equal(start.reply?.t, undefined, `${sc.name}: start accepted`);
    for (let guard = 0; guard < 100; guard++) {
      const run = (await hub.state()).scenario;
      if (run.done) break;
      if (run.waiting) {
        const r = await hub.onMessage('c-1', msg({ t: 'scenarioNext' }));
        assert.equal(r.reply?.t, undefined, `${sc.name}: tap accepted`);
      } else {
        clock.t = run.nextAt;
        const r = await hub.onAlarm();
        assert.ok(r.broadcast, `${sc.name}: the alarm ran a step`);
      }
    }
    const end = (await hub.state()).scenario;
    assert.equal(end.done, true, `${sc.name}: finished`);
    assert.equal(end.step, sc.steps.length);
  });
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePatch } from '../src/shared/schema.js';
import { defaultPatient } from '../src/shared/schema.js';
import {
  paramList, buildPatch, pendingCount, stepPercent, clampDisplay, glideProgress, formatValue, intervalLabel, DEFAULT_UNITS, moveDisplay,
} from '../src/controller/params.js';
import { BUILTIN_PRESETS, PresetStore, normalizePreset, runPreset, presetFromPatient } from '../src/controller/presets.js';
import { Settings } from '../src/controller/settings.js';
import { makeActions } from '../src/controller/actions.js';
import { RoomClient } from '../src/room/client.js';
import { presenceMessage } from '../src/room/presence.js';

const pt = () => defaultPatient('p1', 'Bed 1', 1000);
const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), m }; };

test('buildPatch sends only changed values, as an allowed patch', () => {
  const p = pt();
  assert.equal(buildPatch({}, p, DEFAULT_UNITS), null);
  assert.equal(buildPatch({ hr: 80 }, p, DEFAULT_UNITS), null);
  const patch = buildPatch({ hr: 100, nibpSys: 90, rhythm: 'vt', spo2: 98 }, p, DEFAULT_UNITS);
  assert.deepEqual(patch, { patient: { hr: 100, nibp: { sys: 90 }, rhythm: 'vt' } });
  assert.ok(validatePatch(patch).ok);
  assert.equal(pendingCount({ hr: 100, nibpSys: 90, rhythm: 'vt' }, p, DEFAULT_UNITS), 3);
});

test('units change the display only; patches stay mmHg and C', () => {
  const u = { co2: 'kPa', temp: 'F' };
  const et = paramList(u).find((s) => s.id === 'etco2');
  const tp = paramList(u).find((s) => s.id === 'temp');
  assert.equal(formatValue(et, 38), '5.1');
  assert.equal(et.from(5.3), 39.8);
  assert.equal(formatValue(tp, 36.8), '98.2');
  assert.equal(tp.from(100.4), 38);
  const patch = buildPatch({ etco2: et.from(4), temp: tp.from(101) }, pt(), u);
  assert.ok(validatePatch(patch).ok);
  assert.equal(patch.patient.etco2, 30);
  assert.equal(patch.patient.temp, 38.3);
});

test('every step range stays inside the schema ranges', () => {
  for (const s of paramList(DEFAULT_UNITS)) {
    for (const wire of [s.from(s.min), s.from(s.max)]) {
      const patch = buildPatch({ [s.id]: wire }, { ...pt(), hr: -1, spo2: -1, etco2: -1, rr: -1, temp: -1, nibp: { sys: -1, dia: -1 }, abp: { sys: -1, dia: -1 } }, DEFAULT_UNITS);
      assert.ok(validatePatch(patch).ok, `${s.id} ${wire}`);
    }
  }
});

test('stepPercent moves at least one step and respects the range', () => {
  const hr = paramList(DEFAULT_UNITS)[0];
  assert.equal(stepPercent(hr, 80, 10), 88);
  assert.equal(stepPercent(hr, 80, -5), 76);
  assert.equal(stepPercent(hr, 5, 5), 6);
  assert.equal(stepPercent(hr, 245, 10), 250);
  assert.equal(clampDisplay(hr, -4), 0);
});

test('glide progress follows the server clock', () => {
  const p = pt();
  p.glide = { startedAt: 1000, durationMs: 10000, from: p.glide.from };
  assert.deepEqual(glideProgress(p, 1000), { active: true, u: 0, leftMs: 10000 });
  assert.equal(glideProgress(p, 6000).u, 0.5);
  assert.equal(glideProgress(p, 12000).active, false);
  p.glide.durationMs = 0;
  assert.equal(glideProgress(p, 1000).active, false);
  assert.equal(intervalLabel(0), 'Manual');
  assert.equal(intervalLabel(300), '5 min');
});

test('built-in presets are valid, synthetic, one step at 0', () => {
  assert.deepEqual(BUILTIN_PRESETS.map((p) => p.name), ['Normal', 'Hypotension', 'Desaturation', 'Anaphylaxis', 'VF arrest']);
  for (const p of BUILTIN_PRESETS) {
    assert.deepEqual(normalizePreset(p)?.steps.map((s) => s.atSec), [0], p.name);
    assert.ok(validatePatch(p.steps[0].patch).ok, p.name);
  }
});

test('preset store saves, exports, imports and survives bad data', () => {
  const kv = mem();
  const a = new PresetStore(kv);
  assert.ok(a.save(presetFromPatient('Mine', pt(), 10000)));
  assert.equal(a.save(presetFromPatient('Normal', pt(), 0)), false, 'built-in names are taken');
  assert.equal(new PresetStore(kv).saved.length, 1, 'reloads from storage');
  const json = a.exportJson();
  const b = new PresetStore(mem());
  assert.deepEqual(b.importJson(json), { added: 1, skipped: 0 });
  assert.deepEqual(b.importJson('not json'), { added: 0, skipped: 1 });
  const bad = JSON.stringify([{ name: 'x', steps: [{ atSec: 0, glideMs: 0, patch: { patient: { hr: 9999 } } }] }, { name: 'y', steps: [{ atSec: 0, glideMs: 0, patch: { evil: 1 } }] }]);
  assert.deepEqual(b.importJson(bad), { added: 0, skipped: 2 });
  kv.setItem('sim.presets', '{broken');
  assert.deepEqual(new PresetStore(kv).saved, []);
  assert.equal(new PresetStore(null).save(presetFromPatient('Mem', pt(), 0)), true, 'works with storage blocked');
});

test('runPreset sends step 0 now and later steps on a timer, through act', () => {
  const sent = [];
  const timers = [];
  const act = (patch, glideMs, p) => sent.push({ patch, glideMs, p });
  const preset = { name: 's', steps: [{ atSec: 0, patch: { patient: { hr: 90 } }, glideMs: 5000 }, { atSec: 60, patch: { patient: { hr: 40 } }, glideMs: 10000 }] };
  const run = runPreset(preset, act, 'p2', { setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; }, clearTimer: (i) => { timers[i].cancelled = true; } });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { patch: { patient: { hr: 90 } }, glideMs: 5000, p: 'p2' });
  assert.equal(timers[0].ms, 60000);
  run.cancel();
  assert.ok(timers[0].cancelled);
});

test('act is the one path: set carries the patient id and glide time', () => {
  const out = [];
  const a = makeActions({ send: (m) => { out.push(m); return true; } }, () => 'p2');
  a.act({ patient: { hr: 70 } }, 30000);
  a.act({ alarms: { enabled: false } });
  a.act({ patient: { hr: 70 } }, 0, 'p1');
  a.nibpNow();
  assert.deepEqual(out, [
    { t: 'set', patch: { patient: { hr: 70 } }, p: 'p2', glideMs: 30000 },
    { t: 'set', patch: { alarms: { enabled: false } }, p: 'p2' },
    { t: 'set', patch: { patient: { hr: 70 } }, p: 'p1', glideMs: 0 },
    { t: 'nibp', p: 'p2' },
  ]);
});

test('settings use the sim.settings.* namespace and fall back when storage is blocked', () => {
  const kv = mem();
  const s = new Settings(kv);
  assert.deepEqual(s.units(), { co2: 'mmHg', temp: 'C' });
  s.set('units', { co2: 'kPa', temp: 'F' });
  assert.ok(kv.m.has('sim.settings.units'));
  assert.deepEqual(new Settings(kv).units(), { co2: 'kPa', temp: 'F' });
  const blocked = new Settings({ getItem() { throw new Error('no'); }, setItem() { throw new Error('no'); } });
  blocked.set('glideMs', 30000);
  assert.equal(blocked.get('glideMs', 0), 30000);
});

test('presence counts monitors and controllers', () => {
  assert.deepEqual(presenceMessage([{ role: 'monitor' }, { role: 'monitor' }, { role: 'controller' }, null]), { t: 'presence', monitors: 2, controllers: 2, screens: [] });
});

class FakeWS {
  static all = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeWS.all.push(this); }
  send(t) { this.sent.push(JSON.parse(t)); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen(); }
  recv(o) { this.onmessage({ data: JSON.stringify(o) }); }
}
function makeClient() {
  FakeWS.all = [];
  const timers = [];
  const c = new RoomClient({ url: 'wss://x/ws/ABC234?role=controller&id=c-1', WebSocketCtor: FakeWS, now: () => 1000, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; }, clearTimer: () => {} });
  return { c, timers };
}

test('client keeps the last presence message', () => {
  const { c } = makeClient();
  const seen = [];
  c.on('presence', (p) => seen.push(p));
  c.connect();
  FakeWS.all[0].open();
  FakeWS.all[0].recv({ t: 'presence', monitors: 2, controllers: 1 });
  assert.deepEqual(c.presence, { monitors: 2, controllers: 1, screens: [] });
  assert.equal(seen.length, 1);
});

test('wake replaces a dead socket at once and a silent one after the wait', () => {
  const { c, timers } = makeClient();
  c.connect();
  FakeWS.all[0].open();
  // silent socket: ping goes out, no pong, the check timer replaces it
  c.wake(2500);
  assert.equal(FakeWS.all[0].sent.at(-1).t, 'ping');
  timers.at(-1).fn();
  assert.equal(FakeWS.all.length, 2);
  assert.equal(c.status, 'reconnecting');
  // answered ping keeps the socket
  FakeWS.all[1].open();
  c.wake(2500);
  const n = FakeWS.all[1].sent.at(-1).n;
  FakeWS.all[1].recv({ t: 'pong', n, now: 1000 });
  timers.at(-1).fn();
  assert.equal(FakeWS.all.length, 2);
  // dead socket (closed, backoff pending): wake connects without waiting
  FakeWS.all[1].readyState = 3;
  FakeWS.all[1].onclose({ code: 1006 });
  c.wake();
  assert.equal(FakeWS.all.length, 3);
});

test('steppers always move to a different wire value (F and kPa)', () => {
  for (const u of [{ co2: 'mmHg', temp: 'F' }, { co2: 'kPa', temp: 'C' }]) {
    for (const id of ['temp', 'etco2']) {
      const sp = paramList(u).find((x) => x.id === id);
      const lo = sp.from(sp.min); const hi = sp.from(sp.max);
      for (let w = lo * 10 + 1; w < hi * 10; w++) {
        const wire = w / 10;
        const d = sp.to(wire);
        if (sp.from(d) !== wire || d <= sp.min || d >= sp.max) continue; // not shown exactly, or at a range end
        assert.notEqual(sp.from(moveDisplay(sp, d, sp.step)), sp.from(d), `${id} up ${wire}`);
        assert.notEqual(sp.from(moveDisplay(sp, d, -sp.step)), sp.from(d), `${id} down ${wire}`);
      }
    }
  }
});

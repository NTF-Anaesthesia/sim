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
  for (const s of paramList(DEFAULT_UNITS).filter((x) => !x.limitOnly)) {
    for (const wire of [s.from(s.min), s.from(s.max)]) {
      const gas = { fio2: -1, eto2: -1, fiag: -1, etag: -1, fin2o: -1, etn2o: -1, age: -1, tofCount: -1, tofRatio: -1 };
      const patch = buildPatch({ [s.id]: wire }, { ...pt(), ...gas, hr: -1, spo2: -1, etco2: -1, rr: -1, temp: -1, nibp: { sys: -1, dia: -1 }, abp: { sys: -1, dia: -1 }, abp2: { sys: -1, dia: -1 }, cvp: -99, ppv: -1, bis: -1, bisSqi: -1, bisEmg: -1, bisSr: -1 }, DEFAULT_UNITS);
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

test('scenario strip: hidden with no run, on the Scenarios tab or once done; shows name, step, countdown and cue', async () => {
  const { scenarioBar } = await import('../src/controller/scnbar.js');
  const run = { name: 'Bleed <A>', p: 'p1', step: 1, total: 3, startedAt: 0, nextAt: 5000, waiting: false, pausedAt: 0, done: false, note: 'Ask for help' };
  assert.equal(scenarioBar(undefined, { tab: 'vitals', line: '' }).show, false);
  assert.equal(scenarioBar(null, { tab: 'vitals', line: '' }).show, false);
  assert.equal(scenarioBar(run, { tab: 'scenarios', line: 'x' }).show, false, 'the full card is on the Scenarios tab');
  assert.equal(scenarioBar({ ...run, done: true }, { tab: 'vitals', line: 'x' }).show, false);
  const b = scenarioBar(run, { tab: 'vitals', line: 'Next step in 0:05' });
  assert.ok(b.show);
  assert.match(b.html, /data-testid="scnbar-name">Bleed &lt;A&gt;</);
  assert.match(b.html, /data-testid="scnbar-step">1\/3 done</);
  assert.match(b.html, /id="scnbar-count"[^>]*>Next step in 0:05</);
  assert.match(b.html, /data-testid="scnbar-cue"[^>]*><b>Cue:<\/b> Ask for help</);
  assert.match(b.html, /data-act="scn-pause" data-testid="scnbar-pause">Pause</);
  assert.match(b.html, /data-act="scn-next" data-testid="scnbar-next">Skip wait</);
  assert.doesNotMatch(b.html, /scn-stop/, 'Stop stays on the Scenarios tab');
  assert.doesNotMatch(b.html, /data-testid="scn-(pause|next)"/, 'the card testids stay unique');
  assert.doesNotMatch(scenarioBar({ ...run, note: undefined }, { tab: 'vitals', line: '' }).html, /scnbar-cue/);
  assert.match(scenarioBar(run, { tab: 'alarms', bed: 'Bed 2', line: '' }).html, /· Bed 2 ·/);
});

test('scenario strip: waiting and paused change the labels and the key, the countdown does not', async () => {
  const { scenarioBar } = await import('../src/controller/scnbar.js');
  const run = { name: 'S', p: 'p1', step: 2, total: 3, startedAt: 0, nextAt: 0, waiting: true, pausedAt: 0, done: false };
  const w = scenarioBar(run, { tab: 'vitals', line: 'Waiting for you: tap Next step.' });
  assert.ok(w.show && w.waiting);
  assert.match(w.html, /data-testid="scnbar-next">Next step</);
  const p = scenarioBar({ ...run, waiting: false, pausedAt: 10, nextAt: 99 }, { tab: 'vitals', line: '' });
  assert.ok(p.show && !p.waiting);
  assert.match(p.html, /data-testid="scnbar-pause">Resume</);
  assert.notEqual(w.key, p.key);
  const a = scenarioBar({ ...run, waiting: false, nextAt: 5000 }, { tab: 'vitals', line: '0:05' });
  const c = scenarioBar({ ...run, waiting: false, nextAt: 5000 }, { tab: 'vitals', line: '0:04' });
  assert.ok(a.show && c.show && a.key === c.key, 'a ticking countdown does not rebuild the buttons');
});

// ---- offline banner and toast (feedback.js) ----------------------------------------------------------------------
async function fakeFeedback() {
  const { createFeedback, LOAD_GRACE_MS, RECONNECTED_MS, TOAST_MS } = await import('../src/controller/feedback.js');
  let t = 1000;
  /** @type {Map<number, { fn: () => void, at: number }>} */
  const timers = new Map();
  let id = 0;
  let changes = 0;
  const fb = createFeedback({
    now: () => t,
    setTimer: (fn, ms) => { timers.set(++id, { fn, at: t + ms }); return id; },
    clearTimer: (k) => { timers.delete(k); },
    onChange: () => { changes++; },
  });
  /** advance the clock, running due timers in order @param {number} ms */
  const tick = (ms) => {
    const end = t + ms;
    for (;;) {
      const due = [...timers].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      t = due[1].at;
      due[1].fn();
    }
    t = end;
  };
  return { fb, tick, changes: () => changes, LOAD_GRACE_MS, RECONNECTED_MS, TOAST_MS };
}

test('offline banner: quiet during a normal load, hidden when open, Reconnecting when the link drops, Reconnected then hidden', async () => {
  const { fb, tick, LOAD_GRACE_MS, RECONNECTED_MS } = await fakeFeedback();
  assert.equal(fb.banner().show, false, 'no flash while the page first connects');
  fb.status('open');
  assert.equal(fb.banner().show, false, 'hidden when open');
  fb.status('reconnecting');
  const b = fb.banner();
  assert.ok(b.show && b.kind === 'wait' && /Reconnecting/.test(b.text) && /kept/.test(b.text) && !b.reload);
  tick(10_000);
  fb.status('open');
  const ok = fb.banner();
  assert.ok(ok.show && ok.kind === 'ok' && ok.text === 'Reconnected');
  tick(RECONNECTED_MS - 1);
  assert.equal(fb.banner().show, true);
  tick(1);
  assert.equal(fb.banner().show, false, 'Reconnected hides after 3 s');
  // a slow first connection shows the banner after the grace, and opening then just hides it
  const slow = await fakeFeedback();
  slow.tick(LOAD_GRACE_MS - 1);
  assert.equal(slow.fb.banner().show, false);
  const before = slow.changes();
  slow.tick(1);
  assert.ok(slow.changes() > before, 'the grace timer asks for a repaint');
  assert.equal(slow.fb.banner().show && slow.fb.banner().kind, 'wait');
  slow.fb.status('open');
  assert.equal(slow.fb.banner().show, false);
});

test('offline banner: full and expired are red with Reload at once; closed by the page shows nothing', async () => {
  const { fb } = await fakeFeedback();
  fb.status('expired');
  assert.deepEqual(fb.banner(), { show: true, kind: 'expired', text: 'Room expired', reload: true });
  fb.status('full');
  assert.deepEqual(fb.banner(), { show: true, kind: 'full', text: 'Room full', reload: true });
  fb.status('closed');
  assert.equal(fb.banner().show, false);
});

test('toast: one line, replaced by the next, cleared after 5 s; server errors read "Refused: ..." except schema', async () => {
  const { errorText } = await import('../src/controller/feedback.js');
  const { fb, tick, TOAST_MS } = await fakeFeedback();
  fb.say('Not connected: that was not sent.');
  tick(2000);
  fb.say(errorText({ code: 'bad_patch', msg: 'pads are off' }) ?? '');
  assert.equal(fb.toast(), 'Refused: pads are off');
  tick(TOAST_MS - 1);
  assert.equal(fb.toast(), 'Refused: pads are off', 'the newer line gets its own 5 s');
  tick(1);
  assert.equal(fb.toast(), '');
  assert.equal(errorText({ code: 'schema', msg: 'update needed' }), null);
  assert.equal(errorText({ code: 'rate', msg: 'too many messages' }), 'Refused: too many messages');
});

test('Apply while offline: the label says so, the send fails, the pending changes stay', async () => {
  const { applyLabel } = await import('../src/controller/feedback.js');
  assert.equal(applyLabel(2, 'open'), 'Apply 2 changes');
  assert.equal(applyLabel(1, 'open'), 'Apply 1 change');
  assert.equal(applyLabel(2, 'reconnecting'), 'Apply when connected');
  // the controller sends through act; a closed socket returns false and nothing is queued for a resend
  FakeWS.all = [];
  const c = new RoomClient({ url: 'wss://x/ws/ABC234?role=controller&id=c-1', WebSocketCtor: FakeWS, now: () => 1000, setTimer: () => 0, clearTimer: () => {} });
  c.connect();
  const p = pt();
  const pending = { hr: 120 };
  const { act } = makeActions(c, () => p.id);
  const patch = buildPatch(pending, p, DEFAULT_UNITS);
  assert.equal(act(patch ?? {}, 0, p.id), false, 'not sent while connecting');
  assert.equal(FakeWS.all[0].sent.length, 0);
  assert.equal(pendingCount(pending, p, DEFAULT_UNITS), 1, 'the pending edit is still there');
});

// ---- header Silence button, bed dots, Mark note (topbar.js) ----------------------------------------------------
test('header Silence: "Silence", "Silenced m:ss" from the server clock, "Alarms off"; the Alarms tab agrees', async () => {
  const { silenceButton, alarmsTabSilence, clockLeft } = await import('../src/controller/topbar.js');
  const now = 50_000;
  assert.equal(silenceButton({ enabled: true, silencedUntil: 0 }, now).state, 'ready');
  assert.equal(silenceButton({ enabled: true, silencedUntil: 0 }, now).text, 'Silence');
  assert.equal(silenceButton(undefined, now).state, 'ready', 'before the first state');
  const s = silenceButton({ enabled: true, silencedUntil: now + 119_200 }, now);
  assert.deepEqual([s.state, s.text], ['silenced', 'Silenced 2:00']);
  assert.equal(silenceButton({ enabled: true, silencedUntil: now + 61_000 }, now).text, 'Silenced 1:01');
  assert.equal(silenceButton({ enabled: true, silencedUntil: now + 1 }, now).text, 'Silenced 0:01', 'never 0:00 while silenced');
  assert.equal(silenceButton({ enabled: true, silencedUntil: now }, now).state, 'ready', 'expired');
  const off = silenceButton({ enabled: false, silencedUntil: now + 5000 }, now);
  assert.deepEqual([off.state, off.text], ['off', 'Alarms off'], 'off wins over a silence');
  assert.equal(clockLeft(9_000), '0:09');
  assert.deepEqual(alarmsTabSilence({ silencedUntil: 0 }, now), { cancel: false, text: 'Silence 2 min' });
  assert.deepEqual(alarmsTabSilence({ silencedUntil: now + 44_100 }, now), { cancel: true, text: 'Cancel silence (45 s left)' });
});

test('silenceCancel sends {t:"silence",cancel:true}; a failed send returns false for the toast', () => {
  const out = [];
  let up = true;
  const a = makeActions({ send: (m) => { if (!up) return false; out.push(m); return true; } }, () => 'p1');
  assert.equal(a.silence(), true);
  assert.equal(a.silenceCancel(), true);
  assert.deepEqual(out, [{ t: 'silence' }, { t: 'silence', cancel: true }]);
  up = false;
  assert.equal(a.silenceCancel(), false);
});

test('bed chips: a dot and "unapplied changes" label only on beds with pending edits', async () => {
  const { bedsHtml, bedLabel } = await import('../src/controller/topbar.js');
  const beds = [{ id: 'p1', label: 'Bed 1' }, { id: 'p2', label: 'Bed <2>' }];
  const p1 = pt();
  const pending = { p1: { hr: 120 } };
  const has = (id) => id === 'p1' && pendingCount(pending.p1, p1, DEFAULT_UNITS) > 0;
  const html = bedsHtml(beds, 'p2', has);
  assert.match(html, /data-bed="p1" aria-pressed="false" data-pending="true" aria-label="Bed 1, unapplied changes">Bed 1</);
  assert.match(html, /data-bed="p2" aria-pressed="true">Bed &lt;2&gt;</);
  assert.match(html, /data-act="add"/);
  // after Apply the pending edits are cleared: no dot
  delete pending.p1;
  assert.doesNotMatch(bedsHtml(beds, 'p2', (id) => !!pending[id]), /data-pending/);
  // an edit back to the current value is not pending
  assert.equal(pendingCount({ hr: p1.hr }, p1, DEFAULT_UNITS), 0);
  assert.equal(bedLabel('Bed 1', false), 'Bed 1');
});

test('Mark: the toast line reads "Bookmarked at HH:MM"', async () => {
  const { markNote } = await import('../src/controller/topbar.js');
  const { createFeedback } = await import('../src/controller/feedback.js');
  const fb = createFeedback({ now: () => 0, setTimer: () => 0, clearTimer: () => {}, onChange: () => {} });
  fb.say(markNote(new Date(2026, 10, 16, 9, 5)));
  assert.equal(fb.toast(), 'Bookmarked at 09:05');
});

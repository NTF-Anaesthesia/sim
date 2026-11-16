import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHub, msg } from './fake.mjs';
import { IDLE_MS, MAX_PER_SECOND } from '../src/room/hub.js';
import { displayed } from '../src/engine/glide.js';

test('a new client gets the current state (late joiner)', async () => {
  const { hub } = makeHub();
  await hub.onMessage('c-1', msg({ t: 'set', patch: { patient: { hr: 130 } } }));
  const first = await hub.hello();
  assert.equal(first.t, 'state');
  assert.equal(first.state.patients[0].hr, 130);
  assert.equal(first.state.rev, 1);
});

test('set is broadcast to everyone and bumps rev by one', async () => {
  const { hub } = makeHub();
  const a = await hub.onMessage('c-1', msg({ t: 'set', patch: { patient: { spo2: 85, rhythm: 'af' } } }));
  assert.equal(a.broadcast.t, 'state');
  assert.equal(a.broadcast.state.patients[0].spo2, 85);
  assert.equal(a.broadcast.state.patients[0].rhythm, 'af');
  assert.equal(a.broadcast.state.rev, 1);
  const b = await hub.onMessage('c-2', msg({ t: 'set', patch: { modules: ['ecg', 'abp'] } }));
  assert.equal(b.broadcast.state.rev, 2);
  assert.deepEqual(b.broadcast.state.modules, ['ecg', 'abp']);
});

test('test value reaches the broadcast', async () => {
  const { hub } = makeHub();
  const r = await hub.onMessage('c-1', msg({ t: 'test', value: '42' }));
  assert.equal(r.broadcast.state.test, '42');
});

test('patch allow-list: unknown paths and bad values are rejected, state unchanged', async () => {
  const { hub } = makeHub();
  for (const patch of [{ rev: 99 }, { patient: { hr: 9999 } }, { patient: { rhythm: 'nope' } }, { alarms: { silencedUntil: 1 } }, { patient: { evil: 1 } }, 'x']) {
    const r = await hub.onMessage('c-1', msg({ t: 'set', patch }));
    assert.equal(r.reply?.t, 'error', JSON.stringify(patch));
    assert.equal(r.reply.code, 'bad_patch');
    assert.equal(r.broadcast, undefined);
  }
  assert.equal((await hub.state()).rev, 0);
});

test('bad json, unknown type, too big', async () => {
  const { hub } = makeHub();
  assert.equal((await hub.onMessage('c-1', 'not json')).reply.code, 'bad_json');
  assert.equal((await hub.onMessage('c-1', msg({ t: 'zzz' }))).reply.code, 'bad_json');
  assert.equal((await hub.onMessage('c-1', 'x'.repeat(17000))).reply.code, 'too_big');
  assert.equal((await hub.onMessage('c-1', msg({ t: 'test', value: 'x'.repeat(2000) }))).reply.code, 'bad_patch');
});

test('rate limit: 30 per second per client, others unaffected', async () => {
  const { hub, clock } = makeHub();
  for (let i = 0; i < MAX_PER_SECOND; i++) assert.equal((await hub.onMessage('c-1', msg({ t: 'ping', n: i }))).reply.t, 'pong');
  assert.equal((await hub.onMessage('c-1', msg({ t: 'ping', n: 99 }))).reply.code, 'rate');
  assert.equal((await hub.onMessage('c-2', msg({ t: 'ping', n: 1 }))).reply.t, 'pong');
  clock.t += 1001;
  assert.equal((await hub.onMessage('c-1', msg({ t: 'ping', n: 100 }))).reply.t, 'pong');
});

test('state persists across a restart (hibernation wake) via storage', async () => {
  const { hub, storage, clock } = makeHub();
  await hub.onMessage('c-1', msg({ t: 'set', patch: { patient: { hr: 55 } } }));
  const { RoomHub } = await import('../src/room/hub.js');
  const woke = new RoomHub(storage, () => clock.t);
  assert.equal((await woke.state()).patients[0].hr, 55);
});

test('silence sets silencedUntil to now + 2 min', async () => {
  const { hub, clock } = makeHub();
  const r = await hub.onMessage('c-1', msg({ t: 'silence' }));
  assert.equal(r.broadcast.state.alarms.silencedUntil, clock.t + 120000);
});

test('glide: a change records a glide from the values shown at that moment', async () => {
  const { hub, clock } = makeHub();
  await hub.onMessage('c-1', msg({ t: 'set', patch: { patient: { hr: 180 } }, glideMs: 10000 }));
  clock.t += 5000; // halfway: 130
  const r = await hub.onMessage('c-1', msg({ t: 'set', patch: { patient: { hr: 60 } }, glideMs: 10000 }));
  assert.equal(Math.round(r.broadcast.state.patients[0].glide.from.hr), 130);
  assert.equal(r.broadcast.state.patients[0].glide.durationMs, 10000);
  assert.equal(r.broadcast.state.patients[0].glide.startedAt, clock.t);
});

test('nibp now takes the glided target values and stamps the time', async () => {
  const { hub, clock } = makeHub();
  await hub.onMessage('c-1', msg({ t: 'set', patch: { patient: { nibp: { sys: 80, dia: 40 } } }, glideMs: 0 }));
  clock.t += 1;
  const r = await hub.onMessage('c-1', msg({ t: 'nibp' }));
  const got = r.broadcast.state.patients[0].nibpRead;
  assert.ok(Math.abs(got.sys - 80) <= 4 && Math.abs(got.dia - 40) <= 3, `close to 80/40 with cuff error: ${got.sys}/${got.dia}`);
  assert.equal(got.at, clock.t);
});

test('rooms expire after 24 h idle: alarm deletes state; before that it re-arms', async () => {
  const { hub, storage, clock } = makeHub();
  await hub.onMessage('c-1', msg({ t: 'set', patch: { patient: { hr: 70 } } }));
  assert.equal(storage.alarm, clock.t + IDLE_MS);
  const t0 = clock.t;
  clock.t = t0 + IDLE_MS - 1000;
  assert.deepEqual(await hub.onAlarm(), { expired: false });
  assert.equal(storage.alarm, t0 + IDLE_MS);
  clock.t = t0 + IDLE_MS;
  assert.deepEqual(await hub.onAlarm(), { expired: true });
  assert.equal(storage.data.size, 0);
  assert.equal((await hub.state()).patients[0].hr, 80); // fresh default room
});

test('activity extends the expiry', async () => {
  const { hub, storage, clock } = makeHub();
  await hub.onMessage('c-1', msg({ t: 'test', value: 1 }));
  clock.t += IDLE_MS - 10;
  await hub.onMessage('c-1', msg({ t: 'test', value: 2 }));
  clock.t += 20;
  assert.deepEqual(await hub.onAlarm(), { expired: false });
  assert.ok(storage.alarm > clock.t);
});

test('events log keeps the newest 20', async () => {
  const { hub, clock } = makeHub();
  for (let i = 0; i < 25; i++) { clock.t += 50; await hub.onMessage('c-1', msg({ t: 'test', value: i })); }
  const s = await hub.state();
  assert.equal(s.events.length, 20);
  assert.equal(s.rev, 25);
});

test('nibp with a stale "after" is ignored (several monitors, one reading)', async () => {
  const { hub, clock } = makeHub();
  const at0 = (await hub.state()).patients[0].nibpRead.at;
  clock.t += 10;
  const first = await hub.onMessage('m-1', msg({ t: 'nibp', after: at0 }));
  assert.equal(first.broadcast.state.rev, 1);
  const second = await hub.onMessage('m-2', msg({ t: 'nibp', after: at0 }));
  assert.deepEqual(second, {});
  assert.equal((await hub.state()).rev, 1);
});

test('one bad value rejects the whole set', async () => {
  const { hub } = makeHub();
  const r = await hub.onMessage('c-1', msg({ t: 'set', patch: { patient: { hr: 100 }, modules: 'x' } }));
  assert.equal(r.reply.code, 'bad_patch');
  assert.equal((await hub.state()).patients[0].hr, 80);
});

test('patients: set targets one patient by id; default is the first', async () => {
  const { hub } = makeHub();
  const add = await hub.onMessage('c-1', msg({ t: 'addPatient', label: 'Bed B' }));
  const ids = add.broadcast.state.patients.map((p) => p.id);
  assert.deepEqual(ids, ['p1', 'p2']);
  await hub.onMessage('c-1', msg({ t: 'set', p: 'p2', patch: { patient: { hr: 40, off: { spo2: true } } } }));
  const s = await hub.state();
  assert.equal(s.patients[0].hr, 80);
  assert.equal(s.patients[1].hr, 40);
  assert.equal(s.patients[1].off.spo2, true);
  assert.equal(s.patients[1].off.ecg, false);
  const bad = await hub.onMessage('c-1', msg({ t: 'set', p: 'zz', patch: { patient: { hr: 40 } } }));
  assert.equal(bad.reply.code, 'bad_patch');
});

test('patients: glide and NIBP are per patient', async () => {
  const { hub } = makeHub();
  await hub.onMessage('c-1', msg({ t: 'addPatient' }));
  await hub.onMessage('c-1', msg({ t: 'set', p: 'p2', patch: { patient: { hr: 150 } }, glideMs: 5000 }));
  const s = await hub.state();
  assert.equal(s.patients[0].glide.durationMs, 0);
  assert.equal(s.patients[1].glide.durationMs, 5000);
  const at0 = s.patients[0].nibpRead.at;
  const r = await hub.onMessage('c-1', msg({ t: 'nibp', p: 'p2' }));
  assert.equal(r.broadcast.state.patients[0].nibpRead.at, at0);
});

test('patients: max 8, cannot remove the last, remove by id', async () => {
  const { hub } = makeHub();
  for (let i = 0; i < 7; i++) assert.ok((await hub.onMessage('c-1', msg({ t: 'addPatient' }))).broadcast);
  assert.equal((await hub.onMessage('c-1', msg({ t: 'addPatient' }))).reply.code, 'bad_patch');
  assert.ok((await hub.onMessage('c-1', msg({ t: 'removePatient', p: 'p3' }))).broadcast);
  assert.equal((await hub.state()).patients.length, 7);
  const { hub: one } = makeHub();
  assert.equal((await one.onMessage('c-1', msg({ t: 'removePatient', p: 'p1' }))).reply.code, 'bad_patch');
  assert.equal((await hub.onMessage('c-1', msg({ t: 'removePatient', p: 'nope' }))).reply.code, 'bad_patch');
});

test('events carry kind and patient id; mark adds a bookmark', async () => {
  const { hub } = makeHub();
  await hub.onMessage('c-1', msg({ t: 'set', patch: { patient: { rhythm: 'vf' } } }));
  await hub.onMessage('c-1', msg({ t: 'set', patch: { patient: { hr: 90 } } }));
  await hub.onMessage('c-1', msg({ t: 'mark', text: 'shock given' }));
  await hub.onMessage('c-1', msg({ t: 'mark', p: 'p1' }));
  const ev = (await hub.state()).events;
  assert.deepEqual(ev.map((e) => e.kind), ['rhythm', 'set', 'bookmark', 'bookmark']);
  assert.equal(ev[0].p, 'p1');
  assert.equal(ev[2].what, 'mark shock given');
  assert.equal(ev[2].p, undefined);
  assert.equal((await hub.onMessage('c-1', msg({ t: 'mark', p: 'zz' }))).reply.code, 'bad_patch');
  assert.equal((await hub.onMessage('c-1', msg({ t: 'mark', text: 'x'.repeat(201) }))).reply.code, 'bad_patch');
});

test('theme: a custom theme reaches every monitor; "default" clears it; a bad theme is rejected', async () => {
  const { hub } = makeHub();
  const themeJson = { themeSchema: 1, name: 'T', colors: { ecg: '#112233' } };
  const a = await hub.onMessage('c-1', msg({ t: 'set', patch: { theme: 'custom', themeJson } }));
  assert.equal(a.broadcast.state.theme, 'custom');
  assert.equal(a.broadcast.state.themeJson.colors.ecg, '#112233');
  const bad = await hub.onMessage('c-1', msg({ t: 'set', patch: { theme: 'custom', themeJson: { css: 'x', colors: {} } } }));
  assert.equal(bad.reply.code, 'bad_patch');
  assert.equal((await hub.hello()).state.themeJson.colors.ecg, '#112233', 'the old theme is kept');
  const c = await hub.onMessage('c-1', msg({ t: 'set', patch: { theme: 'default' } }));
  assert.equal(c.broadcast.state.theme, 'default');
  assert.equal('themeJson' in c.broadcast.state, false);
});

test('glide: a change to one vital keeps the time the others still had left', async () => {
  const { hub, clock } = makeHub();
  const s0 = (await hub.state()).patients[0];
  const start = s0.spo2;
  await hub.onMessage('c-1', msg({ t: 'set', patch: { patient: { hr: 120, spo2: 85 } }, glideMs: 60000 }));
  clock.t += 10000;
  const r = await hub.onMessage('c-1', msg({ t: 'set', patch: { patient: { temp: 38.5 } }, glideMs: 2000 }));
  const pt = r.broadcast.state.patients[0];
  assert.ok(Math.abs(pt.glide.glideMsBy.spo2 - 50000) <= 1, `spo2 left ${pt.glide.glideMsBy.spo2}`);
  assert.ok(Math.abs(pt.glide.glideMsBy.hr - 50000) <= 1);
  assert.equal(pt.glide.glideMsBy.temp, 2000);
  assert.ok(Math.abs(pt.glide.durationMs - 50000) <= 1);
  clock.t += 20000;
  const shown = displayed(pt, clock.t).spo2;
  assert.ok(shown < start && shown > 85, `spo2 shown ${shown} at +30 s should be mid-glide`);
  assert.equal(displayed(pt, clock.t).temp, 38.5);
});

test('glide: a field in the new patch takes the new time, from the value shown, even mid-glide', async () => {
  const { hub, clock } = makeHub();
  await hub.onMessage('c-1', msg({ t: 'set', patch: { patient: { hr: 180, spo2: 85 } }, glideMs: 10000 }));
  clock.t += 5000;
  const mid = displayed((await hub.state()).patients[0], clock.t).hr;
  const r = await hub.onMessage('c-1', msg({ t: 'set', patch: { patient: { hr: 60 } }, glideMs: 20000 }));
  const g = r.broadcast.state.patients[0].glide;
  assert.equal(g.glideMsBy.hr, 20000);
  assert.ok(Math.abs(g.glideMsBy.spo2 - 5000) <= 1);
  assert.equal(g.durationMs, 20000);
  assert.ok(Math.abs(g.from.hr - mid) < 0.5);
});

test('glide: with nothing mid-glide, a uniform set stays a plain record', async () => {
  const { hub } = makeHub();
  const r = await hub.onMessage('c-1', msg({ t: 'set', patch: { patient: { hr: 100 } }, glideMs: 7000 }));
  const g = r.broadcast.state.patients[0].glide;
  assert.equal(g.glideMsBy, undefined);
  assert.equal(g.durationMs, 7000);
});

test('glide: an NIBP-only change keeps a running HR glide', async () => {
  const { hub, clock } = makeHub();
  await hub.onMessage('c-1', msg({ t: 'set', patch: { patient: { hr: 150 } }, glideMs: 60000 }));
  clock.t += 15000;
  const r = await hub.onMessage('c-1', msg({ t: 'set', patch: { patient: { nibp: { sys: 80, dia: 45 } } }, glideMs: 3000 }));
  const pt = r.broadcast.state.patients[0];
  assert.equal(pt.glide.glideMsBy.nibp, 3000);
  assert.ok(Math.abs(pt.glide.glideMsBy.hr - 45000) <= 1);
  assert.deepEqual(displayed(pt, clock.t + 3000).nibp, { sys: 80, dia: 45 });
});

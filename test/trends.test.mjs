// Room log (SQLite rows), history reply, trends rebuilt from glide records, debrief file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { RoomHub, IDLE_MS } from '../src/room/hub.js';
import { MAX_LOG_ROWS, memoryLog, sqlLog } from '../src/room/log.js';
import { displayed } from '../src/engine/glide.js';
import { groupsFor, numericsAt, sampleSeries, TREND_GROUPS } from '../src/trends/series.js';
import { trendSvg, trendTable } from '../src/trends/chart.js';
import { debriefData, debriefHtml, debriefJson } from '../src/trends/debrief.js';
import { fakeStorage, msg } from './fake.mjs';

/** A fake storage whose `sql` is a real SQLite database (node:sqlite), shaped like the Durable Object's `sql.exec`. */
function sqlStorage(db = new DatabaseSync(':memory:')) {
  const s = fakeStorage();
  s.db = db;
  s.sql = {
    exec(query, ...b) {
      const st = db.prepare(query);
      const rows = /^\s*select/i.test(query) ? st.all(...b) : (st.run(...b), []); // runs at once, like the Durable Object
      return { toArray: () => rows };
    },
  };
  return s;
}
function makeSqlHub(start = 1_000_000, storage = sqlStorage()) {
  const clock = { t: start };
  return { hub: new RoomHub(storage, () => clock.t), storage, clock };
}
const send = async (hub, clock, who, o, dt = 1000) => { clock.t += dt; return hub.onMessage(who, msg(o)); };

test('every event is kept as a SQLite row past the 20 shown in state', async () => {
  const { hub, storage, clock } = makeSqlHub();
  for (let i = 0; i < 60; i++) await send(hub, clock, 'c-1', { t: 'mark', text: `m${i}` });
  const st = await hub.state();
  assert.equal(st.events.length, 20);
  assert.equal(storage.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 60);
  const h = await hub.history({}, clock.t);
  assert.equal(h.events.length, 60);
  assert.equal(h.events[0].what, 'mark m0');
  assert.equal(h.events[59].what, 'mark m59');
});

test('the log survives a restart (hibernation wake) because it is in storage', async () => {
  const { hub, storage, clock } = makeSqlHub();
  for (let i = 0; i < 25; i++) await send(hub, clock, 'c-1', { t: 'set', patch: { patient: { hr: 60 + i } }, glideMs: 5000 });
  const woke = new RoomHub(storage, () => clock.t);
  const h = await woke.history({}, clock.t);
  assert.equal(h.events.length, 25);
  assert.equal(h.glides.length, 25);
});

test('a bookmark from the phone appears in the log with its text and bed', async () => {
  const { hub, clock } = makeSqlHub();
  await send(hub, clock, 'c-ab12', { t: 'mark', p: 'p1', text: 'induction' });
  const h = await hub.history({}, clock.t);
  const m = h.events.find((e) => e.kind === 'bookmark');
  assert.ok(m);
  assert.equal(m.what, 'mark induction');
  assert.equal(m.p, 'p1');
  assert.equal(m.by, 'c-ab12');
});

test('history window: range limits events, the glide in force at the window start is included, expiry is reported', async () => {
  const { hub, clock } = makeSqlHub();
  await send(hub, clock, 'c-1', { t: 'set', patch: { patient: { hr: 100 } }, glideMs: 0 });
  await send(hub, clock, 'c-1', { t: 'mark', text: 'old' }, 3 * 3600_000);
  await send(hub, clock, 'c-1', { t: 'mark', text: 'new' }, 120_000);
  const h = await hub.history({ range: 60_000 }, clock.t);
  assert.deepEqual(h.events.map((e) => e.what), ['mark new']);
  assert.equal(h.glides.length, 1); // the hr 100 change, started before the window, still in force
  assert.equal(h.expiresAt, clock.t + IDLE_MS);
  const all = await hub.history({ all: true }, clock.t);
  assert.equal(all.events.length, 3);
});

test('the log is deleted with the room', async () => {
  const { hub, storage, clock } = makeSqlHub();
  await send(hub, clock, 'c-1', { t: 'mark' });
  clock.t += IDLE_MS;
  await hub.onAlarm();
  const h = await hub.history({ all: true }, clock.t);
  assert.equal(h.events.length, 0);
  assert.equal(storage.data.size, 0);
});

test('log is capped', async () => {
  const log = sqlLog(sqlStorage().sql);
  for (let i = 0; i < MAX_LOG_ROWS + 30; i++) log.addEvent({ t: i, by: 'c', kind: 'x', what: String(i) });
  const rows = log.events(0, MAX_LOG_ROWS + 100);
  assert.equal(rows.length, MAX_LOG_ROWS);
  assert.equal(rows.at(-1).what, String(MAX_LOG_ROWS + 29));
});

test('memory log matches the SQL log', () => {
  const a = memoryLog(), b = sqlLog(sqlStorage().sql);
  const g = (t, p) => ({ t, p, dur: 0, from: { hr: 1 }, to: { hr: 2 } });
  for (const l of [a, b]) {
    l.addEvent({ t: 5, by: 'c', kind: 'k', what: 'w', p: 'p1' }); l.addEvent({ t: 9, by: 'c', kind: 'k', what: 'z' });
    l.addGlide(g(1, 'p1')); l.addGlide(g(4, 'p1')); l.addGlide(g(2, 'p2')); l.addGlide(g(8, 'p1'));
  }
  const strip = (r) => r.map(({ id, ...x }) => x);
  assert.deepEqual(strip(a.events(6, 10)), strip(b.events(6, 10)));
  assert.deepEqual(a.glides(6), b.glides(6));
});

test('trend values equal displayed() at sampled times, including mid-glide and after a second change', async () => {
  const { hub, clock } = makeSqlHub();
  const snaps = []; // what the room showed, taken from the live state at known times
  const snap = async () => { const st = await hub.state(); snaps.push({ t: clock.t, d: displayed(st.patients[0], clock.t) }); };
  await snap();
  await send(hub, clock, 'c-1', { t: 'set', patch: { patient: { hr: 120, spo2: 90, nibp: { sys: 150, dia: 90 } } }, glideMs: 60_000 });
  await snap();
  for (let i = 0; i < 6; i++) { clock.t += 7_000; await snap(); } // mid-glide
  await send(hub, clock, 'c-1', { t: 'set', patch: { patient: { hr: 50, temp: 35.2 } }, glideMs: 20_000 }, 3_000); // second change mid-glide
  await snap();
  for (let i = 0; i < 6; i++) { clock.t += 5_000; await snap(); }
  await send(hub, clock, 'c-1', { t: 'set', patch: { patient: { rhythm: 'vf' } } }, 1_000); // no numerics: no glide row
  await snap();
  const h = await hub.history({ all: true }, clock.t);
  assert.equal(h.glides.length, 2);
  const mine = h.glides.filter((g) => g.p === 'p1');
  const keys = ['hr', 'spo2', 'etco2', 'rr', 'temp'];
  for (const s of snaps.slice(1)) {
    const d = numericsAt(mine, s.t, null);
    for (const k of keys) assert.ok(Math.abs(d[k] - s.d[k]) < 1e-9, `${k} at +${s.t - 1_000_000}`);
    assert.ok(Math.abs(d.nibp.sys - s.d.nibp.sys) < 1e-9);
  }
  // the sampled series carries the same numbers under its own keys
  const series = sampleSeries({ glides: h.glides, p: 'p1', from: 1_000_000, to: clock.t, points: 50, groups: TREND_GROUPS });
  const mid = series[20];
  const direct = numericsAt(mine, mid.t, null);
  assert.equal(mid.v.hr, direct.hr);
  assert.equal(mid.v.nibpSys, direct.nibp.sys);
});

test('a room nobody has changed falls back to the bed in state', async () => {
  const { hub, clock } = makeSqlHub();
  const st = await hub.state();
  const series = sampleSeries({ glides: [], p: 'p1', from: clock.t - 1000, to: clock.t, points: 3, groups: TREND_GROUPS, fallback: st.patients[0] });
  assert.equal(series[0].v.hr, st.patients[0].hr);
});

test('groups follow the modules', () => {
  assert.ok(!groupsFor(['ecg']).some((g) => g.id === 'cvp'));
  assert.ok(groupsFor(['ecg', 'cvp', 'abp']).some((g) => g.id === 'cvp'));
});

test('graph and table are built from the same series', async () => {
  const { hub, clock } = makeSqlHub();
  await send(hub, clock, 'c-1', { t: 'set', patch: { patient: { hr: 130 } }, glideMs: 30_000 });
  await send(hub, clock, 'c-1', { t: 'mark', text: 'b1' }, 10_000);
  clock.t += 30_000;
  const h = await hub.history({}, clock.t);
  const groups = groupsFor((await hub.state()).modules);
  const series = sampleSeries({ glides: h.glides, p: 'p1', from: clock.t - 60_000, to: clock.t, points: 30, groups });
  const svg = trendSvg({ series, groups, events: h.events, p: 'p1', from: clock.t - 60_000, to: clock.t });
  assert.match(svg, /data-event="bookmark"/);
  assert.match(svg, /data-series="hr"/);
  const table = trendTable({ series, groups, rows: 4 });
  assert.equal((table.match(/<tr data-t/g) ?? []).length, 4);
  const lastHr = table.match(/data-key="hr">(\d+)</g).at(-1);
  assert.equal(lastHr, `data-key="hr">${Math.round(series.at(-1).v.hr)}<`);
  assert.equal(Math.round(series.at(-1).v.hr), 130);
});

test('debrief HTML is one self-contained file with chart, events and embedded data', async () => {
  const { hub, clock } = makeSqlHub();
  await send(hub, clock, 'c-1', { t: 'set', patch: { patient: { hr: 40 } }, glideMs: 5000 });
  await send(hub, clock, 'c-1', { t: 'mark', text: '<b>"intubation"</b> & </script>' }, 2000);
  clock.t += 5000;
  const state = await hub.state();
  const h = await hub.history({ all: true }, clock.t);
  const data = debriefData({ code: 'ABCD', state, history: h, now: clock.t });
  const html = debriefHtml(data);
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<svg[^>]*class="trend-svg"/);
  assert.match(html, /Bed 1/);
  assert.ok(!html.includes('<b>"intubation"'), 'event text is escaped');
  assert.ok(html.includes('&lt;b&gt;'));
  assert.ok(!/<script[^>]*\bsrc=|<link[^>]*href=|<img|@import|url\(/i.test(html), 'nothing is loaded from outside');
  const embedded = html.match(/<script type="application\/json" id="debrief-data">([\s\S]*?)<\/script>/)[1];
  assert.ok(!embedded.includes('</script>'));
  const parsed = JSON.parse(embedded);
  assert.equal(parsed.events.length, h.events.length);
  assert.equal(parsed.room, 'ABCD');
  const json = JSON.parse(debriefJson(data));
  assert.equal(json.glides.length, h.glides.length);
  assert.equal(json.beds[0].fallback, undefined);
});

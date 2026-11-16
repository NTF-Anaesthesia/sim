import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomClient, roomUrl, BACKOFF_MS } from '../src/room/client.js';

class FakeWS {
  static all = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeWS.all.push(this); }
  send(t) { this.sent.push(JSON.parse(t)); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen(); }
  recv(o) { this.onmessage({ data: JSON.stringify(o) }); }
  drop(code = 1006) { this.readyState = 3; this.onclose({ code }); }
}

function make() {
  FakeWS.all = [];
  const timers = [];
  let t = 1000;
  const c = new RoomClient({
    url: 'wss://x/ws/ABC234?role=monitor&id=m-1', WebSocketCtor: FakeWS, now: () => t,
    setTimer: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length - 1; },
    clearTimer: (id) => { if (timers[id]) timers[id].cleared = true; },
  });
  /** timers still pending (set, not cleared) with this delay */
  const live = (ms) => timers.filter((x) => x.ms === ms && !x.cleared);
  return { c, timers, live, setNow: (v) => { t = v; } };
}

test('roomUrl builds wss for https and ws for http', () => {
  assert.equal(roomUrl({ protocol: 'https:', host: 'a.b' }, 'ABC234', 'monitor', 'm-1'), 'wss://a.b/ws/ABC234?role=monitor&id=m-1');
  assert.equal(roomUrl({ protocol: 'http:', host: 'localhost:8787' }, 'ABC234', 'controller', 'c-1'), 'ws://localhost:8787/ws/ABC234?role=controller&id=c-1');
});

test('connects, receives state, sends', () => {
  const { c } = make();
  const seen = [];
  c.on('state', (s) => seen.push(s.rev));
  c.connect();
  const ws = FakeWS.all[0];
  ws.open();
  assert.equal(c.status, 'open');
  ws.recv({ t: 'state', state: { schema: 1, rev: 3 }, now: 5000 });
  assert.deepEqual(seen, [3]);
  assert.equal(c.serverNow(), 5000);
  assert.ok(c.set({ patient: { hr: 90 } }, 2000));
  assert.deepEqual(ws.sent.at(-1), { t: 'set', patch: { patient: { hr: 90 } }, glideMs: 2000 });
});

test('reconnects with backoff 0.5 1 2 4 8 8', () => {
  const { c, timers } = make();
  c.connect();
  const waits = [];
  for (let i = 0; i < 6; i++) {
    FakeWS.all.at(-1).drop();
    waits.push(timers.at(-1).ms);
    timers.at(-1).fn();
  }
  assert.deepEqual(waits, [500, 1000, 2000, 4000, 8000, 8000]);
  assert.deepEqual(BACKOFF_MS, [500, 1000, 2000, 4000, 8000]);
});

test('room full (4002) does not reconnect', () => {
  const { c, timers } = make();
  c.connect();
  FakeWS.all[0].drop(4002);
  assert.equal(c.status, 'full');
  assert.equal(timers.filter((t) => t.ms < 9000 && t.ms !== 10000).length, 0);
});

test('clock offset uses the smallest round trip', () => {
  const { c, setNow } = make();
  c.connect();
  const ws = FakeWS.all[0];
  ws.open();
  setNow(1000); c.sendPing();
  setNow(1100); ws.recv({ t: 'pong', n: 2, now: 10050 });
  assert.equal(c.offsetMs, 10050 + 50 - 1100);
  setNow(2000); c.sendPing();
  setNow(2600); ws.recv({ t: 'pong', n: 3, now: 0 }); // slower round trip: ignored
  assert.equal(c.offsetMs, 10050 + 50 - 1100);
});

test('newer schema is refused, not drawn', () => {
  const { c } = make();
  const errors = [];
  c.on('error', (e) => errors.push(e.code));
  c.connect();
  FakeWS.all[0].open();
  FakeWS.all[0].recv({ t: 'state', state: { schema: 2 }, now: 1 });
  assert.deepEqual(errors, ['schema']);
  assert.equal(c.state, null);
});

test('a socket replaced while still connecting never goes live', () => {
  const { c, timers, live } = make();
  c.connect();
  const old = FakeWS.all[0];
  const oldOpen = old.onopen; // what a late open event would still run if the handler was kept
  c.reconnectNow();
  assert.equal(old.onopen, null);
  assert.equal(old.readyState, 3);
  const fresh = FakeWS.all[1];
  fresh.open();
  assert.equal(c.status, 'open');
  // the old socket opens late anyway (slow network)
  old.readyState = 1;
  const statuses = [];
  c.on('status', (s) => statuses.push(s));
  oldOpen();
  assert.deepEqual(statuses, []);
  assert.equal(old.readyState, 3, 'closed again at once');
  assert.equal(old.sent.length, 0, 'no ping on the old socket');
  assert.equal(c.ws, fresh);
  assert.equal(live(10000).length, 1, 'exactly one ping chain');
  // running the chain keeps it at one
  timers.find((x) => x.ms === 10000 && !x.cleared).fn();
  assert.equal(live(10000).length, 1);
});

test('wake on a dead socket replaces it without a second ping chain', () => {
  const { c, live } = make();
  c.connect();
  const old = FakeWS.all[0];
  old.readyState = 2; // closing, no close event yet
  c.wake();
  assert.equal(FakeWS.all.length, 2);
  FakeWS.all[1].open();
  assert.equal(live(10000).length, 1);
});

test('the ping loop stops after close()', () => {
  const { c, timers, live } = make();
  c.connect();
  FakeWS.all[0].open();
  const chain = timers.find((x) => x.ms === 10000);
  c.close();
  const before = timers.length;
  chain.fn(); // a timer that fired anyway
  assert.equal(timers.length, before, 'not rescheduled');
  assert.equal(live(10000).length, 0);
});

test('a ping chain from a replaced socket ends', () => {
  const { c, timers } = make();
  c.connect();
  FakeWS.all[0].open();
  const chain = timers.find((x) => x.ms === 10000);
  c.reconnectNow();
  FakeWS.all[1].open();
  const sentBefore = FakeWS.all[1].sent.length;
  const before = timers.length;
  chain.fn();
  assert.equal(timers.length, before);
  assert.equal(FakeWS.all[1].sent.length, sentBefore);
});

test('server clock follows a local clock step', () => {
  const { c, setNow } = make();
  c.connect();
  const ws = FakeWS.all[0];
  setNow(1000); ws.open(); // ping n=1
  setNow(1040); ws.recv({ t: 'pong', n: 1, now: 50020 }); // server = local + 49000
  assert.equal(c.serverNow(), 50040);
  // local clock jumps 5 s ahead (NTP step on wake); server time keeps going normally
  setNow(2000); c.sendPing(); // n=2, server ~51000
  setNow(7050); ws.recv({ t: 'pong', n: 2, now: 51030 }); // step landed mid-ping: huge rtt, ignored
  setNow(8000); c.sendPing(); // n=3, server ~51960
  setNow(8040); ws.recv({ t: 'pong', n: 3, now: 51980 });
  setNow(8100);
  assert.ok(Math.abs(c.serverNow() - 52060) <= 50, `serverNow ${c.serverNow()}`);
});

test('a reconnect starts a fresh clock estimate', () => {
  const { c, setNow } = make();
  c.connect();
  setNow(1000); FakeWS.all[0].open(); // n=1
  setNow(1010); FakeWS.all[0].recv({ t: 'pong', n: 1, now: 11005 }); // rtt 10, offset 10000
  assert.equal(c.offsetMs, 10000);
  FakeWS.all[0].drop();
  c.connect();
  setNow(2000); FakeWS.all[1].open(); // n=2
  setNow(2200); FakeWS.all[1].recv({ t: 'pong', n: 2, now: 12150 }); // rtt 200 (worse), offset 10050
  assert.equal(c.offsetMs, 10050);
  assert.equal(c.bestRtt, 200);
});

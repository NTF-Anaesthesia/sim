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
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; }, clearTimer: () => {},
  });
  return { c, timers, setNow: (v) => { t = v; } };
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

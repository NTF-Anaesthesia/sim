import test from 'node:test';
import assert from 'node:assert/strict';
import { WAKE_UNSUPPORTED_TITLE, requestWake, soundPrompt, wakeLabel } from '../src/monitor/device.js';
import { createSettings } from '../src/monitor/settings.js';

const L = (o) => wakeLabel({ wanted: false, held: false, supported: true, failed: false, ...o });

test('keep awake label: off, held, waiting, not supported', () => {
  assert.deepEqual(L({}), { text: 'Keep awake', title: '' });
  assert.equal(L({ supported: false }).text, 'Keep awake'); // no wish: nothing new on a fresh device
  assert.deepEqual(L({ wanted: true, held: true }), { text: 'Awake on', title: '' });
  assert.equal(L({ wanted: true }).text, 'Keep awake…');
  for (const o of [{ supported: false }, { failed: true }, { supported: false, held: true }, { failed: true, held: true }]) {
    const l = L({ wanted: true, ...o });
    assert.equal(l.text, 'Awake: not supported', JSON.stringify(o));
    assert.equal(l.title, WAKE_UNSUPPORTED_TITLE);
  }
  // 'Awake on' only while a lock is held
  for (const wanted of [false, true]) for (const held of [false, true]) for (const supported of [false, true]) for (const failed of [false, true]) {
    if (wakeLabel({ wanted, held, supported, failed }).text === 'Awake on') assert.ok(wanted && held && supported && !failed);
  }
});

test('sound prompt only when sound is wanted and not running', () => {
  assert.equal(soundPrompt({ soundWanted: false, running: false }), false);
  assert.equal(soundPrompt({ soundWanted: false, running: true }), false);
  assert.equal(soundPrompt({ soundWanted: true, running: true }), false);
  assert.equal(soundPrompt({ soundWanted: true, running: false }), true);
});

test('sound and wake settings default off, round-trip, survive broken storage', () => {
  const mem = new Map();
  const store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  const s = createSettings(store);
  assert.equal(s.get('sound', false), false);
  assert.equal(s.get('wake', false), false);
  s.set('sound', true); s.set('wake', true);
  const again = createSettings(store);
  assert.equal(again.get('sound', false), true);
  assert.equal(again.get('wake', false), true);
  again.set('sound', false);
  assert.equal(createSettings(store).get('sound', false), false);
  const none = createSettings(null);
  none.set('sound', true);
  assert.equal(none.get('sound', false), false);
  const throwing = createSettings({ getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } });
  throwing.set('wake', true);
  assert.equal(throwing.get('wake', false), false);
});

test('requestWake: missing, rejecting, resolving', async () => {
  assert.deepEqual(await requestWake(undefined), { state: 'unsupported' });
  assert.deepEqual(await requestWake({}), { state: 'unsupported' });
  assert.deepEqual(await requestWake({ wakeLock: { request: () => Promise.reject(new Error('NotAllowedError')) } }), { state: 'failed' });
  assert.deepEqual(await requestWake({ wakeLock: { request: () => { throw new Error('sync'); } } }), { state: 'failed' });
  const sentinel = { released: false };
  let asked = '';
  const r = await requestWake({ wakeLock: { request: (t) => { asked = t; return Promise.resolve(sentinel); } } });
  assert.equal(r.state, 'held');
  assert.equal(r.sentinel, sentinel);
  assert.equal(asked, 'screen');
});

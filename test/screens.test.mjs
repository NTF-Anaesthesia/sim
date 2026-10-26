// Named screens (V2 S1): addScreen, screens.<id>.* patch paths, forget, identify / clearDevice, iam and presence,
// theme precedence (device > screen > room > default).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHub, msg } from './fake.mjs';
import { presenceMessage } from '../src/room/presence.js';
import { validateIam, validatePatch, MAX_SCREENS } from '../src/shared/schema.js';
import { pickTheme } from '../src/theme/store.js';
import { LIGHT_THEME } from '../src/theme/builtin.js';
import { DEFAULT_THEME } from '../src/theme/default.js';

const add = async (hub, o = {}) => hub.onMessage('m-1', msg({ t: 'addScreen', ...o }));

test('addScreen makes s1, s2 with default names and kind monitor; the sender gets the id', async () => {
  const { hub } = makeHub();
  const a = await add(hub, { name: '  Bay laptop ' });
  assert.deepEqual(a.reply, { t: 'screenAdded', s: 's1' });
  assert.deepEqual(a.broadcast.state.screens.s1, { name: 'Bay laptop', kind: 'monitor' });
  const b = await add(hub);
  assert.equal(b.reply.s, 's2');
  assert.equal(b.broadcast.state.screens.s2.name, 'Screen 2');
  assert.equal(b.broadcast.state.schema, 1);
  assert.equal(b.broadcast.state.events.at(-1).kind, 'screen');
  const d = await add(hub, { kind: 'defib' }); // reserved kind is stored now
  assert.equal(d.broadcast.state.screens.s3.kind, 'defib');
  for (const bad of [{ kind: 'tv' }, { name: 'x'.repeat(25) }, { name: 5 }]) {
    const r = await add(hub, bad);
    assert.equal(r.reply.code, 'bad_patch', JSON.stringify(bad));
    assert.equal(r.broadcast, undefined);
  }
});

test('at most MAX_SCREENS screens; a forgotten id is reused', async () => {
  const { hub } = makeHub();
  for (let i = 0; i < MAX_SCREENS; i++) await add(hub);
  assert.equal((await add(hub)).reply.code, 'bad_patch');
  await hub.onMessage('c-1', msg({ t: 'forgetScreen', s: 's3' }));
  assert.equal((await add(hub)).reply.s, 's3');
});

test('screens patch paths: name, p, modules, theme, themeJson; null follows again', async () => {
  const { hub } = makeHub();
  await add(hub);
  await hub.onMessage('c-1', msg({ t: 'addPatient' }));
  const set = (patch) => hub.onMessage('c-1', msg({ t: 'set', patch: { screens: { s1: patch } } }));
  let r = await set({ name: 'Left', p: 'p2', modules: ['ecg', 'abp', 'ecg'], theme: 'light' });
  assert.deepEqual(r.broadcast.state.screens.s1, { name: 'Left', kind: 'monitor', p: 'p2', modules: ['ecg', 'abp'], theme: 'light' });
  assert.deepEqual(r.broadcast.state.modules, ['ecg', 'spo2', 'etco2', 'nibp', 'rr', 'temp'], 'room modules unchanged');
  r = await set({ themeJson: LIGHT_THEME });
  assert.equal(r.broadcast.state.screens.s1.theme, 'custom');
  assert.equal(r.broadcast.state.screens.s1.themeJson.name, 'Generic light');
  r = await set({ theme: 'default' });
  assert.equal(r.broadcast.state.screens.s1.themeJson, undefined, 'a built-in drops the imported theme');
  r = await set({ p: null, modules: null, theme: null });
  assert.deepEqual(r.broadcast.state.screens.s1, { name: 'Left', kind: 'monitor' });
});

test('screens patch rejects unknown screens, fields, patients and bad values', async () => {
  const { hub } = makeHub();
  await add(hub);
  for (const screens of [
    { s2: { name: 'x' } }, { s1: { kind: 'defib' } }, { s1: { evil: 1 } }, { s1: { p: 'p9' } }, { s1: { name: '' } },
    { s1: { modules: 'ecg' } }, { s1: { theme: 'brand' } }, { s1: { theme: 'custom' } }, { s1: { themeJson: { themeSchema: 99 } } },
    { x1: {} }, { s1: 'x' }, [],
  ]) {
    const r = await hub.onMessage('c-1', msg({ t: 'set', patch: { screens } }));
    assert.equal(r.reply?.code, 'bad_patch', JSON.stringify(screens));
    assert.equal(r.broadcast, undefined);
  }
  assert.deepEqual((await hub.state()).screens.s1, { name: 'Screen 1', kind: 'monitor' });
});

test('forget removes a screen; removing a patient clears screens that showed it', async () => {
  const { hub } = makeHub();
  await add(hub);
  await add(hub);
  await hub.onMessage('c-1', msg({ t: 'addPatient' }));
  await hub.onMessage('c-1', msg({ t: 'set', patch: { screens: { s2: { p: 'p2' } } } }));
  const r = await hub.onMessage('c-1', msg({ t: 'removePatient', p: 'p2' }));
  assert.equal(r.broadcast.state.screens.s2.p, undefined);
  const f = await hub.onMessage('c-1', msg({ t: 'forgetScreen', s: 's1' }));
  assert.deepEqual(Object.keys(f.broadcast.state.screens), ['s2']);
  assert.equal((await hub.onMessage('c-1', msg({ t: 'forgetScreen', s: 's1' }))).reply.code, 'bad_patch');
});

test('identify and clearDevice go to every socket, change nothing, need a known screen', async () => {
  const { hub } = makeHub();
  await add(hub);
  const rev = (await hub.state()).rev;
  assert.deepEqual((await hub.onMessage('c-1', msg({ t: 'identify', s: 's1' }))).broadcast, { t: 'identify', s: 's1', ms: 3000 });
  assert.deepEqual((await hub.onMessage('c-1', msg({ t: 'clearDevice', s: 's1', what: 'theme' }))).broadcast, { t: 'clearDevice', s: 's1', what: 'theme' });
  assert.equal((await hub.onMessage('c-1', msg({ t: 'clearDevice', s: 's1', what: 'all' }))).reply.code, 'bad_patch');
  assert.equal((await hub.onMessage('c-1', msg({ t: 'identify', s: 's9' }))).reply.code, 'bad_patch');
  assert.equal((await hub.state()).rev, rev);
});

test('iam is checked and handed to the room; presence lists online screens once, device choices merged', async () => {
  const { hub } = makeHub();
  assert.deepEqual((await hub.onMessage('m-1', msg({ t: 'iam', s: 's1', dev: ['theme'] }))).iam, { s: 's1', dev: ['theme'] });
  assert.deepEqual((await hub.onMessage('m-1', msg({ t: 'iam', s: null }))).iam, { s: null, dev: [] });
  assert.equal((await hub.onMessage('m-1', msg({ t: 'iam', s: '../x' }))).reply.code, 'bad_patch');
  assert.equal(validateIam({ s: 's1', dev: ['volume'] }).ok, false);
  assert.deepEqual(presenceMessage([
    { role: 'monitor', s: 's1', dev: ['theme'] }, { role: 'monitor', s: 's1', dev: ['p'] }, { role: 'monitor' },
    { role: 'monitor', s: 's2', dev: [] }, { role: 'controller', s: 's3' },
  ]), { t: 'presence', monitors: 4, controllers: 1, screens: [{ s: 's1', dev: ['theme', 'p'] }, { s: 's2', dev: [] }] });
});

test('V1 patches still pass unchanged', () => {
  assert.deepEqual(validatePatch({ modules: ['ecg'], theme: 'default' }), { ok: true, patch: { modules: ['ecg'], theme: 'default' } });
});

test('theme precedence: device > screen > room > default', () => {
  const room = { theme: 'custom', themeJson: { ...DEFAULT_THEME, name: 'Room one' } };
  const screen = { theme: 'light' };
  assert.equal(pickTheme({ id: 'default' }, room, screen).source, 'device');
  assert.deepEqual(pickTheme(null, room, screen), { raw: LIGHT_THEME, source: 'screen' });
  assert.equal(pickTheme(null, room, { theme: 'custom', themeJson: { name: 'Mine' } }).raw.name, 'Mine');
  assert.equal(pickTheme(null, room, {}).source, 'room');
  assert.equal(pickTheme(null, room, null).source, 'room');
  assert.equal(pickTheme(null, { theme: 'default' }, undefined).source, 'default');
});

test('screen names are trimmed before the length check, in addScreen and rename alike', async () => {
  const { screenName } = await import('../src/shared/schema.js');
  assert.equal(screenName('  ' + 'a'.repeat(23) + ' '), 'a'.repeat(23));
  assert.equal(screenName('   '), null);
  assert.equal(screenName('a'.repeat(25)), null);
  assert.equal(screenName(3), null);
});

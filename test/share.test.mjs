import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHub, msg } from './fake.mjs';
import { SAFE_QR_CHARS, decodeScenario, encodeScenario, linkFor, payloadFromHash, qrFits } from '../src/share/link.js';
import { qrSvgLow } from '../src/share/qr.js';
import { freeName } from '../src/share/import.js';
import { BUILTIN_SCENARIOS } from '../src/controller/library.js';
import { forMonitor, validateScenario } from '../src/shared/scenario.js';
import { eventRows, wrapText } from '../src/trends/export.js';

const words = 'airway oxygen circuit suction call help check monitor probe leak cuff valve flow gas drug dose rate pulse rhythm pressure'.split(' ');
/** a step with a varied 150-character cue, so compression cannot lean on repeats */
const step = (i, note = true) => ({
  ...(i % 4 === 3 ? { onTap: true } : { atSec: 20 + i * 5 }), glideMs: 20000, glideMsBy: { spo2: 90000 },
  ...(note ? { note: Array.from({ length: 24 }, (_, k) => words[(i * 7 + k * 5 + (k * k) % 11) % words.length]).join(' ').slice(0, 150) } : {}),
  patch: { patient: { hr: 80 + (i * 4) % 60, spo2: 98 - (i * 3) % 20, etco2: 38 - (i % 10), rr: 12 - (i % 3), nibp: { sys: 120 - (i * 5) % 40, dia: 75 - (i * 3) % 30 }, abp: { sys: 120 - (i * 5) % 40, dia: 75 - (i * 3) % 30 } } },
});
const make = (n, note = true) => ({ name: 'Ten steps', objectives: 'Spot the fall in SpO2 early and act on it. Expect a call for help.', steps: Array.from({ length: n }, (_, i) => step(i, note)) });

test('a scenario goes into a link and comes back the same', async () => {
  for (const sc of [...BUILTIN_SCENARIOS, make(10)]) {
    const e = await encodeScenario(sc);
    assert.ok(e.ok);
    assert.match(e.payload, /^[A-Za-z0-9_-]+$/);
    const back = await decodeScenario(e.payload);
    assert.ok(back.ok, back.msg);
    assert.deepEqual(back.scenario, validateScenario(sc).scenario, 'the built-in flag is not carried');
  }
});

test('size: 3 and 10 steps fit a QR; a 10-step scenario with long notes may show the link only', async () => {
  const sizes = {};
  for (const [n, note] of [[3, false], [3, true], [10, false], [10, true]]) {
    const link = linkFor('https://sim.anantf.com', (await encodeScenario(make(n, note))).payload);
    sizes[`${n}${note ? 'n' : ''}`] = link.length;
    if (n === 3) assert.ok(qrFits(link) && qrSvgLow(link), `a ${n}-step scenario gets a QR (${link.length} chars)`);
  }
  console.log('link sizes (characters):', JSON.stringify(sizes), 'QR limit', SAFE_QR_CHARS);
  assert.ok(sizes['10'] <= SAFE_QR_CHARS, '10 steps without notes still fit');
  const huge = linkFor('https://sim.anantf.com', (await encodeScenario(make(30))).payload);
  assert.ok(!qrFits(huge), 'a 30-step scenario with notes is link only');
  assert.ok(huge.length < 2900, 'but still an ordinary link');
});

test('a bad, damaged or too-new link is refused with a reason', async () => {
  const good = (await encodeScenario(make(3))).payload;
  for (const bad of ['', 'x', '!!!', good.slice(0, 12), `${good.slice(0, -6)}AAAAAA`]) {
    const r = await decodeScenario(bad);
    assert.equal(r.ok, false, bad);
  }
  const bytes = Buffer.from(good, 'base64url');
  bytes[0] = 2;
  const newer = await decodeScenario(bytes.toString('base64url'));
  assert.equal(newer.ok, false);
  assert.match(newer.msg, /newer version/);
  // a valid link to something that is not a scenario
  const raw = Buffer.concat([Buffer.from([1]), Buffer.from(await new Response(new Blob([JSON.stringify({ name: 'x', steps: [] })]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer())]);
  const notSc = await decodeScenario(raw.toString('base64url'));
  assert.equal(notSc.ok, false);
  assert.match(notSc.msg, /valid scenario/);
  // a decompression bomb is cut off
  const bomb = Buffer.concat([Buffer.from([1]), Buffer.from(await new Response(new Blob(['a'.repeat(5_000_000)]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer())]);
  assert.equal((await decodeScenario(bomb.toString('base64url'))).ok, false);
});

test('the hash and name helpers', () => {
  assert.equal(payloadFromHash('#s=abc'), 'abc');
  assert.equal(payloadFromHash('#s='), null);
  assert.equal(payloadFromHash('#x=abc'), null);
  assert.equal(freeName('Slow bleed', ['Slow bleed']), 'Slow bleed 2');
  assert.equal(freeName('A'.repeat(24), ['A'.repeat(24)]).length, 24);
  assert.equal(freeName('New', ['Old']), 'New');
});

const lib = (n, extra = {}) => ({ sim: 'library', version: 1, scenarios: Array.from({ length: n }, (_, i) => ({ ...make(2), name: `Mine ${i + 1}` })), drugs: [], ...extra });
const offer = (hub, library, id = 'c-1') => hub.onMessage(id, msg({ t: 'libraryOffer', library }));

test('offer: stored in the room, counted in state, replaced by the next offer, fetched with libraryGet', async () => {
  const { hub, storage } = makeHub();
  assert.equal((await hub.onMessage('c-2', msg({ t: 'libraryGet' }))).reply.t, 'error', 'nothing offered yet');
  const r = await offer(hub, lib(3));
  assert.deepEqual(r.broadcast.state.offer, { scenarios: 3, drugs: 0, at: 1_000_000, by: 'c-1' });
  assert.equal(r.broadcast.state.events.at(-1).kind, 'library');
  assert.ok(!JSON.stringify(r.broadcast.state).includes('Mine 1'), 'the library itself is not in the broadcast state');
  assert.ok(storage.data.has('libraryOffer'));
  const got = await hub.onMessage('c-2', msg({ t: 'libraryGet' }));
  assert.equal(got.reply.t, 'library');
  assert.equal(got.reply.library.scenarios.length, 3);
  const r2 = await offer(hub, lib(1), 'c-3');
  assert.equal(r2.broadcast.state.offer.scenarios, 1);
  assert.equal(r2.broadcast.state.offer.by, 'c-3');
  assert.equal((await hub.onMessage('c-2', msg({ t: 'libraryGet' }))).reply.library.scenarios.length, 1, 'replaced');
});

test('offer: refused whole when bad or over 32 KB, and the earlier offer stays', async () => {
  const { hub } = makeHub();
  await offer(hub, lib(2));
  for (const bad of [null, { sim: 'library', version: 9, scenarios: [{}] }, { sim: 'library', version: 1, scenarios: [{ name: 'x', steps: [] }] }, { sim: 'other' }]) {
    const r = await offer(hub, bad);
    assert.equal(r.reply?.code, 'bad_patch');
  }
  const big = { sim: 'library', version: 1, scenarios: Array.from({ length: 20 }, (_, i) => ({ ...make(30), name: `Big ${i}`, objectives: 'x'.repeat(300) })), drugs: [] };
  const r = await offer(hub, big);
  assert.ok(r.reply, 'over the file cap');
  assert.equal((await hub.state()).offer.scenarios, 2);
  assert.equal((await hub.onMessage('c-2', msg({ t: 'libraryGet' }))).reply.library.scenarios.length, 2);
});

test('offer: a 32 KB library gets through the message limit; other messages still stop at 16 KB', async () => {
  const { hub } = makeHub();
  const many = lib(0);
  for (let i = 0; JSON.stringify(many).length < 20000; i++) many.scenarios.push({ ...make(30, true), name: `S ${i}`, objectives: 'o'.repeat(200) });
  const text = msg({ t: 'libraryOffer', library: many });
  assert.ok(text.length > 16 * 1024 && text.length < 32 * 1024, String(text.length));
  assert.equal((await hub.onMessage('c-1', text)).broadcast?.state?.offer?.scenarios, many.scenarios.length);
  const r = await hub.onMessage('c-1', msg({ t: 'test', value: 'x'.repeat(17 * 1024) }));
  assert.equal(r.reply.code, 'too_big');
});

test('offer: gone with the room, and monitors never see it', async () => {
  const { hub, storage, clock } = makeHub();
  const r = await offer(hub, lib(1));
  assert.equal(forMonitor(r.broadcast).state.offer, undefined);
  assert.equal(r.broadcast.state.offer.scenarios, 1, 'the phones still get it');
  clock.t += 25 * 60 * 60 * 1000;
  assert.equal((await hub.onAlarm()).expired, true);
  assert.equal(storage.data.has('libraryOffer'), false);
});

test('an old room (no offer field) still works', async () => {
  const { hub } = makeHub();
  const s = await hub.state();
  assert.equal(s.offer, undefined);
  const r = await hub.onMessage('c-1', msg({ t: 'set', patch: { patient: { hr: 90 } } }));
  assert.equal(r.broadcast.state.offer, undefined);
});

test('teaching notes reach the log for the debrief but not state.events or monitors', async () => {
  const { hub } = makeHub();
  const sc = { name: 'Cued', steps: [{ atSec: 0, glideMs: 0, patch: { patient: { hr: 100 } }, note: 'Ask for the airway plan' }] };
  const r = await hub.onMessage('c-1', msg({ t: 'scenarioStart', scenario: sc }));
  assert.ok(!JSON.stringify(r.broadcast.state.events).includes('airway plan'));
  const h = await hub.onMessage('c-1', msg({ t: 'history', all: true, rid: 1 }));
  const note = h.reply.events.find((e) => e.kind === 'note');
  assert.equal(note.what, 'step 1/1: Ask for the airway plan');
  assert.equal(forMonitor(h.reply).events.some((e) => e.kind === 'note'), false);
  assert.ok(h.reply.events.indexOf(note) > h.reply.events.findIndex((e) => e.kind === 'scenario'), 'note follows its step');
});

test('debrief picture rows and wrapping', () => {
  const d = { beds: [{ id: 'p1', label: 'Bed 1' }, { id: 'p2', label: 'Bed 2' }], events: [
    { t: 1, by: 'a', kind: 'scenario', p: 'p1', what: 'step 1/3' }, { t: 2, by: 'a', kind: 'drug', p: 'p2', what: 'Opioid' },
    { t: 3, by: 'room', kind: 'note', p: 'p1', what: 'step 1/3: cue' }, { t: 4, by: 'a', kind: 'silence', what: 'silence' }, { t: 5, by: 'a', kind: 'bookmark', what: 'x' },
  ] };
  assert.deepEqual(eventRows(d, 'p1').map((r) => r.kind), ['scenario', 'note', 'bookmark']);
  assert.deepEqual(wrapText((s) => s.length, 'one two three four', 8), ['one two', 'three', 'four']);
  assert.deepEqual(wrapText((s) => s.length, '', 8), ['']);
});

test('offer: a monitor cannot pull the offered library', () => {
  assert.equal(forMonitor({ t: 'library', library: { scenarios: [] } }).t, 'error');
});

// Scenarios and drug buttons against a running Worker (BASE_URL): a library file is imported (bad files refused with a
// reason), a 3-step scenario is started from the phone, the phone is closed and the room still runs the timed step, then
// the phone pauses, resumes and advances it by tap, and a drug button applies its relative change.
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failed++; };

const lib = {
  sim: 'library', version: 1,
  scenarios: [{
    name: 'E2E three',
    steps: [
      { atSec: 0, glideMs: 0, patch: { patient: { hr: 100 } } },
      { atSec: 3, glideMs: 0, patch: { patient: { hr: 120 } } },
      { onTap: true, glideMs: 0, patch: { patient: { hr: 140 } } },
    ],
  }],
  drugs: [{ name: 'E2E drug', note: 'test', glideMs: 0, effects: { hr: { mul: 0.5 } } }],
};

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const home = await (await browser.newContext()).newPage();
  await home.goto(`${BASE}/`);
  await home.getByTestId('new-room').click();
  await home.locator('#room').waitFor({ state: 'visible' });
  const code = (await home.getByTestId('code').textContent())?.trim() ?? '';

  // an observer that stays connected the whole time (no phone UI)
  const obs = await (await browser.newContext()).newPage();
  await obs.goto(`${BASE}/`);
  await obs.evaluate(async (c) => {
    const m = await import('/src/room/client.js');
    const cl = new m.RoomClient({ url: m.roomUrl(location, c, 'monitor', m.newClientId('monitor')) });
    cl.connect();
    window.cl = cl;
    await new Promise((r) => cl.on('status', (s) => s === 'open' && r(0)));
  }, code);
  const sc = () => obs.evaluate(() => window.cl.state.scenario ?? null);
  const hr = () => obs.evaluate(() => window.cl.state.patients[0].hr);
  const until = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await obs.waitForTimeout(100); } return false; };

  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
  let phone = await ctx.newPage();
  const errors = [];
  phone.on('pageerror', (e) => errors.push(String(e)));
  await phone.goto(`${BASE}/c/${code}`);
  await phone.locator('#status[data-status="open"]').waitFor({ timeout: 10000 });
  await phone.getByTestId('tab-scenarios').click();
  const note = () => phone.getByTestId('lib-note').textContent();
  check((await phone.getByTestId('drug-Vasopressor').count()) === 0, 'drug buttons are off by default');

  const tryImport = async (text) => { await phone.locator('#lib').fill(text); await phone.getByTestId('lib-import').click(); return note(); };
  check((await tryImport('not json')).startsWith('Refused: not valid JSON'), 'a non-JSON file is refused with a reason');
  const bad = structuredClone(lib);
  bad.scenarios[0].steps[1].patch.patient.hr = 9999;
  const n = await tryImport(JSON.stringify(bad));
  check(/^Refused: .*step 2.*hr out of range/.test(n), `a bad step is refused with its place: ${n}`);
  check((await phone.getByTestId('scn-start-E2E three').count()) === 0, 'a refused file adds nothing');
  check((await tryImport(JSON.stringify(lib))).startsWith('Imported 1 scenario and 1 drug'), 'a good file imports');

  await phone.getByTestId('tab-more').click();
  await phone.getByTestId('sw-drugs-on').click();
  await phone.getByTestId('tab-scenarios').click();
  check((await phone.getByTestId('drug-E2E drug').count()) === 1, 'drug buttons show once switched on for this phone');

  await phone.getByTestId('scn-start-E2E three').click();
  check(await until(async () => (await hr()) === 100 && (await sc())?.step === 1), 'step 1 ran at once');
  const t1 = Date.now();
  await phone.close(); // the phone is gone: the room's alarm must run the timed step
  check(await until(async () => (await hr()) === 120, 12000), `timed step ran with the phone closed (${Date.now() - t1} ms after closing)`);
  let run = await sc();
  check(run?.step === 2 && run.waiting === true && run.nextAt === 0, 'then it waits for a tap');

  phone = await ctx.newPage();
  await phone.goto(`${BASE}/c/${code}`);
  await phone.locator('#status[data-status="open"]').waitFor({ timeout: 10000 });
  await phone.getByTestId('tab-scenarios').click();
  check((await phone.getByTestId('scn-step').textContent()) === 'Step 2 of 3 done', 'a new phone shows the running scenario');
  await phone.getByTestId('scn-pause').click();
  check(await until(async () => (await sc())?.pausedAt > 0), 'pause');
  await phone.getByTestId('scn-pause').click();
  check(await until(async () => (await sc())?.pausedAt === 0), 'resume');
  await phone.getByTestId('scn-next').click();
  check(await until(async () => (await hr()) === 140 && (await sc())?.done === true), 'tap advances the last step');
  await phone.getByTestId('scn-stop').click();
  check(await until(async () => (await sc()) === null), 'clear removes it');

  await obs.evaluate(() => window.cl.send({ t: 'set', patch: { patient: { hr: 100 } } }));
  await until(async () => (await hr()) === 100);
  await phone.getByTestId('drug-E2E drug').click();
  check(await until(async () => (await hr()) === 50), 'drug button applies its relative change');
  check(errors.length === 0, `no page errors ${errors.join('; ')}`);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);

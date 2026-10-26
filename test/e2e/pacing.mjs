// Pacing on the defib screen against a running Worker (BASE_URL): the pacer is started from the defib screen; capture
// follows the phone's threshold (pulse and shown HR only at or above it); pads off refuses; the second ECG lead draws.
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failed++; };

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const home = await (await browser.newContext()).newPage();
  await home.goto(`${BASE}/`);
  await home.getByTestId('new-room').click();
  await home.locator('#room').waitFor({ state: 'visible' });
  const code = (await home.getByTestId('code').textContent())?.trim() ?? '';

  const ctl = await (await browser.newContext()).newPage();
  await ctl.goto(`${BASE}/`);
  await ctl.evaluate(async (c) => {
    const m = await import('/src/room/client.js');
    const cl = new m.RoomClient({ url: m.roomUrl(location, c, 'controller', m.newClientId('controller')) });
    cl.connect();
    window.cl = cl;
    await new Promise((r) => cl.on('status', (s) => s === 'open' && r(0)));
  }, code);
  const state = () => ctl.evaluate(() => window.cl.state);

  // a second, plain monitor of the same bed, to see the artefact
  const mon = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  const errors = [];
  mon.on('pageerror', (e) => errors.push(String(e)));
  await mon.goto(`${BASE}/m/${code}`);
  await mon.locator('#status[data-status="open"]').waitFor({ timeout: 10000 });

  // the defib screen: a touch-sized tablet; named, then switched to kind defib from the phone
  const tabletCtx = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true });
  const tab = await tabletCtx.newPage();
  tab.on('pageerror', (e) => errors.push(String(e)));
  await tab.goto(`${BASE}/m/${code}`);
  await tab.getByPlaceholder(/name/i).first().fill('Defib').catch(() => {});
  await tab.getByRole('button', { name: /^save$/i }).first().click().catch(() => {});
  await ctl.waitForFunction(() => Object.keys(window.cl.state?.screens ?? {}).length > 0, null, { timeout: 8000 });
  const sid = Object.keys((await state()).screens)[0];
  check((await state()).screens[sid].kind === 'monitor', 'a named screen starts as a monitor');
  check(await tab.locator('.defib').count() === 0, 'defib layout is off by default');
  await ctl.evaluate((s) => window.cl.set({ screens: { [s]: { kind: 'defib' } } }), sid);
  await tab.locator('.defib').waitFor({ timeout: 8000 });
  check(true, 'kind defib shows the defib layout');

  await ctl.evaluate(() => window.cl.set({ patient: { rhythm: 'asystole', hr: 0, paceThreshold: 60 } }));
  await tab.waitForTimeout(400);
  const pace = tab.getByTestId('pace-toggle');
  check(await pace.getAttribute('aria-pressed') === 'false', 'pacer starts off');
  await tab.getByTestId('pace-rate-up').tap();
  await tab.getByTestId('pace-ma-up').tap();
  await ctl.waitForFunction(() => window.cl.state.patients[0].paceMa >= 5, null, { timeout: 5000 });
  check((await state()).patients[0].paceRate === 75, 'rate steps by 5');

  // pads off refuses
  await ctl.evaluate(() => window.cl.set({ patient: { off: { pads: true } } }));
  await tab.waitForTimeout(300);
  await pace.tap();
  await tab.waitForTimeout(500);
  check((await state()).patients[0].paceOn === false, 'pads off: pacer will not start');
  await ctl.evaluate(() => window.cl.set({ patient: { off: { pads: false } } }));
  await tab.waitForTimeout(300);

  // output below threshold: spikes, no pulse
  await pace.tap();
  await ctl.waitForFunction(() => window.cl.state.patients[0].paceOn === true, null, { timeout: 5000 });
  check((await state()).events.some((e) => e.kind === 'pace' && e.what.startsWith('on 75/min')), 'start is logged');
  await tab.waitForTimeout(800);
  const lowHr = await mon.evaluate(() => document.querySelector('.cell[data-module="ecg"][data-part="numeric"]')?.textContent ?? '');
  check(!/75/.test(lowHr), `below threshold: no captured rate shown (${lowHr.trim().slice(0, 20)})`);

  // output above threshold: captured, rate shown
  for (let i = 0; i < 5; i++) await tab.getByTestId('pace-ma-up').tap();
  await ctl.evaluate(() => window.cl.set({ patient: { paceThreshold: 20 } }));
  await tab.waitForTimeout(2500);
  const hiHr = await mon.evaluate(() => document.querySelector('.cell[data-module="ecg"][data-part="numeric"]')?.textContent ?? '');
  check(/75/.test(hiHr), `at or above threshold: paced rate shown (${hiHr.trim().slice(0, 20)})`);

  // second ECG lead
  await ctl.evaluate(() => window.cl.set({ modules: ['ecg', 'ecg2', 'spo2'] }));
  await mon.waitForTimeout(1500);
  const lane = await mon.evaluate(() => {
    const c = document.querySelector('.cell[data-module="ecg2"][data-part="wave"] canvas');
    if (!c) return -1;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
  check(lane > 50, `second ECG lead draws (${lane} px)`);

  check(errors.length === 0, `no page errors ${errors.join('; ')}`);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);

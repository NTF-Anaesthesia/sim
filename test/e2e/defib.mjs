// Defib screen against a running Worker (BASE_URL): a screen set to kind defib shows the defib layout; charge, shock and
// sync work by touch and mouse; pads off blocks the shock; a shock shows artefact on a monitor of the same bed, applies
// the postShock rhythm and logs one event.
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

  await ctl.evaluate(() => window.cl.set({ patient: { rhythm: 'vf', postShock: 'sinus', hr: 75 } }));
  await tab.waitForTimeout(500);
  const shock = tab.getByTestId('defib-shock');
  check(await shock.isDisabled(), 'shock is disabled until charged');

  // charge (touch), energy
  await tab.getByTestId('defib-up').tap();
  check((await tab.getByTestId('defib-energy').textContent()).includes('170'), 'energy steps up by touch');
  await tab.getByTestId('defib-charge').tap();
  await tab.waitForFunction(() => document.querySelector('.defib')?.dataset.phase === 'ready', null, { timeout: 8000 });
  check(true, 'charge reaches ready');

  // pads off blocks the shock
  await ctl.evaluate(() => window.cl.set({ patient: { off: { pads: true } } }));
  await tab.waitForTimeout(400);
  const evs0 = (await state()).events.filter((e) => e.kind === 'shock').length;
  await shock.click();
  await tab.waitForTimeout(500);
  check((await tab.getByTestId('defib-msg').textContent()).includes('Pads off'), 'pads off shows a message');
  check((await state()).events.filter((e) => e.kind === 'shock').length === evs0, 'pads off blocks the shock');
  check((await state()).patients[0].rhythm === 'vf', 'rhythm unchanged when blocked');

  // pads on: shock by mouse, artefact on the other monitor, rhythm changes, one event
  await ctl.evaluate(() => window.cl.set({ patient: { off: { pads: false } } }));
  await tab.waitForTimeout(400);
  await shock.click();
  await ctl.waitForFunction(() => window.cl.state.events.some((e) => e.kind === 'shock'), null, { timeout: 5000 });
  const s2 = await state();
  const ev = s2.events.filter((e) => e.kind === 'shock');
  check(ev.length === 1 && ev[0].what === '170J', `one shock event logged (${JSON.stringify(ev.map((e) => e.what))})`);
  check(s2.patients[0].rhythm === 'sinus', 'postShock rhythm applied');
  await mon.waitForTimeout(250);
  const spike = await mon.evaluate(() => {
    const c = document.querySelector('.cell[data-module="ecg"][data-part="wave"] canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    // artefact: ink in the top and bottom 8% of the lane at the same time
    const band = (y0, y1) => { let n = 0; for (let y = y0; y < y1; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 0) n++; return n; };
    return [band(0, Math.round(c.height * 0.08)), band(Math.round(c.height * 0.92), c.height)];
  });
  check(spike[0] > 0 && spike[1] > 0, `shock artefact drawn on the other screen (${spike})`);
  check((await tab.getByTestId('defib-msg').textContent()).includes('Shock delivered'), 'defib screen confirms the shock');
  check((await tab.getByTestId('defib-shock').isDisabled()), 'the charge is spent after a shock');

  // sync: markers on R waves and the shock waits for one
  await tab.getByTestId('defib-sync').tap();
  check((await tab.getByTestId('defib-mode').textContent()) === 'SYNC', 'sync toggles on');
  await tab.waitForTimeout(1500);
  const marks = await tab.evaluate(() => {
    const c = document.querySelector('[data-testid="defib-marks"]');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
  check(marks > 30, `sync marks R waves (${marks} px)`);
  await tab.getByTestId('defib-charge').tap();
  await tab.waitForFunction(() => document.querySelector('.defib')?.dataset.phase === 'ready', null, { timeout: 8000 });
  await ctl.evaluate(() => window.cl.set({ patient: { rhythm: 'sinus', hr: 70 } }));
  await tab.getByTestId('defib-shock').tap();
  await ctl.waitForFunction(() => window.cl.state.events.filter((e) => e.kind === 'shock').length === 2, null, { timeout: 6000 });
  check((await state()).events.filter((e) => e.kind === 'shock').at(-1).what === '170J sync', 'sync shock goes out on an R wave and says so');

  check(errors.length === 0, `no page errors ${errors.join('; ')}`);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);

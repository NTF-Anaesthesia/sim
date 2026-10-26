// Monitor screen against a running Worker (BASE_URL): the controller sets VT and the monitor shows VT and the alarm
// bar within a second; the art-line module adds its wave; traces are drawn; screenshots at 1280 and 1024 px.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const SHOTS = process.env.SHOTS_DIR ?? 'test/e2e/out';
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failed++; };

mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const home = await (await browser.newContext()).newPage();
  await home.goto(`${BASE}/`);
  await home.getByTestId('new-room').click();
  await home.locator('#room').waitFor({ state: 'visible' });
  const code = (await home.getByTestId('code').textContent())?.trim() ?? '';

  // controller stand-in: the real RoomClient on a bare page
  const ctl = await (await browser.newContext()).newPage();
  await ctl.goto(`${BASE}/`);
  await ctl.evaluate(async (c) => {
    const m = await import('/src/room/client.js');
    const cl = new m.RoomClient({ url: m.roomUrl(location, c, 'controller', m.newClientId('controller')) });
    cl.connect();
    window.cl = cl;
    await new Promise((r) => cl.on('status', (s) => s === 'open' && r(0)));
  }, code);
  const set = (patch) => ctl.evaluate((p) => window.cl.set(p), patch);

  const mon = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  const errors = [];
  mon.on('pageerror', (e) => errors.push(String(e)));
  await mon.goto(`${BASE}/m/${code}`);
  await mon.locator('#status[data-status="open"]').waitFor({ timeout: 10000 });
  await mon.locator('.cell[data-module="ecg"][data-part="wave"]').waitFor({ timeout: 5000 });
  check(await mon.locator('.cell[data-module="abp"]').count() === 0, 'no art line wave by default');
  check(await mon.locator('.cell[data-module="spo2"][data-part="numeric"]').count() === 1, 'SpO2 numeric shown');

  await mon.waitForTimeout(2500);
  const ink = (mod) => mon.evaluate((m) => {
    const c = document.querySelector(`.cell[data-module="${m}"][data-part="wave"] canvas`);
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  }, mod);
  check((await ink('ecg')) > 200, 'ECG trace has been drawn');
  check((await ink('spo2')) > 100, 'pleth trace has been drawn');
  check((await ink('etco2')) > 100, 'capnogram has been drawn');

  const t0 = Date.now();
  await set({ patient: { rhythm: 'vt' } });
  await mon.locator('.cell[data-module="ecg"][data-part="numeric"] .nsub', { hasText: /^VT$/ }).waitFor({ timeout: 3000 });
  await mon.locator('.alarmbar[data-alarm="high"]').waitFor({ timeout: 3000 });
  const dt = Date.now() - t0;
  check(dt < 1500, `VT and the alarm bar showed in ${dt} ms`);
  check(/VENT TACH/.test((await mon.locator('.alarmbar').textContent()) ?? ''), 'alarm bar says VENT TACH');
  await mon.screenshot({ path: `${SHOTS}/monitor-vt-1280.png` });

  await set({ patient: { rhythm: 'sinus' } });
  await set({ modules: ['ecg', 'spo2', 'etco2', 'nibp', 'rr', 'temp', 'abp'] });
  await mon.locator('.cell[data-module="abp"][data-part="wave"]').waitFor({ timeout: 3000 });
  check(await mon.locator('.cell[data-module="abp"][data-part="numeric"]').count() === 1, 'art line adds its wave and numeric');
  await mon.waitForTimeout(2500);
  check((await ink('abp')) > 100, 'arterial wave has been drawn');
  await mon.screenshot({ path: `${SHOTS}/monitor-abp-1280.png` });

  await mon.setViewportSize({ width: 1024, height: 768 });
  await mon.waitForTimeout(800);
  await mon.screenshot({ path: `${SHOTS}/monitor-abp-1024.png` });
  check((await ink('ecg')) > 100, 'still drawn after a resize');
  check(errors.length === 0, `no page errors ${errors.join('; ')}`);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);

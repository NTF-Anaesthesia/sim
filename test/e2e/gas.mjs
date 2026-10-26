// Gas and TOF against a running Worker (BASE_URL): modules are off by default, switching them on adds the agent trace and
// numerics, TOF is measured on demand and on an interval, and a hypoxic mixture raises an alarm.
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

  const mon = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  const errors = [];
  mon.on('pageerror', (e) => errors.push(String(e)));
  await mon.goto(`${BASE}/m/${code}`);
  await mon.locator('#status[data-status="open"]').waitFor({ timeout: 10000 });
  await mon.locator('.cell[data-module="ecg"][data-part="wave"]').waitFor({ timeout: 5000 });
  for (const m of ['gas', 'o2', 'tof']) check(await mon.locator(`.cell[data-module="${m}"]`).count() === 0, `${m} is off by default`);

  await ctl.evaluate(() => window.cl.set({ modules: ['ecg', 'spo2', 'etco2', 'nibp', 'gas', 'tof'] }));
  await ctl.evaluate(() => window.cl.set({ patient: { agent: 'sevo', age: 40, fio2: 45, fiag: 1.5, etag: 1.8, tofCount: 2, tofRatio: 0 } }, 0));
  await mon.locator('.cell[data-module="gas"][data-part="wave"]').waitFor({ timeout: 5000 });
  await mon.locator('.cell[data-module="tof"][data-part="numeric"]').waitFor({ timeout: 5000 });
  await mon.waitForTimeout(3000);
  const gasText = await mon.locator('.cell[data-module="gas"][data-part="numeric2"]').textContent();
  check(gasText.includes('Sevo') && gasText.includes('1.8'), `agent numeric shows name and Et (${gasText.trim().slice(0, 40)})`);
  check((await mon.locator('.cell[data-module="gas"][data-part="numeric"]').textContent()).includes('45'), 'FiO2 numeric shows 45');
  check((await mon.locator('.cell[data-module="gas"][data-part="numeric3"]').count()) === 1, 'N2O numeric present');
  const ink = (mod) => mon.evaluate((m) => {
    const c = document.querySelector(`.cell[data-module="${m}"][data-part="wave"] canvas`);
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  }, mod);
  check((await ink('gas')) > 100, 'agent trace drawn');

  // TOF: the last reading changes only when measured (tap on the monitor or the phone's button)
  const tofBefore = await mon.locator('.cell[data-module="tof"][data-part="numeric"]').textContent();
  await ctl.evaluate(() => window.cl.send({ t: 'tof' }));
  await mon.waitForFunction(() => document.querySelector('.cell[data-module="tof"][data-part="numeric"]').textContent.includes('2'), null, { timeout: 5000 });
  check(true, `TOF measured on demand (was: ${tofBefore.trim().slice(0, 30)})`);
  await ctl.evaluate(() => window.cl.set({ tof: { mode: 'cycle', cycleSec: 15 } }));
  await ctl.evaluate(() => window.cl.set({ patient: { tofCount: 4, tofRatio: 90 } }, 0));
  await mon.waitForFunction(() => document.querySelector('.cell[data-module="tof"][data-part="numeric"]').textContent.includes('0.90'), null, { timeout: 25000 });
  check(true, 'TOF on an interval takes the new reading on its own');

  // alarms: a hypoxic mixture is a high alarm
  await ctl.evaluate(() => window.cl.set({ patient: { fio2: 15 } }, 0));
  await mon.waitForFunction(() => document.body.textContent.includes('FIO2 LOW'), null, { timeout: 8000 });
  check(true, 'low FiO2 alarm shows');

  // the phone: switches add the agent select, TOF buttons, gas rows and the two alarm limit rows
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true })).newPage();
  await phone.goto(`${BASE}/c/${code}`);
  await phone.locator('#status[data-status="open"]').waitFor({ timeout: 10000 });
  await phone.getByTestId('agent').selectOption('des');
  await phone.locator('[data-tof-int="30"]').click();
  await phone.waitForFunction(() => document.querySelector('[data-tof-int="30"]')?.getAttribute('aria-pressed') === 'true', null, { timeout: 5000 });
  check(await phone.getByTestId('rng-etag').count() === 1 && await phone.getByTestId('rng-tofCount').count() === 1, 'phone shows gas and TOF rows');
  await phone.getByTestId('tab-alarms').click();
  check(await phone.locator('[data-limit="fio2"]').count() === 1 && await phone.locator('[data-limit="etagent"]').count() === 1, 'phone shows FiO2 and Et agent limits');
  check(errors.length === 0, `no page errors ${errors.join('; ')}`);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);

// CVP, second art line and flush test against a running Worker (BASE_URL): the modules are off by default, switching
// them on adds their waves and numerics, traces are drawn, and a flush event pegs the art line at the top of its lane.
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
  for (const m of ['cvp', 'abp2']) check(await mon.locator(`.cell[data-module="${m}"]`).count() === 0, `${m} is off by default`);

  await ctl.evaluate(() => window.cl.set({ modules: ['ecg', 'spo2', 'etco2', 'nibp', 'abp', 'abp2', 'cvp'] }));
  await ctl.evaluate(() => window.cl.set({ patient: { abp2: { sys: 140, dia: 70 }, abp2Label: 'FEM', cvp: 10, ppv: 15 } }));
  for (const m of ['cvp', 'abp2']) await mon.locator(`.cell[data-module="${m}"][data-part="wave"]`).waitFor({ timeout: 5000 });
  await mon.waitForTimeout(3000);
  check((await mon.locator('.cell[data-module="abp2"][data-part="numeric"]').textContent()).includes('FEM'), 'second line shows its own label');
  const ink = (mod) => mon.evaluate((m) => {
    const c = document.querySelector(`.cell[data-module="${m}"][data-part="wave"] canvas`);
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  }, mod);
  check((await ink('cvp')) > 100, 'CVP trace drawn');
  check((await ink('abp2')) > 100, 'second art line trace drawn');

  const before = await ink('abp');
  await ctl.evaluate(() => window.cl.send({ t: 'flush', line: 'abp' }));
  await mon.waitForTimeout(700);
  const top = await mon.evaluate(() => {
    const c = document.querySelector('.cell[data-module="abp"][data-part="wave"] canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, 12 * (c.height / c.clientHeight)).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
  check(top > 40, `flush draws a square wave at the top of the art lane (${top} px, was ${before} total)`);
  check(errors.length === 0, `no page errors ${errors.join('; ')}`);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);

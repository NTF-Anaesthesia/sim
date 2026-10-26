// BIS module against a running Worker (BASE_URL): off by default, switching it on adds the EEG strip and the numeric
// (BIS with SQI, EMG and SR), the strip is drawn, the number follows the phone, and the sensor-off flag blanks both.
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
  check(await mon.locator('.cell[data-module="bis"]').count() === 0, 'bis is off by default');

  await ctl.evaluate(() => window.cl.set({ modules: ['ecg', 'spo2', 'etco2', 'nibp', 'bis'] }));
  await ctl.evaluate(() => window.cl.set({ patient: { bis: 46, bisSqi: 91, bisEmg: 12, bisSr: 30 } }));
  await mon.locator('.cell[data-module="bis"][data-part="wave"]').waitFor({ timeout: 5000 });
  await mon.waitForTimeout(3500);
  const num = () => mon.locator('.cell[data-module="bis"][data-part="numeric"]').textContent();
  const ink = () => mon.evaluate(() => {
    const c = document.querySelector('.cell[data-module="bis"][data-part="wave"] canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
  const text = await num();
  check(text.includes('46') && text.includes('SQI 91') && text.includes('EMG 12') && text.includes('SR 30'), `numeric shows BIS, SQI, EMG, SR (${text.trim().slice(0, 60)})`);
  check((await ink()) > 100, 'EEG strip drawn');

  await ctl.evaluate(() => window.cl.set({ patient: { bis: 80 } }));
  await mon.waitForTimeout(500);
  check((await num()).includes('80'), 'number follows the phone');

  await ctl.evaluate(() => window.cl.set({ patient: { off: { bis: true } } }));
  await mon.waitForTimeout(600);
  check((await num()).includes('SENSOR OFF'), 'sensor off shows SENSOR OFF');
  check((await mon.locator('.cell[data-module="bis"][data-part="wave"] .woff').textContent()) === 'BIS SENSOR OFF', 'wave shows the off text');
  await mon.screenshot({ path: process.env.SHOT ?? '/tmp/bis-off.png' }).catch(() => {});
  check(errors.length === 0, `no page errors ${errors.join('; ')}`);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);

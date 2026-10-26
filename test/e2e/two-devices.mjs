// Two browser contexts (a "laptop" monitor and a "phone" controller) share a room: a value typed on the controller
// shows on the monitor in under 1 s, and a late joiner gets the current value. Needs the Worker running at BASE_URL.
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const LIMIT_MS = 1000;
let failed = false;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failed = true; };

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  // home page: new room shows a code and a QR
  const home = await (await browser.newContext()).newPage();
  await home.goto(`${BASE}/`);
  await home.getByTestId('new-room').click();
  await home.locator('#room').waitFor({ state: 'visible' });
  const code = (await home.getByTestId('code').textContent())?.trim() ?? '';
  check(/^[A-HJKMNP-Z2-9]{6}$/.test(code), `new room code looks right (${code})`);
  check((await home.locator('#qr svg').count()) === 1, 'QR drawn');

  // monitor on one "device", controller on another
  const monitor = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true })).newPage();
  await monitor.goto(`${BASE}/m/${code}`);
  await phone.goto(`${BASE}/c/${code.toLowerCase()}`); // lower case is accepted
  // the shell's `test` value is sent by a bare socket (the real controller no longer has the test box)
  const sock = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws/${code}?role=controller&id=c-test`);
  await new Promise((r) => { sock.onopen = r; });
  await monitor.locator('#status[data-status="open"]').waitFor({ timeout: 10000 });
  await phone.locator('#status[data-status="open"]').waitFor({ timeout: 10000 });
  check(/1 monitor/.test((await phone.locator('#status').textContent()) ?? ''), 'phone chip shows one monitor');
  check((await monitor.getByTestId('value').textContent()) === '--', 'monitor starts empty');

  for (const v of ['118', '72']) {
    const t0 = Date.now();
    sock.send(JSON.stringify({ t: 'test', value: v }));
    await monitor.getByTestId('value').filter({ hasText: v }).waitFor({ timeout: 5000 });
    const dt = Date.now() - t0;
    check(dt < LIMIT_MS, `value ${v} reached the monitor in ${dt} ms (< ${LIMIT_MS} ms)`);
  }

  // late joiner: a second monitor opened afterwards gets the current value at once
  const late = await (await browser.newContext()).newPage();
  await late.goto(`${BASE}/m/${code}`);
  await late.getByTestId('value').filter({ hasText: '72' }).waitFor({ timeout: 5000 });
  check(true, 'late joiner sees the current value');

  // a different room is separate
  const other = await (await browser.newContext()).newPage();
  await other.goto(`${BASE}/m/${code[0] === 'A' ? 'B' : 'A'}${code.slice(1)}`);
  await other.locator('#status[data-status="open"]').waitFor({ timeout: 10000 });
  check((await other.getByTestId('value').textContent()) === '--', 'another room is separate');

  // bad code
  const bad = await (await browser.newContext()).newPage();
  const res = await bad.goto(`${BASE}/m/NOPE`);
  check(res?.status() === 404, 'bad code is 404');
  sock.close();
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);

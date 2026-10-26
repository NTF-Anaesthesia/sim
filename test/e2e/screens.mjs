// Named screens (V2 S1) against a running Worker (BASE_URL): two monitors in one room are named from their own name
// card, then set from the phone's Screens tab to different beds, modules and themes; a reload keeps each screen's
// identity and settings; Identify shows the name on the right monitor only; presence marks both online; Forget brings
// the name card back.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const SHOTS = process.env.SHOTS_DIR ?? 'test/e2e/out';
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failed++; };
mkdirSync(SHOTS, { recursive: true });

const bg = (page) => page.evaluate(() => getComputedStyle(document.querySelector('#app')).backgroundColor);
const bed = (page) => page.getByTestId('value').getAttribute('data-patient');
const hasTemp = (page) => page.locator('.cell[data-module="temp"]').count().then((n) => n > 0);
const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); }
  return false;
};

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const home = await (await browser.newContext()).newPage();
  await home.goto(`${BASE}/`);
  await home.getByTestId('new-room').click();
  await home.locator('#room').waitFor({ state: 'visible' });
  const code = (await home.getByTestId('code').textContent())?.trim() ?? '';

  const errors = [];
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 800 } })).newPage();
  phone.on('pageerror', (e) => errors.push(String(e)));
  phone.on('dialog', (d) => d.accept());
  await phone.goto(`${BASE}/c/${code}`);
  await phone.locator('[data-act="add"]').click();
  await phone.locator('[data-act="add"]').waitFor({ state: 'attached' });

  /** @type {import('playwright').Page[]} */
  const mons = [];
  for (const name of ['Left', 'Right']) {
    const m = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    m.on('pageerror', (e) => errors.push(String(e)));
    await m.goto(`${BASE}/m/${code}`);
    await m.locator('#status[data-status="open"]').waitFor({ timeout: 10000 });
    await m.getByTestId('screen-name-card').waitFor({ state: 'visible', timeout: 5000 });
    await m.getByTestId('screen-name').fill(name);
    await m.getByTestId('screen-name-save').click();
    check(await waitFor(async () => (await m.getByTestId('screen-label').textContent()) === name), `monitor named "${name}" from its card`);
    check(await m.getByTestId('screen-name-card').isHidden(), `"${name}": the card goes away once named`);
    mons.push(m);
  }
  const [left, right] = mons;

  await phone.getByTestId('tab-screens').click();
  await phone.getByTestId('online-s2').waitFor({ timeout: 5000 });
  check(await waitFor(async () => (await phone.getByTestId('online-s1').getAttribute('data-on')) === 'true'
    && (await phone.getByTestId('online-s2').getAttribute('data-on')) === 'true'), 'phone: presence shows both screens online');

  // different beds
  await phone.getByTestId('scrbed-s2').selectOption('p2');
  check(await waitFor(async () => (await bed(right)) === 'p2'), 'Right shows bed 2 after the phone sets it');
  check((await bed(left)) === 'p1', 'Left stays on bed 1');

  // different modules
  await phone.getByTestId('sw-scrfollow-s2').click();
  await phone.getByTestId('sw-scrmod-s2-temp').click();
  check(await waitFor(async () => !(await hasTemp(right))), 'Right drops the temperature module');
  check(await hasTemp(left), 'Left keeps the room modules (temperature on)');

  // different themes
  const leftBg = await bg(left);
  await phone.getByTestId('scrtheme-s2').selectOption('light');
  check(await waitFor(async () => (await bg(right)) !== leftBg), `Right switches to the light theme (${await bg(right)})`);
  check((await bg(left)) === leftBg, 'Left keeps the room theme');
  const rightBg = await bg(right);
  await right.screenshot({ path: `${SHOTS}/screens-right.png` });

  // reload keeps identity and settings
  for (const m of mons) await m.reload();
  for (const m of mons) await m.locator('#status[data-status="open"]').waitFor({ timeout: 10000 });
  check(await waitFor(async () => (await right.getByTestId('screen-label').textContent()) === 'Right'
    && (await left.getByTestId('screen-label').textContent()) === 'Left'), 'reload: both monitors keep their names');
  check(await right.getByTestId('screen-name-card').isHidden() && await left.getByTestId('screen-name-card').isHidden(), 'reload: no name card');
  check(await waitFor(async () => (await bed(right)) === 'p2' && !(await hasTemp(right)) && (await bg(right)) === rightBg),
    'reload: Right keeps its bed, modules and theme');
  check((await bed(left)) === 'p1' && await hasTemp(left) && (await bg(left)) === leftBg, 'reload: Left keeps the room settings');
  check(await waitFor(async () => (await phone.getByTestId('online-s1').getAttribute('data-on')) === 'true'
    && (await phone.getByTestId('online-s2').getAttribute('data-on')) === 'true'), 'phone: both screens online again after the reload');

  // identify
  await phone.getByTestId('identify-s1').click();
  check(await waitFor(async () => left.getByTestId('screen-identify').isVisible()), 'Identify: Left shows its name large');
  check((await left.getByTestId('screen-identify').textContent()) === 'Left', 'Identify: the overlay reads "Left"');
  check(await right.getByTestId('screen-identify').isHidden(), 'Identify: Right shows nothing');
  check(await waitFor(async () => left.getByTestId('screen-identify').isHidden(), 5000), 'Identify: the overlay goes away by itself');

  // forget
  await phone.getByTestId('forget-s2').click();
  check(await waitFor(async () => right.getByTestId('screen-name-card').isVisible()), 'Forget: Right asks for a name again');
  check(await waitFor(async () => (await bed(right)) === 'p1' && await hasTemp(right) && (await bg(right)) === leftBg),
    'Forget: Right follows the room again');

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
} finally {
  await browser.close();
}
if (failed) { console.log(`${failed} check(s) failed`); process.exit(1); }
console.log('screens e2e passed');

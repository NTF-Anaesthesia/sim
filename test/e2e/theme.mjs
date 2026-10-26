// Theme engine against a running Worker (BASE_URL): a theme imported on the phone changes the monitor in a second
// context within 1 s; a bad file shows an error and keeps the old theme; the monitor imports by file and URL, remembers
// its own choice after a reload, edits live, and exports.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const SHOTS = process.env.SHOTS_DIR ?? 'test/e2e/out';
const LIGHT = readFileSync(new URL('../../themes/generic-light.json', import.meta.url), 'utf8');
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failed++; };
mkdirSync(SHOTS, { recursive: true });

const bg = (page) => page.evaluate(() => getComputedStyle(document.querySelector('#app')).backgroundColor);
const ecgX = (page) => page.evaluate(() => Math.round(document.querySelector('.cell[data-module="ecg"][data-part="wave"]').getBoundingClientRect().x));

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const home = await (await browser.newContext()).newPage();
  await home.goto(`${BASE}/`);
  await home.getByTestId('new-room').click();
  await home.locator('#room').waitFor({ state: 'visible' });
  const code = (await home.getByTestId('code').textContent())?.trim() ?? '';

  // two monitors in separate contexts, one phone
  const mon = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  const mon2 = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  const errors = [];
  for (const m of [mon, mon2]) {
    m.on('pageerror', (e) => errors.push(String(e)));
    await m.goto(`${BASE}/m/${code}`);
    await m.locator('#status[data-status="open"]').waitFor({ timeout: 10000 });
    await m.locator('.cell[data-module="ecg"][data-part="wave"]').waitFor({ timeout: 5000 });
  }
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 800 } })).newPage();
  phone.on('pageerror', (e) => errors.push(String(e)));
  await phone.goto(`${BASE}/c/${code}`);
  await phone.locator('[data-testid="tab-more"]').click();

  check(await bg(mon) === 'rgb(0, 0, 0)', 'monitor starts on the default (black)');
  const x0 = await ecgX(mon);

  // phone: bad file first -> error, nothing changes
  await phone.getByTestId('theme-open').click();
  await phone.getByTestId('theme-text').fill('{"css":"body{display:none}","colors":{}}');
  await phone.getByTestId('theme-apply-text').click();
  check(await phone.getByTestId('theme-error').isVisible() && /CSS/.test(await phone.getByTestId('theme-error').textContent()), 'phone: CSS in a theme is refused with a clear message');
  await phone.getByTestId('theme-text').fill('{not json');
  await phone.getByTestId('theme-apply-text').click();
  check(/not valid JSON/.test(await phone.getByTestId('theme-error').textContent()), 'phone: broken JSON is refused');
  await mon.waitForTimeout(600);
  check(await bg(mon) === 'rgb(0, 0, 0)' && await bg(mon2) === 'rgb(0, 0, 0)', 'bad files left both monitors unchanged');

  // phone: import the light theme -> both monitors change within 1 s
  await phone.getByTestId('theme-text').fill(LIGHT);
  const t0 = Date.now();
  await phone.getByTestId('theme-apply-text').click();
  await Promise.all([mon, mon2].map((m) => m.waitForFunction(() => getComputedStyle(document.querySelector('#app')).backgroundColor === 'rgb(243, 241, 234)', null, { timeout: 1000 })));
  const ms = Date.now() - t0;
  check(ms < 1000, `import on the phone reached both monitors in ${ms} ms`);
  check(await ecgX(mon) !== x0, 'the layout moved (ECG wave is somewhere else)');
  check(await mon.locator('.cell[data-module="ecg"][data-part="numeric"]').count() === 1, 'all numerics still drawn');
  await mon.screenshot({ path: `${SHOTS}/theme-light-monitor.png` });
  await phone.screenshot({ path: `${SHOTS}/theme-phone-panel.png` });

  // a late joiner gets the room theme
  const late = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  await late.goto(`${BASE}/m/${code}`);
  await late.waitForFunction(() => getComputedStyle(document.querySelector('#app')).backgroundColor === 'rgb(243, 241, 234)', null, { timeout: 5000 });
  check(true, 'a monitor that joins later gets the room theme');
  await late.context().close();

  // monitor: its own choice wins, is remembered after a reload, and "Follow the room" gives control back
  await mon.getByTestId('theme-open').click();
  await mon.getByTestId('theme-choose').selectOption('default');
  check(await bg(mon) === 'rgb(0, 0, 0)' && await bg(mon2) === 'rgb(243, 241, 234)', 'monitor 1 chose the default for itself; monitor 2 still follows the room');
  await mon.reload();
  await mon.locator('.cell[data-module="ecg"][data-part="wave"]').waitFor({ timeout: 5000 });
  check(await bg(mon) === 'rgb(0, 0, 0)', 'the device choice is remembered after a reload');
  await mon.getByTestId('theme-open').click();
  await mon.getByTestId('theme-choose').selectOption('room');
  check(await bg(mon) === 'rgb(243, 241, 234)', 'Follow the room hands control back');

  // monitor: import by file and by URL, bad file keeps the theme, live edit, export
  await mon.getByTestId('theme-file').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"themeSchema":9,"colors":{}}') });
  check(/schema 9/.test(await mon.getByTestId('theme-error').textContent()) && await bg(mon) === 'rgb(243, 241, 234)', 'monitor: a newer schema is refused, the old theme stays');
  const dark = readFileSync(new URL('../../themes/generic-dark.json', import.meta.url));
  await mon.getByTestId('theme-file').setInputFiles({ name: 'dark.json', mimeType: 'application/json', buffer: dark });
  check(await bg(mon) === 'rgb(0, 0, 0)', 'monitor: file import applies at once, no reload');
  await mon.getByTestId('theme-url').fill(`${BASE}/themes/generic-light.json`);
  await mon.getByTestId('theme-url-load').click();
  await mon.waitForFunction(() => getComputedStyle(document.querySelector('#app')).backgroundColor === 'rgb(243, 241, 234)', null, { timeout: 3000 });
  check(true, 'monitor: URL import applies');
  await mon.getByTestId('theme-url').fill(`${BASE}/themes/nothing-here.json`);
  await mon.getByTestId('theme-url-load').click();
  await mon.getByTestId('theme-error').waitFor({ state: 'visible' });
  check(/404/.test(await mon.getByTestId('theme-error').textContent()) && await bg(mon) === 'rgb(243, 241, 234)', 'monitor: a missing URL shows an error and keeps the theme');

  await mon.evaluate(() => document.querySelectorAll('.tp details').forEach((d) => { d.open = true; }));
  await mon.getByTestId('f-colors.ecg').fill('#ff00ff');
  const pink = await mon.evaluate(() => getComputedStyle(document.querySelector('#app')).getPropertyValue('--c-ecg').trim());
  check(pink === '#ff00ff', 'editor: a colour change shows live');
  await mon.getByTestId('f-layout.grid.gap').fill('20');
  check(await mon.evaluate(() => getComputedStyle(document.querySelector('#app')).getPropertyValue('--m-gap').trim()) === '10px', 'editor: gap changes live');
  await mon.getByTestId('f-waves.lineWidth').fill('99');
  check(await mon.getByTestId('f-waves.lineWidth').getAttribute('aria-invalid') === 'true', 'editor: an out-of-range number is flagged and not applied');
  // v1 additions: cell border, left limits, mean inline, caption colour, wave caption size, scale lines
  const cssVar = (page, name) => page.evaluate((n) => getComputedStyle(document.querySelector('#app')).getPropertyValue(n).trim(), name);
  await mon.getByTestId('f-cells.border.width').fill('3');
  await mon.getByTestId('f-cells.border.radius').fill('10');
  check(await mon.evaluate(() => getComputedStyle(document.querySelector('.cell.wave')).borderTopWidth) === '3px', 'editor: cell border width shows live');
  await mon.getByTestId('f-cells.border.width').fill('99');
  check(await mon.getByTestId('f-cells.border.width').getAttribute('aria-invalid') === 'true', 'editor: border width over 6 is flagged');
  await mon.getByTestId('f-numerics.limitsPosition').selectOption('left');
  check(await mon.evaluate(() => document.querySelector('#app').dataset.limits) === 'left', 'editor: limits at the left');
  await mon.getByTestId('f-numerics.meanPosition').selectOption('inline');
  await mon.getByTestId('f-labels.colorMode').selectOption('text');
  const capCol = await mon.evaluate(() => { const c = document.querySelector('.cell[data-module="ecg"][data-part="numeric"]'); return [getComputedStyle(c.querySelector('.nlabel')).color, getComputedStyle(c.querySelector('.nval')).color]; });
  check(capCol[0] !== capCol[1], 'editor: captions in the text colour differ from the number colour');
  await mon.getByTestId('f-font.waveLabelScale').fill('2');
  check(await cssVar(mon, '--m-wlabel-scale') !== '1', 'editor: wave caption size changes');
  await mon.getByTestId('f-waves.etco2.scaleLines').fill('20, 40');
  const inked = await mon.waitForFunction(() => {
    const c = document.querySelector('.cell[data-module="etco2"][data-part="wave"] canvas.wscale');
    return !!c && c.width > 0 && c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v > 0);
  }, null, { timeout: 3000 }).then(() => true, () => false);
  check(inked, 'editor: scale lines are drawn on the CO2 wave');
  await mon.getByTestId('f-cells.border.width').fill('0');
  await mon.getByTestId('theme-fill').click();
  const boxed = await mon.getByTestId('theme-text').inputValue();
  check(/"themeSchema": 1/.test(boxed) && boxed.includes('#ff00ff'), 'export: the current theme (with the edit) is shown as JSON');
  await mon.screenshot({ path: `${SHOTS}/theme-editor-monitor.png` });

  // the other monitor was not touched by device edits
  check(await mon2.evaluate(() => getComputedStyle(document.querySelector('#app')).getPropertyValue('--c-ecg').trim()) === '#0b6b1e', 'device edits stay on that device');

  // phone: reset everyone
  await phone.getByTestId('theme-reset').click();
  await mon2.waitForFunction(() => getComputedStyle(document.querySelector('#app')).backgroundColor === 'rgb(0, 0, 0)', null, { timeout: 1000 });
  check(true, 'phone: "Reset all to default" reaches monitors that follow the room');

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
} finally {
  await browser.close();
}
if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log('theme e2e ok');

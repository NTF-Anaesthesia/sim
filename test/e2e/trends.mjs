// Full event log, bookmark, trends and debrief (V2 S4) against a running Worker (BASE_URL): the phone marks the log
// more than 20 times, bookmarks with text, sees the trend graph and table (the table's last HR equals the monitor's),
// the monitor opens the same trends in an overlay, and the debrief file downloads and opens offline with chart and events.
import { chromium } from 'playwright';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const SHOTS = process.env.SHOTS_DIR ?? 'test/e2e/out';
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failed++; };
mkdirSync(SHOTS, { recursive: true });
const waitFor = async (fn, ms = 5000) => {
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
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 800 }, acceptDownloads: true });
  const phone = await phoneCtx.newPage();
  phone.on('pageerror', (e) => errors.push(String(e)));
  await phone.goto(`${BASE}/c/${code}`);
  await phone.locator('#status[data-status="open"]').waitFor({ timeout: 10000 });
  const mon = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  mon.on('pageerror', (e) => errors.push(String(e)));
  await mon.goto(`${BASE}/m/${code}`);
  await mon.locator('#status[data-status="open"]').waitFor({ timeout: 10000 });

  // a change with a glide, so the trend has something to show
  await phone.evaluate(({ code }) => new Promise((res) => {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${code}?role=controller&id=c-e2e`);
    ws.onopen = () => { ws.send(JSON.stringify({ t: 'set', patch: { patient: { hr: 130 } }, glideMs: 0 })); setTimeout(() => { ws.close(); res(null); }, 300); };
  }), { code });

  // 25 marks from the phone's header button: more than the 20 that state carries
  for (let i = 0; i < 25; i++) { await phone.getByTestId('mark').click(); await phone.waitForTimeout(60); } // under the 30 messages a second limit
  await phone.getByTestId('tab-trends').click();
  await phone.getByTestId('marktext').fill('induction <done>');
  await phone.getByTestId('mark-text').click();
  check(await waitFor(async () => /Bookmarked at/.test(await phone.getByTestId('mark-note').textContent())), 'bookmark confirmation shown');
  await phone.getByTestId('trend-refresh').click();
  const hasText = await waitFor(async () => (await phone.locator('.trend-body .hint').textContent().catch(() => '')).match(/(\d+) events in the log/)?.[1] >= 25);
  check(hasText, 'the log holds more than 20 events (25 marks + bookmark + change)');
  check(await phone.locator('[data-event="bookmark"]').count() >= 25, 'bookmarks appear as marks on the graph');
  check((await phone.getByTestId('trend-expiry').textContent()).includes('deleted at'), 'the 24 h expiry is shown on the phone');

  // table: last HR is the displayed value (glide 0, so it is 130 everywhere)
  await phone.getByTestId('trend-view-table').click();
  const lastHr = await phone.locator('.trend-table tbody tr:last-child td[data-key="hr"]').textContent();
  await phone.getByTestId('tab-vitals').click();
  const shownHr = (await phone.getByTestId('val-hr').textContent()).trim();
  check(lastHr?.trim() === shownHr && shownHr === '130', `trend table HR (${lastHr}) equals the displayed HR (${shownHr})`);

  // monitor: button opens an overlay with the same trends; closed again by default
  check(await mon.getByTestId('trends-overlay').isHidden(), 'monitor trends overlay is closed by default');
  await mon.getByTestId('trends-open').click();
  check(await waitFor(async () => (await mon.locator('.trends-overlay svg[data-testid="trend-svg"]').count()) === 1), 'monitor shows the trend graph');
  await mon.getByTestId('trends-close').click();
  check(await mon.getByTestId('trends-overlay').isHidden(), 'overlay closes');

  // debrief file: download, then open it offline
  await phone.getByTestId('tab-trends').click();
  const dl = phone.waitForEvent('download');
  await phone.getByTestId('trend-debrief').click();
  const download = await dl;
  const file = join(mkdtempSync(join(tmpdir(), 'debrief-')), download.suggestedFilename());
  await download.saveAs(file);
  const html = readFileSync(file, 'utf8');
  check(/debrief-data/.test(html) && html.includes('induction &lt;done&gt;'), 'debrief file has the embedded data and the escaped bookmark text');
  const off = await browser.newContext();
  await off.setOffline(true);
  const page = await off.newPage();
  await page.goto(pathToFileURL(file).href);
  check(await page.locator('svg.trend-svg').count() === 1, 'debrief opens offline with the chart');
  check(await page.locator('[data-testid="debrief-events"] tbody tr').count() >= 25, 'debrief lists the events');
  check(await page.locator('tr.bm').count() >= 25, 'bookmarks are highlighted in the debrief');

  // screenshots last: a file written under the assets folder makes `wrangler dev` reload and drop the sockets
  await phone.screenshot({ path: `${SHOTS}/trends-phone.png` });
  await mon.screenshot({ path: `${SHOTS}/trends-monitor.png` });
  await page.screenshot({ path: `${SHOTS}/trends-debrief.png`, fullPage: true });
  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);

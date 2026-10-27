// Share link, library offer and debrief export (sim-train S3) against a running Worker (BASE_URL): a scenario shared from
// phone A imports on phone B through the link (a bad or too-new link changes nothing), phone A offers its library to the
// room and phone B imports it, and the debrief saves as a PNG and opens as a print view.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';

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

const lib = {
  sim: 'library', version: 1,
  scenarios: [{
    name: 'Shared three', objectives: 'Spot the fall.',
    steps: [
      { atSec: 0, glideMs: 0, note: 'Check the probe', patch: { patient: { hr: 100 } } },
      { atSec: 2, glideMs: 0, patch: { patient: { hr: 120 } } },
      { onTap: true, glideMs: 0, patch: { patient: { hr: 140 } } },
    ],
  }],
  drugs: [],
};

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const errors = [];
  const home = await (await browser.newContext()).newPage();
  await home.goto(`${BASE}/`);
  await home.getByTestId('new-room').click();
  await home.locator('#room').waitFor({ state: 'visible' });
  const code = (await home.getByTestId('code').textContent())?.trim() ?? '';

  const open = async (ctx, path) => {
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.goto(`${BASE}${path}`);
    return p;
  };
  const ctxA = await browser.newContext({ viewport: { width: 390, height: 800 }, acceptDownloads: true });
  const ctxB = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const a = await open(ctxA, `/c/${code}`);
  await a.locator('#status[data-status="open"]').waitFor({ timeout: 10000 });
  await a.getByTestId('tab-scenarios').click();
  await a.locator('#lib').fill(JSON.stringify(lib));
  await a.getByTestId('lib-import').click();

  // share: card with QR and link
  await a.getByTestId('scn-share-Shared three').click();
  check(await a.getByTestId('share-qr').count() === 1, 'a small scenario gets a QR code');
  const link = await a.getByTestId('share-link').inputValue();
  check(/\/c\/#s=[A-Za-z0-9_-]+$/.test(link), `the link has the scenario in the hash (${link.length} chars)`);
  await a.screenshot({ path: `${SHOTS}/share-card.png` });

  // bad and too-new links change nothing
  const hash = link.slice(link.indexOf('#'));
  const b0 = await open(ctxB, `/c/${hash.slice(0, -6)}zzzzz`);
  check(await waitFor(async () => (await b0.getByTestId('share-refused').count()) === 1), 'a damaged link is refused with a message');
  const newer = Buffer.from([9, 1, 2, 3]).toString('base64url');
  const b1 = await open(ctxB, `/c/#s=${newer}`);
  check(await waitFor(async () => /newer version/.test(await b1.getByTestId('share-refused').textContent().catch(() => ''))), 'a too-new link says so');
  await b1.close();
  await b0.close();
  const check0 = await open(ctxB, `/c/${code}`);
  await check0.locator('#status[data-status="open"]').waitFor({ timeout: 10000 });
  await check0.getByTestId('tab-scenarios').click();
  check(await check0.getByTestId('scn-start-Shared three').count() === 0, 'refused links added nothing');
  await check0.close();

  // good link: Import on phone B, then the scenario is in B's library
  const b = await open(ctxB, `/c/${hash}`);
  await b.getByTestId('share-import-go').waitFor({ timeout: 5000 });
  check((await b.getByTestId('share-name').textContent()) === 'Shared three', 'the import card names the scenario');
  await b.getByTestId('share-import-go').click();
  check(await b.getByTestId('share-done').count() === 1, 'Import confirms');
  const b2 = await open(ctxB, `/c/${code}`);
  await b2.locator('#status[data-status="open"]').waitFor({ timeout: 10000 });
  await b2.getByTestId('tab-scenarios').click();
  check(await b2.getByTestId('scn-start-Shared three').count() === 1, 'the shared scenario is in phone B\'s library');
  await b.close();
  await b2.close();

  // library offer: phone A offers, a fresh phone C sees it and imports
  await a.getByTestId('lib-offer').click();
  check(await waitFor(async () => /You offered/.test(await a.getByTestId('offer-own').textContent().catch(() => ''))), 'phone A sees its own offer');
  const ctxC = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const c = await open(ctxC, `/c/${code}`);
  await c.locator('#status[data-status="open"]').waitFor({ timeout: 10000 });
  await c.getByTestId('tab-scenarios').click();
  check(await waitFor(async () => /Library offered: 1 scenario/.test(await c.getByTestId('offer').textContent().catch(() => ''))), 'phone C sees "Library offered: 1 scenario"');
  await c.getByTestId('lib-take').click();
  check(await waitFor(async () => (await c.getByTestId('scn-start-Shared three').count()) === 1), 'Import brings the offered scenario in');

  // debrief: run the scenario on A so notes and steps reach the log, then PNG and print view
  await a.getByTestId('scn-start-Shared three').click();
  await a.waitForTimeout(3500);
  await a.getByTestId('tab-trends').click();
  const [dl] = await Promise.all([a.waitForEvent('download'), a.getByTestId('trend-png').click()]);
  const path = await dl.path();
  const png = readFileSync(path);
  check(dl.suggestedFilename().endsWith('.png') && png.subarray(1, 4).toString() === 'PNG', `the debrief saves as a PNG (${png.length} bytes)`);
  await a.getByTestId('trend-print').click();
  await a.getByTestId('print-view').waitFor({ timeout: 5000 });
  check(await a.getByTestId('print-view').locator('svg').count() >= 1, 'the print view shows the chart');
  const text = await a.getByTestId('print-view').textContent();
  check(/Check the probe/.test(text ?? ''), 'the print view lists the scenario note reached');
  await a.emulateMedia({ media: 'print' });
  check(await a.getByTestId('print-view').isVisible(), 'the print view stays visible when printing');
  await a.screenshot({ path: `${SHOTS}/share-print.png`, fullPage: true });
  await a.emulateMedia({ media: 'screen' });
  await a.getByTestId('print-close').click();
  check(await a.getByTestId('print-view').count() === 0, 'the print view closes');

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);

// Speed per change, queue and live tempo on the phone (sim-train S1), 360 px wide. Needs the Worker at BASE_URL.
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
let failed = false;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failed = true; };

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 760 }, hasTouch: true, isMobile: true });
  const phone = await ctx.newPage();
  const { code } = await (await fetch(`${BASE}/api/room`, { method: 'POST' })).json();
  const mon = { state: null, waiters: [] };
  const sock = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws/${code}?role=monitor&id=m-q`);
  sock.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.t === 'state') mon.state = msg.state;
    mon.waiters = mon.waiters.filter((w) => !w());
  };
  const until = (pred, ms = 8000) => new Promise((resolve, reject) => {
    const w = () => { if (mon.state && pred(mon.state)) { resolve(); return true; } return false; };
    if (w()) return;
    mon.waiters.push(w);
    setTimeout(() => reject(new Error('timeout')), ms);
  });
  await new Promise((r) => { sock.onopen = r; });
  await phone.goto(`${BASE}/c/${code}`);
  await phone.locator('#status[data-status="open"]').waitFor({ timeout: 10000 });
  await phone.getByTestId('rng-hr').waitFor();
  const noScroll = () => phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  check(await noScroll(), 'no horizontal scroll at 360 px');

  // custom speed
  await phone.getByTestId('cust-n').fill('45');
  await phone.getByTestId('cust-set').click();
  await phone.getByTestId('glide-0').click();
  await phone.getByTestId('cust-n').fill('45');
  await phone.getByTestId('cust-set').click();

  // speed per change: HR 5 s, the rest on the shared custom 45 s
  for (let i = 0; i < 10; i++) await phone.locator('[data-id="hr"] [data-step="1"]').click();
  await phone.locator('[data-id="spo2"] [data-pct="-10"]').click();
  await phone.getByTestId('own-hr').selectOption('5000');
  check(await noScroll(), 'no horizontal scroll with pending chips');
  await phone.getByTestId('apply').click();
  await until((s) => s.patients[0].glide.glideMsBy?.hr === 5000);
  const g = mon.state.patients[0].glide;
  check(g.glideMsBy.hr === 5000 && g.glideMsBy.spo2 === 135000 && g.durationMs === 135000, `per-field glide recorded (${JSON.stringify(g.glideMsBy)})`);

  // live tempo: Finish now lands everything
  await phone.getByTestId('tempo-finish').click();
  await until((s) => s.patients[0].hr === 90 && s.patients[0].spo2 === 88);
  check(true, 'Finish now lands the running glide');

  // queue: two steps, reorder, skip, save as scenario
  await phone.getByTestId('glide-0').click();
  for (let i = 0; i < 5; i++) await phone.locator('[data-id="hr"] [data-step="1"]').click();
  await phone.getByTestId('q-mode').selectOption('tap');
  await phone.getByTestId('queue-add').click();
  await until((s) => s.scenario?.queue === true);
  for (let i = 0; i < 5; i++) await phone.locator('[data-id="hr"] [data-step="1"]').click();
  await phone.getByTestId('q-mode').selectOption('after');
  await phone.getByTestId('q-sec').fill('600');
  await phone.getByTestId('queue-add').click();
  await until((s) => s.scenario?.q?.length === 2);
  await phone.getByTestId('tab-scenarios').click();
  await phone.getByTestId('queue-panel').waitFor();
  check((await phone.getByTestId('queue-panel').locator('li').count()) === 2, 'queue panel lists two steps');
  check(await noScroll(), 'no horizontal scroll with the queue panel');
  await phone.getByTestId('tempo-2').click();
  await until((s) => s.scenario?.tempo === 2);
  check(true, 'tempo 2x reaches the room');
  await phone.getByTestId('qname').fill('My queue');
  await phone.getByTestId('q-save').click();
  const ln = (await phone.getByTestId('lib-note').textContent()) ?? '';
  check(/Saved/.test(ln), `queue saved as a scenario (${ln})`);
  await phone.getByTestId('q-del-1').click();
  await until((s) => s.scenario?.q?.length === 1);
  check(true, 'skip removes a step');
  await phone.getByTestId('tempo-finish').click();
  await until((s) => s.patients[0].hr === 95 || s.scenario?.done === true);
  check(true, 'Finish now finishes the whole queue');
  sock.close();
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);

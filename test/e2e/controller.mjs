// The phone controller against a real room: two browser contexts (a "phone" at 390 px and a monitor stand-in that
// listens on its own socket). Controller change reaches the monitor within 1 s, a preset applies to a chosen patient,
// alarm limits arrive, Apply sends changes together, and the phone reconnects after a sleep. Needs the Worker at BASE_URL.
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const LIMIT_MS = 1000;
let failed = false;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failed = true; };

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
  const phone = await ctx.newPage();
  const res = await fetch(`${BASE}/api/room`, { method: 'POST' });
  const { code } = await res.json();

  // the monitor stand-in: a second client that keeps the latest state (the real monitor draws from the same message)
  const mon = { state: null, presence: null, waiters: [] };
  const sock = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws/${code}?role=monitor&id=m-e2e`);
  sock.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.t === 'state') mon.state = msg.state;
    if (msg.t === 'presence') mon.presence = msg;
    mon.waiters = mon.waiters.filter((w) => !w());
  };
  const until = (pred, ms = 5000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const w = () => { if (mon.state && pred(mon.state)) { resolve(Date.now() - t0); return true; } return false; };
    if (w()) return;
    mon.waiters.push(w);
    setTimeout(() => reject(new Error('timeout')), ms);
  });
  await new Promise((r) => { sock.onopen = r; });

  await phone.goto(`${BASE}/c/${code}`);
  await phone.locator('#status[data-status="open"]').waitFor({ timeout: 10000 });
  await phone.getByTestId('rng-hr').waitFor();
  check(/1 monitor/.test((await phone.locator('#status').textContent()) ?? ''), 'connection chip shows 1 monitor');
  check(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal scroll at 390 px');

  // pending edits stay local until Apply, then go out together over the chosen glide time
  await phone.getByTestId('glide-30000').click();
  for (let i = 0; i < 20; i++) await phone.locator('[data-id="hr"] [data-step="1"]').click();
  await phone.locator('[data-id="spo2"] [data-pct="-10"]').click();
  check(mon.state.patients[0].hr === 80, 'unapplied change is not sent');
  const t0 = Date.now();
  await phone.getByTestId('apply').click();
  await until((s) => s.patients[0].hr === 100 && s.patients[0].spo2 === 88);
  const dt = Date.now() - t0;
  check(dt < LIMIT_MS, `applied HR and SpO2 reached the monitor together in ${dt} ms`);
  check(mon.state.patients[0].glide.durationMs === 30000, 'glide time 30 s recorded');
  await phone.locator('#progress').waitFor({ state: 'visible', timeout: 3000 });
  check(true, 'glide progress bar visible while gliding');
  await phone.locator('[data-id="hr"] [data-step="1"]').click();
  await phone.getByTestId('cancel').click();
  check((await phone.getByTestId('val-hr').textContent()) === '100', 'cancel drops pending changes');

  // art line is off until switched on; then its sliders appear
  check((await phone.locator('[data-id="abpSys"]').count()) === 0, 'art line off by default');
  await phone.getByTestId('sw-abp-module').click();
  await until((s) => s.modules.includes('abp'));
  await phone.locator('[data-id="abpSys"]').waitFor();
  check(true, 'art line switch adds ABP controls');

  // a second patient and a preset applied to it
  await phone.locator('[data-act="add"]').click();
  await until((s) => s.patients.length === 2);
  await phone.locator('.bed', { hasText: 'Bed 2' }).click();
  await phone.getByTestId('tab-presets').click();
  const t1 = Date.now();
  await phone.getByTestId('preset-VF arrest').click();
  await until((s) => s.patients[1].rhythm === 'vf');
  check(Date.now() - t1 < LIMIT_MS, `preset reached the monitor in ${Date.now() - t1} ms`);
  check(mon.state.patients[0].rhythm === 'sinus', 'other patient untouched by the preset');

  // alarm limits
  await phone.getByTestId('tab-alarms').click();
  for (let i = 0; i < 5; i++) await phone.locator('[data-limit="hr"] [data-end="hi"] [data-lstep="1"]').click();
  const t2 = Date.now();
  await until((s) => s.alarms.limits.hr[1] === 125);
  check(Date.now() - t2 < LIMIT_MS, 'alarm limit reached the monitor');

  // sensor off, NIBP interval
  await phone.getByTestId('tab-more').click();
  await phone.getByTestId('sw-off-spo2').click();
  await until((s) => s.patients[1].off.spo2 === true);
  check(true, 'sensor-off switch reaches the monitor');
  await phone.getByTestId('tab-vitals').click();
  await phone.locator('[data-nibp-int="300"]').click();
  await until((s) => s.patients[1].nibpRead.mode === 'cycle' && s.patients[1].nibpRead.cycleSec === 300);
  check(true, 'NIBP interval 5 min set');

  // the phone sleeps: its socket dies without a close; waking it reconnects and it sees changes made meanwhile
  await phone.evaluate(() => { for (const ev of ['offline']) window.dispatchEvent(new Event(ev)); });
  await ctx.setOffline(true);
  await phone.waitForTimeout(300);
  sock.send(JSON.stringify({ t: 'set', p: 'p2', patch: { patient: { hr: 61 } } }));
  await ctx.setOffline(false);
  await phone.evaluate(() => { window.dispatchEvent(new Event('online')); });
  await phone.locator('#status[data-status="open"]').waitFor({ timeout: 10000 });
  await phone.locator('[data-testid="val-hr"]', { hasText: '61' }).waitFor({ timeout: 5000 });
  check(true, 'phone reconnects after being offline and shows the latest state');
  sock.close();
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);

// Record, step editor and teaching notes on the phone (sim-train S2), 360 px wide. Needs the Worker at BASE_URL.
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
let failed = false;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failed = true; };

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 760 }, hasTouch: true, isMobile: true });
  const phone = await ctx.newPage();
  const errors = [];
  phone.on('pageerror', (e) => errors.push(String(e)));
  const { code } = await (await fetch(`${BASE}/api/room`, { method: 'POST' })).json();

  // a monitor socket: keeps every raw message, to prove no teaching text ever reaches a monitor
  let raw = '';
  let mon = null;
  const sock = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws/${code}?role=monitor&id=m-r`);
  const waiters = [];
  sock.onmessage = (ev) => {
    raw += ev.data;
    const msg = JSON.parse(ev.data);
    if (msg.t === 'state') mon = msg.state;
    for (const w of [...waiters]) if (w()) waiters.splice(waiters.indexOf(w), 1);
  };
  const until = (pred, ms = 15000) => new Promise((resolve, reject) => {
    const w = () => { if (mon && pred(mon)) { resolve(); return true; } return false; };
    if (w()) return;
    waiters.push(w);
    setTimeout(() => reject(new Error('timeout')), ms);
  });
  await new Promise((r) => { sock.onopen = r; });
  const monitor = await ctx.newPage();
  await monitor.goto(`${BASE}/m/${code}`);

  await phone.goto(`${BASE}/c/${code}`);
  await phone.locator('#status[data-status="open"]').waitFor({ timeout: 10000 });
  await phone.getByTestId('rng-hr').waitFor();
  const noScroll = () => phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

  // ---- record two changes, 6 s apart; the second has its own slow SpO2 speed
  await phone.getByTestId('tab-scenarios').click();
  await phone.getByTestId('rec-start').click();
  await phone.getByTestId('rec-panel').waitFor();
  check(await phone.getByTestId('recbar').isVisible(), 'the recording bar shows');
  await phone.getByTestId('tab-vitals').click();
  check(await phone.getByTestId('recbar').isVisible(), 'the recording bar shows on every tab');
  await phone.getByTestId('glide-0').click();
  for (let i = 0; i < 5; i++) await phone.locator('[data-id="hr"] [data-step="1"]').click();
  await phone.getByTestId('apply').click();
  await phone.waitForTimeout(6000);
  await phone.locator('[data-id="spo2"] [data-pct="-10"]').click();
  await phone.getByTestId('own-spo2').selectOption('120000');
  await phone.getByTestId('apply').click();
  await until((s) => s.patients[0].glide.glideMsBy?.spo2 === 120000);
  check((await phone.getByTestId('rec-count').textContent()).includes('2 steps'), 'two changes recorded');

  // ---- stop: named, saved, editor opens
  await phone.getByTestId('tab-scenarios').click();
  await phone.getByTestId('rec-name').fill('Rec A');
  await phone.getByTestId('rec-stop').click();
  await phone.getByTestId('editor').waitFor();
  check(!(await phone.getByTestId('recbar').isVisible()), 'recording stopped');
  check((await phone.getByTestId('ed-name').inputValue()) === 'Rec A', 'the editor opens on the recording');
  check((await phone.getByTestId('ed-step-1').count()) === 1 && (await phone.getByTestId('ed-step-2').count()) === 0, 'two step cards');
  const wait1 = await phone.getByTestId('ed-wait-1').inputValue();
  check(wait1 === '5' || wait1 === '10', `the real gap is kept, rounded to 5 s (${wait1} s)`);
  check((await phone.getByTestId('ed-step-1').textContent()).includes('spo2'), 'the own SpO2 speed is kept on the step');
  check(await noScroll(), 'no horizontal scroll in the editor');

  // ---- edit: notes, objectives, on-tap, reorder, rename, delete
  await phone.getByTestId('ed-obj').fill('Learner calls for help early');
  await phone.getByTestId('ed-note-0').fill('Cue: HR climbs');
  await phone.getByTestId('ed-note-1').fill('Expect oxygen on');
  await phone.getByTestId('ed-tap-1').check();
  check(await phone.getByTestId('ed-wait-1').isDisabled(), 'on tap disables the wait');
  await phone.getByTestId('ed-glide-0').fill('2');
  await phone.getByTestId('ed-down-0').click();
  check((await phone.getByTestId('ed-note-0').inputValue()) === 'Expect oxygen on', 'reorder moves the card and its note');
  await phone.getByTestId('ed-up-1').click();
  check((await phone.getByTestId('ed-note-0').inputValue()) === 'Cue: HR climbs', 'moved back');
  await phone.getByTestId('ed-name').fill('Rec B');
  await phone.getByTestId('ed-save').click();
  check((await phone.getByTestId('lib-note').textContent()).includes('Saved "Rec B"'), 'edited scenario saved under its new name');
  check((await phone.getByTestId('scn-start-Rec A').count()) === 0 && (await phone.getByTestId('scn-start-Rec B').count()) === 1, 'rename replaced the old entry');

  // built-ins open as a copy
  await phone.getByTestId('scn-edit-Slow bleed').click();
  check((await phone.getByTestId('ed-name').inputValue()) === 'Slow bleed copy', 'a built-in opens as a copy');
  await phone.getByTestId('ed-del-0').click();
  await phone.getByTestId('ed-cancel').click();
  check((await phone.getByTestId('scn-start-Slow bleed copy').count()) === 0, 'cancel saves nothing');

  // ---- run it: the phone shows objectives and the cue, the monitor never does
  await phone.getByTestId('scn-start-Rec B').click();
  await until((s) => s.scenario?.name === 'Rec B' && s.scenario.step === 1);
  await phone.getByTestId('scn-note').waitFor();
  check((await phone.getByTestId('scn-objectives').textContent()).includes('Learner calls for help early'), 'the phone shows the objectives');
  check((await phone.getByTestId('scn-note').textContent()).includes('Cue: HR climbs'), 'the phone shows the current step note');
  await phone.getByTestId('scn-next').click();
  await until((s) => s.scenario?.step === 2);
  await phone.waitForFunction(() => document.querySelector('[data-testid="scn-note"]')?.textContent.includes('Expect oxygen on'));
  check(true, 'the note follows the current step');
  sock.send(JSON.stringify({ t: 'hello' }));
  await phone.waitForTimeout(800);
  check(/"scenario"/.test(raw), 'the monitor does see the scenario run itself');
  check(!/Cue: HR climbs|Expect oxygen|Learner calls/.test(raw), 'no teaching text ever reached the monitor socket (state, broadcasts, hello reply)');
  const monText = await monitor.evaluate(() => document.body.innerText + document.body.innerHTML);
  check(!/Cue: HR climbs|Expect oxygen|Learner calls/.test(monText), 'the monitor page shows no teaching text');
  check(errors.length === 0, `no page errors ${errors.join('|')}`);
  sock.close();
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);

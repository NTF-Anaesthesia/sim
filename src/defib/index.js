// @ts-check
// The defib screen (a named screen of kind `defib`): ECG from the pads, energy select, charge, shock, sync with R-wave
// markers. Touch and mouse (plain buttons). The shock itself is a room message, so every screen of the bed and the log
// agree; charge, energy and sync are local to this screen. Colours come from the theme; the look is generic.
import { shown } from '../engine/rhythm.js';
import { Lane } from '../monitor/lane.js';
import { waveSettings } from '../theme/resolve.js';
import { DefibModel } from './model.js';

/** How long a "Shock delivered" line stays, ms. */
const NOTE_MS = 4000;

/**
 * @param {HTMLElement} root
 * @param {{
 *   client: import('../room/client.js').RoomClient, settings: import('../monitor/settings.js').Settings,
 *   waves: import('../waves/registry.js').WaveRegistry, src: import('../waves/source.js').WaveSource,
 *   onFull: () => void, makeContext?: () => AudioContext, model?: ConstructorParameters<typeof DefibModel>[0]
 * }} opts
 */
export function createDefib(root, opts) {
  const { client, settings } = opts;
  const doc = root.ownerDocument;
  const model = new DefibModel(opts.model);
  /** @type {import('../shared/schema.js').Patient | null} */
  let patient = null;
  /** @type {Record<string, any> | null} */
  let theme = null;
  let themeKey = '';
  /** @type {Lane | null} */
  let lane = null;
  let screenName = '';
  let startedAt = 0;
  let noteUntil = 0;
  let note = '';
  /** @type {AudioContext | null} */
  let ctx = null;
  /** @type {OscillatorNode | null} */
  let osc = null;
  let lastReadyBeep = 0;
  let pressedAtSec = 0;
  let lastKey = '';

  root.className = 'defib';
  root.innerHTML = `
    <div class="d-top"><b class="d-name" data-testid="defib-name"></b><span class="d-bed" data-testid="defib-bed"></span>
      <span class="chip" data-testid="defib-status">connecting</span>
      <button type="button" class="d-small" data-d="tone" data-testid="defib-tone" aria-pressed="false">Tone</button>
      <button type="button" class="d-small" data-d="full">Full screen</button></div>
    <div class="d-wave"><canvas class="d-main"></canvas><canvas class="d-marks" data-testid="defib-marks"></canvas><span class="d-label">ECG (pads)</span><span class="d-off" hidden>Pads off</span></div>
    <div class="d-read"><span class="d-hr" data-testid="defib-hr">--</span><span class="d-unit">/min</span>
      <span class="d-mode" data-testid="defib-mode"></span></div>
    <div class="d-msg" role="status" aria-live="polite" data-testid="defib-msg"></div>
    <div class="d-bar" hidden><i></i></div>
    <div class="d-ctl">
      <div class="d-energy"><button type="button" data-d="down" aria-label="Lower energy" data-testid="defib-down">−</button>
        <output class="d-j" data-testid="defib-energy"></output>
        <button type="button" data-d="up" aria-label="Higher energy" data-testid="defib-up">+</button></div>
      <button type="button" class="d-big d-charge" data-d="charge" data-testid="defib-charge">CHARGE</button>
      <button type="button" class="d-big d-shock" data-d="shock" data-testid="defib-shock" disabled>SHOCK</button>
      <button type="button" class="d-big d-sync" data-d="sync" data-testid="defib-sync" aria-pressed="false">SYNC</button>
    </div>`;
  const q = (/** @type {string} */ s) => /** @type {HTMLElement} */ (root.querySelector(s));
  const canvas = /** @type {HTMLCanvasElement} */ (q('.d-main'));
  const marks = /** @type {HTMLCanvasElement} */ (q('.d-marks'));
  const el = {
    name: q('.d-name'), bed: q('.d-bed'), chip: q('.chip'), tone: q('[data-d=tone]'), hr: q('.d-hr'), mode: q('.d-mode'),
    msg: q('.d-msg'), bar: q('.d-bar'), barFill: q('.d-bar i'), j: q('.d-j'), charge: q('.d-charge'), shock: q('.d-shock'),
    sync: q('.d-sync'), off: q('.d-off'),
  };

  const toneOn = () => settings.get('defib.tone', /** @type {boolean} */ (false)) === true;
  const padsOff = () => !!patient?.off?.pads;

  /** @param {number} fromHz @param {number} toHz @param {number} secs */
  function startTone(fromHz, toHz, secs) {
    if (!toneOn()) return;
    try {
      ctx ??= (opts.makeContext ?? (() => new AudioContext()))();
      stopTone();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.setValueAtTime(fromHz, ctx.currentTime);
      o.frequency.linearRampToValueAtTime(toHz, ctx.currentTime + secs);
      g.gain.value = 0.06;
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + secs);
      osc = o;
    } catch { /* no audio here */ }
  }
  function stopTone() { try { osc?.stop(); } catch { /* already stopped */ } osc = null; }
  function readyBeep() {
    if (!toneOn() || !ctx) return;
    try {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 1000;
      g.gain.value = 0.05;
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.25);
    } catch { /* no audio here */ }
  }

  function sendShock() {
    if (!patient) return;
    client.send({ t: 'shock', p: patient.id, energy: model.energy, sync: model.sync });
    model.delivered();
    stopTone();
  }

  root.addEventListener('click', (e) => {
    const what = /** @type {HTMLElement} */ (e.target).closest('button')?.dataset.d;
    if (!what) return;
    const now = performance.now();
    if (what === 'up') model.step(1);
    else if (what === 'down') model.step(-1);
    else if (what === 'sync') model.setSync(!model.sync);
    else if (what === 'full') opts.onFull();
    else if (what === 'tone') {
      settings.set('defib.tone', !toneOn());
      if (!toneOn()) stopTone();
    } else if (what === 'charge') {
      model.charge(now);
      if (model.phase === 'charging') startTone(300, 1200, model.chargeMs / 1000);
    } else if (what === 'shock') {
      const r = model.press(now, padsOff());
      if (r === 'send') sendShock();
      else if (r === 'wait') pressedAtSec = performance.now() / 1000;
    }
    if (model.phase === 'idle') stopTone();
    render(now);
  });

  let dead = false;
  client.on('error', (m) => {
    if (dead) return;
    const e = /** @type {{ code?: string, msg?: string }} */ (m);
    if (e.code === 'bad_patch' && /shock|pads|energy/.test(e.msg ?? '')) { model.msg = e.msg ?? 'Shock refused'; render(performance.now()); }
  });

  function buildLane() {
    if (!theme) return;
    const wd = opts.waves.get('ecg');
    if (!wd) return;
    const ws = waveSettings(theme, 'ecg');
    const [lo, hi] = wd.range(ws.gain);
    lane = new Lane(canvas, {
      pxPerSec: ws.speed * theme.waves.pxPerMm, color: theme.colors.ecg ?? theme.colors.text, lineWidth: theme.waves.lineWidth,
      gapPx: theme.waves.sweepGapPx, lo, hi,
      sample: (t) => (patient && t >= startedAt ? wd.sample(opts.src, t, { patient, perfusing: true, tSec: t }) : null),
    });
    lane.refill(performance.now() / 1000);
  }

  /** @param {number} now */
  function render(now) {
    const key = `${model.phase}|${model.energy}|${model.sync}|${padsOff()}|${model.waitingSince > 0}|${model.msg}|${toneOn()}|${now < noteUntil ? note : ''}|${client.status}`;
    if (key === lastKey && model.phase !== 'charging') return;
    lastKey = key;
    el.j.textContent = `${model.energy} J`;
    el.chip.textContent = client.status === 'open' ? 'live' : client.status;
    el.sync.setAttribute('aria-pressed', String(model.sync));
    el.tone.setAttribute('aria-pressed', String(toneOn()));
    el.shock.toggleAttribute('disabled', model.phase !== 'ready');
    el.charge.toggleAttribute('disabled', model.phase !== 'idle');
    el.shock.dataset.armed = model.phase === 'ready' ? '1' : '';
    el.mode.textContent = model.sync ? 'SYNC' : 'ASYNC';
    el.off.hidden = !padsOff();
    el.bar.hidden = model.phase === 'idle';
    root.dataset.phase = model.phase;
    root.dataset.waiting = model.waitingSince > 0 ? '1' : '';
    el.msg.textContent = now < noteUntil ? note : model.msg;
  }

  return {
    model,
    /**
     * Called after every state change: which bed, which screen name, which theme.
     * @param {{ patient: import('../shared/schema.js').Patient | null, theme: Record<string, any>, themeKey: string, name: string }} a
     */
    update(a) {
      const bedChanged = patient?.id !== a.patient?.id;
      patient = a.patient;
      screenName = a.name;
      el.name.textContent = screenName;
      el.bed.textContent = patient?.label ?? '';
      if (a.themeKey !== themeKey) {
        themeKey = a.themeKey;
        theme = a.theme;
        startedAt = performance.now() / 1000;
        const s = root.style;
        s.setProperty('--m-bg', theme.background);
        s.setProperty('--m-font', theme.font.family);
        for (const [k, v] of Object.entries(theme.colors)) s.setProperty(`--c-${k}`, String(v));
        buildLane();
      }
      if (lane && patient) lane.blank = !!patient.off?.ecg || !!patient.off?.pads;
      if (bedChanged && lane) lane.refill(performance.now() / 1000);
      render(performance.now());
    },
    /** A shock event from the room (this device's or another screen's): message and the new rhythm follows in state. */
    onShock(/** @type {{ what: string, t: number }} */ e) {
      note = `Shock delivered: ${e.what}`;
      noteUntil = performance.now() + NOTE_MS;
      lastKey = '';
      render(performance.now());
    },
    /** @param {number} tSec display time @param {number} perfNow performance.now() in ms */
    frame(tSec, perfNow) {
      if (!lane || !patient) return;
      const nowMs = client.serverNow();
      const sh = shown(patient, nowMs);
      el.hr.textContent = sh.hr === null || sh.hr === undefined || !Number.isFinite(sh.hr) ? '---' : String(Math.round(sh.hr));
      // sync: an R wave after the button was pressed releases the shock
      const beats = opts.src.beats;
      const rWave = model.waitingSince > 0 && beats.some((b) => b.t > pressedAtSec && b.t <= tSec && b.kind !== 'dropped');
      if (model.tick(perfNow, rWave) === 'send') sendShock();
      if (model.phase === 'ready' && perfNow - lastReadyBeep > 1000) { lastReadyBeep = perfNow; readyBeep(); }
      if (model.phase !== 'idle') el.barFill.style.width = `${Math.round(model.progress(perfNow) * 100)}%`;
      lane.draw(tSec);
      drawMarks(tSec);
      render(perfNow);
    },
    /** Redraw the ECG from the source's history (resize, theme, tab back). */
    refill(/** @type {number} */ tSec) { lane?.refill(tSec); },
    destroy() { dead = true; stopTone(); },
  };

  /** Sync markers: a small triangle above each R wave in the visible sweep while sync is on. */
  function drawMarks(/** @type {number} */ tSec) {
    if (!lane || !lane.w) return;
    const dpr = lane.dpr;
    const W = Math.round(lane.w * dpr);
    const H = Math.round(lane.h * dpr);
    if (marks.width !== W || marks.height !== H) { marks.width = W; marks.height = H; }
    const c = marks.getContext('2d');
    if (!c) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, lane.w, lane.h);
    if (!model.sync) return;
    c.fillStyle = theme?.colors.alarmMed ?? '#ffd000';
    const win = lane.window;
    for (const b of opts.src.beats) {
      if (b.kind === 'dropped' || b.t > tSec || b.t < tSec - win + 0.3) continue;
      const x = lane.x(b.t);
      c.beginPath();
      c.moveTo(x - 6, 3);
      c.lineTo(x + 6, 3);
      c.lineTo(x, 15);
      c.closePath();
      c.fill();
    }
  }
}

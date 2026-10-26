// @ts-check
// The monitor screen: joins a room's state to the view. One frame loop draws the waves; a 250 ms tick updates numerics,
// alarms and the alarm tone. Waves run on the display clock (seconds), glide / silence / NIBP on the server clock (ms).
import { AlarmTracker, burstDue, evaluateAlarms, PRIORITY_NAME } from '../engine/alarms.js';
import { displayed } from '../engine/glide.js';
import { jittered } from '../engine/jitter.js';
import { NibpMachine, nibpCycleDue } from '../engine/nibp.js';
import { pulseless, shown } from '../engine/rhythm.js';
import { SCHEMA_VERSION } from '../shared/schema.js';
import { createWaveRegistry, registerBuiltinWaves, WaveSource } from '../waves/index.js';
import { layoutCells } from '../theme/layout.js';
import { BUILTIN_THEMES } from '../theme/builtin.js';
import { createThemePanel } from '../theme/panel.js';
import { mountTrends } from '../trends/panel.js';
import { resolveTheme, waveSettings } from '../theme/resolve.js';
import { createThemeStore, pickTheme } from '../theme/store.js';
import { loadTheme } from '../theme/validate.js';
import { AudioMixer } from './audio.js';
import { Lane } from './lane.js';
import { createDefib } from '../defib/index.js';
import { createIdentity } from './identity.js';
import { createModuleRegistry, registerBuiltinModules } from './modules.js';
import { createSettings } from './settings.js';
import { buildView } from './view.js';

const TICK_MS = 250;
/** @param {unknown} x @param {number} fallback a device setting is only used when it is a positive number */
const positive = (x, fallback) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : fallback);

/**
 * @param {HTMLElement} root
 * @param {{
 *   client: import('../room/client.js').RoomClient, code: string, pick?: string | null, screenParam?: string | null,
 *   onClearPick?: () => void, settings?: import('./settings.js').Settings, makeContext?: () => AudioContext
 * }} opts
 */
export function mountScreen(root, opts) {
  const { client } = opts;
  const settings = opts.settings ?? createSettings();
  const waves = createWaveRegistry();
  registerBuiltinWaves(waves);
  const modules = createModuleRegistry();
  registerBuiltinModules(modules);
  const src = new WaveSource(7);
  const tracker = new AlarmTracker();
  const burstSt = { lastAt: 0, lastPriority: 0 };
  let theme = resolveTheme(undefined).theme;
  let themeKey = '';
  const screenPick = () => { const m = /** @type {string} */ (settings.get('screen', 'theme')); return m === 'fill' || m === 'fixed' ? m : 'theme'; };
  /** @type {import('../shared/schema.js').RoomState | null} */
  let state = null;
  /** @type {import('../shared/schema.js').Patient | null} */
  let patient = null;
  let nibp = new NibpMachine();
  let nibpReq = { after: -1, at: 0 };
  /** @type {import('./view.js').View | null} */
  let view = null;
  let viewKey = '';
  /** @type {{ lane: Lane, id: string, ref: import('./view.js').CellRef }[]} */
  let lanes = [];
  let needRefill = true;
  let lastBeepT = performance.now() / 1000;
  let lastTick = 0;
  const startedAt = performance.now() / 1000; // before this there is no history to draw: leave the lanes blank
  let latestVals = /** @type {Record<string, any>} */ ({});
  /** @type {import('../shared/schema.js').Numerics | undefined} */
  let latestD;
  let flushSeen = 0;
  let shockSeen = 0;
  /** @type {ReturnType<typeof createDefib> | null} the defib screen, while this screen's kind is `defib` */
  let defib = null;
  /** @type {WakeLockSentinel | null} */
  let wake = null;
  let wakeWanted = false;
  /** @type {import('../shared/schema.js').Screen | null} this monitor's named screen (set from the phone) */
  let screen = null;
  let pick = opts.pick ?? null; // bed chosen on this device (`?p=`)

  const audio = new AudioMixer({
    volume: (ch) => (theme.audio?.[ch]?.volume ?? 1) * settings.get(`vol.${ch}`, 1),
    makeContext: opts.makeContext,
  });

  // Theme: a choice made on this device wins, else its screen's theme, else the room's theme (sent from a phone), else
  // the default.
  const themeStore = createThemeStore(settings);
  // Named screen: device choices (theme, `?p=` bed) win over the screen's settings; the phone can clear them.
  const identity = createIdentity({
    client, code: opts.code, settings, param: opts.screenParam, doc: root.ownerDocument,
    deviceChoices: () => [...(themeStore.get() ? ['theme'] : []), ...(pick ? ['p'] : [])],
    onChange: () => applyState(),
    onClear: (what) => {
      if (what === 'theme') themeStore.followRoom();
      if (what === 'p') { pick = null; opts.onClearPick?.(); }
      applyState();
    },
  });
  const panel = createThemePanel({
    title: 'Theme (this device)',
    getTheme: () => theme,
    editor: true,
    choices: [
      { id: 'room', label: 'Follow the room' },
      ...BUILTIN_THEMES.map((b) => ({ id: b.id, label: String(b.theme.name) })),
      { id: 'custom', label: 'Custom (this device)' },
    ],
    current: () => themeStore.get()?.id ?? 'room',
    onChoose: (id) => {
      if (id === 'room') themeStore.followRoom();
      else if (id === 'custom') themeStore.setCustom(theme);
      else themeStore.setBuiltin(id);
      identity.report();
      applyState();
    },
    onApply: (t) => { themeStore.setCustom(t); identity.report(); applyState(); },
    extras: [],
    screen: { get: screenPick, set: (m) => { settings.set('screen', m); applyState(); } },
    doc: root.ownerDocument,
  });
  root.ownerDocument.body.append(panel.el);

  // Trends overlay: closed by default; opening it asks the room for its log (nothing is kept on this device).
  const trendsEl = root.ownerDocument.createElement('div');
  trendsEl.className = 'trends-overlay';
  trendsEl.hidden = true;
  trendsEl.dataset.testid = 'trends-overlay';
  trendsEl.innerHTML = '<div class="trends-bar"><b>Trends</b><button type="button" data-testid="trends-close">Close</button></div><div class="trends-host"></div>';
  const trendsHost = /** @type {HTMLElement} */ (trendsEl.querySelector('.trends-host'));
  const trendsPanel = mountTrends(trendsHost, { client, code: opts.code, patientId: () => patient?.id });
  trendsEl.querySelector('button')?.addEventListener('click', () => { trendsEl.hidden = true; });
  root.ownerDocument.body.append(trendsEl);
  function toggleTrends() {
    trendsEl.hidden = !trendsEl.hidden;
    if (!trendsEl.hidden) trendsPanel.refresh();
  }

  const modsOn = () => screen?.modules ?? state?.modules ?? [];
  /** @param {import('../theme/layout.js').Cell} cell */
  function isShown(cell) {
    const def = modules.get(cell.module);
    if (!def || !modsOn().includes(cell.module)) return false;
    if (cell.part === 'wave') return !!def.wave && !!waves.get(def.wave);
    return !!def.parts[cell.part] && !def.skip?.(cell.part, modsOn());
  }

  /**
   * Flush and shock events from the room start their effect on this bed, timed from when they happened on the server: a
   * flush test draws a square wave on the art line, a shock draws artefact on the ECG and pleth (and a defib screen
   * says so).
   */
  function pickFlush() {
    if (!state || !patient) return;
    const nowMs = client.serverNow();
    for (const e of state.events) {
      if (e.kind === 'shock') {
        if (e.t <= shockSeen || (e.p && e.p !== patient.id)) continue;
        shockSeen = e.t;
        if (nowMs - e.t > 4000) continue;
        src.shock = performance.now() / 1000 - Math.max(0, nowMs - e.t) / 1000;
        needRefill = true;
        defib?.onShock(e);
        continue;
      }
      if (e.kind !== 'flush' || e.t <= flushSeen || (e.p && e.p !== patient.id)) continue;
      flushSeen = e.t;
      if (nowMs - e.t > 4000) continue;
      src.flush = { ...(src.flush ?? {}), [e.what]: performance.now() / 1000 - Math.max(0, nowMs - e.t) / 1000 };
      needRefill = true;
    }
  }

  function pickPatient() {
    const ps = state?.patients ?? [];
    return ps.find((p) => p.id === pick) ?? ps.find((p) => p.id === screen?.p) ?? ps[0] ?? null;
  }

  function rebuild() {
    if (!state) return;
    const cells = layoutCells(theme, isShown);
    view = buildView(root, theme, cells, {
      code: opts.code,
      onSilence: () => client.send({ t: 'silence' }),
      onSound: toggleSound,
      onFull: toggleFull,
      onWake: toggleWake,
      onTheme: () => (panel.isOpen ? panel.close() : panel.open()),
      onTrends: toggleTrends,
      screenMode: screenPick() === 'theme' ? theme.screen.mode : screenPick(),
      onFit: () => { needRefill = true; },
    });
    lanes = [];
    for (const ref of view.refs) {
      const def = modules.get(ref.cell.module);
      if (ref.cell.part !== 'wave' || !ref.canvas || !def?.wave) continue;
      const id = def.wave;
      const wd = /** @type {import('../waves/registry.js').WaveDef} */ (waves.get(id));
      const ws = waveSettings(theme, id);
      const speed = positive(settings.get(`sweep.${id}`, ws.speed), ws.speed);
      const gain = positive(settings.get(`gain.${id}`, ws.gain), ws.gain);
      const [lo, hi] = wd.range(gain);
      const lane = new Lane(ref.canvas, {
        pxPerSec: speed * theme.waves.pxPerMm, color: theme.colors[id] ?? theme.colors.text,
        lineWidth: theme.waves.lineWidth, gapPx: theme.waves.sweepGapPx, lo, hi,
        zoom: () => view?.fit.scale ?? 1,
        scale: ref.scale && Array.isArray(theme.waves[id]?.scaleLines) && theme.waves[id].scaleLines.length
          ? { canvas: ref.scale, lines: theme.waves[id].scaleLines, font: theme.font.family, px: Math.round(10 * theme.font.labelScale * (theme.font.waveLabelScale ?? 1)) }
          : undefined,
        sample: (t) => (patient && t >= startedAt ? wd.sample(src, t, { patient, perfusing: !pulseless(patient), tSec: t, d: latestD }) : null),
      });
      lanes.push({ lane, id, ref });
    }
    needRefill = true;
    renderChips();
    tick(performance.now());
  }

  function applyState() {
    if (!state) return;
    screen = identity.sync(state);
    const { raw } = pickTheme(themeStore.get(), state, screen);
    const key = JSON.stringify(raw ?? null);
    if (key !== themeKey) {
      themeKey = key;
      theme = loadTheme(raw).theme;
      nibp = new NibpMachine(theme.nibp);
      audio.refreshVolumes();
      viewKey = '';
    }
    const np = pickPatient();
    if (np?.id !== patient?.id) { nibp = new NibpMachine(theme.nibp); viewKey = ''; }
    patient = np;
    if (screen?.kind === 'defib') {
      if (!defib) {
        view = null;
        viewKey = '';
        lanes = [];
        defib = createDefib(root, { client, settings, waves, src, onFull: toggleFull, makeContext: opts.makeContext });
      }
      defib.update({ patient, theme, themeKey, name: screen.name });
      return;
    }
    if (defib) { defib.destroy(); defib = null; viewKey = ''; }
    const k = JSON.stringify([modsOn(), patient?.id, screenPick()]) + themeKey;
    if (k !== viewKey) { viewKey = k; rebuild(); }
    if (view && identity.nameEl.parentElement !== view.chip.parentElement) view.chip.before(identity.nameEl);
    if (view) view.testValue.textContent = state.test === undefined ? '--' : String(state.test);
    if (view) view.testValue.dataset.patient = patient?.id ?? '';
  }

  function renderChips() {
    if (!view) return;
    const s = client.status;
    view.chip.textContent = s === 'open' ? 'live' : s;
    view.chip.dataset.status = s;
    view.soundBtn.textContent = audio.enabled ? 'Sound on' : 'Sound';
    view.wakeBtn.textContent = wakeWanted ? 'Awake on' : 'Keep awake';
    view.fullBtn.textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen';
  }

  async function toggleSound() {
    if (audio.enabled) await audio.disable();
    else await audio.enable();
    renderChips();
  }
  async function toggleFull() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch { /* not allowed here */ }
    renderChips();
  }
  async function acquireWake() {
    try {
      if (!wakeWanted) { await wake?.release(); wake = null; return; }
      if (wake) return;
      wake = await navigator.wakeLock.request('screen');
      wake.addEventListener('release', () => { wake = null; renderChips(); });
    } catch { wake = null; }
  }
  async function toggleWake() {
    wakeWanted = !wakeWanted;
    await acquireWake();
    renderChips();
  }

  /** @param {number} perfNow */
  function tick(perfNow) {
    lastTick = perfNow;
    if (!state || !patient || !view) return;
    const nowMs = client.serverNow();
    const tSec = perfNow / 1000;
    const s = shown(patient, nowMs);
    const jit = settings.get('jitter', true);
    /** @type {(v: number | null, kind: 'hr' | 'spo2' | 'etco2' | 'rr' | 'temp' | 'sys' | 'dia' | 'cvp', max?: number) => number | null} */
    const J = (v, kind, max) => (jit ? jittered(v, kind, `${patient?.id}${kind}`, tSec, { max }) : v);
    const abp = s.abp ? { sys: /** @type {number} */ (J(s.abp.sys, 'sys')), dia: /** @type {number} */ (J(s.abp.dia, 'dia')) } : null;
    const abp2 = s.abp2 ? { sys: /** @type {number} */ (J(s.abp2.sys, 'sys')), dia: /** @type {number} */ (J(s.abp2.dia, 'dia')) } : null;
    const v = {
      cvp: s.cvp === null ? null : /** @type {number} */ (jit ? J(s.cvp, 'cvp') : s.cvp), abp2,
      bis: s.bis === null ? null : Math.round(s.bis),
      hr: J(s.hr, 'hr'), spo2: J(s.spo2, 'spo2', 100), etco2: J(s.etco2, 'etco2'), rr: J(s.rr, 'rr'),
      temp: jit ? /** @type {number} */ (J(s.temp, 'temp')) : s.temp, abp,
    };
    latestVals = v;
    const nb = nibp.tick(patient.nibpRead, !!patient.off?.nibp, nowMs);
    const due = nibpCycleDue(patient.nibpRead, nowMs);
    if (due !== null && (nibpReq.after !== due || nowMs - nibpReq.at > 5000)) {
      nibpReq = { after: due, at: nowMs };
      client.send({ t: 'nibp', p: patient.id, after: due });
    }
    const alarms = evaluateAlarms(patient, state, {
      // alarms judge the glided value, not the display wobble, so a value near a limit does not flap
      hr: s.hr, spo2: s.spo2, etco2: s.etco2, rr: s.rr, temp: s.temp,
      nibpSys: nb.phase === 'result' ? nb.sys : null, abpSys: s.abp ? s.abp.sys : null,
      cvp: s.cvp, abp2Sys: s.abp2 ? s.abp2.sys : null,
      bis: s.bis === null ? null : Math.round(s.bis),
    }, nowMs);
    const av = tracker.update(alarms, { enabled: state.alarms.enabled, silencedUntil: state.alarms.silencedUntil }, nowMs);

    const ctx = {
      patient, state, v, nibp: nb, nowMs, theme,
      units: settings.get('units', { co2: 'mmHg', temp: 'C' }),
    };
    for (const ref of view.refs) {
      if (ref.cell.part === 'wave') continue;
      const def = modules.get(ref.cell.module);
      const part = def?.parts[ref.cell.part];
      if (!part || !ref.val) continue;
      const nv = part(ctx);
      const text = `${nv.label}|${nv.main}|${nv.sub}|${nv.unit}|${nv.small}|${nv.limits}`;
      if (ref.el.dataset.sig !== text) {
        ref.el.dataset.sig = text;
        ref.el.style.setProperty('--c', `var(--c-${nv.color})`);
        /** @type {HTMLElement} */ (ref.label).textContent = nv.label;
        /** @type {HTMLElement} */ (ref.unit).textContent = nv.unit;
        const inline = theme.numerics.meanPosition === 'inline' && nv.sub.startsWith('(');
        ref.el.dataset.mean = inline ? 'inline' : '';
        ref.val.textContent = nv.main;
        if (inline) {
          const mean = ref.val.ownerDocument.createElement('span');
          mean.className = 'nmean';
          mean.textContent = ` ${nv.sub}`;
          ref.val.append(mean);
        }
        /** @type {HTMLElement} */ (ref.sub).textContent = inline ? '' : nv.sub;
        /** @type {HTMLElement} */ (ref.small).textContent = nv.small;
        /** @type {HTMLElement} */ (ref.hi).textContent = nv.limits ? String(nv.limits[1]) : '';
        /** @type {HTMLElement} */ (ref.lo).textContent = nv.limits ? String(nv.limits[0]) : '';
      }
      ref.el.dataset.off = nv.off ? '1' : '';
      const a = av.alarms.find((x) => x.param === nv.param);
      const flash = av.flashParams.has(nv.param) && !av.silenced;
      ref.el.dataset.alarm = a ? PRIORITY_NAME[/** @type {1 | 2 | 3} */ (a.priority)] : '';
      ref.el.classList.toggle('flash', flash);
    }
    for (const { lane, id, ref } of lanes) {
      const wd = /** @type {import('../waves/registry.js').WaveDef} */ (waves.get(id));
      const blank = wd.blank({ patient, perfusing: s.perfusing, tSec });
      if (blank !== lane.blank) { lane.blank = blank; needRefill = true; }
      if (ref.off) ref.off.hidden = !blank;
    }
    const bar = view.bar;
    const top = av.top;
    bar.dataset.alarm = av.silenced ? 'silenced' : (top ? PRIORITY_NAME[/** @type {1 | 2 | 3} */ (top.priority)] : '');
    bar.classList.toggle('flash', !!top && !av.silenced && top.priority >= 2);
    const left = Math.ceil(av.silenceLeftMs / 1000);
    bar.textContent = av.silenced
      ? `Silenced ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
      : (top ? top.text + (av.alarms.length > 1 ? ` +${av.alarms.length - 1}` : '') : (av.master ? '' : 'ALARMS OFF'));
    bar.title = 'Tap to silence alarms for 2 minutes';

    // tone: repeats while active, restarts at once for a higher priority; a lower priority resets the ceiling
    if (av.priority <= 0) burstSt.lastPriority = 0;
    else if (av.priority < burstSt.lastPriority) burstSt.lastPriority = av.priority;
    if (audio.enabled && burstDue(av.priority, av.silenced, burstSt, nowMs)) {
      audio.burst(av.priority, theme.alarmStyle);
      burstSt.lastAt = nowMs;
      burstSt.lastPriority = av.priority;
    }
    renderChips();
  }

  /** @param {number} perfNow */
  function frame(perfNow) {
    requestAnimationFrame(frame);
    if (!state || !patient || (!view && !defib)) return;
    const t = perfNow / 1000;
    const dd = displayed(patient, client.serverNow());
    latestD = dd;
    src.update(t, patient, dd);
    if (t - lastBeepT > 0.5) lastBeepT = t; // tab was hidden: no burst of old beeps
    for (const b of src.beats) {
      if (b.t > lastBeepT && b.t <= t && b.kind !== 'dropped') {
        audio.beep(modsOn().includes('spo2') && typeof latestVals.spo2 === 'number' ? latestVals.spo2 : null);
      }
    }
    lastBeepT = t;
    if (defib) {
      if (needRefill) { needRefill = false; defib.refill(t); }
      defib.frame(t, perfNow);
      return;
    }
    if (needRefill) {
      needRefill = false;
      for (const l of lanes) l.lane.refill(t);
    } else for (const l of lanes) l.lane.draw(t);
    if (perfNow - lastTick >= TICK_MS) tick(perfNow);
  }

  client.on('state', (s) => {
    const st = /** @type {import('../shared/schema.js').RoomState} */ (s);
    if (st.schema !== SCHEMA_VERSION) {
      root.innerHTML = '<p class="hint">This monitor needs an update. Reload the page.</p>';
      state = null;
      view = null;
      viewKey = '';
      return;
    }
    state = st;
    applyState();
    pickFlush();
  });
  client.on('status', () => renderChips());
  const refill = () => { needRefill = true; };
  addEventListener('resize', refill);
  document.addEventListener('visibilitychange', async () => {
    refill();
    if (document.visibilityState === 'visible' && wake === null && wakeWanted) await acquireWake();
  });
  document.addEventListener('fullscreenchange', renderChips);
  requestAnimationFrame(frame);
  return { audio, panel, tick: () => tick(performance.now()) };
}

// @ts-check
// Entry `controller`: the phone controller (DESIGN.md sections 5-6). No work on import; `mountController` does it all.
import { RoomClient, newClientId, roomUrl } from '../room/client.js';
import { POST_SHOCK, RHYTHMS, SENSORS, MODULE_IDS } from '../shared/schema.js';
import { macFraction } from '../engine/gas.js';
import { BUILTIN_THEMES } from '../theme/builtin.js';
import { createThemePanel } from '../theme/panel.js';
import { pickTheme } from '../theme/store.js';
import { loadTheme } from '../theme/validate.js';
import { mountTrends } from '../trends/panel.js';
import { makeActions } from './actions.js';
import { LibraryStore } from './library.js';
import { PresetStore, runPreset, presetFromPatient } from './presets.js';
import { Settings, browserStorage } from './settings.js';
import {
  paramList, LIMIT_PARAMS, GLIDE_CHOICES, NIBP_INTERVALS, TOF_INTERVALS, hasModule, buildPatch, pendingCount, stepPercent, clampDisplay,
  glideProgress, formatValue, intervalLabel, moveDisplay,
} from './params.js';

const RHYTHM_LABELS = /** @type {Record<string, string>} */ ({
  sinus: 'Sinus', sinus_brady: 'Sinus brady', sinus_tachy: 'Sinus tachy', af: 'AF', flutter: 'Flutter', svt: 'SVT',
  vt: 'VT', vf: 'VF', asystole: 'Asystole', pea: 'PEA', first_degree_block: '1st degree block', mobitz1: 'Mobitz I',
  mobitz2: 'Mobitz II', chb: 'Complete heart block', torsades: 'Torsades', paced: 'Paced',
});
const SENSOR_LABELS = /** @type {Record<string, string>} */ ({ ecg: 'ECG leads', spo2: 'SpO₂ probe', nibp: 'NIBP cuff', abp: 'Art line', etco2: 'CO₂ line', cvp: 'CVP line', abp2: 'Second art line', gas: 'Gas line', bis: 'BIS sensor', pads: 'Defib pads' });
const MODULE_LABELS = /** @type {Record<string, string>} */ ({ ecg: 'ECG', spo2: 'Pleth', etco2: 'EtCO₂ and RR', nibp: 'NIBP', rr: 'RR', temp: 'Temp', abp: 'Arterial line', cvp: 'CVP', abp2: 'Second arterial line', gas: 'Gas (agent, N₂O, O₂)', o2: 'O₂ only', tof: 'TOF', bis: 'BIS and EEG' });
const TABS = [['vitals', 'Vitals'], ['alarms', 'Alarms'], ['presets', 'Presets'], ['scenarios', 'Scenarios'], ['screens', 'Screens'], ['trends', 'Trends'], ['more', 'More']];
const esc = (/** @type {unknown} */ s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

/**
 * @param {HTMLElement} root
 * @param {{ code: string, location?: { protocol: string, host: string }, storage?: Storage | null }} opts
 * @returns {RoomClient}
 */
export function mountController(root, opts) {
  const loc = opts.location ?? window.location;
  const client = new RoomClient({ url: roomUrl(loc, opts.code, 'controller', newClientId('controller')) });
  const kv = opts.storage === undefined ? browserStorage() : opts.storage;
  const settings = new Settings(kv);
  const presets = new PresetStore(kv);
  const library = new LibraryStore(kv);
  const ui = {
    tab: 'vitals', p: /** @type {string | undefined} */ (undefined), glideMs: Number(settings.get('glideMs', 10000)),
    /** pending edits per patient id, wire units */
    pending: /** @type {Record<string, Record<string, number | string>>} */ ({}),
    dragging: false, note: '', io: '', lib: '', libNote: '', markNote: '', forceView: false,
    scr: '', // screen the per-screen theme panel is open for
  };
  const actions = makeActions(client, () => ui.p);

  // Theme for every monitor in the room: a theme sent here replaces what each monitor without its own choice shows.
  const roomTheme = () => loadTheme(state()?.theme === 'custom' ? state()?.themeJson : undefined).theme;
  const themePanel = createThemePanel({
    title: 'Theme (every monitor)',
    getTheme: roomTheme,
    choices: [...BUILTIN_THEMES.map((b) => ({ id: b.id, label: String(b.theme.name) })), { id: 'custom', label: 'Imported' }],
    current: () => {
      if (state()?.theme !== 'custom') return 'default';
      const name = roomTheme().name;
      return BUILTIN_THEMES.find((b) => b.theme.name === name)?.id ?? 'custom';
    },
    onChoose: (id) => {
      const b = BUILTIN_THEMES.find((x) => x.id === id);
      if (b) sendTheme(b.id === 'default' ? null : b.theme);
    },
    onApply: (t) => sendTheme(t),
    extras: [{ label: 'Reset all to default', testid: 'theme-reset', run: () => sendTheme(null) }],
    doc: root.ownerDocument,
  });
  root.ownerDocument.body.append(themePanel.el);
  /** @param {Record<string, any> | null} t null = back to the default */
  function sendTheme(t) {
    if (client.status !== 'open') { themePanel.say('Not connected: the theme was not sent.'); return false; }
    return actions.act(t ? { theme: 'custom', themeJson: t } : { theme: 'default' });
  }
  const { act } = actions;

  // Theme for one named screen (Screens tab): `ui.scr` is the screen the panel is open for.
  const screenTheme = () => {
    const sc = state()?.screens?.[ui.scr];
    const st = state();
    return loadTheme(st ? pickTheme(null, st, sc ?? null).raw : undefined).theme;
  };
  /** @type {ReturnType<typeof createThemePanel> | null} made on first use, so the room's panel stays the only one until then */
  let screenPanel = null;
  /** @param {string} id */
  function openScreenPanel(id) {
    ui.scr = id;
    if (!screenPanel) {
      const panel = createThemePanel({
        title: 'Theme (one screen)',
        getTheme: screenTheme,
        onApply: (t) => {
          if (client.status !== 'open') { panel.say('Not connected: the theme was not sent.'); return false; }
          return setScreen(ui.scr, { theme: 'custom', themeJson: t });
        },
        doc: root.ownerDocument,
      });
      root.ownerDocument.body.append(panel.el);
      screenPanel = panel;
    }
    themePanel.close();
    screenPanel.open();
  }
  /** @param {string} id @param {Record<string, any>} patch */
  const setScreen = (id, patch) => act({ screens: { [id]: patch } });
  /** @type {{ cancel: () => void } | null} */
  let scenario = null;
  /** @type {Map<string, any>} */
  const timers = new Map();

  const state = () => client.state;
  const patient = () => {
    const s = state();
    if (!s) return null;
    return s.patients.find((x) => x.id === ui.p) ?? s.patients[0];
  };
  const pend = () => { const pt = patient(); return pt ? (ui.pending[pt.id] ??= {}) : {}; };
  const units = () => settings.units();

  root.classList.add('ctl');
  root.innerHTML = `
    <header class="top">
      <span class="chip" id="status" data-status="connecting" data-testid="status">connecting</span>
      <span class="code">Room <b id="code"></b></span>
      <button type="button" class="small mark" data-act="mark" data-testid="mark" aria-label="Bookmark this moment in the log">Mark</button>
    </header>
    <nav id="beds" class="beds" aria-label="Patients"></nav>
    <section id="view" class="view" aria-live="off"></section>
    <footer class="dock">
      <div id="progress" class="progress" hidden><div id="bar"></div><span id="left"></span></div>
      <div id="apply" class="applybar" hidden></div>
      <nav class="tabs" id="tabs">${TABS.map(([id, l]) => `<button type="button" data-tab="${id}" data-testid="tab-${id}">${l}</button>`).join('')}</nav>
    </footer>`;
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (root.querySelector(`#${id}`));
  $('code').textContent = opts.code;

  // ---- rendering -------------------------------------------------------------------------------------------------
  function renderStatus() {
    const st = client.status;
    const pr = client.presence;
    const label = st === 'open' ? 'connected' : st === 'reconnecting' ? 'reconnecting…' : st === 'connecting' ? 'connecting…'
      : st === 'full' ? 'room full' : st === 'expired' ? 'room expired' : st;
    const mon = st === 'open' && pr ? ` · ${pr.monitors} monitor${pr.monitors === 1 ? '' : 's'}` : '';
    const chip = $('status');
    chip.textContent = label + mon;
    chip.dataset.status = st;
    chip.dataset.monitors = pr ? String(pr.monitors) : '';
  }

  function renderBeds() {
    const s = state();
    const cur = patient();
    $('beds').innerHTML = s ? s.patients.map((x) =>
      `<button type="button" class="bed" data-bed="${esc(x.id)}" aria-pressed="${x.id === cur?.id}">${esc(x.label)}</button>`).join('')
      + '<button type="button" class="bed add" data-act="add" aria-label="Add patient">+</button>' : '';
  }

  /** @param {import('./params.js').ParamSpec} spec @param {import('../shared/schema.js').Patient} pt */
  function paramRow(spec, pt) {
    const pv = pend()[spec.id];
    const wire = typeof pv === 'number' ? pv : spec.get(pt);
    return `<div class="prm" data-id="${spec.id}" data-pending="${typeof pv === 'number'}">
      <div class="prm-head"><span class="prm-name" style="color:${spec.color}">${spec.label}</span>
        <span class="prm-val" data-testid="val-${spec.id}">${formatValue(spec, wire)}</span><span class="prm-unit">${spec.unit}</span></div>
      <div class="prm-ctl">
        <button type="button" data-step="-1" aria-label="${spec.label} down">−</button>
        <input type="range" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${spec.to(wire)}" aria-label="${spec.label}" data-testid="rng-${spec.id}">
        <button type="button" data-step="1" aria-label="${spec.label} up">+</button>
      </div>
      <div class="prm-pct"><button type="button" data-pct="-10">−10%</button><button type="button" data-pct="-5">−5%</button><button type="button" data-pct="5">+5%</button><button type="button" data-pct="10">+10%</button></div>
    </div>`;
  }

  function viewVitals() {
    const s = /** @type {NonNullable<ReturnType<typeof state>>} */ (state());
    const pt = /** @type {NonNullable<ReturnType<typeof patient>>} */ (patient());
    const list = paramList(units()).filter((sp) => !sp.limitOnly && hasModule(sp.needs ?? (sp.id.startsWith('abp') ? 'abp' : undefined), s.modules));
    const rhythm = typeof pend().rhythm === 'string' ? String(pend().rhythm) : pt.rhythm;
    return `
      <label class="field">Rhythm
        <select id="rhythm" data-testid="rhythm">${RHYTHMS.map((r) => `<option value="${r}"${r === rhythm ? ' selected' : ''}>${esc(RHYTHM_LABELS[r] ?? r)}</option>`).join('')}</select>
      </label>
      <div class="glide" role="group" aria-label="Glide over">
        <span class="label">Glide over</span>
        ${GLIDE_CHOICES.map((g) => `<button type="button" class="pill" data-glide="${g.ms}" aria-pressed="${g.ms === ui.glideMs}" data-testid="glide-${g.ms}">${g.label}</button>`).join('')}
      </div>
      ${list.map((sp) => paramRow(sp, pt)).join('')}
      <div class="sw-row"><span>Arterial line</span>${toggle('abp-module', s.modules.includes('abp'), 'Arterial line')}</div>
      ${viewLines(s, pt)}
      <h2>NIBP</h2>
      <div class="row"><button type="button" class="wide" data-act="nibp-now" data-testid="nibp-now">Cycle now</button></div>
      <div class="glide" role="group" aria-label="NIBP interval"><span class="label">Interval</span>
        ${NIBP_INTERVALS.map((sec) => `<button type="button" class="pill" data-nibp-int="${sec}" aria-pressed="${(pt.nibpRead.mode === 'cycle' ? pt.nibpRead.cycleSec : 0) === sec}">${intervalLabel(sec)}</button>`).join('')}
      </div>
      <p class="hint">Last reading ${pt.nibpRead.sys}/${pt.nibpRead.dia}</p>
      ${viewGas(s, pt)}`;
  }

  /** Gas and TOF extras: agent in use, MAC readout, TOF now and interval. Off until the modules are switched on. */
  function viewGas(/** @type {NonNullable<ReturnType<typeof state>>} */ s, /** @type {NonNullable<ReturnType<typeof patient>>} */ pt) {
    const gas = s.modules.includes('gas');
    const tof = s.modules.includes('tof');
    const agents = [['none', 'No agent'], ['sevo', 'Sevoflurane'], ['des', 'Desflurane'], ['iso', 'Isoflurane']];
    return `<div class="sw-row"><span>Gas</span>${toggle('mod-gas', gas, 'Gas')}</div>
      <div class="sw-row"><span>TOF</span>${toggle('mod-tof', tof, 'TOF')}</div>
      ${gas ? `<label class="field">Agent<select id="agent" data-testid="agent">${agents.map(([v, l]) => `<option value="${v}"${v === pt.agent ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        ${pt.agent !== 'none' ? `<p class="hint" data-testid="mac-hint">Et ${mac(pt).toFixed(2)} MAC at age ${pt.age}</p>` : ''}` : ''}
      ${tof ? `<h2>TOF</h2>
        <div class="row"><button type="button" class="wide" data-act="tof-now" data-testid="tof-now">Measure TOF now</button></div>
        <div class="glide" role="group" aria-label="TOF interval"><span class="label">Interval</span>
          ${TOF_INTERVALS.map((sec) => `<button type="button" class="pill" data-tof-int="${sec}" aria-pressed="${(pt.tofRead.mode === 'cycle' ? pt.tofRead.cycleSec : 0) === sec}">${sec ? intervalLabel(sec) : 'On demand'}</button>`).join('')}
        </div>
        <p class="hint">Last reading ${pt.tofRead.count}/4, ratio ${pt.tofRead.ratio}%</p>` : ''}`;
  }

  /** @param {NonNullable<ReturnType<typeof patient>>} pt */
  function mac(pt) { return macFraction(pt, pt.etag, pt.etn2o); }

  /** Line extras: damping, flush test, CVP v waves. Modules are off until switched on (More tab or here). */
  function viewLines(/** @type {NonNullable<ReturnType<typeof state>>} */ s, /** @type {NonNullable<ReturnType<typeof patient>>} */ pt) {
    const sel = (/** @type {string} */ id, /** @type {string} */ label, /** @type {[string, string][]} */ opts, /** @type {string} */ cur) =>
      `<label class="field">${label}<select id="${id}" data-testid="${id}">${opts.map(([v, l]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`;
    const a1 = s.modules.includes('abp');
    const a2 = s.modules.includes('abp2');
    return `<div class="sw-row"><span>Second arterial line</span>${toggle('mod-abp2', a2, 'Second arterial line')}</div>
      <div class="sw-row"><span>CVP</span>${toggle('mod-cvp', s.modules.includes('cvp'), 'CVP')}</div>
      ${a1 || a2 ? sel('damping', 'Art line damping', [['normal', 'Normal'], ['over', 'Over-damped'], ['under', 'Under-damped']], pt.abpDamping) : ''}
      ${a1 || a2 ? `<div class="row">${a1 ? '<button type="button" data-act="flush-abp" data-testid="flush-abp">Flush art line</button>' : ''}${a2 ? '<button type="button" data-act="flush-abp2" data-testid="flush-abp2">Flush line 2</button>' : ''}</div>` : ''}
      ${s.modules.includes('cvp') ? sel('cvpv', 'CVP v wave', [['normal', 'Normal'], ['giant', 'Giant v (TR)']], pt.cvpV) : ''}`;
  }

  /** @param {string} id @param {boolean} on @param {string} label */
  function toggle(id, on, label) {
    return `<button type="button" class="switch" role="switch" aria-checked="${on}" aria-label="${esc(label)}" data-switch="${id}" data-testid="sw-${id}"><i></i></button>`;
  }

  function viewAlarms() {
    const s = /** @type {NonNullable<ReturnType<typeof state>>} */ (state());
    const u = units();
    const specs = new Map(paramList(u).map((sp) => [sp.id, sp]));
    const left = Math.max(0, s.alarms.silencedUntil - client.serverNow());
    return `
      <div class="sw-row"><span>Alarms on</span>${toggle('alarms-on', s.alarms.enabled, 'Alarms on')}</div>
      <div class="row"><button type="button" class="wide" data-act="silence" data-testid="silence">Silence 2 min${left > 0 ? ` (${Math.ceil(left / 1000)} s left)` : ''}</button></div>
      ${LIMIT_PARAMS.filter((l) => hasModule(l.needs, s.modules)).map((l) => {
        const sp = /** @type {import('./params.js').ParamSpec} */ (specs.get(l.spec));
        const [lo, hi] = s.alarms.limits[l.name] ?? [sp.min, sp.max];
        return `<div class="lim" data-limit="${l.name}"><span class="prm-name" style="color:${sp.color}">${l.label}</span>
          ${limitEnd(sp, 'lo', lo)}<span class="dash">to</span>${limitEnd(sp, 'hi', hi)}</div>`;
      }).join('')}`;
  }

  /** @param {import('./params.js').ParamSpec} sp @param {'lo' | 'hi'} end @param {number} wire */
  function limitEnd(sp, end, wire) {
    return `<span class="lim-end" data-end="${end}"><button type="button" data-lstep="-1" aria-label="${end === 'lo' ? 'low' : 'high'} limit down">−</button>
      <output data-testid="lim-${end}" data-w="${wire}">${formatValue(sp, wire)}</output><button type="button" data-lstep="1" aria-label="${end === 'lo' ? 'low' : 'high'} limit up">+</button></span>`;
  }

  function viewPresets() {
    const pt = /** @type {NonNullable<ReturnType<typeof patient>>} */ (patient());
    return `
      <p class="label">Applies to <b>${esc(pt.label)}</b> over ${esc(GLIDE_CHOICES.find((g) => g.ms === ui.glideMs)?.label ?? '')} unless the preset sets its own time.</p>
      <ul class="presets">${presets.all().map((pr, i) => `<li><button type="button" class="preset" data-preset="${i}" data-testid="preset-${esc(pr.name)}">${esc(pr.name)}</button>
        ${pr.builtin ? '' : `<button type="button" class="small" data-del="${esc(pr.name)}" aria-label="Delete ${esc(pr.name)}">✕</button>`}</li>`).join('')}</ul>
      <div class="row"><input id="pname" maxlength="24" placeholder="Name for current values" aria-label="Preset name">
        <button type="button" data-act="save-preset" data-testid="save-preset">Save current</button></div>
      <h2>Export and import</h2>
      <textarea id="io" rows="4" aria-label="Preset JSON" spellcheck="false">${esc(ui.io)}</textarea>
      <div class="row"><button type="button" data-act="export">Export</button><button type="button" data-act="import" data-testid="import">Import</button>
        <label class="btn file">File<input type="file" id="file" accept="application/json,.json" hidden></label></div>
      <p class="hint" id="note">${esc(ui.note)}</p>`;
  }

  /** `m:ss` for a countdown. @param {number} ms */
  const clock = (ms) => { const t = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };

  function viewScenarios() {
    const s = /** @type {NonNullable<ReturnType<typeof state>>} */ (state());
    const pt = /** @type {NonNullable<ReturnType<typeof patient>>} */ (patient());
    const run = s.scenario;
    const runBed = run ? s.patients.find((x) => x.id === run.p)?.label ?? run.p : '';
    const card = run ? `<div class="scn-run" data-testid="scn-run">
        <p><b data-testid="scn-name">${esc(run.name)}</b> on ${esc(runBed)}</p>
        <p data-testid="scn-step">${run.done ? 'Finished' : `Step ${run.step} of ${run.total} done`}</p>
        <p class="hint" id="scn-count" data-testid="scn-count">${esc(scenarioLine(run))}</p>
        <div class="row">
          ${run.done ? '' : `<button type="button" data-act="scn-pause" data-testid="scn-pause">${run.pausedAt ? 'Resume' : 'Pause'}</button>
          <button type="button" data-act="scn-next" data-testid="scn-next">${run.waiting ? 'Next step' : 'Skip wait'}</button>`}
          <button type="button" data-act="scn-stop" data-testid="scn-stop">${run.done ? 'Clear' : 'Stop'}</button></div></div>` : '';
    const drugsOn = settings.get('drugs', false) === true;
    return `
      ${card}
      <p class="label">Starts on <b>${esc(pt.label)}</b>. The room runs it, so it keeps going with this phone closed.</p>
      <ul class="presets">${library.allScenarios().map((sc, i) => `<li><button type="button" class="preset" data-scn="${i}" data-testid="scn-start-${esc(sc.name)}">${esc(sc.name)} <small>${sc.steps.length} steps</small></button>
        ${sc.builtin ? '' : `<button type="button" class="small" data-scn-del="${esc(sc.name)}" aria-label="Delete ${esc(sc.name)}">✕</button>`}</li>`).join('')}</ul>
      ${drugsOn ? `<h2>Drug buttons</h2>
      <p class="label">Applies to <b>${esc(pt.label)}</b>. Teaching effects only, not doses.</p>
      <ul class="presets">${library.allDrugs().map((d, i) => `<li><button type="button" class="preset" data-drug="${i}" data-testid="drug-${esc(d.name)}">${esc(d.name)}<br><small>${esc(d.note ?? '')}</small></button>
        ${d.builtin ? '' : `<button type="button" class="small" data-drug-del="${esc(d.name)}" aria-label="Delete ${esc(d.name)}">✕</button>`}</li>`).join('')}</ul>` : ''}
      <h2>Library file</h2>
      <textarea id="lib" rows="4" aria-label="Library JSON" spellcheck="false">${esc(ui.lib)}</textarea>
      <div class="row"><button type="button" data-act="lib-export" data-testid="lib-export">Export</button><button type="button" data-act="lib-import" data-testid="lib-import">Import</button>
        <label class="btn file">File<input type="file" id="libfile" accept="application/json,.json" hidden></label></div>
      <p class="hint" id="libnote" data-testid="lib-note">${esc(ui.libNote)}</p>`;
  }

  /** One line about where the running scenario is. @param {NonNullable<ReturnType<typeof state>>['scenario']} run */
  function scenarioLine(run) {
    if (!run || run.done) return 'All steps ran.';
    if (run.waiting) return 'Waiting for you: tap Next step.';
    if (run.pausedAt) return `Paused, ${clock(run.nextAt - run.pausedAt)} left to the next step.`;
    return `Next step in ${clock(run.nextAt - client.serverNow())}`;
  }

  /** Keep the countdown moving without rebuilding the page. */
  function renderCountdown() {
    const run = state()?.scenario;
    const el = root.querySelector('#scn-count');
    if (el && run) el.textContent = scenarioLine(run);
  }

  function viewScreens() {
    const s = /** @type {NonNullable<ReturnType<typeof state>>} */ (state());
    const pr = client.presence;
    const online = new Map((pr?.screens ?? []).map((x) => [x.s, x.dev]));
    const ids = Object.keys(s.screens ?? {}).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    const unnamed = Math.max(0, (pr?.monitors ?? 0) - ids.filter((id) => online.has(id)).length);
    /** @param {string} id @param {string} what @param {string} text */
    const shadow = (id, what, text) => (online.get(id)?.includes(what)
      ? `<p class="hint shadow" data-testid="shadow-${id}-${what}">${text} <button type="button" class="small" data-scr-act="clear-${what}" data-s="${id}" data-testid="clear-${id}-${what}">Clear it</button></p>` : '');
    return `
      <p class="hint">Each laptop or tablet can be a named screen with its own bed, modules and theme. A monitor asks for a
        name the first time it opens.${unnamed ? ` ${unnamed} monitor${unnamed === 1 ? ' is' : 's are'} open without a name.` : ''}</p>
      ${ids.length ? '' : '<p class="hint">No named screens yet.</p>'}
      ${ids.map((id) => {
        const sc = /** @type {import('../shared/schema.js').Screen} */ (s.screens?.[id]);
        const on = online.has(id);
        const themeId = sc.theme ?? '';
        return `<section class="scr" data-scr="${id}" data-testid="screen-${id}">
          <h2><span class="dot" data-on="${on}" title="${on ? 'online' : 'offline'}" data-testid="online-${id}"></span>${esc(sc.name)}
            <span class="hint">${on ? 'online' : 'offline'}</span></h2>
          <div class="row"><input id="scrname-${id}" maxlength="24" value="${esc(sc.name)}" aria-label="Name of ${esc(sc.name)}" data-testid="scrname-${id}">
            <button type="button" data-scr-act="rename" data-s="${id}" data-testid="rename-${id}">Rename</button></div>
          <label class="field">Kind
            <select data-scr-sel="kind" data-s="${id}" data-testid="scrkind-${id}">
              <option value="monitor"${sc.kind !== 'defib' ? ' selected' : ''}>Monitor</option>
              <option value="defib"${sc.kind === 'defib' ? ' selected' : ''}>Defibrillator (touch screen)</option>
            </select></label>
          <label class="field">Bed
            <select data-scr-sel="p" data-s="${id}" data-testid="scrbed-${id}">
              <option value="">Its own choice (default: first bed)</option>
              ${s.patients.map((x) => `<option value="${esc(x.id)}"${x.id === sc.p ? ' selected' : ''}>${esc(x.label)}</option>`).join('')}
            </select></label>
          ${shadow(id, 'p', 'This screen\'s address picks its own bed, which wins.')}
          <div class="sw-row"><span>Modules: same as the room</span>${toggle(`scrfollow-${id}`, !sc.modules, 'Modules same as the room')}</div>
          ${sc.modules ? MODULE_IDS.map((k) => `<div class="sw-row sub"><span>${MODULE_LABELS[k]}</span>${toggle(`scrmod-${id}-${k}`, /** @type {string[]} */ (sc.modules).includes(k), MODULE_LABELS[k])}</div>`).join('') : ''}
          <label class="field">Theme
            <select data-scr-sel="theme" data-s="${id}" data-testid="scrtheme-${id}">
              <option value="">Same as the room</option>
              ${BUILTIN_THEMES.map((b) => `<option value="${b.id}"${b.id === themeId ? ' selected' : ''}>${esc(b.theme.name)}</option>`).join('')}
              <option value="custom"${themeId === 'custom' ? ' selected' : ''}>Imported…</option>
            </select></label>
          ${shadow(id, 'theme', 'This screen picked its own theme, which wins.')}
          <div class="row"><button type="button" data-scr-act="identify" data-s="${id}" data-testid="identify-${id}"${on ? '' : ' disabled'}>Identify</button>
            <button type="button" data-scr-act="theme-import" data-s="${id}">Import theme…</button>
            <button type="button" data-scr-act="forget" data-s="${id}" data-testid="forget-${id}">Forget</button></div>
        </section>`;
      }).join('')}`;
  }

  function viewMore() {
    const s = /** @type {NonNullable<ReturnType<typeof state>>} */ (state());
    const pt = /** @type {NonNullable<ReturnType<typeof patient>>} */ (patient());
    const u = units();
    return `
      <h2>Sensors off (${esc(pt.label)})</h2>
      ${SENSORS.map((k) => `<div class="sw-row"><span>${SENSOR_LABELS[k]}</span>${toggle('off-' + k, !!pt.off[k], SENSOR_LABELS[k] + ' off')}</div>`).join('')}
      <h2>Defibrillator (${esc(pt.label)})</h2>
      <label class="field">Rhythm after a shock
        <select id="postshock" data-testid="postshock">${POST_SHOCK.map((r) => `<option value="${r}"${r === pt.postShock ? ' selected' : ''}>${r === 'none' ? 'No change' : esc(RHYTHM_LABELS[r] ?? r)}</option>`).join('')}</select></label>
      <p class="hint">A shock from a defib screen (set a screen's kind in the Screens tab) changes the rhythm to this. Pads off blocks the shock.</p>
      <h2>Show on monitor</h2>
      ${MODULE_IDS.map((k) => `<div class="sw-row"><span>${MODULE_LABELS[k]}</span>${toggle('mod-' + k, s.modules.includes(k), MODULE_LABELS[k])}</div>`).join('')}
      <h2>Monitor theme</h2>
      <div class="row"><button type="button" data-act="theme" data-testid="theme-open">Theme for all monitors…</button></div>
      <h2>This device</h2>
      <div class="sw-row"><span>Drug buttons (Scenarios tab)</span>${toggle('drugs-on', settings.get('drugs', false) === true, 'Drug buttons')}</div>
      <div class="glide" role="group" aria-label="CO2 unit"><span class="label">CO₂</span>
        ${['mmHg', 'kPa'].map((x) => `<button type="button" class="pill" data-unit="co2:${x}" aria-pressed="${u.co2 === x}">${x}</button>`).join('')}</div>
      <div class="glide" role="group" aria-label="Temperature unit"><span class="label">Temp</span>
        ${['C', 'F'].map((x) => `<button type="button" class="pill" data-unit="temp:${x}" aria-pressed="${u.temp === x}">°${x}</button>`).join('')}</div>
      ${s.patients.length > 1 ? `<h2>Patients</h2><div class="row"><button type="button" data-act="remove" data-testid="remove-bed">Remove ${esc(pt.label)}</button></div>` : ''}
      <p class="hint">Simulation only. Made-up patients; never real data.</p>`;
  }

  /** Trends tab: the panel draws itself from the room log, so it is built once per visit and left alone by state updates. */
  let trends = /** @type {ReturnType<typeof mountTrends> | null} */ (null);
  function viewTrends() {
    return `<h2>Bookmark</h2>
      <div class="row"><input id="marktext" maxlength="200" placeholder="Note for the debrief (optional)" aria-label="Bookmark note" data-testid="marktext">
        <button type="button" data-act="mark-text" data-testid="mark-text">Mark</button></div>
      <p class="hint" data-testid="mark-note">${esc(ui.markNote)}</p>
      <h2>Trends</h2><div id="trendsHost"></div>`;
  }

  function renderView() {
    const view = $('view');
    if (!state()) { view.innerHTML = '<p class="hint">Joining the room…</p>'; return; }
    if (ui.tab === 'trends' && trends && view.querySelector('#trendsHost')?.isConnected && !ui.forceView) return;
    ui.forceView = false;
    const scroll = window.scrollY;
    trends = null;
    view.innerHTML = ({ vitals: viewVitals, alarms: viewAlarms, presets: viewPresets, scenarios: viewScenarios, screens: viewScreens, trends: viewTrends, more: viewMore }[/** @type {'vitals'} */ (ui.tab)] ?? viewVitals)();
    if (ui.tab === 'trends') {
      trends = mountTrends($('trendsHost'), { client, code: opts.code, patientId: () => ui.p });
      trends.refresh();
    }
    window.scrollTo(0, scroll);
  }

  function renderDock() {
    for (const b of root.querySelectorAll('[data-tab]')) b.setAttribute('aria-current', String(/** @type {HTMLElement} */ (b).dataset.tab === ui.tab));
    const pt = patient();
    const n = pt ? pendingCount(pend(), pt, units()) : 0;
    const bar = $('apply');
    bar.hidden = n === 0;
    bar.innerHTML = n ? `<button type="button" class="apply" data-act="apply" data-testid="apply">Apply ${n} change${n === 1 ? '' : 's'}</button>
      <button type="button" class="cancel" data-act="cancel" data-testid="cancel">Cancel</button>` : '';
  }

  function renderProgress() {
    const pt = patient();
    const g = pt ? glideProgress(pt, client.serverNow()) : { active: false, u: 1, leftMs: 0 };
    $('progress').hidden = !g.active;
    if (g.active) {
      $('bar').style.width = `${Math.round(g.u * 100)}%`;
      $('left').textContent = `${Math.ceil(g.leftMs / 1000)} s`;
    }
  }

  function render() {
    renderStatus(); renderBeds(); renderDock(); renderProgress();
    // do not rebuild the page under a finger that is dragging a slider, or while a screen name is being typed
    if (!ui.dragging && !root.ownerDocument.activeElement?.matches(ui.tab === 'screens' ? '#view input' : ui.tab === 'scenarios' ? '#view textarea' : '#never')) renderView();
  }

  // ---- edits ------------------------------------------------------------------------------------------------------
  /** @param {string} id @param {number} wire */
  function setPending(id, wire) {
    const pt = patient();
    if (!pt) return;
    const sp = paramList(units()).find((x) => x.id === id);
    if (!sp) return;
    if (wire === sp.get(pt)) delete pend()[id]; else pend()[id] = wire;
  }

  /** @param {HTMLElement} row @param {number} display */
  function setFromDisplay(row, display) {
    const sp = paramList(units()).find((x) => x.id === row.dataset.id);
    if (!sp) return;
    const d = clampDisplay(sp, display);
    setPending(sp.id, sp.from(d));
    const pt = /** @type {NonNullable<ReturnType<typeof patient>>} */ (patient());
    const wire = typeof pend()[sp.id] === 'number' ? /** @type {number} */ (pend()[sp.id]) : sp.get(pt);
    row.dataset.pending = String(typeof pend()[sp.id] === 'number');
    /** @type {HTMLElement} */ (row.querySelector('.prm-val')).textContent = formatValue(sp, wire);
    /** @type {HTMLInputElement} */ (row.querySelector('input[type=range]')).value = String(d);
    renderDock();
  }

  /** Display value now in a row (pending or current). @param {HTMLElement} row */
  function rowDisplay(row) {
    const sp = paramList(units()).find((x) => x.id === row.dataset.id);
    const pt = patient();
    if (!sp || !pt) return null;
    const v = pend()[sp.id];
    return { sp, d: sp.to(typeof v === 'number' ? v : sp.get(pt)) };
  }

  function apply() {
    const pt = patient();
    if (!pt) return;
    const patch = buildPatch(pend(), pt, units());
    if (patch && !act(patch, ui.glideMs, pt.id)) { ui.note = 'Not connected: your changes are kept. Apply again when connected.'; $('status').title = ui.note; return; }
    delete ui.pending[pt.id];
    render();
  }

  /** @param {string} key @param {() => void} fn */
  function debounce(key, fn) {
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(fn, 250));
  }

  /** Alarm limits go out at once (no glide), merged per parameter. @param {HTMLElement} row @param {number} dir @param {'lo' | 'hi'} end */
  function stepLimit(row, end, dir) {
    const s = state();
    if (!s) return;
    const name = /** @type {string} */ (row.dataset.limit);
    const lp = LIMIT_PARAMS.find((l) => l.name === name);
    const sp = paramList(units()).find((x) => x.id === lp?.spec);
    if (!lp || !sp) return;
    const out = /** @type {HTMLElement} */ (row.querySelector(`[data-end="${end}"] output`));
    const wireNow = Number(out.dataset.w);
    const nextD = moveDisplay(sp, sp.to(wireNow), dir * sp.step);
    out.dataset.w = String(sp.from(nextD));
    out.textContent = nextD.toFixed(sp.dec);
    debounce('lim-' + name, () => {
      const loOut = /** @type {HTMLElement} */ (row.querySelector('[data-end="lo"] output'));
      const hiOut = /** @type {HTMLElement} */ (row.querySelector('[data-end="hi"] output'));
      let lo = Number(loOut.dataset.w);
      let hi = Number(hiOut.dataset.w);
      if (lo > hi) { if (end === 'lo') hi = lo; else lo = hi; }
      act({ alarms: { limits: { [name]: [lo, hi] } } });
    });
  }

  /** @param {string[]} modules */
  const setModules = (modules) => act({ modules });

  /** @param {string} name */
  function runByName(name) {
    const pt = patient();
    const pr = presets.all().find((x) => x.name === name);
    if (!pt || !pr) return;
    if (client.status !== 'open') { ui.note = 'Not connected: preset not applied.'; renderView(); return; }
    scenario?.cancel();
    // a preset's own glide time wins; a step with glideMs 0 still means "instant"
    scenario = runPreset(pr, act, pt.id);
    delete ui.pending[pt.id];
  }

  // ---- events -----------------------------------------------------------------------------------------------------
  root.addEventListener('click', (ev) => {
    const t = /** @type {HTMLElement} */ (ev.target).closest('button');
    if (!t) return;
    const d = t.dataset;
    const s = state();
    const pt = patient();
    if (d.tab) { ui.tab = d.tab; ui.forceView = true; render(); return; }
    if (d.bed) { ui.p = d.bed; ui.forceView = true; render(); return; }
    if (d.act === 'mark' || d.act === 'mark-text') {
      const input = /** @type {HTMLInputElement | null} */ (root.querySelector('#marktext'));
      const text = d.act === 'mark-text' ? (input?.value ?? '').trim().slice(0, 200) : '';
      if (!client.send({ t: 'mark', ...(ui.p ? { p: ui.p } : {}), ...(text ? { text } : {}) })) { ui.markNote = 'Not connected: bookmark not saved.'; }
      else { ui.markNote = `Bookmarked at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`; if (input) input.value = ''; }
      t.dataset.done = 'true';
      const note = root.querySelector('[data-testid=mark-note]');
      if (note) note.textContent = ui.markNote;
      return;
    }
    if (!s || !pt) return;
    if (d.scrAct && d.s) { onScreenAct(d.scrAct, d.s); return; }
    if (d.glide !== undefined) { ui.glideMs = Number(d.glide); settings.set('glideMs', ui.glideMs); renderView(); return; }
    if (d.step || d.pct) {
      const row = /** @type {HTMLElement} */ (t.closest('.prm'));
      const cur = rowDisplay(row);
      if (!cur) return;
      setFromDisplay(row, d.pct ? stepPercent(cur.sp, cur.d, Number(d.pct)) : moveDisplay(cur.sp, cur.d, Number(d.step) * cur.sp.step));
      return;
    }
    if (d.lstep) { const row = /** @type {HTMLElement} */ (t.closest('.lim')); stepLimit(row, /** @type {'lo' | 'hi'} */ (/** @type {HTMLElement} */ (t.closest('.lim-end')).dataset.end), Number(d.lstep)); return; }
    if (d.tofInt !== undefined) {
      const sec = Number(d.tofInt);
      act({ tof: sec ? { mode: 'cycle', cycleSec: sec } : { mode: 'manual' } }, undefined, pt.id);
      return;
    }
    if (d.nibpInt !== undefined) {
      const sec = Number(d.nibpInt);
      act({ nibp: sec ? { mode: 'cycle', cycleSec: sec } : { mode: 'manual' } }, undefined, pt.id);
      return;
    }
    if (d.unit) { const [k, v] = d.unit.split(':'); settings.set('units', { ...units(), [k]: v }); render(); return; }
    if (d.preset !== undefined) { runByName(/** @type {string} */ (presets.all()[Number(d.preset)]?.name)); return; }
    if (d.del) { presets.remove(d.del); renderView(); return; }
    if (d.scn !== undefined) {
      const sc = library.allScenarios()[Number(d.scn)];
      if (sc && !actions.scenarioStart(sc, pt.id)) { ui.libNote = 'Not connected: the scenario did not start.'; renderView(); } else delete ui.pending[pt.id];
      return;
    }
    if (d.drug !== undefined) {
      const dr = library.allDrugs()[Number(d.drug)];
      if (dr && !actions.drug(dr, pt.id)) { ui.libNote = 'Not connected: the drug was not given.'; renderView(); } else delete ui.pending[pt.id];
      return;
    }
    if (d.scnDel) { library.removeScenario(d.scnDel); renderView(); return; }
    if (d.drugDel) { library.removeDrug(d.drugDel); renderView(); return; }
    if (d.switch) { onSwitch(d.switch, t.getAttribute('aria-checked') !== 'true', s, pt); return; }
    switch (d.act) {
      case 'apply': apply(); break;
      case 'cancel': delete ui.pending[pt.id]; render(); break;
      case 'nibp-now': actions.nibpNow(pt.id); break;
      case 'tof-now': actions.tofNow(pt.id); break;
      case 'flush-abp': actions.flush('abp', pt.id); break;
      case 'flush-abp2': actions.flush('abp2', pt.id); break;
      case 'silence': actions.silence(); break;
      case 'theme': themePanel.open(); break;
      case 'add': actions.addPatient(); break;
      case 'remove': if (window.confirm(`Remove ${pt.label}?`)) { actions.removePatient(pt.id); ui.p = undefined; } break;
      case 'scn-pause': actions.scenarioControl(s.scenario?.pausedAt ? 'scenarioResume' : 'scenarioPause'); break;
      case 'scn-next': actions.scenarioControl('scenarioNext'); break;
      case 'scn-stop': actions.scenarioControl('scenarioStop'); break;
      case 'lib-export': ui.lib = library.exportJson(); ui.libNote = 'Copy this text, or paste a library file here and tap Import.'; renderView(); break;
      case 'lib-import': importLibrary(/** @type {HTMLTextAreaElement} */ ($('lib')).value); break;
      case 'save-preset': {
        const input = /** @type {HTMLInputElement} */ ($('pname'));
        const ok = presets.save(presetFromPatient(input.value, pt, ui.glideMs));
        ui.note = ok ? `Saved "${input.value.trim()}".` : 'Give it a new name (up to 24 characters; built-in names are taken).';
        renderView();
        break;
      }
      case 'export': ui.io = presets.exportJson(); ui.note = 'Copy this text, or paste saved presets here and tap Import.'; renderView(); break;
      case 'import': {
        const r = presets.importJson(/** @type {HTMLTextAreaElement} */ ($('io')).value);
        ui.io = ''; ui.note = `Imported ${r.added}, skipped ${r.skipped}.`; renderView();
        break;
      }
    }
  });

  /** @param {string} what @param {string} id screen id */
  function onScreenAct(what, id) {
    const sc = state()?.screens?.[id];
    if (!sc) return;
    if (what === 'rename') {
      const name = /** @type {HTMLInputElement} */ ($(`scrname-${id}`)).value.trim();
      if (name && name !== sc.name) setScreen(id, { name });
      /** @type {HTMLElement} */ (root.ownerDocument.activeElement)?.blur?.();
      renderView();
    } else if (what === 'identify') client.send({ t: 'identify', s: id });
    else if (what === 'forget') { if (window.confirm(`Forget ${sc.name}? Its settings go; that monitor asks for a name again.`)) client.send({ t: 'forgetScreen', s: id }); }
    else if (what === 'clear-theme' || what === 'clear-p') client.send({ t: 'clearDevice', s: id, what: what.slice(6) });
    else if (what === 'theme-import') openScreenPanel(id);
  }

  /** @param {string} text */
  function importLibrary(text) {
    const r = library.importJson(text);
    if (r.ok) { ui.lib = ''; ui.libNote = `Imported ${r.scenarios} scenario${r.scenarios === 1 ? '' : 's'} and ${r.drugs} drug${r.drugs === 1 ? '' : 's'}.`; }
    else ui.libNote = `Refused: ${r.msg}`;
    renderView();
  }

  /** @param {string} id @param {boolean} on @param {NonNullable<ReturnType<typeof state>>} s @param {NonNullable<ReturnType<typeof patient>>} pt */
  function onSwitch(id, on, s, pt) {
    if (id.startsWith('scrfollow-')) {
      const sid = id.slice(10);
      setScreen(sid, { modules: on ? null : [...s.modules] }); // a screen's own list starts as a copy of the room's
      return;
    }
    if (id.startsWith('scrmod-')) {
      const [sid, m] = id.slice(7).split('-');
      const cur = s.screens?.[sid]?.modules ?? s.modules;
      setScreen(sid, { modules: on ? [...new Set([...cur, m])] : cur.filter((x) => x !== m) });
      return;
    }
    if (id === 'abp-module' || id.startsWith('mod-')) {
      const m = id === 'abp-module' ? 'abp' : id.slice(4);
      setModules(on ? [...new Set([...s.modules, m])] : s.modules.filter((x) => x !== m));
    } else if (id.startsWith('off-')) act({ patient: { off: { [id.slice(4)]: on } } }, undefined, pt.id);
    else if (id === 'alarms-on') act({ alarms: { enabled: on } });
    else if (id === 'drugs-on') { settings.set('drugs', on); renderView(); }
  }

  root.addEventListener('change', (ev) => {
    const t = /** @type {HTMLElement} */ (ev.target);
    const pt = patient();
    const sd = t.dataset;
    if (sd.scrSel && sd.s) {
      const v = /** @type {HTMLSelectElement} */ (t).value;
      if (sd.scrSel === 'p') setScreen(sd.s, { p: v || null });
      else if (sd.scrSel === 'kind') setScreen(sd.s, { kind: v === 'defib' ? 'defib' : 'monitor' });
      else if (v === 'custom') {
        if (state()?.screens?.[sd.s]?.theme !== 'custom') { openScreenPanel(sd.s); renderView(); }
      } else setScreen(sd.s, { theme: v || null });
      return;
    }
    if (t.id === 'rhythm' && pt) {
      const v = /** @type {HTMLSelectElement} */ (t).value;
      if (v === pt.rhythm) delete pend().rhythm; else pend().rhythm = v;
      renderDock();
    } else if (t.id === 'agent' && pt) {
      act({ patient: { agent: /** @type {HTMLSelectElement} */ (t).value } }, undefined, pt.id);
    } else if (t.id === 'postshock' && pt) {
      act({ patient: { postShock: /** @type {HTMLSelectElement} */ (t).value } }, undefined, pt.id);
    } else if ((t.id === 'damping' || t.id === 'cvpv') && pt) {
      act({ patient: t.id === 'damping' ? { abpDamping: /** @type {HTMLSelectElement} */ (t).value } : { cvpV: /** @type {HTMLSelectElement} */ (t).value } }, undefined, pt.id);
    } else if (t.id === 'libfile') {
      const f = /** @type {HTMLInputElement} */ (t).files?.[0];
      f?.text().then(importLibrary);
    } else if (t.id === 'file') {
      const f = /** @type {HTMLInputElement} */ (t).files?.[0];
      f?.text().then((text) => { const r = presets.importJson(text); ui.note = `Imported ${r.added}, skipped ${r.skipped}.`; renderView(); });
    }
  });

  root.addEventListener('input', (ev) => {
    const t = /** @type {HTMLInputElement} */ (ev.target);
    if (t.type === 'range') setFromDisplay(/** @type {HTMLElement} */ (t.closest('.prm')), Number(t.value));
  });
  // do not rebuild the page under a finger that is dragging a slider
  root.addEventListener('pointerdown', (ev) => { if (/** @type {HTMLElement} */ (ev.target).matches('input[type=range]')) ui.dragging = true; });
  const release = () => { if (ui.dragging) { ui.dragging = false; render(); } };
  root.addEventListener('pointerup', release);
  root.addEventListener('pointercancel', release);

  // ---- connection -------------------------------------------------------------------------------------------------
  client.on('status', renderStatus);
  client.on('presence', () => { renderStatus(); if (ui.tab === 'screens' && !ui.dragging) render(); });
  client.on('state', () => { render(); if (themePanel.isOpen) themePanel.refresh(); if (screenPanel?.isOpen) screenPanel.refresh(); });
  client.on('error', (e) => {
    $('status').title = e?.msg ?? '';
    if (e?.code === 'schema') $('view').innerHTML = '<p class="hint">Update needed: reload this page.</p>';
  });
  const progressTimer = setInterval(() => { renderProgress(); renderCountdown(); }, 250);
  const wake = () => { if (document.visibilityState !== 'hidden') client.wake(); };
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('pageshow', wake);
  window.addEventListener('online', wake);
  const close = client.close.bind(client);
  client.close = () => { clearInterval(progressTimer); scenario?.cancel(); document.removeEventListener('visibilitychange', wake); close(); };

  render();
  client.connect();
  return client;
}

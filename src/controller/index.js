// @ts-check
// Entry `controller`: the phone controller (DESIGN.md sections 5-6). No work on import; `mountController` does it all.
import { RoomClient, newClientId, roomUrl } from '../room/client.js';
import { RHYTHMS, SENSORS, MODULE_IDS } from '../shared/schema.js';
import { BUILTIN_THEMES } from '../theme/builtin.js';
import { createThemePanel } from '../theme/panel.js';
import { pickTheme } from '../theme/store.js';
import { loadTheme } from '../theme/validate.js';
import { makeActions } from './actions.js';
import { PresetStore, runPreset, presetFromPatient } from './presets.js';
import { Settings, browserStorage } from './settings.js';
import {
  paramList, LIMIT_PARAMS, GLIDE_CHOICES, NIBP_INTERVALS, buildPatch, pendingCount, stepPercent, clampDisplay,
  glideProgress, formatValue, intervalLabel, moveDisplay,
} from './params.js';

const RHYTHM_LABELS = /** @type {Record<string, string>} */ ({
  sinus: 'Sinus', sinus_brady: 'Sinus brady', sinus_tachy: 'Sinus tachy', af: 'AF', flutter: 'Flutter', svt: 'SVT',
  vt: 'VT', vf: 'VF', asystole: 'Asystole', pea: 'PEA', first_degree_block: '1st degree block', mobitz1: 'Mobitz I',
  mobitz2: 'Mobitz II', chb: 'Complete heart block', torsades: 'Torsades', paced: 'Paced',
});
const SENSOR_LABELS = /** @type {Record<string, string>} */ ({ ecg: 'ECG leads', spo2: 'SpO₂ probe', nibp: 'NIBP cuff', abp: 'Art line', etco2: 'CO₂ line' });
const MODULE_LABELS = /** @type {Record<string, string>} */ ({ ecg: 'ECG', spo2: 'Pleth', etco2: 'EtCO₂ and RR', nibp: 'NIBP', rr: 'RR', temp: 'Temp', abp: 'Arterial line' });
const TABS = [['vitals', 'Vitals'], ['alarms', 'Alarms'], ['presets', 'Presets'], ['screens', 'Screens'], ['more', 'More']];
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
  const ui = {
    tab: 'vitals', p: /** @type {string | undefined} */ (undefined), glideMs: Number(settings.get('glideMs', 10000)),
    /** pending edits per patient id, wire units */
    pending: /** @type {Record<string, Record<string, number | string>>} */ ({}),
    dragging: false, note: '', io: '',
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
    const list = paramList(units()).filter((sp) => !sp.id.startsWith('abp') || s.modules.includes('abp'));
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
      <h2>NIBP</h2>
      <div class="row"><button type="button" class="wide" data-act="nibp-now" data-testid="nibp-now">Cycle now</button></div>
      <div class="glide" role="group" aria-label="NIBP interval"><span class="label">Interval</span>
        ${NIBP_INTERVALS.map((sec) => `<button type="button" class="pill" data-nibp-int="${sec}" aria-pressed="${(pt.nibpRead.mode === 'cycle' ? pt.nibpRead.cycleSec : 0) === sec}">${intervalLabel(sec)}</button>`).join('')}
      </div>
      <p class="hint">Last reading ${pt.nibpRead.sys}/${pt.nibpRead.dia}</p>`;
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
      ${LIMIT_PARAMS.filter((l) => !l.needs || s.modules.includes(l.needs)).map((l) => {
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
      <h2>Show on monitor</h2>
      ${MODULE_IDS.map((k) => `<div class="sw-row"><span>${MODULE_LABELS[k]}</span>${toggle('mod-' + k, s.modules.includes(k), MODULE_LABELS[k])}</div>`).join('')}
      <h2>Monitor theme</h2>
      <div class="row"><button type="button" data-act="theme" data-testid="theme-open">Theme for all monitors…</button></div>
      <h2>This device</h2>
      <div class="glide" role="group" aria-label="CO2 unit"><span class="label">CO₂</span>
        ${['mmHg', 'kPa'].map((x) => `<button type="button" class="pill" data-unit="co2:${x}" aria-pressed="${u.co2 === x}">${x}</button>`).join('')}</div>
      <div class="glide" role="group" aria-label="Temperature unit"><span class="label">Temp</span>
        ${['C', 'F'].map((x) => `<button type="button" class="pill" data-unit="temp:${x}" aria-pressed="${u.temp === x}">°${x}</button>`).join('')}</div>
      ${s.patients.length > 1 ? `<h2>Patients</h2><div class="row"><button type="button" data-act="remove" data-testid="remove-bed">Remove ${esc(pt.label)}</button></div>` : ''}
      <p class="hint">Simulation only. Made-up patients; never real data.</p>`;
  }

  function renderView() {
    const view = $('view');
    if (!state()) { view.innerHTML = '<p class="hint">Joining the room…</p>'; return; }
    const scroll = window.scrollY;
    view.innerHTML = ({ vitals: viewVitals, alarms: viewAlarms, presets: viewPresets, screens: viewScreens, more: viewMore }[/** @type {'vitals'} */ (ui.tab)] ?? viewVitals)();
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
    if (!ui.dragging && !(ui.tab === 'screens' && root.ownerDocument.activeElement?.matches('#view input'))) renderView();
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
    if (d.tab) { ui.tab = d.tab; render(); return; }
    if (d.bed) { ui.p = d.bed; render(); return; }
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
    if (d.nibpInt !== undefined) {
      const sec = Number(d.nibpInt);
      act({ nibp: sec ? { mode: 'cycle', cycleSec: sec } : { mode: 'manual' } }, undefined, pt.id);
      return;
    }
    if (d.unit) { const [k, v] = d.unit.split(':'); settings.set('units', { ...units(), [k]: v }); render(); return; }
    if (d.preset !== undefined) { runByName(/** @type {string} */ (presets.all()[Number(d.preset)]?.name)); return; }
    if (d.del) { presets.remove(d.del); renderView(); return; }
    if (d.switch) { onSwitch(d.switch, t.getAttribute('aria-checked') !== 'true', s, pt); return; }
    switch (d.act) {
      case 'apply': apply(); break;
      case 'cancel': delete ui.pending[pt.id]; render(); break;
      case 'nibp-now': actions.nibpNow(pt.id); break;
      case 'silence': actions.silence(); break;
      case 'theme': themePanel.open(); break;
      case 'add': actions.addPatient(); break;
      case 'remove': if (window.confirm(`Remove ${pt.label}?`)) { actions.removePatient(pt.id); ui.p = undefined; } break;
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
  }

  root.addEventListener('change', (ev) => {
    const t = /** @type {HTMLElement} */ (ev.target);
    const pt = patient();
    const sd = t.dataset;
    if (sd.scrSel && sd.s) {
      const v = /** @type {HTMLSelectElement} */ (t).value;
      if (sd.scrSel === 'p') setScreen(sd.s, { p: v || null });
      else if (v === 'custom') {
        if (state()?.screens?.[sd.s]?.theme !== 'custom') { openScreenPanel(sd.s); renderView(); }
      } else setScreen(sd.s, { theme: v || null });
      return;
    }
    if (t.id === 'rhythm' && pt) {
      const v = /** @type {HTMLSelectElement} */ (t).value;
      if (v === pt.rhythm) delete pend().rhythm; else pend().rhythm = v;
      renderDock();
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
  const progressTimer = setInterval(renderProgress, 250);
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

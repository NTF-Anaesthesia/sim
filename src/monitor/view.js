// @ts-check
// Builds the monitor's DOM from a theme and a list of cells (layout.js output). All colours, fonts and positions come
// from the theme: they are set as CSS variables and percentages here; monitor.css only holds structure.

/**
 * @typedef {{
 *   cell: import('../theme/layout.js').Cell, el: HTMLElement,
 *   canvas?: HTMLCanvasElement, scale?: HTMLCanvasElement, off?: HTMLElement,
 *   label?: HTMLElement, val?: HTMLElement, sub?: HTMLElement, unit?: HTMLElement, small?: HTMLElement,
 *   lo?: HTMLElement, hi?: HTMLElement
 * }} CellRef
 */

/** @param {Record<string, any>} theme */
function applyTheme(theme, /** @type {HTMLElement} */ root) {
  const s = root.style;
  s.setProperty('--m-bg', theme.background);
  s.setProperty('--m-font', theme.font.family);
  s.setProperty('--m-num-weight', String(theme.font.numericWeight));
  s.setProperty('--m-label-weight', String(theme.font.labelWeight));
  s.setProperty('--m-num-scale', String(theme.font.numericScale * (theme.numerics.fontScale ?? 1)));
  s.setProperty('--m-label-scale', String(theme.font.labelScale));
  s.setProperty('--m-wlabel-scale', String(theme.font.labelScale * (theme.font.waveLabelScale ?? 1)));
  const cb = theme.cells?.border ?? {};
  s.setProperty('--m-cell-bw', `${cb.width ?? 0}px`);
  s.setProperty('--m-cell-bc', String(cb.color ?? '#404040'));
  s.setProperty('--m-cell-br', `${cb.radius ?? 0}px`);
  s.setProperty('--m-cell-bg', String(theme.cells?.background ?? 'transparent'));
  s.setProperty('--m-gap', `${theme.layout.grid.gap / 2}px`);
  s.setProperty('--m-flash', `${1 / Math.max(0.1, theme.alarmStyle.flashHz)}s`);
  root.dataset.limits = theme.numerics.limitsPosition;
  root.dataset.labelColor = theme.labels?.colorMode ?? 'parameter';
  root.dataset.limitStyle = theme.alarmStyle.limitStyle;
  for (const [k, v] of Object.entries(theme.colors)) s.setProperty(`--c-${k}`, String(v));
}

/**
 * @param {HTMLElement} root the element that becomes the monitor
 * @param {Record<string, any>} theme
 * @param {import('../theme/layout.js').Cell[]} cells
 * @param {{ onSilence: () => void, onSound: () => void, onFull: () => void, onWake: () => void, onTheme: () => void, onTrends?: () => void, code: string, screenMode?: string, onFit?: () => void }} act
 */
export function buildView(root, theme, cells, act) {
  applyTheme(theme, root);
  root.className = 'mon';
  root.innerHTML = '';
  const { columns, rows } = theme.layout.grid;
  const stage = document.createElement('div');
  stage.className = 'stage';
  root.append(stage);
  // fixed screen: the layout is drawn at width x height inside `host` and scaled evenly to fit the stage (letterboxed)
  const fit = { scale: 1 };
  let host = stage;
  const mode = act.screenMode ?? theme.screen?.mode ?? 'fill';
  if (mode === 'fixed') {
    const W = theme.screen.width;
    const H = theme.screen.height;
    host = document.createElement('div');
    host.className = 'screen';
    host.style.width = `${W}px`;
    host.style.height = `${H}px`;
    stage.append(host);
    const refit = () => {
      const w = stage.clientWidth;
      const h = stage.clientHeight;
      if (!w || !h) return;
      const s = Math.min(w / W, h / H);
      const changed = Math.abs(s - fit.scale) > 1e-6;
      fit.scale = s;
      host.style.transform = `translate(${(w - W * s) / 2}px, ${(h - H * s) / 2}px) scale(${s})`;
      if (changed) act.onFit?.();
    };
    refit();
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(refit).observe(stage);
  }
  /** @param {HTMLElement} el @param {{ x: number, y: number, w: number, h: number }} b */
  const place = (el, b) => {
    el.style.left = `${(b.x / columns) * 100}%`;
    el.style.top = `${(b.y / rows) * 100}%`;
    el.style.width = `${(b.w / columns) * 100}%`;
    el.style.height = `${(b.h / rows) * 100}%`;
  };
  /** @type {CellRef[]} */
  const refs = [];
  for (const cell of cells) {
    const el = document.createElement('div');
    el.className = `cell ${cell.part === 'wave' ? 'wave' : 'num'}`;
    el.dataset.module = cell.module;
    el.dataset.part = cell.part;
    el.style.setProperty('--c', `var(--c-${cell.part === 'wave' ? cell.module : 'text'})`);
    place(el, cell);
    /** @type {CellRef} */
    const ref = { cell, el };
    if (cell.part === 'wave') {
      if (theme.waves.grid) {
        const mm = theme.waves.pxPerMm * 5;
        el.style.backgroundImage = 'linear-gradient(var(--c-grid) 1px, transparent 1px), linear-gradient(90deg, var(--c-grid) 1px, transparent 1px)';
        el.style.backgroundSize = `${mm}px ${mm}px`;
      }
      el.innerHTML = '<canvas class="wmain"></canvas><canvas class="wscale"></canvas><span class="wlabel"></span><span class="woff"></span>';
      ref.canvas = /** @type {HTMLCanvasElement} */ (el.querySelector('.wmain'));
      ref.scale = /** @type {HTMLCanvasElement} */ (el.querySelector('.wscale'));
      /** @type {HTMLElement} */ (el.querySelector('.wlabel')).textContent = theme.labels.wave?.[cell.module] ?? cell.module;
      ref.off = /** @type {HTMLElement} */ (el.querySelector('.woff'));
      ref.off.textContent = theme.labels.off?.[cell.module] ?? '';
    } else {
      el.innerHTML = '<span class="nlabel"></span><span class="nunit"></span><span class="nval"></span>'
        + '<span class="nsub"></span><span class="nsmall"></span><span class="nlim"><span class="hi"></span><span class="lo"></span></span>';
      const q = (/** @type {string} */ s) => /** @type {HTMLElement} */ (el.querySelector(s));
      ref.label = q('.nlabel'); ref.unit = q('.nunit'); ref.val = q('.nval'); ref.sub = q('.nsub');
      ref.small = q('.nsmall'); ref.hi = q('.hi'); ref.lo = q('.lo');
      if (!theme.numerics.showLimits) q('.nlim').hidden = true;
    }
    host.append(el);
    refs.push(ref);
  }
  const bar = document.createElement('button');
  bar.className = 'alarmbar';
  bar.type = 'button';
  bar.dataset.testid = 'alarm-bar';
  bar.addEventListener('click', act.onSilence);
  place(bar, theme.layout.alarmBar);
  const [vert, horiz] = String(theme.alarmStyle.barPosition).split('-');
  bar.dataset.v = vert;
  bar.dataset.h = horiz;
  host.append(bar);

  const tools = document.createElement('div');
  tools.className = 'tools';
  tools.innerHTML = '<button type="button" data-t="sound">Sound</button><button type="button" data-t="full">Full screen</button>'
    + '<button type="button" data-t="wake">Keep awake</button><button type="button" data-t="theme" data-testid="theme-open">Theme</button><button type="button" data-t="trends" data-testid="trends-open">Trends</button><span class="chip" id="status" data-status="connecting">connecting</span>'
    + '<span class="code">Room <b></b></span><span class="hidden-test" data-testid="value"></span>';
  /** @type {HTMLElement} */ (tools.querySelector('.code b')).textContent = act.code;
  /** @type {Record<string, () => void>} */
  const handlers = { sound: act.onSound, full: act.onFull, wake: act.onWake, theme: act.onTheme, trends: act.onTrends ?? (() => {}) };
  tools.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target).closest('button')?.dataset.t;
    if (t) handlers[t]?.();
  });
  root.append(tools);
  const q = (/** @type {string} */ s) => /** @type {HTMLElement} */ (tools.querySelector(s));
  return {
    refs, bar, tools, fit,
    chip: q('.chip'), soundBtn: q('[data-t=sound]'), fullBtn: q('[data-t=full]'), wakeBtn: q('[data-t=wake]'),
    testValue: q('.hidden-test'),
  };
}

/** @typedef {ReturnType<typeof buildView>} View */

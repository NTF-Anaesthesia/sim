// @ts-check
// The theme panel (DOM): choose a theme, import by file, URL or pasted text, export the current one, and edit the main
// values with a live preview (every change goes straight to `onApply`, and the monitor redraws at once). Shared by the
// monitor (this device) and the phone (every monitor in the room). Nothing happens on import; `createThemePanel` builds
// the elements, `open()` shows them. All text goes in with textContent / value, never as markup.
import { FIELDS, FONT_CHOICES, fieldProblem, getPath, setPath } from './fields.js';
import { exportTheme, parseThemeText, themeName, validateTheme } from './validate.js';

const CSS = `
.tp{position:fixed;top:0;right:0;bottom:0;width:min(420px,100vw);z-index:50;background:#15171a;color:#e6e6e6;font:14px system-ui,sans-serif;
  overflow:auto;padding:12px 14px 40px;box-shadow:-4px 0 18px #0008}
.tp[hidden]{display:none}
.tp h2{font-size:16px;margin:0 0 8px;display:flex;justify-content:space-between;align-items:center}
.tp h3{font-size:13px;margin:14px 0 6px;color:#9fb0c0;text-transform:uppercase;letter-spacing:.04em}
.tp button,.tp select,.tp input,.tp textarea{font:inherit;color:inherit;background:#242830;border:1px solid #3a404a;border-radius:6px;padding:8px 10px;min-height:40px}
.tp button{cursor:pointer}.tp button:hover{background:#2e3440}
.tp textarea{width:100%;min-height:96px;font:12px ui-monospace,monospace}
.tp .row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:6px 0}
.tp .row>input[type=url],.tp .row>input[type=text]{flex:1;min-width:0}
.tp .msg{margin:8px 0;padding:8px 10px;border-radius:6px;white-space:pre-wrap;font-size:13px}
.tp .msg[hidden]{display:none}
.tp .msg.err{background:#4a1d1d;color:#ffd0d0}.tp .msg.ok{background:#173a22;color:#c8f5d4}
.tp details{border-top:1px solid #2c313a;padding:4px 0}.tp summary{cursor:pointer;padding:8px 0}
.tp .fld{display:grid;grid-template-columns:1fr 130px;gap:8px;align-items:center;margin:4px 0}
.tp .fld input,.tp .fld select{width:100%;min-height:36px;padding:4px 8px}
.tp .fld input[type=color]{padding:2px;height:36px}.tp .fld input[type=checkbox]{width:22px;min-height:22px}
.tp .fld input[aria-invalid=true]{border-color:#e55}
.tp .hint{color:#9aa4b0;font-size:12px}
`;

/**
 * @param {{
 *   title?: string,
 *   getTheme: () => Record<string, any>,
 *   onApply: (theme: Record<string, any>, via: string) => unknown,
 *   choices?: { id: string, label: string }[],
 *   current?: () => string,
 *   onChoose?: (id: string) => void,
 *   extras?: { label: string, testid: string, run: () => void }[],
 *   screen?: { get: () => string, set: (mode: string) => void },
 *   editor?: boolean,
 *   fetchImpl?: typeof fetch,
 *   doc?: Document,
 * }} opts
 */
export function createThemePanel(opts) {
  const doc = opts.doc ?? document;
  const el = doc.createElement('aside');
  el.className = 'tp';
  el.hidden = true;
  el.dataset.testid = 'theme-panel';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Theme');
  const style = doc.createElement('style');
  style.textContent = CSS;
  el.append(style);

  /** @param {string} tag @param {Record<string, string>} [attrs] @param {string} [text] */
  const make = (tag, attrs = {}, text) => {
    const n = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text !== undefined) n.textContent = text;
    return n;
  };
  /** @param {string} text @param {string} testid @param {() => void} fn */
  const button = (text, testid, fn) => {
    const b = make('button', { type: 'button', 'data-testid': testid }, text);
    b.addEventListener('click', fn);
    return b;
  };

  const head = make('h2');
  head.append(make('span', {}, opts.title ?? 'Theme'), button('Close', 'theme-close', () => api.close()));
  const errBox = make('div', { class: 'msg err', role: 'alert', 'data-testid': 'theme-error' });
  const okBox = make('div', { class: 'msg ok', role: 'status', 'data-testid': 'theme-msg' });
  errBox.hidden = true;
  okBox.hidden = true;
  const nameLine = make('p', { class: 'hint', 'data-testid': 'theme-name' });

  /** @param {string} [err] @param {string} [ok] */
  function say(err, ok) {
    errBox.hidden = !err;
    errBox.textContent = err ?? '';
    okBox.hidden = !ok;
    okBox.textContent = ok ?? '';
  }

  // choose
  const pickRow = make('div', { class: 'row' });
  /** @type {HTMLSelectElement | null} */
  let pickSel = null;
  if (opts.choices?.length) {
    pickSel = /** @type {HTMLSelectElement} */ (make('select', { 'data-testid': 'theme-choose', 'aria-label': 'Theme' }));
    for (const c of opts.choices) pickSel.append(make('option', { value: c.id }, c.label));
    pickSel.addEventListener('change', () => { say(); opts.onChoose?.(/** @type {HTMLSelectElement} */ (pickSel).value); api.refresh(); });
    pickRow.append(pickSel);
  }
  /** @type {HTMLSelectElement | null} */
  let screenSel = null;
  if (opts.screen) {
    const scr = opts.screen;
    screenSel = /** @type {HTMLSelectElement} */ (make('select', { 'data-testid': 'theme-screen', 'aria-label': 'Screen size' }));
    for (const [v, l] of [['theme', 'Screen: as theme'], ['fill', 'Screen: fill window'], ['fixed', 'Screen: fixed size']]) screenSel.append(make('option', { value: v }, l));
    screenSel.addEventListener('change', () => { say(); scr.set(/** @type {HTMLSelectElement} */ (screenSel).value); });
    pickRow.append(screenSel);
  }
  for (const x of opts.extras ?? []) pickRow.append(button(x.label, x.testid, () => { say(); x.run(); }));

  // import
  /** @param {string} text @param {string} via */
  function importText(text, via) {
    const p = parseThemeText(text);
    if (!p.ok) { say(p.error); return false; }
    const v = validateTheme(p.value);
    if (!v.ok) { say(v.errors.join('\n')); return false; }
    if (opts.onApply(v.theme, via) === false) return false; // the caller said why with `say`
    api.refresh();
    const warn = v.warnings.length ? `\nIgnored: ${v.warnings.slice(0, 6).join('; ')}${v.warnings.length > 6 ? ` (+${v.warnings.length - 6} more)` : ''}` : '';
    say(undefined, `Applied “${themeName(v.theme)}”.${warn}`);
    return true;
  }
  const file = /** @type {HTMLInputElement} */ (make('input', { type: 'file', accept: 'application/json,.json', 'data-testid': 'theme-file', 'aria-label': 'Theme file' }));
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    if (f.size > 32768) { say(`The file is ${Math.ceil(f.size / 1024)} KB; a theme is at most 32 KB.`); return; }
    try { importText(await f.text(), 'file'); } catch { say('The file could not be read.'); }
  });
  const url = /** @type {HTMLInputElement} */ (make('input', { type: 'url', placeholder: 'https://… theme.json', 'data-testid': 'theme-url', 'aria-label': 'Theme address' }));
  const doFetch = opts.fetchImpl ?? ((/** @type {RequestInfo | URL} */ u, /** @type {RequestInit} */ i) => fetch(u, i));
  const loadUrl = button('Load', 'theme-url-load', async () => {
    let u;
    try { u = new URL(url.value.trim()); } catch { say('That is not a web address.'); return; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') { say('Only http or https addresses can be loaded.'); return; }
    try {
      const r = await doFetch(u.href, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!r.ok) { say(`The address answered ${r.status}.`); return; }
      importText(await r.text(), 'url');
    } catch { say('Could not load that address (it may block other sites, or be offline).'); }
  });
  const paste = /** @type {HTMLTextAreaElement} */ (make('textarea', { 'data-testid': 'theme-text', 'aria-label': 'Theme JSON', spellcheck: 'false', placeholder: 'Paste theme JSON here' }));

  const exportRow = make('div', { class: 'row' });
  exportRow.append(
    button('Download', 'theme-download', () => {
      const t = opts.getTheme();
      const a = make('a', { download: `${themeName(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'theme'}.json` });
      const href = URL.createObjectURL(new Blob([exportTheme(t)], { type: 'application/json' }));
      a.setAttribute('href', href);
      doc.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    }),
    button('Copy', 'theme-copy', async () => {
      try { await navigator.clipboard.writeText(exportTheme(opts.getTheme())); say(undefined, 'Copied.'); } catch { say('Copy is not allowed here; use Download or the text box.'); }
    }),
    button('Show in box', 'theme-fill', () => { paste.value = exportTheme(opts.getTheme()); }),
  );

  el.append(head, errBox, okBox, nameLine, pickRow);
  el.append(make('h3', {}, 'Import'));
  const fileRow = make('div', { class: 'row' });
  fileRow.append(file);
  const urlRow = make('div', { class: 'row' });
  urlRow.append(url, loadUrl);
  const pasteRow = make('div', { class: 'row' });
  pasteRow.append(button('Apply text', 'theme-apply-text', () => importText(paste.value, 'paste')));
  el.append(fileRow, urlRow, paste, pasteRow, make('h3', {}, 'Export'), exportRow);

  // editor
  const editorBox = make('div');
  /** @type {Map<string, HTMLInputElement | HTMLSelectElement>} */
  const inputs = new Map();
  if (opts.editor) {
    el.append(make('h3', {}, 'Edit (live)'), make('p', { class: 'hint' }, 'Changes show at once. Layout cells are edited in the JSON box; see THEMES.md.'), editorBox);
    const groups = [...new Set(FIELDS.map((f) => f.group))];
    for (const g of groups) {
      const d = make('details', { 'data-group': g });
      d.append(make('summary', {}, g));
      for (const f of FIELDS.filter((x) => x.group === g)) {
        const row = make('label', { class: 'fld' });
        row.append(make('span', {}, f.label));
        /** @type {HTMLInputElement | HTMLSelectElement} */
        let inp;
        if (f.type === 'select') {
          inp = /** @type {HTMLSelectElement} */ (make('select'));
          for (const o of f.options ?? []) inp.append(make('option', { value: o }, o.startsWith('system-ui') ? 'System' : o.startsWith('Georgia') ? 'Serif' : o.startsWith('ui-mono') ? 'Monospace' : o.startsWith('Arial') ? 'Arial' : o));
        } else {
          inp = /** @type {HTMLInputElement} */ (make('input', {
            type: f.type === 'color' ? 'color' : f.type === 'bool' ? 'checkbox' : f.type === 'number' ? 'number' : 'text',
            ...(f.type === 'number' ? { min: String(f.min), max: String(f.max), step: String(f.step) } : {}),
            ...(f.type === 'text' || f.type === 'numlist' ? { maxlength: String(f.maxLen ?? 24) } : {}),
          }));
        }
        inp.dataset.testid = `f-${f.path}`;
        inp.setAttribute('aria-label', f.label);
        inp.addEventListener('input', () => {
          const raw = f.type === 'bool' ? /** @type {HTMLInputElement} */ (inp).checked
            : f.type === 'number' ? (inp.value === '' ? NaN : Number(inp.value))
              : f.type === 'numlist' ? inp.value.split(/[,\s]+/).filter(Boolean).map(Number) : inp.value;
          const why = f.type === 'color' ? '' : fieldProblem(f, raw);
          inp.setAttribute('aria-invalid', String(!!why));
          inp.title = why;
          if (why) return;
          const t = structuredClone(opts.getTheme());
          setPath(t, f.path, raw);
          opts.onApply(t, 'editor');
        });
        inputs.set(f.path, inp);
        row.append(inp);
        d.append(row);
      }
      editorBox.append(d);
    }
  }

  function fillEditor() {
    const t = opts.getTheme();
    for (const f of FIELDS) {
      const inp = inputs.get(f.path);
      const v = getPath(t, f.path);
      if (!inp || v === undefined) continue;
      if (f.type === 'bool') /** @type {HTMLInputElement} */ (inp).checked = !!v;
      else {
        if (f.path === 'font.family' && !FONT_CHOICES.includes(String(v))) {
          inp.append(make('option', { value: String(v) }, String(v)));
        }
        inp.value = Array.isArray(v) ? v.join(', ') : String(v);
      }
      inp.setAttribute('aria-invalid', 'false');
    }
  }

  const api = {
    el,
    /** Bring the name, the chooser and the editor in line with the current theme. */
    refresh() {
      nameLine.textContent = `Current: ${themeName(opts.getTheme())}`;
      if (pickSel && opts.current) pickSel.value = opts.current();
      if (screenSel && opts.screen) screenSel.value = opts.screen.get();
      fillEditor();
    },
    open() { api.refresh(); el.hidden = false; },
    close() { el.hidden = true; },
    get isOpen() { return !el.hidden; },
    importText,
    say,
  };
  return api;
}

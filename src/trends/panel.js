// @ts-check
// The trends panel, shared by the phone (a tab) and the monitor (a button and an overlay). It asks the room for its log
// when opened or refreshed and draws the graph or the table; nothing is kept between openings.
import { clock, esc, trendSvg, trendTable } from './chart.js';
import { debriefData, debriefHtml, debriefJson } from './debrief.js';
import { debriefPng, openPrintView } from './export.js';
import { TREND_RANGES, groupsFor, sampleSeries } from './series.js';

const RANGE_LABELS = /** @type {Record<string, string>} */ ({ '30m': '30 min', '1h': '1 h', '4h': '4 h' });
const WARN_MS = 2 * 60 * 60 * 1000;

/**
 * @param {HTMLElement} el container to draw into
 * @param {{ client: import('../room/client.js').RoomClient, code: string, patientId: () => string | undefined, save?: (name: string, type: string, text: string | Blob) => void }} opts
 */
export function mountTrends(el, opts) {
  const ui = { range: '1h', view: 'graph', data: /** @type {any} */ (null), note: '' };

  const bed = () => {
    const s = opts.client.state;
    return s?.patients.find((p) => p.id === opts.patientId()) ?? s?.patients[0] ?? null;
  };

  function expiryNote() {
    const h = ui.data;
    if (!h) return '';
    const left = h.expiresAt - h.now;
    const mins = Math.max(0, Math.round(left / 60000));
    const when = `${Math.floor(mins / 60)} h ${mins % 60} min`;
    const warn = left < WARN_MS;
    return `<p class="hint trend-expiry" data-warn="${warn}" data-testid="trend-expiry">${warn ? 'Save the debrief now. ' : ''}This room is deleted at ${clock(h.expiresAt)} (in ${when}) unless someone changes something.</p>`;
  }

  function render() {
    const s = opts.client.state;
    const b = bed();
    const chips = (/** @type {string} */ name, /** @type {[string, string][]} */ items, /** @type {string} */ cur) =>
      `<div class="glide" role="group" aria-label="${name}">${items.map(([v, l]) => `<button type="button" class="pill" data-${name}="${v}" aria-pressed="${v === cur}" data-testid="trend-${name}-${v}">${esc(l)}</button>`).join('')}</div>`;
    let body = '<p class="hint">Loading the log…</p>';
    if (ui.data && s && b) {
      const groups = groupsFor(s.modules);
      const to = ui.data.now;
      const from = to - TREND_RANGES[/** @type {'30m' | '1h' | '4h'} */ (ui.range)];
      const series = sampleSeries({ glides: ui.data.glides, p: b.id, from, to, points: 120, groups, fallback: b });
      body = ui.view === 'graph'
        ? trendSvg({ series, groups, events: ui.data.events, p: b.id, from, to })
        : trendTable({ series, groups });
      body += `<p class="hint">${esc(b.label)}: glided values as the monitor showed them. Marks: orange = bookmark. ${ui.data.events.length} events in the log.</p>`;
    } else if (ui.data === false) body = '<p class="hint">Could not reach the room.</p>';
    el.innerHTML = `<div class="trends" data-testid="trends">
      ${chips('range', Object.keys(TREND_RANGES).map((k) => [k, RANGE_LABELS[k]]), ui.range)}
      ${chips('view', [['graph', 'Graph'], ['table', 'Table']], ui.view)}
      <div class="trend-body">${body}</div>
      ${expiryNote()}
      <div class="row"><button type="button" data-act="trend-refresh" data-testid="trend-refresh">Refresh</button>
        <button type="button" data-act="trend-debrief" data-testid="trend-debrief">Debrief file</button>
        <button type="button" data-act="trend-json" data-testid="trend-json">JSON</button></div>
      <div class="row"><button type="button" data-act="trend-png" data-testid="trend-png">Save picture (PNG)</button>
        <button type="button" data-act="trend-print" data-testid="trend-print">Print view</button></div>
      <p class="hint" data-testid="trend-note">${esc(ui.note)}</p></div>`;
  }

  async function refresh() {
    ui.data = await opts.client.history({ range: TREND_RANGES['4h'] }) ?? false;
    render();
  }

  /** @param {'html' | 'json' | 'png' | 'print'} kind */
  async function exportFile(kind) {
    const h = await opts.client.history({ all: true });
    const s = opts.client.state;
    if (!h || !s) { ui.note = 'Could not reach the room.'; render(); return; }
    const data = debriefData({ code: opts.code, state: s, history: h, now: h.now });
    const stamp = new Date(h.now).toISOString().slice(0, 16).replace(/[-:T]/g, '');
    ui.data = h;
    if (kind === 'print') { openPrintView(data); ui.note = 'Print view open: tap Print / Save as PDF.'; render(); return; }
    /** @type {[string, string, string | Blob]} */
    let file;
    if (kind === 'png') {
      try { file = [`debrief-${opts.code}-${stamp}.png`, 'image/png', await debriefPng(data, bed()?.id)]; } catch (e) { ui.note = `Could not make the picture: ${e instanceof Error ? e.message : 'error'}`; render(); return; }
    } else if (kind === 'html') file = [`debrief-${opts.code}-${stamp}.html`, 'text/html', debriefHtml(data)];
    else file = [`debrief-${opts.code}-${stamp}.json`, 'application/json', debriefJson(data)];
    (opts.save ?? browserSave)(...file);
    ui.note = `Saved ${file[0]}`;
    render();
  }

  el.addEventListener('click', (ev) => {
    const t = /** @type {HTMLElement} */ (ev.target).closest('button');
    if (!t) return;
    if (t.dataset.range) { ui.range = t.dataset.range; render(); }
    else if (t.dataset.view) { ui.view = t.dataset.view; render(); }
    else if (t.dataset.act === 'trend-refresh') refresh();
    else if (t.dataset.act === 'trend-debrief') exportFile('html');
    else if (t.dataset.act === 'trend-json') exportFile('json');
    else if (t.dataset.act === 'trend-png') exportFile('png');
    else if (t.dataset.act === 'trend-print') exportFile('print');
  });

  render();
  return { refresh, render, get data() { return ui.data; } };
}

/** @param {string} name @param {string} type @param {string | Blob} data */
function browserSave(name, type, data) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

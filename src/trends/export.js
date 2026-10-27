// @ts-check
// Debrief as a picture and as a print view (sim-train S3). The picture is one PNG per bed: the trends graph, then the event
// list (scenario steps, drug buttons, teaching notes reached, bookmarks). The print view is the same report shown over the
// page with Print / Save as PDF; the browser's print dialog makes the PDF. Both are built in the browser from the room log.
import { clock, esc } from './chart.js';
import { bedChart, debriefBody } from './debrief.js';

/** Rows the event list leaves out: housekeeping that says nothing about the session. */
const QUIET = ['screen', 'test', 'silence'];
export const PNG_WIDTH = 1080;
export const PNG_MAX_ROWS = 90;

/**
 * The event list for the picture: one text line per event, oldest first.
 * @param {import('./debrief.js').DebriefData} d @param {string} bedId only this bed's events and the room's own
 * @returns {{ time: string, kind: string, text: string }[]}
 */
export function eventRows(d, bedId) {
  return d.events
    .filter((e) => !QUIET.includes(e.kind) && (!e.p || e.p === bedId))
    .map((e) => ({ time: clock(e.t, true), kind: e.kind, text: e.what }));
}

/** Split text into lines no wider than `maxW`, by words. @param {(s: string) => number} width @param {string} text @param {number} maxW */
export function wrapText(width, text, maxW) {
  /** @type {string[]} */
  const out = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && width(next) > maxW) { out.push(line); line = word; } else line = next;
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

/** @param {string} svg @returns {Promise<HTMLImageElement>} */
function loadSvg(svg) {
  return new Promise((resolve, reject) => {
    const m = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
    const sized = m ? svg.replace('<svg ', `<svg width="${m[1]}" height="${m[2]}" color="#222" `) : svg;
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('could not draw the graph'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`;
  });
}

/**
 * @param {import('./debrief.js').DebriefData} d @param {string} [bedId] default: the first bed
 * @returns {Promise<Blob>} a PNG
 */
export async function debriefPng(d, bedId) {
  const bed = d.beds.find((b) => b.id === bedId) ?? d.beds[0];
  const img = await loadSvg(bedChart(d, bed));
  const pad = 24, scale = (PNG_WIDTH - 2 * pad) / img.width, chartH = Math.round(img.height * scale);
  const font = '15px system-ui, sans-serif', lh = 21;
  const all = eventRows(d, bed.id);
  const rows = all.slice(-PNG_MAX_ROWS);
  const measure = document.createElement('canvas').getContext('2d');
  if (!measure) throw new Error('no canvas');
  measure.font = font;
  const textX = pad + 190;
  const wrapped = rows.map((r) => wrapText((s) => measure.measureText(s).width, r.text, PNG_WIDTH - pad - textX));
  const lines = wrapped.reduce((n, w) => n + w.length, 0);
  const headH = 78, listTop = headH + chartH + 40;
  const canvas = document.createElement('canvas');
  canvas.width = PNG_WIDTH;
  canvas.height = listTop + (lines + (all.length > rows.length ? 1 : 0) + (rows.length ? 0 : 1)) * lh + pad + 8 * rows.length;
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#111';
  ctx.font = '600 26px system-ui, sans-serif';
  ctx.fillText(`Simulation debrief: ${bed.label}`, pad, 40);
  ctx.font = '14px system-ui, sans-serif';
  ctx.fillStyle = '#555';
  ctx.fillText(`Room ${d.room}, ${new Date(d.exportedAt).toLocaleString()}. Teaching simulation with made-up patients.`, pad, 62);
  ctx.drawImage(img, pad, headH, PNG_WIDTH - 2 * pad, chartH);
  ctx.fillStyle = '#111';
  ctx.font = '600 18px system-ui, sans-serif';
  ctx.fillText('Events', pad, listTop - 12);
  ctx.font = font;
  let y = listTop + 12;
  if (!rows.length) { ctx.fillStyle = '#555'; ctx.fillText('No events recorded.', pad, y); }
  if (all.length > rows.length) { ctx.fillStyle = '#555'; ctx.fillText(`(${all.length - rows.length} earlier events are in the debrief file)`, pad, y); y += lh; }
  rows.forEach((r, i) => {
    const note = r.kind === 'note', mark = r.kind === 'bookmark';
    ctx.fillStyle = '#666';
    ctx.fillText(r.time, pad, y);
    ctx.fillText(r.kind, pad + 80, y);
    ctx.fillStyle = mark ? '#b45309' : '#111';
    ctx.font = note ? `italic ${font}` : mark ? `600 ${font}` : font;
    for (const l of wrapped[i]) { ctx.fillText(l, textX, y); y += lh; }
    ctx.font = font;
    y += 8;
  });
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not make the picture'))), 'image/png'));
}

const PRINT_CSS = `
.print-view{position:fixed;inset:0;z-index:50;overflow:auto;background:#fff;color:#1b1b1b;padding:12px 16px;font:15px/1.45 system-ui,sans-serif}
.print-view .bar{display:flex;gap:8px;margin-bottom:8px}
.print-view h1{font-size:1.3rem;margin:.2em 0}.print-view h2{font-size:1.05rem;margin:1.2em 0 .3em;break-after:avoid}
.print-view table{border-collapse:collapse;width:100%}.print-view th,.print-view td{text-align:left;padding:4px 6px;border-bottom:1px solid #8886;vertical-align:top}
.print-view tr{break-inside:avoid}.print-view tr.bm td{font-weight:600}.print-view tr.nt td{font-style:italic}
.print-view svg{width:100%;height:auto;color:#222}.print-view section{break-inside:avoid}.print-view .note{color:#555;font-size:.85rem}
@media print{body>*:not(.print-view){display:none!important}.print-view{position:static;overflow:visible;padding:0}.print-view .bar{display:none}}`;

/**
 * Show the report over the page with Print and Close buttons. Print opens the browser's print dialog, where "Save as PDF"
 * makes the PDF; Close removes the view.
 * @param {import('./debrief.js').DebriefData} d
 * @param {{ print?: () => void, doc?: Document }} [opts]
 * @returns {HTMLElement}
 */
export function openPrintView(d, opts = {}) {
  const doc = opts.doc ?? document;
  doc.querySelector('.print-view')?.remove();
  const el = doc.createElement('div');
  el.className = 'print-view';
  el.dataset.testid = 'print-view';
  el.innerHTML = `<style>${PRINT_CSS}</style>
    <div class="bar"><button type="button" data-testid="print-go">Print / Save as PDF</button><button type="button" data-testid="print-close">Close</button></div>
    <h1>Simulation debrief</h1>
    <p class="note">Room ${esc(d.room)}, exported ${new Date(d.exportedAt).toLocaleString()}. Teaching simulation with made-up patients; not real data.</p>
    ${debriefBody(d)}`;
  el.querySelector('[data-testid=print-go]')?.addEventListener('click', () => (opts.print ?? (() => window.print()))());
  el.querySelector('[data-testid=print-close]')?.addEventListener('click', () => el.remove());
  doc.body.append(el);
  return el;
}

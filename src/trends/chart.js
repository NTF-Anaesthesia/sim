// @ts-check
// Plain string builders for the trend graph (inline SVG) and the trend table. No DOM, so node tests can check them and
// the debrief file can embed the same output.
import { markersFor } from './series.js';

/** @typedef {typeof import('./series.js').TREND_GROUPS} Groups */

export const esc = (/** @type {unknown} */ s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

/** @param {number} t @param {boolean} [secs] */
export const clock = (t, secs = false) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...(secs ? { second: '2-digit' } : {}), hour12: false });

/** @param {string} key @param {number} v */
export const fmt = (key, v) => (key === 'temp' ? v.toFixed(1) : String(Math.round(v)));

/**
 * One small graph per group on a shared time axis, with a vertical line for each event (bookmarks drawn heavier).
 * @param {{ series: { t: number, v: Record<string, number> }[], groups: Groups, events: import('../room/log.js').LogEvent[], p: string, from: number, to: number, width?: number }} o
 */
export function trendSvg(o) {
  const W = o.width ?? 640;
  const left = 54, right = 8, rowH = 62, gap = 8, top = 4, axisH = 18;
  const H = top + o.groups.length * (rowH + gap) + axisH;
  const x = (/** @type {number} */ t) => left + ((t - o.from) / Math.max(1, o.to - o.from)) * (W - left - right);
  const marks = markersFor(o.events, o.p, o.from, o.to);
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Trends" class="trend-svg" data-testid="trend-svg" font-family="system-ui, sans-serif" font-size="10">`;
  o.groups.forEach((g, gi) => {
    const y0 = top + gi * (rowH + gap);
    const vals = o.series.flatMap((s) => g.series.map((k) => s.v[k.key])).filter((v) => Number.isFinite(v));
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (!vals.length) { lo = 0; hi = 1; }
    const pad = Math.max((hi - lo) * 0.15, hi === lo ? Math.max(1, Math.abs(hi) * 0.05) : 0);
    lo -= pad; hi += pad;
    const y = (/** @type {number} */ v) => y0 + rowH - ((v - lo) / (hi - lo)) * rowH;
    svg += `<g data-group="${g.id}"><rect x="${left}" y="${y0}" width="${W - left - right}" height="${rowH}" fill="none" stroke="#8884" />`;
    svg += `<text x="2" y="${y0 + 12}" fill="${g.color}" font-weight="600">${esc(g.label)}</text>`;
    svg += `<text x="2" y="${y0 + 24}" fill="#888" font-size="9">${esc(g.unit)}</text>`;
    svg += `<text x="${left - 3}" y="${y0 + 9}" text-anchor="end" fill="#888" font-size="9">${esc(fmt(g.series[0].key, hi))}</text>`;
    svg += `<text x="${left - 3}" y="${y0 + rowH - 1}" text-anchor="end" fill="#888" font-size="9">${esc(fmt(g.series[0].key, lo))}</text>`;
    g.series.forEach((k, ki) => {
      const pts = o.series.filter((s) => Number.isFinite(s.v[k.key])).map((s) => `${x(s.t).toFixed(1)},${y(s.v[k.key]).toFixed(1)}`);
      if (pts.length) svg += `<polyline fill="none" stroke="${g.color}" stroke-width="1.6"${ki ? ' stroke-dasharray="4 3"' : ''} points="${pts.join(' ')}" data-series="${k.key}"/>`;
    });
    svg += '</g>';
  });
  const bottom = top + o.groups.length * (rowH + gap) - gap;
  for (const e of marks) {
    const book = e.kind === 'bookmark';
    svg += `<line x1="${x(e.t).toFixed(1)}" x2="${x(e.t).toFixed(1)}" y1="${top}" y2="${bottom}" stroke="${book ? '#d97706' : '#8886'}" stroke-width="${book ? 1.6 : 0.8}"${book ? '' : ' stroke-dasharray="2 3"'} data-event="${e.kind}"><title>${esc(clock(e.t, true))} ${esc(e.what)}</title></line>`;
  }
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const t = o.from + ((o.to - o.from) * i) / ticks;
    svg += `<text x="${x(t).toFixed(1)}" y="${H - 4}" text-anchor="${i === 0 ? 'start' : i === ticks ? 'end' : 'middle'}" fill="#888">${clock(t, o.to - o.from < 10 * 60000)}</text>`;
  }
  return svg + '</svg>';
}

/**
 * The same values as a table: a row per sampled time (newest last), one column per series.
 * @param {{ series: { t: number, v: Record<string, number> }[], groups: Groups, rows?: number }} o
 */
export function trendTable(o) {
  const cols = o.groups.flatMap((g) => g.series.map((s) => ({ key: s.key, head: g.series.length > 1 ? `${g.label} ${s.key.endsWith('Dia') ? 'dia' : 'sys'}` : g.label })));
  const n = o.rows ?? 12;
  const step = Math.max(1, (o.series.length - 1) / (n - 1));
  const picked = [];
  for (let i = 0; i < n && o.series.length; i++) picked.push(o.series[Math.min(o.series.length - 1, Math.round(i * step))]);
  return `<table class="trend-table" data-testid="trend-table"><thead><tr><th>Time</th>${cols.map((c) => `<th>${esc(c.head)}</th>`).join('')}</tr></thead><tbody>`
    + picked.map((r) => `<tr data-t="${Math.round(r.t)}"><td>${clock(r.t)}</td>${cols.map((c) => `<td data-key="${c.key}">${Number.isFinite(r.v[c.key]) ? fmt(c.key, r.v[c.key]) : '--'}</td>`).join('')}</tr>`).join('')
    + '</tbody></table>';
}

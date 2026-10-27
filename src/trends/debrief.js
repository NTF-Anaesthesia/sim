// @ts-check
// Debrief export: one HTML file that opens offline (data embedded, chart drawn as inline SVG, event list) plus the same
// data as JSON. Built in the browser from the room log; nothing is uploaded anywhere.
import { esc, clock, trendSvg } from './chart.js';
import { groupsFor, sampleSeries } from './series.js';

/**
 * @typedef {{
 *   schema: 1, room: string, exportedAt: number, since: number, modules: string[],
 *   beds: { id: string, label: string, fallback?: any }[],
 *   events: import('../room/log.js').LogEvent[], glides: import('../room/log.js').LogGlide[]
 * }} DebriefData
 */

/**
 * @param {{ code: string, state: import('../shared/schema.js').RoomState, history: { since: number, events: any[], glides: any[] }, now: number }} o
 * @returns {DebriefData}
 */
export function debriefData(o) {
  return {
    schema: 1, room: o.code, exportedAt: o.now, since: o.history.since, modules: [...o.state.modules],
    beds: o.state.patients.map((p) => ({ id: p.id, label: p.label, fallback: structuredClone(p) })),
    events: o.history.events, glides: o.history.glides,
  };
}

/** The JSON file: the raw log, so a trend can be rebuilt from it (no fallback copies of the beds). */
export const debriefJson = (/** @type {DebriefData} */ d) => JSON.stringify({ ...d, beds: d.beds.map(({ id, label }) => ({ id, label })) }, null, 2);

/** The graph of one bed over the whole log, as an SVG string. @param {DebriefData} d @param {{ id: string, fallback?: any }} b */
export function bedChart(d, b) {
  const groups = groupsFor(d.modules);
  const first = Math.min(d.exportedAt, ...d.events.map((e) => e.t), ...d.glides.filter((g) => g.t >= d.since).map((g) => g.t));
  const from = Math.min(first, d.exportedAt - 60000);
  const series = sampleSeries({ glides: d.glides, p: b.id, from, to: d.exportedAt, points: 240, groups, fallback: b.fallback });
  return trendSvg({ series, groups, events: d.events, p: b.id, from, to: d.exportedAt, width: 720 });
}

/** The graphs and the event table: the part of the debrief that the file, the print view and the PNG share. @param {DebriefData} d */
export function debriefBody(d) {
  const label = (/** @type {string | undefined} */ p) => d.beds.find((b) => b.id === p)?.label ?? p ?? 'Room';
  const charts = d.beds.map((b) => `<section><h2>${esc(b.label)}</h2>${bedChart(d, b)}</section>`).join('');
  const rows = d.events.map((e) => `<tr class="${e.kind === 'bookmark' ? 'bm' : e.kind === 'note' ? 'nt' : ''}"><td>${clock(e.t, true)}</td><td>${esc(label(e.p))}</td><td>${esc(e.kind)}</td><td>${esc(e.what)}</td></tr>`).join('');
  return `${charts}
<h2>Events</h2>
${d.events.length ? `<table data-testid="debrief-events"><thead><tr><th>Time</th><th>Bed</th><th>Kind</th><th>What</th></tr></thead><tbody>${rows}</tbody></table>` : '<p>No events recorded.</p>'}`;
}

/** @param {DebriefData} d */
export function debriefHtml(d) {
  const json = JSON.stringify({ ...d, beds: d.beds.map(({ id, label: l }) => ({ id, label: l })) }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Simulation debrief, room ${esc(d.room)}</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1b1b1b;--line:#8884}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#eee}}
body{margin:0 auto;max-width:760px;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif}
h1{font-size:1.3rem;margin:.2em 0}h2{font-size:1.05rem;margin:1.2em 0 .3em}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:4px 6px;border-bottom:1px solid var(--line);vertical-align:top}
tr.bm td{font-weight:600;background:#d9770622}tr.nt td{font-style:italic}
svg{width:100%;height:auto;color:var(--fg)}.note{opacity:.7;font-size:.85rem}
</style></head><body>
<h1>Simulation debrief</h1>
<p class="note">Room ${esc(d.room)}, exported ${esc(new Date(d.exportedAt).toLocaleString())}. Teaching simulation with made-up patients; not real data. Trend values are the glided numbers the monitor displayed.</p>
${debriefBody(d)}
<script type="application/json" id="debrief-data">${json}</script>
</body></html>
`;
}

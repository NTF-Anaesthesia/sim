// @ts-check
// Trends are rebuilt from the room log (glide records plus events), never stored (DESIGN.md section 5a). The value at a
// time is the same `displayed()` the monitor uses, so a trend point equals what the screen showed at that moment.
import { displayed } from '../engine/glide.js';

/** @typedef {import('../room/log.js').LogGlide} LogGlide */
/** @typedef {import('../room/log.js').LogEvent} LogEvent */

export const TREND_RANGES = /** @type {const} */ ({ '30m': 30 * 60000, '1h': 60 * 60000, '4h': 4 * 60 * 60000 });

/**
 * Graph groups (one small panel each). `get` reads one value out of `displayed()`; `module` is the room module that
 * has to be on for the group to appear (none = always; `a|b` = either).
 * @type {{ id: string, label: string, unit: string, color: string, module?: string, series: { key: string, get: (d: any) => number }[] }[]}
 */
export const TREND_GROUPS = [
  { id: 'hr', label: 'HR', unit: '/min', color: '#1a9c4a', series: [{ key: 'hr', get: (d) => d.hr }] },
  { id: 'spo2', label: 'SpO₂', unit: '%', color: '#1d78c1', series: [{ key: 'spo2', get: (d) => d.spo2 }] },
  { id: 'etco2', label: 'EtCO₂', unit: 'mmHg', color: '#8a6d00', series: [{ key: 'etco2', get: (d) => d.etco2 }] },
  { id: 'rr', label: 'RR', unit: '/min', color: '#8a6d00', series: [{ key: 'rr', get: (d) => d.rr }] },
  { id: 'nibp', label: 'NIBP', unit: 'mmHg', color: '#b3261e', series: [{ key: 'nibpSys', get: (d) => d.nibp.sys }, { key: 'nibpDia', get: (d) => d.nibp.dia }] },
  { id: 'temp', label: 'Temp', unit: '°C', color: '#6a4bb5', series: [{ key: 'temp', get: (d) => d.temp }] },
  { id: 'abp', label: 'Art line', unit: 'mmHg', color: '#b3261e', module: 'abp', series: [{ key: 'abpSys', get: (d) => d.abp.sys }, { key: 'abpDia', get: (d) => d.abp.dia }] },
  { id: 'abp2', label: 'Art line 2', unit: 'mmHg', color: '#c25a00', module: 'abp2', series: [{ key: 'abp2Sys', get: (d) => d.abp2.sys }, { key: 'abp2Dia', get: (d) => d.abp2.dia }] },
  { id: 'cvp', label: 'CVP', unit: 'mmHg', color: '#1d78c1', module: 'cvp', series: [{ key: 'cvp', get: (d) => d.cvp }] },
  { id: 'fio2', label: 'FiO₂', unit: '%', color: '#4a4a4a', module: 'gas|o2', series: [{ key: 'fio2', get: (d) => d.fio2 }, { key: 'eto2', get: (d) => d.eto2 }] },
  { id: 'agent', label: 'Agent', unit: '%', color: '#7b3fb5', module: 'gas', series: [{ key: 'fiag', get: (d) => d.fiag }, { key: 'etag', get: (d) => d.etag }] },
  { id: 'bis', label: 'BIS', unit: '', color: '#7a4bc0', module: 'bis', series: [{ key: 'bis', get: (d) => d.bis }] },
];

/**
 * @param {string[]} modules the room's shown modules
 * @returns {typeof TREND_GROUPS}
 */
export const groupsFor = (modules) => TREND_GROUPS.filter((g) => !g.module || g.module.split('|').some((m) => modules.includes(m)));

/**
 * The glide of a log record as a patient-like object `displayed()` can evaluate.
 * @param {LogGlide} g
 */
const asPatient = (g) => /** @type {any} */ ({ ...g.to, glide: { startedAt: g.t, durationMs: g.dur, from: g.from, ...(g.by ? { glideMsBy: g.by } : {}) } });

/**
 * Glided numerics of one bed at `t`: the last glide record that started at or before `t`. Before the first record the
 * numerics are that record's `from`; with no records at all the bed's own current glide is used (a room nobody has
 * touched).
 * @param {LogGlide[]} glides records of this bed, oldest first
 * @param {number} t server ms
 * @param {any} [fallback] the bed from `state` (used when there are no records)
 */
export function numericsAt(glides, t, fallback) {
  let cur = null;
  for (const g of glides) { if (g.t <= t) cur = g; else break; }
  if (cur) return displayed(asPatient(cur), t);
  if (glides.length) return displayed(asPatient({ ...glides[0], dur: 0, to: glides[0].from }), t);
  return fallback ? displayed(fallback, t) : null;
}

/**
 * `points` evenly spaced samples of every series in `groups` between `from` and `to`.
 * @param {{ glides: LogGlide[], p: string, from: number, to: number, points: number, groups: typeof TREND_GROUPS, fallback?: any }} o
 * @returns {{ t: number, v: Record<string, number> }[]}
 */
export function sampleSeries(o) {
  const mine = o.glides.filter((g) => g.p === o.p).sort((a, b) => a.t - b.t);
  const n = Math.max(2, o.points);
  /** @type {{ t: number, v: Record<string, number> }[]} */
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = o.from + ((o.to - o.from) * i) / (n - 1);
    const d = numericsAt(mine, t, o.fallback);
    if (!d) continue;
    /** @type {Record<string, number>} */
    const v = {};
    for (const g of o.groups) for (const s of g.series) v[s.key] = s.get(d);
    out.push({ t, v });
  }
  return out;
}

/**
 * Events worth marking on a graph for bed `p`: that bed's and room-wide ones, without the noise (screen housekeeping).
 * @param {LogEvent[]} events
 * @param {string} p
 * @param {number} from
 * @param {number} to
 */
export const markersFor = (events, p, from, to) =>
  events.filter((e) => e.t >= from && e.t <= to && (!e.p || e.p === p) && !['screen', 'test', 'silence', 'note', 'library'].includes(e.kind));

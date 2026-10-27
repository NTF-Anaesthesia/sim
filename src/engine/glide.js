// @ts-check
// Glide model (DESIGN.md section 6): displayed value = from + (target - from) * ease(progress). Pure functions.
import { numericsOf } from '../shared/schema.js';

/** @typedef {import('../shared/schema.js').Patient} Patient */
/** @typedef {import('../shared/schema.js').Numerics} Numerics */

/** Fields that glide, as keys of a numerics object (a pressure's `sys` and `dia` share one key). */
export const GLIDE_FIELDS = /** @type {const} */ ([
  'hr', 'spo2', 'etco2', 'rr', 'temp', 'nibp', 'abp', 'abp2', 'cvp', 'bis', 'fio2', 'eto2', 'fiag', 'etag', 'fin2o', 'etn2o',
]);

/**
 * Glide time of one field: its own entry in `glideMsBy`, else the record's `durationMs` (old records and old monitors).
 * @param {{ durationMs: number, glideMsBy?: Record<string, number> }} glide
 * @param {string} key
 */
export const fieldMs = (glide, key) => glide.glideMsBy?.[key] ?? glide.durationMs;

/** @param {number} u 0..1 */
export const ease = (u) => u;

/**
 * @param {number} from
 * @param {number} to
 * @param {number} startedAt
 * @param {number} durationMs
 * @param {number} now
 */
export function glideValue(from, to, startedAt, durationMs, now) {
  if (!(durationMs > 0)) return to;
  const u = Math.min(1, Math.max(0, (now - startedAt) / durationMs));
  return from + (to - from) * ease(u);
}

/**
 * Glided values for one patient at `now` (server clock), before pulseless and sensor-off rules.
 * @param {Patient} patient
 * @param {number} now
 * @returns {Numerics}
 */
export function displayed(patient, now) {
  const { startedAt, from } = patient.glide;
  const to = patient;
  const g = (/** @type {string} */ k, /** @type {number} */ a, /** @type {number} */ b) => glideValue(a, b, startedAt, fieldMs(patient.glide, k), now);
  return {
    hr: g('hr', from.hr, to.hr), spo2: g('spo2', from.spo2, to.spo2), etco2: g('etco2', from.etco2, to.etco2), rr: g('rr', from.rr, to.rr),
    temp: g('temp', from.temp, to.temp),
    nibp: { sys: g('nibp', from.nibp.sys, to.nibp.sys), dia: g('nibp', from.nibp.dia, to.nibp.dia) },
    abp: { sys: g('abp', from.abp.sys, to.abp.sys), dia: g('abp', from.abp.dia, to.abp.dia) },
    cvp: g('cvp', from.cvp ?? to.cvp, to.cvp), bis: g('bis', from.bis ?? to.bis, to.bis),
    abp2: { sys: g('abp2', from.abp2?.sys ?? to.abp2.sys, to.abp2.sys), dia: g('abp2', from.abp2?.dia ?? to.abp2.dia, to.abp2.dia) },
    fio2: g('fio2', from.fio2 ?? to.fio2, to.fio2), eto2: g('eto2', from.eto2 ?? to.eto2, to.eto2),
    fiag: g('fiag', from.fiag ?? to.fiag, to.fiag), etag: g('etag', from.etag ?? to.etag, to.etag),
    fin2o: g('fin2o', from.fin2o ?? to.fin2o, to.fin2o), etn2o: g('etn2o', from.etn2o ?? to.etn2o, to.etn2o),
  };
}

/**
 * New glide record for a state whose targets just changed: starts from the values shown right now.
 * @param {Patient} before patient before the change
 * @param {number} now
 * @param {number} durationMs
 */
export function restartGlide(before, now, durationMs) {
  return { startedAt: now, durationMs, from: numericsOf(displayed(before, now)) };
}

/**
 * Time each field still has to glide at `now`, in ms (0 once it has landed).
 * @param {Patient} patient
 * @param {number} now
 * @returns {Record<string, number>}
 */
export function remainingMs(patient, now) {
  const { startedAt } = patient.glide;
  /** @type {Record<string, number>} */
  const out = {};
  for (const k of GLIDE_FIELDS) out[k] = Math.max(0, startedAt + fieldMs(patient.glide, k) - now);
  return out;
}

/**
 * New glide record with a glide time per field (fields left out of `ms` land at once), starting from the values shown
 * now. `durationMs` is the longest time, so a monitor that predates `glideMsBy` never lands early; `glideMsBy` is only
 * written when the times differ.
 * @param {Patient} before patient before the change
 * @param {number} now
 * @param {Record<string, number>} ms
 */
export function startGlide(before, now, ms) {
  const times = GLIDE_FIELDS.map((k) => Math.round(ms[k] ?? 0));
  const durationMs = Math.max(...times);
  const g = { startedAt: now, durationMs, from: numericsOf(displayed(before, now)) };
  if (times.every((t) => t === durationMs)) return g;
  return { ...g, glideMsBy: Object.fromEntries(GLIDE_FIELDS.map((k, i) => [k, times[i]])) };
}

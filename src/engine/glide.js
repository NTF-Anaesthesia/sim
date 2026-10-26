// @ts-check
// Glide model (DESIGN.md section 6): displayed value = from + (target - from) * ease(progress). Pure functions.
import { numericsOf } from '../shared/schema.js';

/** @typedef {import('../shared/schema.js').Patient} Patient */
/** @typedef {import('../shared/schema.js').Numerics} Numerics */

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
  const { startedAt, durationMs, from } = patient.glide;
  const to = patient;
  const g = (/** @type {number} */ a, /** @type {number} */ b) => glideValue(a, b, startedAt, durationMs, now);
  return {
    hr: g(from.hr, to.hr), spo2: g(from.spo2, to.spo2), etco2: g(from.etco2, to.etco2), rr: g(from.rr, to.rr),
    temp: g(from.temp, to.temp),
    nibp: { sys: g(from.nibp.sys, to.nibp.sys), dia: g(from.nibp.dia, to.nibp.dia) },
    abp: { sys: g(from.abp.sys, to.abp.sys), dia: g(from.abp.dia, to.abp.dia) },
    cvp: g(from.cvp ?? to.cvp, to.cvp), bis: g(from.bis ?? to.bis, to.bis),
    abp2: { sys: g(from.abp2?.sys ?? to.abp2.sys, to.abp2.sys), dia: g(from.abp2?.dia ?? to.abp2.dia, to.abp2.dia) },
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

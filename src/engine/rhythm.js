// @ts-check
// Pulseless rule and sensor-off rule (DESIGN.md section 6). Pure functions; the drawing code asks `shown`.
import { PULSELESS_RHYTHMS } from '../shared/schema.js';
import { displayed } from './glide.js';

/** @typedef {import('../shared/schema.js').Patient} Patient */

/**
 * @param {Patient} p
 * @returns {boolean} true when the rhythm gives no pulse (pleth and ABP go flat)
 */
export function pulseless(p) {
  if (PULSELESS_RHYTHMS.includes(p.rhythm)) return true;
  return p.rhythm === 'vt' && p.pulse === false;
}

/**
 * What a monitor shows for a patient at `now`. A value is `null` when it must read "---" (sensor off, or SpO2/ABP
 * while pulseless). Targets are never changed, so a perfusing rhythm restores everything.
 * @param {Patient} p
 * @param {number} now
 */
export function shown(p, now) {
  const d = displayed(p, now);
  const flat = pulseless(p);
  const off = p.off ?? {};
  return {
    perfusing: !flat,
    ecgOff: !!off.ecg,
    hr: off.ecg ? null : d.hr,
    spo2: off.spo2 || flat ? null : d.spo2,
    etco2: off.etco2 ? null : d.etco2,
    rr: off.etco2 ? null : d.rr,
    temp: d.temp,
    nibp: off.nibp ? null : d.nibp,
    abp: off.abp || flat ? null : d.abp,
  };
}

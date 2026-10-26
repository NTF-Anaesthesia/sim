// @ts-check
// Pulseless rule and sensor-off rule (DESIGN.md section 6). Pure functions; the drawing code asks `shown`.
import { NO_CAPTURE_RHYTHMS, PULSELESS_RHYTHMS } from '../shared/schema.js';
import { displayed } from './glide.js';

/** @typedef {import('../shared/schema.js').Patient} Patient */

/**
 * Transcutaneous pacing (V2 S8). `on`: pacing runs (it needs pads on); `capture`: the stimulus is at or above the
 * phone's threshold and the rhythm can be captured, so each spike is followed by a wide complex and a pulse.
 * @param {Patient} p
 */
export function pacing(p) {
  const on = !!p.paceOn && !p.off?.pads;
  return { on, capture: on && p.paceMa >= p.paceThreshold && !NO_CAPTURE_RHYTHMS.includes(p.rhythm) };
}

/**
 * @param {Patient} p
 * @returns {boolean} true when the rhythm gives no pulse (pleth and ABP go flat); captured pacing gives one
 */
export function pulseless(p) {
  if (pacing(p).capture) return false;
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
    hr: off.ecg ? null : pacedHr(p, d.hr),
    spo2: off.spo2 || flat ? null : d.spo2,
    etco2: off.etco2 ? null : d.etco2,
    rr: off.etco2 ? null : d.rr,
    temp: d.temp,
    nibp: off.nibp ? null : d.nibp,
    abp: off.abp || flat ? null : d.abp,
    cvp: off.cvp ? null : d.cvp,
    bis: off.bis ? null : d.bis,
    abp2: off.abp2 || flat ? null : d.abp2,
    // gas line: the agent reads blank while no agent is in use
    fio2: off.gas ? null : d.fio2,
    eto2: off.gas ? null : d.eto2,
    fiag: off.gas || p.agent === 'none' || !p.agent ? null : d.fiag,
    etag: off.gas || p.agent === 'none' || !p.agent ? null : d.etag,
    fin2o: off.gas ? null : d.fin2o,
    etn2o: off.gas ? null : d.etn2o,
  };
}

/**
 * The heart rate a captured pacer gives: the pacing rate when the patient's own rate is slower (or absent), else the
 * patient's own.
 * @param {Patient} p @param {number} hr
 */
function pacedHr(p, hr) {
  if (!pacing(p).capture) return hr;
  return !(hr > 0) || hr < p.paceRate ? p.paceRate : hr;
}

// @ts-check
// Record a scenario (sim-train S2): while on, every change the phone sends for one bed becomes a step with its own glide
// times and the real gap since the previous one (rounded to 5 s). Pure: no DOM, no timers; the caller passes the clock.
import { MAX_STEPS, MAX_STEP_SEC, validateStep } from '../shared/scenario.js';

/** Seconds, rounded to the nearest 5 and kept inside a step's allowed range. @param {number} ms */
export const gapSec = (ms) => Math.min(MAX_STEP_SEC, Math.max(0, Math.round(ms / 5000) * 5));

export class Recorder {
  /**
   * @param {string} bed patient id being recorded
   * @param {number} now ms
   */
  constructor(bed, now) {
    this.bed = bed;
    this.last = now;
    /** @type {import('../shared/scenario.js').ScenarioStep[]} */
    this.steps = [];
    /** changes that could not become a step (more than the step limit, or not allowed in a step) */
    this.skipped = 0;
  }

  /**
   * Note one change sent to the room. Only the `patient` and `alarms` parts of the patch can be a step.
   * @param {Record<string, any>} patch what `act` sent
   * @param {string} p bed it was sent to
   * @param {number} now ms
   * @param {number} [glideMs] one glide time for the change (absent: instant)
   * @param {Record<string, number>} [glideMsBy] glide time per field, where it differs
   * @returns {boolean} whether it became a step
   */
  add(patch, p, now, glideMs, glideMsBy) {
    if (p !== this.bed) return false;
    /** @type {Record<string, any>} */
    const keep = {};
    if (patch.patient && Object.keys(patch.patient).length) keep.patient = patch.patient;
    if (patch.alarms && Object.keys(patch.alarms).length) keep.alarms = patch.alarms;
    if (!Object.keys(keep).length) return false;
    const v = validateStep({
      atSec: gapSec(now - this.last), patch: keep, glideMs: glideMs ?? 0,
      ...(glideMsBy && Object.keys(glideMsBy).length ? { glideMsBy } : {}),
    }, 'recorded step');
    if (!v.ok || this.steps.length >= MAX_STEPS) { this.skipped++; return false; }
    this.steps.push(v.step);
    this.last = now;
    return true;
  }
}

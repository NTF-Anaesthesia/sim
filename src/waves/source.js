// @ts-check
// Wave source: owns the beat and breath schedulers for the patient on screen and keeps them ahead of the display clock.
// Waves, the QRS beep and any later consumer read `beats` and `breaths`. No DOM, no timers.
import { BeatScheduler } from '../engine/beats.js';
import { BreathScheduler } from '../engine/breaths.js';
import { pacing, pulseless } from '../engine/rhythm.js';

/** Events are made this far ahead of the display time (a P wave comes before its R wave). */
export const LOOKAHEAD = 0.6;

export class WaveSource {
  /** @param {number} [seed] */
  constructor(seed = 1) {
    this.beatSched = new BeatScheduler(seed);
    this.breathSched = new BreathScheduler(seed + 6);
    /** @type {Record<string, number>} display time each flush test began, by line (abp, abp2) */
    this.flush = {};
    /** @type {number | undefined} display time of the latest shock (defib artefact), if any */
    this.shock = undefined;
  }

  get beats() { return this.beatSched.beats; }
  get breaths() { return this.breathSched.breaths; }
  get base() { return this.beatSched.base; }
  get atrial() { return this.beatSched.atrial; }

  /**
   * @param {number} tSec display time
   * @param {import('../shared/schema.js').Patient} p
   * @param {import('../shared/schema.js').Numerics} d glided values (before blanking)
   * @returns {import('../engine/beats.js').Beat[]} beats added this call
   */
  update(tSec, p, d) {
    this.breathSched.advance(tSec + LOOKAHEAD, { rr: d.rr, ie: p.ie, etco2: d.etco2, shape: p.etco2Shape });
    const pc = pacing(p);
    return this.beatSched.advance(tSec + LOOKAHEAD, {
      pace: pc.on ? { rate: p.paceRate, capture: pc.capture, fixed: p.paceMode === 'fixed' || !!p.paceNoSense } : null,
      rhythm: p.rhythm, hr: d.hr, flutterRatio: p.flutterRatio, pvcPerMin: p.pvcPerMin, st: p.st,
      pulse: !pulseless(p), sbp: d.abp.sys, dbp: d.abp.dia, sbp2: d.abp2?.sys, dbp2: d.abp2?.dia, rr: d.rr,
    });
  }
}

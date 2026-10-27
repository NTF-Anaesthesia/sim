// @ts-check
// NIBP state machine (plan seam 5): phases idle -> inflating -> measuring -> result | failed. The server only holds the
// last reading (`nibpRead`); the monitor plays the phases locally when it sees a new reading. Durations default to 0,
// which skips straight to the result (V1). Pure.

/** @typedef {'idle' | 'inflating' | 'measuring' | 'result' | 'failed'} Phase */

export class NibpMachine {
  /** @param {{ inflateMs?: number, measureMs?: number }} [opts] */
  constructor(opts = {}) {
    this.inflateMs = opts.inflateMs ?? 0;
    this.measureMs = opts.measureMs ?? 0;
    /** @type {number | null} */
    this.seenAt = null;
    this.startedAt = 0;
    /** @type {{ sys: number, dia: number, at: number } | null} */
    this.reading = null;
    this.failed = false;
  }

  /**
   * Feed the latest server reading and the cuff flag; returns the phase to show.
   * @param {{ sys: number, dia: number, at: number }} reading
   * @param {boolean} cuffOff
   * @param {number} nowMs server ms
   * @returns {{ phase: Phase, sys: number | null, dia: number | null, at: number, progress: number, cuff: number | null }}
   */
  tick(reading, cuffOff, nowMs) {
    if (this.seenAt === null) {
      this.seenAt = reading.at;
      this.reading = reading;
      this.startedAt = reading.at - this.inflateMs - this.measureMs; // an existing reading is already a result
    } else if (reading.at !== this.seenAt) {
      this.seenAt = reading.at;
      this.reading = reading;
      this.startedAt = nowMs;
    }
    this.failed = cuffOff; // follows the cuff: back on, the last reading shows again
    const r = this.reading ?? reading;
    const e = nowMs - this.startedAt;
    if (this.failed) return { phase: 'failed', sys: null, dia: null, at: r.at, progress: 1, cuff: null };
    if (e < this.inflateMs) {
      const progress = e / this.inflateMs;
      return { phase: 'inflating', sys: null, dia: null, at: r.at, progress, cuff: cuffPressure(r, 'inflating', progress) };
    }
    if (e < this.inflateMs + this.measureMs) {
      const progress = (e - this.inflateMs) / this.measureMs;
      return { phase: 'measuring', sys: null, dia: null, at: r.at, progress, cuff: cuffPressure(r, 'measuring', progress) };
    }
    return { phase: 'result', sys: r.sys, dia: r.dia, at: r.at, progress: 1, cuff: null };
  }
}

/** mmHg per deflation step, like an oscillometric cuff bleeding down in steps. */
export const DEFLATE_STEP = 8;

/**
 * Cuff pressure shown while measuring: pumps up to about 30 above systolic (at least 160), then bleeds down in
 * `DEFLATE_STEP` steps to just below diastolic. Pure.
 * @param {{ sys: number, dia: number }} r the reading being taken
 * @param {'inflating' | 'measuring'} phase
 * @param {number} progress 0-1 through the phase
 */
export function cuffPressure(r, phase, progress) {
  const top = Math.max(160, Math.ceil((r.sys + 30) / 10) * 10);
  const p = Math.min(1, Math.max(0, progress));
  if (phase === 'inflating') return Math.round(top * Math.sqrt(p)); // fast at first, slowing as it fills
  const bottom = Math.max(10, r.dia - 10);
  const steps = Math.max(1, Math.ceil((top - bottom) / DEFLATE_STEP));
  return Math.max(bottom, top - Math.floor(p * steps) * DEFLATE_STEP);
}

/**
 * A real cuff never reads the same twice: add a small, roughly bell-shaped error (systolic within 4, diastolic within
 * 3 mmHg), keeping at least 10 mmHg between them. Pure given `rand`.
 * @param {number} sys @param {number} dia @param {() => number} [rand] 0-1
 */
export function nibpJitter(sys, dia, rand = Math.random) {
  const bell = () => (rand() + rand()) / 2 - 0.5; // -0.5..0.5, peaks at 0
  const s = Math.round(sys + bell() * 8);
  const d = Math.round(dia + bell() * 6);
  return { sys: Math.max(1, s), dia: Math.max(1, Math.min(d, s - 10)) };
}

/**
 * Mean arterial pressure shown in brackets.
 * @param {number} sys @param {number} dia
 */
export const mapOf = (sys, dia) => Math.round((sys + 2 * dia) / 3);

/**
 * In cycle mode, the monitor asks for the next reading when the interval has passed (DESIGN.md section 11).
 * @param {{ mode: string, cycleSec: number, at: number }} read
 * @param {number} nowMs server ms
 * @returns {number | null} the `after` value to send, or null when nothing is due
 */
export function nibpCycleDue(read, nowMs) {
  if (read.mode !== 'cycle' || !(read.cycleSec > 0)) return null;
  return nowMs >= read.at + read.cycleSec * 1000 ? read.at : null;
}

/**
 * "2 min ago" text for the reading age.
 * @param {number} ageMs
 */
export function ageText(ageMs) {
  const s = Math.max(0, Math.floor(ageMs / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)} h ${m % 60} min ago`;
}

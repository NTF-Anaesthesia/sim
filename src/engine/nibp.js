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
   * @returns {{ phase: Phase, sys: number | null, dia: number | null, at: number, progress: number }}
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
    if (this.failed) return { phase: 'failed', sys: null, dia: null, at: r.at, progress: 1 };
    if (e < this.inflateMs) return { phase: 'inflating', sys: null, dia: null, at: r.at, progress: e / this.inflateMs };
    if (e < this.inflateMs + this.measureMs) {
      return { phase: 'measuring', sys: null, dia: null, at: r.at, progress: (e - this.inflateMs) / this.measureMs };
    }
    return { phase: 'result', sys: r.sys, dia: r.dia, at: r.at, progress: 1 };
  }
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

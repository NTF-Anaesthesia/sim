// @ts-check
// Beat scheduler (plan "V2-ready rules" seam 1): one engine decides when every beat happens and what kind it is.
// ECG, pleth, arterial line and the QRS beep all read the events, so blocks, ectopy and pacing are new kinds, not new
// code in each drawer. Pure; times are seconds on the display clock. Rhythm and rate are read when the next beat is
// made, so a change takes effect at the next beat.
import { mulberry32 } from './rng.js';

/**
 * kind: normal | pvc | pac | paced | dropped (a P with no QRS) | mech (a pulse with no ECG complex, torsades)
 * @typedef {{
 *   t: number, kind: string, rr: number, pr: number | null, qrsWidth: number, amp: number, st: number,
 *   pulse: boolean, sbp: number, dbp: number
 * }} Beat
 * @typedef {{ type: string, since: number, atrialRate: number } | null} Base
 * @typedef {{
 *   rhythm: string, hr: number, flutterRatio: number, pvcPerMin: number, st: number, pulse: boolean,
 *   sbp: number, dbp: number, rr: number
 * }} BeatParams
 */

const NARROW = 0.09;
const WIDE = 0.16;

/**
 * Per rhythm: `clock` regular | irregular | none | mech; `pr` PR interval in seconds or null (no P wave); `wide` QRS;
 * `pvc` whether ectopics may be added; `label` text shown under HR when it is not plain sinus.
 */
export const RHYTHM_INFO = {
  sinus: { label: 'Sinus', clock: 'regular', pr: 0.16, wide: false, pvc: true },
  sinus_brady: { label: 'Sinus brady', clock: 'regular', pr: 0.17, wide: false, pvc: true },
  sinus_tachy: { label: 'Sinus tachy', clock: 'regular', pr: 0.14, wide: false, pvc: true },
  af: { label: 'AF', clock: 'irregular', pr: null, wide: false, pvc: true },
  flutter: { label: 'Flutter', clock: 'regular', pr: null, wide: false, pvc: true },
  svt: { label: 'SVT', clock: 'regular', pr: null, wide: false, pvc: false },
  vt: { label: 'VT', clock: 'regular', pr: null, wide: true, pvc: false },
  vf: { label: 'VF', clock: 'none', pr: null, wide: true, pvc: false },
  asystole: { label: 'Asystole', clock: 'none', pr: null, wide: false, pvc: false },
  pea: { label: 'PEA', clock: 'regular', pr: 0.16, wide: false, pvc: false },
  first_degree_block: { label: '1st degree block', clock: 'regular', pr: 0.34, wide: false, pvc: true },
  mobitz1: { label: 'Mobitz I', clock: 'regular', pr: 0.16, wide: false, pvc: false },
  mobitz2: { label: 'Mobitz II', clock: 'regular', pr: 0.2, wide: false, pvc: false },
  chb: { label: 'Complete block', clock: 'regular', pr: null, wide: true, pvc: false },
  torsades: { label: 'Torsades', clock: 'mech', pr: null, wide: true, pvc: false },
  paced: { label: 'Paced', clock: 'regular', pr: null, wide: true, pvc: false },
};

/** Wenckebach cycle: PR seconds for each conducted beat, then one dropped P. */
export const WENCKEBACH_PR = [0.16, 0.24, 0.32, 0.4];
/** Mobitz II: this many conducted beats, then one dropped. */
export const MOBITZ2_CONDUCTED = 2;
/** Atrial rate of the independent P waves in complete heart block. */
export const CHB_ATRIAL_RATE = 78;

/** @param {string} rhythm */
export function rhythmInfo(rhythm) {
  return /** @type {Record<string, typeof RHYTHM_INFO.sinus>} */ (RHYTHM_INFO)[rhythm] ?? RHYTHM_INFO.sinus;
}

export class BeatScheduler {
  /** @param {number} [seed] */
  constructor(seed = 1) {
    this.rand = mulberry32(seed);
    /** @type {Beat[]} */
    this.beats = [];
    /** @type {Base} */
    this.base = null;
    this.next = 0;
    this.rhythm = '';
    this.counter = 0;
    this.lastT = -1e9;
    this.anchor = -1e9;
    this.nominal = 1e9;
    /** @type {string} */
    this.baseType = '';
    this.baseSince = 0;
  }

  /** Respiratory sinus arrhythmia: the interval breathes a little with the respiratory rate. */
  /** @param {number} t @param {number} rr */
  rsa(t, rr) {
    const f = (rr > 0 ? rr : 12) / 60;
    return 1 + 0.025 * Math.sin(2 * Math.PI * f * t) + 0.01 * Math.sin(2 * Math.PI * 0.1 * t);
  }

  /**
   * Make beats up to display time `until` from the values now. Returns the beats added.
   * @param {number} until
   * @param {BeatParams} p
   * @returns {Beat[]}
   */
  advance(until, p) {
    /** @type {Beat[]} */
    const added = [];
    const info = rhythmInfo(p.rhythm);
    if (p.rhythm !== this.rhythm) {
      this.rhythm = p.rhythm;
      this.counter = 0;
    }
    const base = this.baseFor(p, until);
    this.base = base;
    const ok = Number.isFinite(p.hr) && p.hr > 0;
    if (info.clock === 'none' || !ok) {
      this.next = Math.max(this.next, until);
      return added;
    }
    const period = 60 / p.hr;
    // a clearly faster rate pulls the next beat in; a slower one waits for the beat already due
    if (period < this.nominal * 0.8) this.next = Math.min(this.next, this.anchor + period * 1.1);
    if (this.next < until - 2) this.next = until;
    while (this.next <= until) {
      const t = this.next;
      this.make(t, period, p, info, added);
    }
    if (this.beats.length > 500) this.beats.splice(0, this.beats.length - 400);
    return added;
  }

  /**
   * @param {number} t
   * @param {number} period
   * @param {BeatParams} p
   * @param {typeof RHYTHM_INFO.sinus} info
   * @param {Beat[]} added
   */
  make(t, period, p, info, added) {
    const push = (/** @type {Partial<Beat> & { t: number }} */ b) => {
      /** @type {Beat} */
      const beat = {
        kind: 'normal', rr: period, pr: info.pr, qrsWidth: info.wide ? WIDE : NARROW, amp: 1, st: p.st,
        pulse: p.pulse, sbp: p.sbp, dbp: p.dbp, ...b,
      };
      this.beats.push(beat);
      added.push(beat);
      this.lastT = Math.max(this.lastT, beat.t);
    };
    let step = period;
    this.anchor = t;
    this.nominal = period;
    switch (p.rhythm) {
      case 'af':
        step = period * (0.72 + 0.56 * this.rand());
        push({ t, rr: step, amp: 0.85 });
        break;
      case 'mobitz1': {
        const i = this.counter++ % WENCKEBACH_PR.length;
        const dropped = i === WENCKEBACH_PR.length - 1;
        push({ t, pr: WENCKEBACH_PR[i], kind: dropped ? 'dropped' : 'normal', pulse: p.pulse && !dropped });
        break;
      }
      case 'mobitz2': {
        const dropped = this.counter++ % (MOBITZ2_CONDUCTED + 1) === MOBITZ2_CONDUCTED;
        push({ t, kind: dropped ? 'dropped' : 'normal', pulse: p.pulse && !dropped });
        break;
      }
      case 'torsades':
        push({ t, kind: 'mech', amp: 0.5 });
        break;
      case 'paced':
        push({ t, kind: 'paced', qrsWidth: WIDE });
        break;
      case 'vt':
        push({ t, amp: 0.8 });
        break;
      case 'chb':
        push({ t, amp: 0.8 });
        break;
      default: {
        step = period * (info.clock === 'regular' && info.pvc ? this.rsa(t, p.rr) : 1);
        push({ t, rr: step });
        if (info.pvc && p.pvcPerMin > 0 && this.rand() < p.pvcPerMin / p.hr) {
          // an early wide beat with a full compensatory pause
          push({ t: t + 0.62 * step, kind: 'pvc', pr: null, qrsWidth: WIDE, amp: 0.55, rr: 0.62 * step });
          step *= 2;
        }
      }
    }
    this.next = t + step;
  }

  /**
   * The continuous baseline under the beats (fibrillation, flutter waves, independent P waves).
   * @param {BeatParams} p
   * @param {number} now
   * @returns {Base}
   */
  baseFor(p, now) {
    /** @type {string} */
    let type = '';
    let atrialRate = 0;
    switch (p.rhythm) {
      case 'af': type = 'af'; break;
      case 'flutter':
        type = 'flutter';
        atrialRate = Math.min(400, Math.max(200, p.hr * (p.flutterRatio || 2)));
        break;
      case 'vf': type = 'vf'; break;
      case 'asystole': type = 'asystole'; break;
      case 'torsades': type = 'torsades'; break;
      case 'chb': type = 'pwave'; atrialRate = CHB_ATRIAL_RATE; break;
      default: type = '';
    }
    if (type !== this.baseType) {
      this.baseType = type;
      this.baseSince = now;
    }
    return type ? { type, since: this.baseSince, atrialRate } : null;
  }
}

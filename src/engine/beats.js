// @ts-check
// Beat scheduler (plan "V2-ready rules" seam 1): one engine decides when every beat happens and what kind it is.
// ECG, pleth, arterial line and the QRS beep all read the events, so blocks, ectopy and pacing are new kinds, not new
// code in each drawer. Pure; times are seconds on the display clock. Rhythm and rate are read when the next beat is
// made, so a change takes effect at the next beat.
import { mulberry32 } from './rng.js';

/**
 * kind: normal | pvc | pac | paced (pacing spike then a wide complex: captured) | spike (a pacing stimulus with no
 * response: no complex, no pulse) | dropped (a P with no QRS) | mech (a pulse with no ECG complex, torsades)
 * `inv`: the P wave is retrograde (junctional), drawn inverted after the QRS.
 * @typedef {{
 *   t: number, kind: string, rr: number, pr: number | null, qrsWidth: number, amp: number, st: number,
 *   pulse: boolean, sbp: number, dbp: number, sbp2: number, dbp2: number, inv?: boolean
 * }} Beat
 * @typedef {{ type: string, since: number, atrialRate: number } | null} Base
 * @typedef {{ rate: number } | null} Atrial atrial activity that runs on its own clock (AV dissociation), per minute
 * @typedef {{ rate: number, capture: boolean, fixed: boolean }} PaceParams pacer on; per minute; stimulus at or above
 *   the capture threshold; `fixed` = fires at the rate whether or not it senses a beat (fixed mode, or demand that fails to sense)
 * @typedef {{
 *   rhythm: string, hr: number, flutterRatio: number, pvcPerMin: number, st: number, pulse: boolean,
 *   sbp: number, dbp: number, rr: number, sbp2?: number, dbp2?: number, pace?: PaceParams | null
 * }} BeatParams
 */

const NARROW = 0.09;
const WIDE = 0.16;
/** Heart muscle does not answer a pacing spike this soon after a complex, seconds. */
const REFRACTORY = 0.3;

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
  junctional: { label: 'Junctional', clock: 'regular', pr: null, wide: false, pvc: true },
  bigeminy: { label: 'Bigeminy', clock: 'regular', pr: 0.16, wide: false, pvc: false },
  trigeminy: { label: 'Trigeminy', clock: 'regular', pr: 0.16, wide: false, pvc: false },
};
/** Where the early beat of a bigeminy / trigeminy comes, as a share of the beat interval. */
const COUPLING = 0.62;

/** Wenckebach cycle: PR seconds for each conducted beat, then one dropped P. */
export const WENCKEBACH_PR = [0.16, 0.24, 0.32, 0.4];
/** Mobitz II: this many conducted beats, then one dropped. */
export const MOBITZ2_CONDUCTED = 2;
/** Atrial rate of the independent P waves in complete heart block. */
export const CHB_ATRIAL_RATE = 78;

/** @param {string} rhythm */
export function rhythmInfo(rhythm) {
  return /** @type {Record<string, typeof RHYTHM_INFO.sinus>} */ (/** @type {unknown} */ (RHYTHM_INFO))[rhythm] ?? RHYTHM_INFO.sinus;
}

export class BeatScheduler {
  /** @param {number} [seed] */
  constructor(seed = 1) {
    this.rand = mulberry32(seed);
    /** @type {Beat[]} */
    this.beats = [];
    /** @type {Base} */
    this.base = null;
    /** @type {Atrial} */
    this.atrial = null;
    this.next = 0;
    this.rhythm = '';
    this.counter = 0;
    this.lastT = -1e9;
    this.anchor = -1e9;
    this.nominal = 1e9;
    /** @type {string} */
    this.baseType = '';
    this.baseSince = 0;
    /** pacer: time of its last stimulus and of the last complex of any origin (seconds) */
    this.lastSpike = -1e9;
    this.lastQrs = -1e9;
    this.lastPaced = -1e9;
    this.pacing = false;
  }

  /** Insert keeping the list sorted by time (an early beat can be made before a later one is). @param {Beat} beat */
  insert(beat) {
    let i = this.beats.length;
    while (i > 0 && this.beats[i - 1].t > beat.t) i--;
    this.beats.splice(i, 0, beat);
    this.lastT = Math.max(this.lastT, beat.t);
    if (beat.kind !== 'spike' && beat.kind !== 'dropped') this.lastQrs = Math.max(this.lastQrs, beat.t);
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
    this.atrial = p.rhythm === 'chb' || p.rhythm === 'vt' ? { rate: CHB_ATRIAL_RATE } : null;
    const ok = Number.isFinite(p.hr) && p.hr > 0;
    const intrinsic = info.clock !== 'none' && ok;
    const pace = p.pace ?? null;
    if (!pace) this.pacing = false;
    else if (!this.pacing) { this.pacing = true; this.lastSpike = Math.max(this.lastSpike, this.lastQrs); }
    const period = ok ? 60 / p.hr : 0;
    if (intrinsic) {
      // a clearly faster rate pulls the next beat in; a slower one waits for the beat already due
      if (period < this.nominal * 0.8) this.next = Math.min(this.next, this.anchor + period * 1.1);
      if (this.next < until - 2) this.next = until;
    } else this.next = Math.max(this.next, until);
    for (;;) {
      const ti = intrinsic ? this.next : Infinity;
      const tp = pace ? this.spikeDue(pace, until) : Infinity;
      if (Math.min(ti, tp) > until) break;
      if (ti <= tp) {
        if (pace && ti - this.lastPaced < REFRACTORY) this.next = ti + period; // lands in the refractory period of a paced beat
        else this.make(ti, period, p, info, added);
      } else if (pace) this.spike(tp, period, p, pace, intrinsic, added);
    }
    if (this.beats.length > 500) this.beats.splice(0, this.beats.length - 400);
    return added;
  }

  /**
   * When the pacer fires next. Demand mode times from the last complex it saw (or its own last stimulus when that
   * did not capture); fixed mode, and demand with failure to sense, time from its own last stimulus only.
   * @param {PaceParams} pace @param {number} until
   */
  spikeDue(pace, until) {
    const ref = pace.fixed ? this.lastSpike : Math.max(this.lastSpike, this.lastQrs);
    const due = ref + 60 / pace.rate;
    return due < until - 2 ? until : Math.max(due, this.lastT + 0.02);
  }

  /**
   * One pacing stimulus: always a spike; a wide complex with a pulse when it captures and the muscle is not refractory.
   * @param {number} t @param {number} period intrinsic interval (0 = none) @param {BeatParams} p
   * @param {PaceParams} pace @param {boolean} intrinsic @param {Beat[]} added
   */
  spike(t, period, p, pace, intrinsic, added) {
    this.lastSpike = t;
    const captured = pace.capture && t - this.lastQrs >= REFRACTORY;
    /** @type {Beat} */
    const beat = {
      t, kind: captured ? 'paced' : 'spike', rr: 60 / pace.rate, pr: null, qrsWidth: WIDE, amp: 1, st: p.st,
      pulse: captured, sbp: p.sbp, dbp: p.dbp, sbp2: p.sbp2 ?? p.sbp, dbp2: p.dbp2 ?? p.dbp,
    };
    this.insert(beat);
    added.push(beat);
    if (captured) this.lastPaced = t;
    // a captured beat resets the heart's own clock when the pacer is the faster one
    if (captured && intrinsic && 60 / pace.rate < period) this.next = t + period;
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
        pulse: p.pulse, sbp: p.sbp, dbp: p.dbp, sbp2: p.sbp2 ?? p.sbp, dbp2: p.dbp2 ?? p.dbp, ...b,
      };
      this.insert(beat);
      added.push(beat);
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
      case 'junctional':
        step = period * this.rsa(t, p.rr);
        push({ t, rr: step, inv: true });
        if (p.pvcPerMin > 0 && this.rand() < p.pvcPerMin / p.hr) {
          push({ t: t + COUPLING * step, kind: 'pvc', pr: null, qrsWidth: WIDE, amp: 0.55, rr: COUPLING * step });
          step *= 2;
        }
        break;
      case 'bigeminy':
      case 'trigeminy': {
        // every 2nd / 3rd beat is an early wide one, followed by a pause, so the average rate stays `hr`
        const n = p.rhythm === 'bigeminy' ? 2 : 3;
        for (let k = 0; k < n - 1; k++) push({ t: t + k * period, rr: period });
        push({ t: t + (n - 2 + COUPLING) * period, kind: 'pvc', pr: null, qrsWidth: WIDE, amp: 0.55, rr: COUPLING * period });
        step = n * period;
        break;
      }
      case 'chb':
        push({ t, amp: 0.8 });
        break;
      default: {
        step = period * (info.clock === 'regular' && info.pvc ? this.rsa(t, p.rr) : 1);
        push({ t, rr: step });
        if (info.pvc && p.pvcPerMin > 0 && this.rand() < p.pvcPerMin / p.hr) {
          // an early wide beat with a full compensatory pause
          push({ t: t + COUPLING * step, kind: 'pvc', pr: null, qrsWidth: WIDE, amp: 0.55, rr: COUPLING * step });
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

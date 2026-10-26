// @ts-check
// Breath scheduler (plan "V2-ready rules" seam 3): one place that decides when breaths happen. The capnogram reads the
// events; later a pulse-pressure swing or ventilator waves can read them too. Pure; times are seconds on the display clock.
import { mulberry32 } from './rng.js';

/**
 * @typedef {{ fio2: number, eto2: number, fiag: number, etag: number }} BreathGas inspired and expired O2 and agent, % (gas waves)
 * @typedef {{ t: number, cycle: number, ti: number, etco2: number, shape: string, gas?: BreathGas }} Breath
 * @typedef {{ rr: number, ie: number, etco2: number, shape: string, gas?: BreathGas }} BreathParams
 */

export class BreathScheduler {
  /** @param {number} [seed] */
  constructor(seed = 7) {
    this.rand = mulberry32(seed);
    /** @type {Breath[]} */
    this.breaths = [];
    this.next = 0;
  }

  /**
   * Make breaths up to display time `until`, from the values now (a change takes effect at the next breath).
   * @param {number} until
   * @param {BreathParams} p
   * @returns {Breath[]} the breaths added
   */
  advance(until, p) {
    /** @type {Breath[]} */
    const added = [];
    if (!(p.rr > 0) || !(p.etco2 > 0) || p.shape === 'none') {
      this.next = Math.max(this.next, until);
      return added;
    }
    // a faster rate pulls the next breath in so the screen follows RR changes within a breath or two
    const last = this.breaths[this.breaths.length - 1];
    if (last) this.next = Math.min(this.next, last.t + 60 / p.rr * 1.1);
    if (this.next < until - 5) this.next = until; // woke from a long pause
    while (this.next <= until) {
      const cycle = 60 / p.rr * (1 + 0.03 * (this.rand() - 0.5));
      const ti = Math.max(0.3, cycle / (1 + Math.max(0.2, p.ie)));
      const b = { t: this.next, cycle, ti, etco2: p.etco2, shape: p.shape, gas: p.gas ? { ...p.gas } : undefined };
      this.breaths.push(b);
      added.push(b);
      this.next += cycle;
    }
    if (this.breaths.length > 80) this.breaths.splice(0, this.breaths.length - 60);
    return added;
  }
}

// @ts-check
// Defib screen logic with no DOM: energy steps, the charge / ready / disarm timing and the sync wait. The view
// (index.js) calls `tick(nowMs)` every frame and reads `phase`; nothing here uses timers, so it is easy to test.

/** Energy choices in joules (generic biphasic steps; any whole 1-360 is valid for the room). */
export const ENERGY_STEPS = [1, 2, 3, 5, 7, 10, 15, 20, 30, 50, 70, 100, 120, 150, 170, 200, 300, 360];
export const DEFAULT_ENERGY = 150;
/** Time to charge, ms. */
export const CHARGE_MS = 2500;
/** A charged defibrillator disarms itself after this long, ms. */
export const DISARM_MS = 30000;
/** With sync on, the shock waits at most this long for an R wave, ms. */
export const SYNC_WAIT_MS = 2500;

/** @typedef {'idle' | 'charging' | 'ready'} Phase */

export class DefibModel {
  /** @param {{ chargeMs?: number, disarmMs?: number, syncWaitMs?: number }} [o] */
  constructor(o = {}) {
    this.chargeMs = o.chargeMs ?? CHARGE_MS;
    this.disarmMs = o.disarmMs ?? DISARM_MS;
    this.syncWaitMs = o.syncWaitMs ?? SYNC_WAIT_MS;
    this.energy = DEFAULT_ENERGY;
    this.sync = false;
    /** @type {Phase} */
    this.phase = 'idle';
    this.chargeStart = 0;
    this.readyAt = 0;
    /** ms the shock button was pressed with sync on and no R wave has come yet; 0 = not waiting */
    this.waitingSince = 0;
    this.msg = '';
  }

  /** @param {number} dir +1 or -1: the next energy step */
  step(dir) {
    let i = ENERGY_STEPS.indexOf(this.energy);
    if (i < 0) i = ENERGY_STEPS.reduce((best, x, k) => (Math.abs(x - this.energy) < Math.abs(ENERGY_STEPS[best] - this.energy) ? k : best), 0);
    const next = Math.max(0, Math.min(ENERGY_STEPS.length - 1, i + dir));
    if (ENERGY_STEPS[next] === this.energy) return;
    this.energy = ENERGY_STEPS[next];
    if (this.phase !== 'idle') this.disarm('Energy changed: charge again');
  }

  /** @param {number} now */
  charge(now) {
    if (this.phase !== 'idle') return;
    this.phase = 'charging';
    this.chargeStart = now;
    this.msg = 'Charging';
  }

  /** @param {string} [why] */
  disarm(why = '') {
    this.phase = 'idle';
    this.waitingSince = 0;
    this.msg = why;
  }

  /** @param {boolean} on */
  setSync(on) { this.sync = on; if (!on) this.waitingSince = 0; }

  /**
   * The shock button. Returns `'send'` when the shock should go to the room now (the caller sends it and calls
   * `delivered`), `'wait'` when it waits for an R wave, or `'no'` (with `msg` saying why).
   * @param {number} now @param {boolean} padsOff
   * @returns {'send' | 'wait' | 'no'}
   */
  press(now, padsOff) {
    if (this.phase !== 'ready') { this.msg = this.phase === 'charging' ? 'Still charging' : 'Charge first'; return 'no'; }
    if (padsOff) { this.msg = 'Pads off: no shock delivered'; return 'no'; }
    if (this.sync) { this.waitingSince = now; this.msg = 'Sync: waiting for an R wave'; return 'wait'; }
    return 'send';
  }

  /** The shock went out: the capacitor is spent. */
  delivered() {
    this.phase = 'idle';
    this.waitingSince = 0;
    this.msg = '';
  }

  /**
   * @param {number} now ms
   * @param {boolean} rWaveSeen an R wave has come since the shock button was pressed
   * @returns {'send' | null} `'send'` when a waiting sync shock should go now
   */
  tick(now, rWaveSeen) {
    if (this.phase === 'charging' && now - this.chargeStart >= this.chargeMs) {
      this.phase = 'ready';
      this.readyAt = now;
      this.msg = 'Ready: press SHOCK';
    } else if (this.phase === 'ready') {
      if (this.waitingSince) {
        if (rWaveSeen) return 'send';
        if (now - this.waitingSince >= this.syncWaitMs) { this.waitingSince = 0; this.readyAt = now; this.msg = 'No R wave to sync to: shock not delivered'; }
      } else if (now - this.readyAt >= this.disarmMs) this.disarm('Disarmed (timed out)');
    }
    return null;
  }

  /** 0..1 charge progress for the bar. @param {number} now */
  progress(now) {
    if (this.phase === 'ready') return 1;
    if (this.phase === 'charging') return Math.min(1, (now - this.chargeStart) / this.chargeMs);
    return 0;
  }
}

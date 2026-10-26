// @ts-check
// Wave generator registry (plan seam 2): every wave on the monitor is a registered module with one interface, so a new
// wave (CVP, PAP, trends) is a new registration, not a change to the drawing code. A registry is made per monitor;
// nothing registers itself on import.

/**
 * @typedef {{
 *   patient: import('../shared/schema.js').Patient, perfusing: boolean, tSec: number
 * }} WaveCtx per-frame facts a generator may read
 * @typedef {{
 *   id: string,
 *   sample: (src: import('./shapes.js').WaveSrc, t: number, ctx: WaveCtx) => number | null,
 *   range: (gain: number) => [number, number],
 *   blank: (ctx: WaveCtx) => boolean,
 * }} WaveDef `sample` returns the value at display time t (null = leave a gap); `range` is the value range the lane
 *   shows at a given gain; `blank` is true when the sensor is off or the shape is "none" (nothing is drawn)
 */

export function createWaveRegistry() {
  /** @type {Map<string, WaveDef>} */
  const defs = new Map();
  return {
    /** @param {WaveDef} def */
    register(def) { defs.set(def.id, def); },
    /** @param {string} id */
    get(id) { return defs.get(id); },
    ids() { return [...defs.keys()]; },
  };
}

/** @typedef {ReturnType<typeof createWaveRegistry>} WaveRegistry */

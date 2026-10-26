// @ts-check
// Raw EEG strip for the BIS module. Pure and deterministic in the display time `t` (seconds), so two monitors show
// the same trace. The mix of bands follows the depth number: fast low-amplitude activity when awake, alpha and theta
// when lightly anaesthetised, large slow waves when deep, and bursts between quiet stretches when the suppression
// ratio is above zero. A teaching picture, not a recording.

const TAU = 2 * Math.PI;
const clamp01 = (/** @type {number} */ x) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** Triangular bump: 1 at `c`, 0 at `c` +/- `w`. */
const bump = (/** @type {number} */ x, /** @type {number} */ c, /** @type {number} */ w) => clamp01(1 - Math.abs(x - c) / w);

/** Components of each band: [frequency Hz, phase, slow wobble Hz]. Unrelated values keep the trace from repeating. */
const BANDS = {
  delta: [[0.9, 0.3, 0.05], [1.7, 2.1, 0.07], [2.6, 4.0, 0.04], [3.4, 5.2, 0.09]],
  theta: [[4.6, 1.1, 0.06], [5.8, 3.3, 0.08], [7.1, 0.6, 0.05]],
  alpha: [[8.4, 2.4, 0.07], [9.6, 4.4, 0.05], [11.2, 1.7, 0.09]],
  beta: [[14.3, 0.9, 0.11], [17.9, 3.7, 0.06], [21.4, 5.5, 0.08], [26.8, 2.8, 0.13], [31.3, 4.9, 0.1]],
};

/** @param {number} n @returns {number} -1..1, the same for the same whole number */
export function hashNoise(n) {
  let h = Math.imul(n | 0, 0x9e3779b1) ^ 0x85ebca6b;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

/** @param {number} t @param {number[][]} comps @param {number} amp */
function band(t, comps, amp) {
  if (amp <= 0) return 0;
  let s = 0;
  for (const [f, ph, wob] of comps) s += Math.sin(TAU * f * t + ph + 0.8 * Math.sin(TAU * wob * t + ph * 2));
  return (amp * s) / Math.sqrt(comps.length);
}

/** Length of one burst-and-quiet cycle, seconds. */
export const BURST_CYCLE = 6;
const QUIET_LEVEL = 0.03;

/**
 * 1 inside a burst, `QUIET_LEVEL` inside a quiet stretch, with short ramps between. Each fixed cycle ends with a quiet
 * stretch whose length is the suppression ratio's share of the cycle (varied a little so the rhythm is not a
 * metronome); a small ratio gives a brief pause, not a wide dip.
 * @param {number} t @param {number} sr suppression ratio 0-100 (percent of the time that is quiet)
 */
export function burstEnvelope(t, sr) {
  if (!(sr > 0)) return 1;
  if (sr >= 100) return QUIET_LEVEL;
  const n = Math.floor(t / BURST_CYCLE);
  const x = t - n * BURST_CYCLE;
  const jitter = 0.85 + 0.3 * (hashNoise(n * 7 + 3) * 0.5 + 0.5);
  const quietLen = Math.min(BURST_CYCLE - 0.3, (sr / 100) * BURST_CYCLE * jitter);
  const burstEnd = BURST_CYCLE - quietLen;
  const ramp = Math.min(0.12, quietLen / 3);
  const inside = clamp01(x / ramp) * clamp01((burstEnd - x) / ramp);
  return QUIET_LEVEL + (1 - QUIET_LEVEL) * inside;
}

/**
 * EEG voltage at display time `t`, about -1.4 to 1.4.
 * @param {number} t seconds
 * @param {{ bis: number, sr: number, emg: number, sqi: number }} q depth 0-100, suppression ratio %, muscle activity 0-100, signal quality 0-100
 */
export function eegSample(t, q) {
  const b = Math.min(100, Math.max(0, q.bis));
  const aBeta = 0.32 * clamp01((b - 55) / 35) + 0.06;
  const aAlpha = 0.55 * bump(b, 68, 26);
  const aTheta = 0.45 * bump(b, 52, 22);
  const aDelta = 0.95 * clamp01((72 - b) / 52);
  let v = band(t, BANDS.beta, aBeta) + band(t, BANDS.alpha, aAlpha) + band(t, BANDS.theta, aTheta) + band(t, BANDS.delta, aDelta);
  v *= burstEnvelope(t, q.sr);
  // muscle activity and poor contact add broadband noise on a fine time grid, so the line looks ragged
  const noise = 0.5 * clamp01(q.emg / 100) + 0.35 * clamp01(1 - q.sqi / 100);
  if (noise > 0) v += noise * hashNoise(Math.floor(t * 250));
  return Math.max(-1.4, Math.min(1.4, v));
}

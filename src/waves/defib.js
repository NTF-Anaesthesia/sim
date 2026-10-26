// @ts-check
// Shock artefact: when a defibrillator discharges, every screen of that bed shows a big deflection on the ECG that
// settles into a decaying wander, and the pleth is noisy for a moment. Pure, like shapes.js: `src.shock` is the display
// time (seconds) the shock happened, or undefined.

/** The artefact lasts this long, seconds. */
export const SHOCK_SHOW = 1.6;

/**
 * ECG while the shock artefact is showing, or null when there is none (draw the normal trace).
 * @param {{ shock?: number }} src @param {number} t
 * @returns {number | null}
 */
export function shockEcg(src, t) {
  const x = src.shock === undefined ? -1 : t - src.shock;
  if (x < 0 || x > SHOCK_SHOW) return null;
  if (x < 0.06) return x < 0.03 ? 2.2 : -2.2; // the discharge spike, clipped by the lane
  const decay = Math.exp(-(x - 0.06) / 0.5);
  return decay * (0.9 * Math.sin(2 * Math.PI * 1.3 * x) + 0.35 * Math.sin(2 * Math.PI * 23 * x + 1) + 0.4);
}

/**
 * Pleth while the shock artefact is showing: movement noise around the middle of the lane.
 * @param {{ shock?: number }} src @param {number} t
 * @returns {number | null}
 */
export function shockPleth(src, t) {
  const x = src.shock === undefined ? -1 : t - src.shock;
  if (x < 0 || x > SHOCK_SHOW) return null;
  const fade = Math.min(1, (SHOCK_SHOW - x) / 0.6);
  return 0.55 + fade * (0.4 * Math.sin(2 * Math.PI * 7 * x) + 0.25 * Math.sin(2 * Math.PI * 17 * x + 2));
}

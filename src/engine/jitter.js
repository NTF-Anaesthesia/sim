// @ts-check
// "Look alive": a small, smooth wobble around the glided value (sum of slow sines with unrelated periods). Pure, so
// two monitors showing the same moment agree. Never moves a value that is blank or zero.

/** Wobble size (half range) per numeric. */
export const JITTER_AMP = { hr: 1.4, spo2: 0.7, etco2: 0.9, rr: 0.5, sys: 2.2, dia: 1.6, temp: 0.03 };

/** @param {string} key @returns {number} a per-key phase so the numerics do not move together */
function phase(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 1000;
  return h / 1000 * 6.2832;
}

/**
 * @param {string} key numeric name (any string; sets the phase)
 * @param {number} tSec seconds on the shared clock
 * @returns {number} -1..1
 */
export function wobble(key, tSec) {
  const p = phase(key);
  return (0.55 * Math.sin(tSec / 2.9 + p) + 0.3 * Math.sin(tSec / 1.3 + 2 * p) + 0.15 * Math.sin(tSec / 5.7 + 3 * p)) / 1;
}

/**
 * @param {number | null} v glided value, or null when blank
 * @param {keyof typeof JITTER_AMP} kind
 * @param {string} key
 * @param {number} tSec
 * @param {{ max?: number }} [opts]
 * @returns {number | null}
 */
export function jittered(v, kind, key, tSec, opts = {}) {
  if (v === null || !(v > 0)) return v;
  const out = v + JITTER_AMP[kind] * wobble(key, tSec);
  return Math.max(0, Math.min(opts.max ?? Infinity, out));
}

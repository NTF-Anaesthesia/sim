// @ts-check
// Wave shapes from beat and breath events. Adapted from the NTF `ot` repo (ot/js/ui/synth.js: sums of bell curves for
// a lead II ECG, finger pleth and capnogram), reworked to read this repo's beat events; simple templates with no
// diagnostic detail. Pure: `src` is { beats, breaths, base } on the display clock (seconds).

const g = (/** @type {number} */ x, /** @type {number} */ c, /** @type {number} */ w) => Math.exp(-((x - c) * (x - c)) / (2 * w * w));
const sig = (/** @type {number} */ x) => 1 / (1 + Math.exp(-x));

/**
 * First index with arr[i].t > t (binary search).
 * @param {{ t: number }[]} arr @param {number} t
 */
export function upper(arr, t) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** @typedef {import('../engine/beats.js').Beat} Beat */
/** @typedef {import('../engine/beats.js').Base} Base */
/** @typedef {import('../engine/breaths.js').Breath} Breath */
/** @typedef {import('../engine/beats.js').Atrial} Atrial */
/** @typedef {{ beats: Beat[], breaths: Breath[], base: Base, atrial?: Atrial }} WaveSrc */

/** Longest time before a beat (PR) and after it (T wave) that can still touch a sample, seconds. */
export const BEAT_REACH = { before: 0.55, after: 0.6 };

/**
 * ECG lead II in mV around one beat (x seconds from its R peak).
 * @param {number} x @param {Beat} b
 */
export function ecgBeat(x, b) {
  if (b.kind === 'mech') return 0;
  const s = Math.sqrt(Math.min(1.5, Math.max(0.3, b.rr)));
  const wide = b.qrsWidth > 0.12;
  let v = 0;
  if (b.pr !== null) v += 0.12 * g(x, -b.pr, 0.022);
  if (b.kind === 'dropped') return v;
  if (wide) {
    v += -0.1 * g(x, -0.02, 0.02) + 0.95 * g(x, 0.012, 0.028) - 0.35 * g(x, 0.065, 0.03);
    v += -0.45 * g(x, 0.15 * s, 0.07 * s);
  } else {
    v += -0.08 * g(x, -0.028, 0.007) + 1.05 * g(x, 0, 0.0095) - 0.22 * g(x, 0.026, 0.009);
    v += 0.28 * g(x, 0.24 * s, 0.05 * s);
    // ST shift: 1 mm = 0.1 mV, a plateau between the QRS and the end of the T wave
    if (b.st) v += b.st * 0.1 * (sig((x - 0.03) / 0.012) - sig((x - 0.3 * s) / 0.03));
  }
  if (b.kind === 'paced') v += 1.1 * g(x, -0.02, 0.0025);
  return v;
}

/**
 * The continuous baseline for the disorganised rhythms and the independent P waves.
 * @param {NonNullable<Base>} base @param {number} t display seconds
 */
export function ecgBase(base, t) {
  const S = (/** @type {number} */ a, /** @type {number} */ hz, /** @type {number} */ ph = 0) => a * Math.sin(2 * Math.PI * hz * t + ph);
  switch (base.type) {
    case 'af': return S(0.04, 6.3) + S(0.025, 9.7, 1.1);
    case 'flutter': { const f = (t * base.atrialRate) / 60; return -0.16 * (2 * (f - Math.floor(f)) - 1); }
    case 'vf': {
      const env = 0.12 + 0.4 * Math.exp(-Math.max(0, t - base.since) / 240);
      return env * (Math.sin(2 * Math.PI * 4.3 * t) + 0.7 * Math.sin(2 * Math.PI * 6.9 * t + 0.7) + 0.5 * Math.sin(2 * Math.PI * 9.1 * t + 2));
    }
    case 'torsades': return 0.45 * Math.abs(Math.sin(2 * Math.PI * 0.3 * t)) * Math.sin(2 * Math.PI * 4 * t);
    case 'asystole': return 0.015 * Math.sin(0.5 * t) + 0.01 * Math.sin(0.13 * t);
    case 'pwave': {
      const f = (t * base.atrialRate) / 60;
      const frac = f - Math.floor(f);
      return 0.14 * g(frac < 0.5 ? frac : frac - 1, 0, 0.05);
    }
    default: return 0;
  }
}

/** @param {WaveSrc} src @param {number} t */
export function ecgSample(src, t) {
  let v = src.base ? ecgBase(src.base, t) : 0;
  const b = src.beats;
  const i = upper(b, t + BEAT_REACH.before);
  for (let k = Math.max(0, i - 5); k < i; k++) {
    if (t - b[k].t < BEAT_REACH.after) v += ecgBeat(t - b[k].t, b[k]);
  }
  return v;
}

/** Pulse reaches the finger about this long after the R wave. */
export const PLETH_DELAY = 0.25;
const plethBeat = (/** @type {number} */ x) => {
  if (x < 0) return 0;
  const up = x < 0.12 ? g(x, 0.12, 0.05) : Math.exp(-(x - 0.12) / 0.32);
  return up + 0.12 * g(x, 0.36, 0.04) * Math.exp(-x / 0.6);
};

/**
 * Pleth, 0..~1.3; flat 0 while there is no pulse. quality: good | poor (small, noisy).
 * @param {WaveSrc} src @param {number} t @param {string} quality
 */
export function plethSample(src, t, quality) {
  const b = src.beats;
  const i = upper(b, t - PLETH_DELAY);
  let v = 0;
  for (let k = Math.max(0, i - 4); k < i; k++) {
    if (!b[k].pulse) continue;
    const pp = Math.max(0, b[k].sbp - b[k].dbp);
    v += plethBeat(t - PLETH_DELAY - b[k].t) * Math.min(1.3, pp / 45) * b[k].amp;
  }
  if (quality === 'poor') {
    v = v * 0.35 + 0.05 * Math.sin(t * 37) + 0.04 * Math.sin(t * 61 + 1) + 0.03 * Math.sin(t * 17);
  }
  return v;
}

export const ABP_DELAY = 0.08;
/** The second line (femoral, say) is closer to the heart's timing than the first. */
export const ABP2_DELAY = 0.06;
/** ABP pulse shape 0..1 at x seconds after the R wave. damping: normal | over | under */
export function abpBeat(/** @type {number} */ x, /** @type {string} */ damping) {
  if (x < 0) return 0;
  const rise = damping === 'over' ? 0.2 : 0.13;
  if (x < rise) return Math.sin((x / rise) * Math.PI / 2);
  const e = Math.exp(-(x - rise) / 0.3);
  if (damping === 'over') return e;
  let v = e - 0.07 * g(x, 0.33, 0.012) + 0.09 * g(x, 0.38, 0.035);
  if (damping === 'under') v += 0.18 * Math.exp(-(x - rise) / 0.12) * Math.sin(2 * Math.PI * 13 * (x - rise));
  return v;
}

/**
 * Pulse-pressure factor for a beat at time `t` when the pressure swings with the breath (positive-pressure
 * ventilation): pulse pressure is largest in inspiration and smallest in expiration, and
 * (max - min) / mean of the two is `ppv` percent. 1 when there is no swing or no breath to follow.
 * @param {Breath[]} breaths @param {number} t @param {number} ppv percent
 */
export function ppvFactor(breaths, t, ppv) {
  if (!(ppv > 0)) return 1;
  const i = upper(breaths, t) - 1;
  const b = breaths[i];
  if (!b || t - b.t > b.cycle + 1) return 1;
  const m = Math.cos((2 * Math.PI * (t - b.t - b.ti / 2)) / b.cycle);
  return 1 + (ppv / 200) * m;
}

/**
 * Arterial pressure in mmHg; a flat low line while there is no pulse.
 * @param {WaveSrc} src @param {number} t @param {string} damping
 * @param {{ line?: 'abp' | 'abp2', ppv?: number }} [opts] `line` picks which pressure the beats carry; `ppv` the swing in %
 */
export function abpSample(src, t, damping, opts = {}) {
  const second = opts.line === 'abp2';
  const b = src.beats;
  const i = upper(b, t - (second ? ABP2_DELAY : ABP_DELAY));
  const last = b[i - 1];
  if (!last) return 8;
  const dia = (/** @type {Beat} */ x) => (second ? x.dbp2 ?? x.dbp : x.dbp);
  const sys = (/** @type {Beat} */ x) => (second ? x.sbp2 ?? x.sbp : x.sbp);
  let best = 0;
  let pulsed = false;
  for (let k = Math.max(0, i - 2); k < i; k++) {
    if (!b[k].pulse) continue;
    pulsed = true;
    const pp = (sys(b[k]) - dia(b[k])) * b[k].amp * (damping === 'over' ? 0.85 : 1) * ppvFactor(src.breaths, b[k].t, opts.ppv ?? 0);
    best = Math.max(best, abpBeat(t - (second ? ABP2_DELAY : ABP_DELAY) - b[k].t, damping) * pp);
  }
  if (!pulsed) return 8; // no pulse: a flat low line
  return dia(last) + best;
}

/**
 * Capnogram in mmHg. shape: normal | obstructive | curare | rebreathing | none
 * @param {WaveSrc} src @param {number} t
 */
export function capnoSample(src, t) {
  const br = src.breaths;
  const i = upper(br, t) - 1;
  if (i < 0) return 0;
  const b = br[i];
  if (b.shape === 'none') return 0;
  const x = t - b.t;
  const et = b.etco2;
  const base = b.shape === 'rebreathing' ? 0.18 * et : 0;
  if (x > b.cycle + 1) return base; // no new breath: flat
  if (x < b.ti) {
    const prev = br[i - 1] ?? b;
    return base + (prev.etco2 - base) * Math.exp(-x / 0.07);
  }
  const e = x - b.ti;
  const exp = Math.max(0.5, b.cycle - b.ti);
  const f = Math.min(1, e / exp);
  const obstructive = b.shape === 'obstructive';
  const up = sig((e - (obstructive ? 0.45 : 0.18)) / (obstructive ? 0.15 : 0.04));
  let plateau = obstructive ? 0.55 + 0.45 * f : 0.9 + 0.1 * f;
  if (b.shape === 'curare') plateau *= 1 - 0.35 * g(e, exp * 0.62, exp * 0.09);
  return base + (et - base) * up * plateau;
}

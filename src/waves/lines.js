// @ts-check
// Pressure-line extras: the CVP trace (a, c, v waves and the x and y descents) and the flush test of an arterial line.
// Pure, like shapes.js: `src` is { beats, breaths, base, atrial, flush } on the display clock (seconds).
import { abpSample, upper } from './shapes.js';

const g = (/** @type {number} */ x, /** @type {number} */ c, /** @type {number} */ w) => Math.exp(-((x - c) * (x - c)) / (2 * w * w));

/** How long the flush is held (the square wave), seconds. */
export const FLUSH_HOLD = 0.9;
/** The flush pressure; the lane clips it at the top. */
export const FLUSH_LEVEL = 300;
/** A flush trace is shown for this long, then the normal trace returns, seconds. */
export const FLUSH_SHOW = 3;

/**
 * Pressure during a flush test, `x` seconds after it began: a square wave, then the line settles back to `base`.
 * Normal damping rings 2-3 times, over-damped creeps back with no ring, under-damped rings many times.
 * @param {number} x @param {number} base mmHg @param {string} damping
 */
export function flushShape(x, base, damping) {
  if (x < 0) return base;
  if (x < 0.04) return base + ((FLUSH_LEVEL - base) * x) / 0.04;
  if (x < FLUSH_HOLD) return FLUSH_LEVEL;
  const k = x - FLUSH_HOLD;
  if (damping === 'over') return base + 70 * Math.exp(-k / 0.25);
  const f = damping === 'under' ? 13 : 18;
  const tau = damping === 'under' ? 0.45 : 0.07;
  const amp = damping === 'under' ? 55 : 45;
  return base - amp * Math.exp(-k / tau) * Math.sin(2 * Math.PI * f * k);
}

/**
 * Art line sample that shows the flush test when one is running for this line.
 * @param {import('./shapes.js').WaveSrc & { flush?: Record<string, number> }} src
 * @param {number} t @param {'abp' | 'abp2'} line @param {string} damping @param {number} ppv
 */
export function artLineSample(src, t, line, damping, ppv) {
  const start = src.flush?.[line];
  const x = start === undefined ? -1 : t - start;
  const normal = abpSample(src, t, damping, { line, ppv });
  if (x < 0 || x > FLUSH_SHOW) return normal;
  // the trace sits at the mean pressure between beats while the line is flushed
  const mean = flushBase(src, t, line);
  const v = flushShape(x, mean, damping);
  return x > FLUSH_HOLD + 1.2 ? normal : (x > FLUSH_HOLD + 0.8 ? v + (normal - v) * ((x - FLUSH_HOLD - 0.8) / 0.4) : v);
}

/** @param {import('./shapes.js').WaveSrc} src @param {number} t @param {string} line */
function flushBase(src, t, line) {
  const i = upper(src.beats, t) - 1;
  const b = src.beats[i];
  if (!b || !b.pulse) return 8;
  const second = line === 'abp2';
  const sys = second ? b.sbp2 ?? b.sbp : b.sbp;
  const dia = second ? b.dbp2 ?? b.dbp : b.dbp;
  return dia + (sys - dia) * 0.33;
}

/** Atrial waves are absent when there is no organised atrial contraction before the beat. */
const NO_A = new Set(['af', 'vf', 'asystole', 'torsades']);

/**
 * Central venous pressure in mmHg around a mean: a wave (atrial contraction, after the P), c (valve closes), x descent,
 * v (venous filling, peaks late in systole), y descent. No a wave without atrial contraction (AF, VF); cannon a waves when
 * the atria beat against a closed tricuspid valve (complete heart block, VT). `v` = 'giant' for tricuspid regurgitation.
 * @param {import('./shapes.js').WaveSrc} src @param {number} t @param {number} mean mmHg @param {string} vType
 * @param {number} [swing] mmHg of respiratory swing (positive: ventilated, rises in inspiration)
 */
export function cvpSample(src, t, mean, vType, swing = 1.5) {
  const giant = vType === 'giant';
  const noA = !!src.base && NO_A.has(src.base.type);
  let v = 0;
  const b = src.beats;
  const i = upper(b, t);
  for (let k = Math.max(0, i - 3); k < Math.min(b.length, i + 2); k++) {
    const bt = b[k].t;
    const x = t - bt;
    if (b[k].kind === 'dropped' || b[k].kind === 'mech') { if (!b[k].pulse) continue; }
    const amp = b[k].amp ?? 1;
    const hasA = !noA && b[k].pr !== null && b[k].kind !== 'pvc';
    if (hasA) v += 3.2 * g(x, -0.06, 0.035);
    v += 1 * g(x, 0.05, 0.025); // c
    v -= 2.2 * g(x, 0.14, 0.05); // x descent
    v += (giant ? 9 : 3.4) * amp * g(x, giant ? 0.22 : 0.3, giant ? 0.09 : 0.06); // v
    v -= 2 * g(x, 0.5, 0.07); // y descent
    if (giant) v -= 1 * g(x, 0.05, 0.03);
  }
  if (src.atrial) {
    const rate = src.atrial.rate;
    const f = (t * rate) / 60;
    const n = Math.round(f);
    const x = (f - n) * (60 / rate);
    const at = n * (60 / rate);
    // cannon when the beat is within 0.2 s after this atrial contraction (tricuspid shut)
    const j = upper(b, at) - 1;
    const cannon = (b[j + 1] && b[j + 1].t - at < 0.2 && b[j + 1].t - at > -0.05) || (b[j] && at - b[j].t < 0.2 && at - b[j].t >= -0.05);
    v += (cannon ? 9 : 3) * g(x, 0, 0.035);
  }
  // respiratory swing
  const bi = upper(src.breaths, t) - 1;
  const br = src.breaths[bi];
  if (br && t - br.t < br.cycle + 1) v += swing * Math.sin(Math.PI * Math.min(1, (t - br.t) / br.cycle)) ** 2 * (t - br.t < br.ti ? 1 : 0.6);
  return mean - 1.5 + v;
}

// @ts-check
// Controller parameter table: ranges, steps, unit conversion and patch building. Pure, no DOM, no timers.
// Messages and state always hold mmHg and C; units only change what the phone shows (DESIGN.md section 3).

/** @typedef {import('../shared/schema.js').Patient} Patient */
/** @typedef {{ co2: 'mmHg' | 'kPa', temp: 'C' | 'F' }} Units */

export const DEFAULT_UNITS = /** @type {Units} */ ({ co2: 'mmHg', temp: 'C' });
export const GLIDE_CHOICES = [
  { ms: 0, label: 'Instant' }, { ms: 10000, label: '10 s' }, { ms: 30000, label: '30 s' },
  { ms: 60000, label: '1 min' }, { ms: 120000, label: '2 min' },
];
/** NIBP interval choices in seconds (0 = manual only). */
export const NIBP_INTERVALS = [0, 60, 120, 180, 300, 600, 900, 1800];
const KPA = 0.133322;

/**
 * @typedef {{
 *   id: string, label: string, unit: string, min: number, max: number, step: number, dec: number, color: string,
 *   get: (p: Patient) => number, set: (v: number) => any, to: (v: number) => number, from: (d: number) => number
 * }} ParamSpec all numbers in the spec (min, max, step) are in display units; `get` and `set` use wire units
 */

/** @param {number} v @param {number} n */
const round = (v, n) => { const k = 10 ** n; return Math.round(v * k) / k; };

/**
 * @param {Units} units
 * @returns {ParamSpec[]}
 */
export function paramList(units) {
  const kpa = units.co2 === 'kPa';
  const f = units.temp === 'F';
  /** @type {ParamSpec[]} */
  const list = [
    { id: 'hr', label: 'HR', unit: 'bpm', min: 0, max: 250, step: 1, dec: 0, color: 'var(--ecg)',
      get: (p) => p.hr, set: (v) => ({ hr: v }), to: (v) => v, from: (d) => d },
    { id: 'spo2', label: 'SpO₂', unit: '%', min: 0, max: 100, step: 1, dec: 0, color: 'var(--spo2)',
      get: (p) => p.spo2, set: (v) => ({ spo2: v }), to: (v) => v, from: (d) => d },
    { id: 'nibpSys', label: 'NIBP sys', unit: 'mmHg', min: 0, max: 300, step: 1, dec: 0, color: 'var(--nibp)',
      get: (p) => p.nibp.sys, set: (v) => ({ nibp: { sys: v } }), to: (v) => v, from: (d) => d },
    { id: 'nibpDia', label: 'NIBP dia', unit: 'mmHg', min: 0, max: 250, step: 1, dec: 0, color: 'var(--nibp)',
      get: (p) => p.nibp.dia, set: (v) => ({ nibp: { dia: v } }), to: (v) => v, from: (d) => d },
    { id: 'abpSys', label: 'ABP sys', unit: 'mmHg', min: 0, max: 300, step: 1, dec: 0, color: 'var(--abp)',
      get: (p) => p.abp.sys, set: (v) => ({ abp: { sys: v } }), to: (v) => v, from: (d) => d },
    { id: 'abpDia', label: 'ABP dia', unit: 'mmHg', min: 0, max: 250, step: 1, dec: 0, color: 'var(--abp)',
      get: (p) => p.abp.dia, set: (v) => ({ abp: { dia: v } }), to: (v) => v, from: (d) => d },
    { id: 'rr', label: 'RR', unit: '/min', min: 0, max: 60, step: 1, dec: 0, color: 'var(--etco2)',
      get: (p) => p.rr, set: (v) => ({ rr: v }), to: (v) => v, from: (d) => d },
    kpa
      ? { id: 'etco2', label: 'EtCO₂', unit: 'kPa', min: 0, max: round(100 * KPA, 1), step: 0.1, dec: 1, color: 'var(--etco2)',
        get: (p) => p.etco2, set: (v) => ({ etco2: v }), to: (v) => round(v * KPA, 1), from: (d) => round(d / KPA, 1) }
      : { id: 'etco2', label: 'EtCO₂', unit: 'mmHg', min: 0, max: 100, step: 1, dec: 0, color: 'var(--etco2)',
        get: (p) => p.etco2, set: (v) => ({ etco2: v }), to: (v) => v, from: (d) => d },
    f
      ? { id: 'temp', label: 'Temp', unit: '°F', min: 77, max: 109.4, step: 0.1, dec: 1, color: 'var(--temp)',
        get: (p) => p.temp, set: (v) => ({ temp: v }), to: (v) => round(v * 1.8 + 32, 1), from: (d) => round((d - 32) / 1.8, 1) }
      : { id: 'temp', label: 'Temp', unit: '°C', min: 25, max: 43, step: 0.1, dec: 1, color: 'var(--temp)',
        get: (p) => p.temp, set: (v) => ({ temp: v }), to: (v) => v, from: (d) => d },
  ];
  return list;
}

/** Alarm limit parameters: limit name, label, which ParamSpec id gives units and step. */
export const LIMIT_PARAMS = [
  { name: 'hr', label: 'HR', spec: 'hr' },
  { name: 'spo2', label: 'SpO₂', spec: 'spo2' },
  { name: 'nibpSys', label: 'NIBP sys', spec: 'nibpSys' },
  { name: 'abpSys', label: 'ABP sys', spec: 'abpSys', needs: 'abp' },
  { name: 'rr', label: 'RR', spec: 'rr' },
  { name: 'etco2', label: 'EtCO₂', spec: 'etco2' },
  { name: 'temp', label: 'Temp', spec: 'temp' },
];

/**
 * Clamp a value (display units) into the spec's range and snap it to the step.
 * @param {ParamSpec} spec
 * @param {number} d
 */
export function clampDisplay(spec, d) {
  const v = Math.min(spec.max, Math.max(spec.min, d));
  return round(v, spec.dec);
}

/**
 * Move a display value by `delta`, and keep going in steps until the wire value really changes (a 0.1 F step can map
 * to the same 0.1 C value). Stops at the range ends.
 * @param {ParamSpec} spec
 * @param {number} d display value now
 * @param {number} delta display units, sign gives the direction
 */
export function moveDisplay(spec, d, delta) {
  const wire = spec.from(d);
  let next = clampDisplay(spec, d + delta);
  const dir = Math.sign(delta) || 1;
  for (let i = 0; i < 20 && spec.from(next) === wire && next > spec.min && next < spec.max; i++) {
    next = clampDisplay(spec, next + dir * spec.step);
  }
  return next;
}

/**
 * Move a value by a percentage (quick +/- buttons). Always moves at least one step so small numbers still change.
 * @param {ParamSpec} spec
 * @param {number} d value in display units
 * @param {number} pct for example 10 or -10
 */
export function stepPercent(spec, d, pct) {
  const raw = d * (1 + pct / 100);
  const minMove = spec.step * Math.sign(pct);
  return moveDisplay(spec, d, Math.abs(raw - d) < spec.step ? minMove : raw - d);
}

/**
 * @typedef {Record<string, number | string>} Pending edited values in wire units (`rhythm` is a string)
 */

/**
 * Build the `set` patch for the pending edits: only values that differ from the patient's current targets.
 * @param {Pending} pending
 * @param {Patient} patient
 * @param {Units} units
 * @returns {object | null} null when nothing differs
 */
export function buildPatch(pending, patient, units) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const spec of paramList(units)) {
    const v = pending[spec.id];
    if (typeof v !== 'number' || v === spec.get(patient)) continue;
    const part = spec.set(v);
    for (const k of Object.keys(part)) out[k] = typeof part[k] === 'object' ? { ...out[k], ...part[k] } : part[k];
  }
  if (typeof pending.rhythm === 'string' && pending.rhythm !== patient.rhythm) out.rhythm = pending.rhythm;
  return Object.keys(out).length ? { patient: out } : null;
}

/** @param {Pending} pending @param {Patient} patient @param {Units} units */
export function pendingCount(pending, patient, units) {
  const patch = /** @type {any} */ (buildPatch(pending, patient, units))?.patient;
  if (!patch) return 0;
  return Object.keys(patch).reduce((n, k) => n + (typeof patch[k] === 'object' ? Object.keys(patch[k]).length : 1), 0);
}

/**
 * Progress of a patient's current glide on the server clock.
 * @param {Patient} patient
 * @param {number} serverNow
 * @returns {{ active: boolean, u: number, leftMs: number }}
 */
export function glideProgress(patient, serverNow) {
  const { startedAt, durationMs } = patient.glide;
  if (!(durationMs > 0)) return { active: false, u: 1, leftMs: 0 };
  const u = Math.min(1, Math.max(0, (serverNow - startedAt) / durationMs));
  return { active: u < 1, u, leftMs: Math.max(0, startedAt + durationMs - serverNow) };
}

/**
 * Format a value for the phone.
 * @param {ParamSpec} spec @param {number} wire
 */
export function formatValue(spec, wire) {
  return spec.to(wire).toFixed(spec.dec);
}

/** @param {number} sec */
export function intervalLabel(sec) {
  if (!sec) return 'Manual';
  return sec < 60 ? `${sec} s` : `${sec / 60} min`;
}

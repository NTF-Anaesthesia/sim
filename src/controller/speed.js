// @ts-check
// Glide speeds on the phone: the choices, the custom time, SpO2's slower start, and the per-field times of one Apply.
// Pure functions (no DOM) so they are tested in node. The wire side is `glideMsBy` (DESIGN.md section 6).
import { GLIDE_FIELDS } from '../engine/glide.js';

/** Speeds offered everywhere a time is picked (ms). */
export const SPEEDS = [0, 5000, 10000, 30000, 60000, 120000, 180000, 300000];
export const MAX_SPEED_MS = 600000;
export const SPO2_MIN_MS = 30000;
/** SpO2 starts at this many times the chosen speed (the finger probe lags, so it moves slower than the rest). */
export const SPO2_FACTOR = 3;

/** @param {number} ms */
export function speedLabel(ms) {
  if (!(ms > 0)) return 'Instant';
  if (ms >= 60000 && ms % 60000 === 0) return `${ms / 60000} min`;
  const s = ms / 1000;
  return `${Number.isInteger(s) ? s : s.toFixed(1)} s`;
}

/** Custom time to ms, clamped to 0 to 10 min. @param {number} n @param {'s' | 'min'} unit */
export function customMs(n, unit) {
  if (!Number.isFinite(n)) return 0;
  return Math.min(MAX_SPEED_MS, Math.max(0, Math.round(n * (unit === 'min' ? 60000 : 1000))));
}

/** The number and unit a stored time shows as in the custom box. @param {number} ms @returns {{ n: number, unit: 's' | 'min' }} */
export function customParts(ms) {
  return ms >= 60000 && ms % 60000 === 0 ? { n: ms / 60000, unit: 'min' } : { n: Math.round(ms / 100) / 10, unit: 's' };
}

/** SpO2's starting speed for a chosen base speed: 3x, at least 30 s, at most 10 min; Instant stays instant. @param {number} base */
export const spo2Speed = (base) => (base > 0 ? Math.min(MAX_SPEED_MS, Math.max(SPO2_MIN_MS, base * SPO2_FACTOR)) : 0);

/**
 * The glide time of one field in a batch: the chip the user set, else the base speed (SpO2: slower).
 * @param {string} field
 * @param {number} base chosen speed in ms
 * @param {Record<string, number>} [own] speeds set on single changes
 */
export const speedFor = (field, base, own = {}) => own[field] ?? (field === 'spo2' ? spo2Speed(base) : base);

/** @param {string} f */
export const isGlideField = (f) => /** @type {readonly string[]} */ (GLIDE_FIELDS).includes(f);

/**
 * The glide fields a patient patch changes (a pressure counts once).
 * @param {{ patient?: Record<string, any> } | null} patch
 * @returns {string[]}
 */
export const changedFields = (patch) => GLIDE_FIELDS.filter((k) => patch?.patient && k in patch.patient);

/**
 * Timing for one Apply or queue step: `glideMs` is the base speed; `glideMsBy` lists the fields that differ from it.
 * @param {{ patient?: Record<string, any> } | null} patch
 * @param {number} base
 * @param {Record<string, number>} [own]
 * @returns {{ glideMs: number, glideMsBy?: Record<string, number> }}
 */
export function timingFor(patch, base, own = {}) {
  /** @type {Record<string, number>} */
  const by = {};
  for (const f of changedFields(patch)) {
    const ms = speedFor(f, base, own);
    if (ms !== base) by[f] = ms;
  }
  return Object.keys(by).length ? { glideMs: base, glideMsBy: by } : { glideMs: base };
}

/** Short text for one step of a queue. @param {{ patch: any }} step */
export function stepSummary(step) {
  const NAMES = /** @type {Record<string, string>} */ ({
    hr: 'HR', spo2: 'SpO₂', etco2: 'EtCO₂', rr: 'RR', temp: 'Temp', cvp: 'CVP', bis: 'BIS', rhythm: 'Rhythm',
    nibp: 'NIBP', abp: 'ABP', abp2: 'ABP2', fio2: 'FiO₂', eto2: 'Et O₂', fiag: 'Fi agent', etag: 'Et agent', fin2o: 'Fi N₂O', etn2o: 'Et N₂O',
  });
  const parts = [];
  for (const [k, v] of Object.entries(step.patch?.patient ?? {})) {
    const val = v && typeof v === 'object' ? `${/** @type {any} */ (v).sys ?? '?'}/${/** @type {any} */ (v).dia ?? '?'}` : String(v);
    parts.push(`${NAMES[k] ?? k} ${val}`);
  }
  if (step.patch?.alarms) parts.push('alarm limits');
  return parts.join(', ') || 'change';
}

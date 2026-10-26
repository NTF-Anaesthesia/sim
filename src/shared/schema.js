// @ts-check
// State and message types for a room, defaults and validation (DESIGN.md sections 3-5). No DOM, no timers.

export const SCHEMA_VERSION = 1;

/** Room code alphabet: no 0 O 1 I L. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;

export const RHYTHMS = ['sinus', 'sinus_brady', 'sinus_tachy', 'af', 'flutter', 'svt', 'vt', 'vf', 'asystole', 'pea'];
export const MODULE_IDS = ['ecg', 'spo2', 'etco2', 'nibp', 'rr', 'temp', 'abp'];
export const DEFAULT_MODULES = ['ecg', 'spo2', 'etco2', 'nibp', 'rr', 'temp'];

/**
 * @typedef {{ sys: number, dia: number }} Pressure
 * @typedef {{ hr: number, spo2: number, etco2: number, rr: number, temp: number, nibp: Pressure, abp: Pressure }} Numerics
 * @typedef {Numerics & { rhythm: string, glideMs: number }} Patient
 * @typedef {{ startedAt: number, durationMs: number, from: Numerics }} Glide
 * @typedef {{ sys: number, dia: number, at: number, mode: 'manual' | 'cycle', cycleSec: number }} NibpReading
 * @typedef {Record<string, [number, number]>} Limits
 * @typedef {{ limits: Limits, enabled: boolean, silencedUntil: number, latched: string[] }} Alarms
 * @typedef {{ t: number, by: string, what: string }} RoomEvent
 * @typedef {{
 *   schema: number, rev: number, patient: Patient, glide: Glide, nibp: NibpReading, modules: string[],
 *   alarms: Alarms, events: RoomEvent[], theme: string, themeJson?: object, test?: unknown
 * }} RoomState
 */

/** @returns {Numerics} */
export function defaultNumerics() {
  return { hr: 80, spo2: 98, etco2: 38, rr: 14, temp: 36.8, nibp: { sys: 120, dia: 75 }, abp: { sys: 120, dia: 75 } };
}

/**
 * @param {number} now server ms
 * @returns {RoomState}
 */
export function defaultState(now) {
  return {
    schema: SCHEMA_VERSION,
    rev: 0,
    patient: { rhythm: 'sinus', ...defaultNumerics(), glideMs: 0 },
    glide: { startedAt: now, durationMs: 0, from: defaultNumerics() },
    nibp: { sys: 120, dia: 75, at: now, mode: 'manual', cycleSec: 0 },
    modules: [...DEFAULT_MODULES],
    alarms: {
      limits: {
        hr: [50, 120], spo2: [90, 100], etco2: [30, 50], rr: [8, 30],
        nibpSys: [90, 180], temp: [35.5, 38.5], abpSys: [90, 180],
      },
      enabled: true,
      silencedUntil: 0,
      latched: [],
    },
    events: [],
    theme: 'default',
  };
}

/** @param {string} s */
export function normalizeCode(s) {
  return String(s ?? '').trim().toUpperCase();
}

/** @param {string} s */
export function isCode(s) {
  return s.length === CODE_LENGTH && [...s].every((c) => CODE_ALPHABET.includes(c));
}

/** @param {(n: number) => number} [rand] returns an int in [0, n) */
export function newCode(rand) {
  const r = rand ?? ((n) => crypto.getRandomValues(new Uint32Array(1))[0] % n);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[r(CODE_ALPHABET.length)];
  return out;
}

/** Allowed ranges for numeric targets: [min, max]. */
const RANGES = {
  hr: [0, 300], spo2: [0, 100], etco2: [0, 100], rr: [0, 60], temp: [25, 43],
  sys: [0, 350], dia: [0, 300], glideMs: [0, 600000], cycleSec: [0, 3600],
};

/**
 * @param {unknown} v
 * @param {[number, number]} range
 */
function inRange(v, range) {
  return typeof v === 'number' && Number.isFinite(v) && v >= range[0] && v <= range[1];
}

/** @param {unknown} v */
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Validate a `set` patch against the allow-list. Returns the cleaned patch or an error text.
 * @param {unknown} patch
 * @returns {{ ok: true, patch: any } | { ok: false, msg: string }}
 */
export function validatePatch(patch) {
  if (!isObj(patch)) return { ok: false, msg: 'patch must be an object' };
  const p = /** @type {Record<string, any>} */ (patch);
  /** @type {Record<string, any>} */
  const out = {};
  for (const key of Object.keys(p)) {
    const v = p[key];
    if (key === 'patient') {
      if (!isObj(v)) return { ok: false, msg: 'patient must be an object' };
      /** @type {Record<string, any>} */
      const pt = {};
      for (const k of Object.keys(v)) {
        const x = v[k];
        if (k === 'rhythm') {
          if (!RHYTHMS.includes(x)) return { ok: false, msg: 'unknown rhythm' };
          pt.rhythm = x;
        } else if (k === 'nibp' || k === 'abp') {
          if (!isObj(x)) return { ok: false, msg: `${k} must be an object` };
          pt[k] = {};
          for (const kk of Object.keys(x)) {
            if (kk !== 'sys' && kk !== 'dia') return { ok: false, msg: `unknown field ${k}.${kk}` };
            if (!inRange(x[kk], /** @type {[number, number]} */ (RANGES[kk]))) return { ok: false, msg: `${k}.${kk} out of range` };
            pt[k][kk] = x[kk];
          }
        } else if (k in RANGES && k !== 'sys' && k !== 'dia' && k !== 'cycleSec') {
          if (!inRange(x, /** @type {[number, number]} */ (RANGES[/** @type {keyof typeof RANGES} */ (k)]))) {
            return { ok: false, msg: `${k} out of range` };
          }
          pt[k] = k === 'temp' ? Math.round(x * 10) / 10 : x;
        } else return { ok: false, msg: `unknown field patient.${k}` };
      }
      out.patient = pt;
    } else if (key === 'modules') {
      if (!Array.isArray(v) || v.length > 16 || !v.every((m) => typeof m === 'string' && m.length <= 16)) {
        return { ok: false, msg: 'modules must be a list of ids' };
      }
      out.modules = [...new Set(v)];
    } else if (key === 'alarms') {
      if (!isObj(v)) return { ok: false, msg: 'alarms must be an object' };
      /** @type {Record<string, any>} */
      const al = {};
      for (const k of Object.keys(v)) {
        if (k === 'enabled') {
          if (typeof v.enabled !== 'boolean') return { ok: false, msg: 'alarms.enabled must be true or false' };
          al.enabled = v.enabled;
        } else if (k === 'limits') {
          if (!isObj(v.limits)) return { ok: false, msg: 'alarms.limits must be an object' };
          al.limits = {};
          for (const name of Object.keys(v.limits)) {
            const pair = v.limits[name];
            if (!Array.isArray(pair) || pair.length !== 2 || !pair.every((n) => typeof n === 'number' && Number.isFinite(n)) || pair[0] > pair[1]) {
              return { ok: false, msg: `limit ${name} must be [low, high]` };
            }
            if (name.length > 16) return { ok: false, msg: 'limit name too long' };
            al.limits[name] = pair;
          }
        } else return { ok: false, msg: `unknown field alarms.${k}` };
      }
      out.alarms = al;
    } else if (key === 'nibp') {
      if (!isObj(v)) return { ok: false, msg: 'nibp must be an object' };
      /** @type {Record<string, any>} */
      const nb = {};
      for (const k of Object.keys(v)) {
        if (k === 'mode') {
          if (v.mode !== 'manual' && v.mode !== 'cycle') return { ok: false, msg: 'nibp.mode must be manual or cycle' };
          nb.mode = v.mode;
        } else if (k === 'cycleSec') {
          if (!inRange(v.cycleSec, /** @type {[number, number]} */ (RANGES.cycleSec))) return { ok: false, msg: 'nibp.cycleSec out of range' };
          nb.cycleSec = v.cycleSec;
        } else return { ok: false, msg: `unknown field nibp.${k}` };
      }
      out.nibp = nb;
    } else if (key === 'theme') {
      if (v !== 'default' && v !== 'custom') return { ok: false, msg: 'theme must be default or custom' };
      out.theme = v;
    } else if (key === 'themeJson') {
      if (!isObj(v) || JSON.stringify(v).length > 12288) return { ok: false, msg: 'themeJson must be an object under 12 KB' };
      out.themeJson = v;
    } else return { ok: false, msg: `unknown field ${key}` };
  }
  return { ok: true, patch: out };
}

/** The numeric fields that glide. */
export function numericsOf(/** @type {Numerics} */ o) {
  return {
    hr: o.hr, spo2: o.spo2, etco2: o.etco2, rr: o.rr, temp: o.temp,
    nibp: { sys: o.nibp.sys, dia: o.nibp.dia }, abp: { sys: o.abp.sys, dia: o.abp.dia },
  };
}

// @ts-check
// State and message types for a room, defaults and validation (DESIGN.md sections 3-5). No DOM, no timers.
import { builtinTheme } from '../theme/builtin.js';
import { validateTheme } from '../theme/validate.js';

export const SCHEMA_VERSION = 1;

/** Room code alphabet: no 0 O 1 I L. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;

export const RHYTHMS = [
  'sinus', 'sinus_brady', 'sinus_tachy', 'af', 'flutter', 'svt', 'vt', 'vf', 'asystole', 'pea',
  // reserved for S2: accepted and stored now so the schema does not change later
  'first_degree_block', 'mobitz1', 'mobitz2', 'chb', 'torsades', 'paced',
];
/** Rhythms with no pulse; `vt` has one unless the patient says `pulse: false`. */
export const PULSELESS_RHYTHMS = ['vf', 'asystole', 'pea'];
export const ETCO2_SHAPES = ['normal', 'obstructive', 'curare', 'rebreathing', 'none'];
export const SPO2_QUALITIES = ['good', 'poor', 'none'];
export const ABP_DAMPINGS = ['normal', 'over', 'under'];
/** CVP v wave: normal | giant (a large v wave, as with a leaking tricuspid valve). */
export const CVP_VS = ['normal', 'giant'];
/** Sensors that can be switched off per patient. */
export const SENSORS = ['ecg', 'spo2', 'nibp', 'abp', 'etco2', 'cvp', 'abp2', 'bis'];
/** Below this signal quality the BIS number is not trusted: shown as dashes and not judged against limits. */
export const BIS_MIN_SQI = 15;
const BIS_KEYS = ['bis', 'bisSqi', 'bisEmg', 'bisSr'];
export const MAX_PATIENTS = 8;
export const MODULE_IDS = ['ecg', 'spo2', 'etco2', 'nibp', 'rr', 'temp', 'abp', 'cvp', 'abp2', 'bis'];
export const DEFAULT_MODULES = ['ecg', 'spo2', 'etco2', 'nibp', 'rr', 'temp'];
/** Named screens (S1 of V2): ids are server-made `s1`, `s2`, ...; `defib` is reserved for the defib screen. */
export const MAX_SCREENS = 12;
export const SCREEN_KINDS = ['monitor', 'defib'];
export const SCREEN_ID = /^s[1-9][0-9]{0,2}$/;
/** Device choices a monitor reports in `iam` (they win over its screen setting; the phone can clear them). */
export const DEVICE_CHOICES = ['theme', 'p'];

/**
 * @typedef {{ sys: number, dia: number }} Pressure
 * @typedef {{ hr: number, spo2: number, etco2: number, rr: number, temp: number, nibp: Pressure, abp: Pressure, cvp: number, abp2: Pressure, bis: number }} Numerics
 * @typedef {Record<string, boolean>} SensorOff
 * @typedef {{ startedAt: number, durationMs: number, from: Numerics }} Glide
 * @typedef {{ sys: number, dia: number, at: number, mode: 'manual' | 'cycle', cycleSec: number }} NibpReading
 * @typedef {Numerics & {
 *   id: string, label: string, rhythm: string, glideMs: number, pulse: boolean, flutterRatio: number, st: number,
 *   pvcPerMin: number, ie: number, off: SensorOff, etco2Shape: string, spo2Quality: string, abpDamping: string,
 *   cvpV: string, ppv: number, abp2Label: string, bisSqi: number, bisEmg: number, bisSr: number,
 *   glide: Glide, nibpRead: NibpReading
 * }} Patient
 * @typedef {Record<string, [number, number]>} Limits
 * @typedef {{ limits: Limits, enabled: boolean, silencedUntil: number, latched: string[] }} Alarms
 * @typedef {{ t: number, by: string, kind: string, p?: string, what: string }} RoomEvent
 * @typedef {{
 *   name: string, kind: string, p?: string, modules?: string[], theme?: string, themeJson?: object
 * }} Screen  absent `p` / `modules` / `theme` = follow the device's URL / the room / the room
 * @typedef {{
 *   schema: number, rev: number, patients: Patient[], modules: string[],
 *   alarms: Alarms, events: RoomEvent[], theme: string, themeJson?: object, test?: unknown,
 *   screens?: Record<string, Screen>, scenario?: import('./scenario.js').ScenarioRun
 * }} RoomState
 */

/** @returns {Numerics} */
export function defaultNumerics() {
  return { hr: 80, spo2: 98, etco2: 38, rr: 14, temp: 36.8, nibp: { sys: 120, dia: 75 }, abp: { sys: 120, dia: 75 }, cvp: 8, abp2: { sys: 120, dia: 75 }, bis: 95 };
}

/** @returns {SensorOff} */
function defaultOff() {
  return { ecg: false, spo2: false, nibp: false, abp: false, etco2: false, cvp: false, abp2: false, bis: false };
}

/**
 * @param {string} id
 * @param {string} label
 * @param {number} now server ms
 * @returns {Patient}
 */
export function defaultPatient(id, label, now) {
  return {
    id, label, rhythm: 'sinus', ...defaultNumerics(), glideMs: 0, pulse: true, flutterRatio: 2, st: 0,
    pvcPerMin: 0, ie: 2, off: defaultOff(),
    etco2Shape: 'normal', spo2Quality: 'good', abpDamping: 'normal', cvpV: 'normal', ppv: 0, abp2Label: '', bisSqi: 98, bisEmg: 5, bisSr: 0,
    glide: { startedAt: now, durationMs: 0, from: defaultNumerics() },
    nibpRead: { sys: 120, dia: 75, at: now, mode: 'manual', cycleSec: 0 },
  };
}

/**
 * @param {number} now server ms
 * @returns {RoomState}
 */
export function defaultState(now) {
  return {
    schema: SCHEMA_VERSION,
    rev: 0,
    patients: [defaultPatient('p1', 'Bed 1', now)],
    modules: [...DEFAULT_MODULES],
    alarms: {
      limits: {
        hr: [50, 120], spo2: [90, 100], etco2: [30, 50], rr: [8, 30],
        nibpSys: [90, 180], temp: [35.5, 38.5], abpSys: [90, 180], cvp: [2, 14], abp2Sys: [90, 180], bis: [20, 100],
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
export const RANGES = {
  hr: [0, 300], spo2: [0, 100], etco2: [0, 100], rr: [0, 60], temp: [25, 43],
  sys: [0, 350], dia: [0, 300], glideMs: [0, 600000], cycleSec: [0, 3600],
  pvcPerMin: [0, 30], ie: [0.5, 5], st: [-3, 3], cvp: [-5, 40], ppv: [0, 40], bis: [0, 100], bisSqi: [0, 100], bisEmg: [0, 100], bisSr: [0, 100],
};
const ENUMS = { etco2Shape: ETCO2_SHAPES, spo2Quality: SPO2_QUALITIES, abpDamping: ABP_DAMPINGS, cvpV: CVP_VS };
const TARGET_KEYS = ['hr', 'spo2', 'etco2', 'rr', 'temp', 'nibp', 'abp', 'cvp', 'abp2', 'bis'];
/** Patient fields that are plain numbers with a range (everything but the objects and enums). */
const NUMBER_KEYS = ['hr', 'spo2', 'etco2', 'rr', 'temp', 'glideMs', 'pvcPerMin', 'ie', 'st', 'cvp', 'ppv', 'bis', 'bisSqi', 'bisEmg', 'bisSr'];
/** Second art line name shown on the monitor: up to 8 letters, digits, spaces and . - / (empty = the theme's label). */
export const ABP2_LABEL = /^[A-Za-z0-9 ./-]{0,8}$/;

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
        } else if (k === 'label') {
          if (typeof x !== 'string' || !x.trim() || x.length > 24) return { ok: false, msg: 'label must be 1-24 characters' };
          pt.label = x.trim();
        } else if (k === 'pulse') {
          if (typeof x !== 'boolean') return { ok: false, msg: 'pulse must be true or false' };
          pt.pulse = x;
        } else if (k === 'flutterRatio') {
          if (x !== 2 && x !== 3 && x !== 4) return { ok: false, msg: 'flutterRatio must be 2, 3 or 4' };
          pt.flutterRatio = x;
        } else if (k === 'off') {
          if (!isObj(x)) return { ok: false, msg: 'off must be an object' };
          pt.off = {};
          for (const kk of Object.keys(x)) {
            if (!SENSORS.includes(kk)) return { ok: false, msg: `unknown sensor off.${kk}` };
            if (typeof x[kk] !== 'boolean') return { ok: false, msg: `off.${kk} must be true or false` };
            pt.off[kk] = x[kk];
          }
        } else if (k in ENUMS) {
          if (!ENUMS[/** @type {keyof typeof ENUMS} */ (k)].includes(x)) return { ok: false, msg: `unknown ${k}` };
          pt[k] = x;
        } else if (k === 'abp2Label') {
          if (typeof x !== 'string' || !ABP2_LABEL.test(x)) return { ok: false, msg: 'abp2Label must be up to 8 letters, digits or . - /' };
          pt.abp2Label = x.trim();
        } else if (k === 'nibp' || k === 'abp' || k === 'abp2') {
          if (!isObj(x)) return { ok: false, msg: `${k} must be an object` };
          pt[k] = {};
          for (const kk of Object.keys(x)) {
            if (kk !== 'sys' && kk !== 'dia') return { ok: false, msg: `unknown field ${k}.${kk}` };
            if (!inRange(x[kk], /** @type {[number, number]} */ (RANGES[kk]))) return { ok: false, msg: `${k}.${kk} out of range` };
            pt[k][kk] = x[kk];
          }
        } else if (NUMBER_KEYS.includes(k)) {
          if (!inRange(x, /** @type {[number, number]} */ (RANGES[/** @type {keyof typeof RANGES} */ (k)]))) {
            return { ok: false, msg: `${k} out of range` };
          }
          pt[k] = k === 'temp' ? Math.round(x * 10) / 10 : k === 'pvcPerMin' ? Math.round(x) : k === 'cvp' || k === 'ppv' ? Math.round(x * 2) / 2 : BIS_KEYS.includes(k) ? Math.round(x) : x;
        } else return { ok: false, msg: `unknown field patient.${k}` };
      }
      out.patient = pt;
    } else if (key === 'modules') {
      if (!isModuleList(v)) {
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
      const checked = checkThemeJson(v);
      if (!checked.ok) return checked;
      out.themeJson = checked.theme;
    } else if (key === 'screens') {
      if (!isObj(v) || Object.keys(v).length > MAX_SCREENS) return { ok: false, msg: 'screens must be an object of screen ids' };
      /** @type {Record<string, any>} */
      const scr = {};
      for (const id of Object.keys(v)) {
        if (!SCREEN_ID.test(id)) return { ok: false, msg: `unknown screen ${id.slice(0, 8)}` };
        const one = validateScreenPatch(v[id], id);
        if (!one.ok) return one;
        scr[id] = one.patch;
      }
      out.screens = scr;
    } else return { ok: false, msg: `unknown field ${key}` };
  }
  return { ok: true, patch: out };
}

/**
 * @param {unknown} v
 * @returns {{ ok: true, theme: any } | { ok: false, msg: string }}
 */
function checkThemeJson(v) {
  if (!isObj(v) || JSON.stringify(v).length > 12288) return { ok: false, msg: 'themeJson must be an object under 12 KB' };
  const checked = validateTheme(v); // the room only carries themes every monitor can draw
  if (!checked.ok) return { ok: false, msg: `themeJson: ${checked.errors[0]}` };
  return { ok: true, theme: checked.theme };
}

/** @param {unknown} v */
function isModuleList(v) {
  return Array.isArray(v) && v.length <= 16 && v.every((m) => typeof m === 'string' && m.length <= 16);
}

/**
 * A screen name trimmed, or null when it is not 1-24 characters after trimming.
 * @param {unknown} v
 * @returns {string | null}
 */
export function screenName(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t && t.length <= 24 ? t : null;
}

/**
 * One screen's part of a `set` patch: `name`, `p`, `modules`, `theme`, `themeJson`. `null` clears a field (the
 * screen then follows its device's URL / the room). `kind` is fixed when the screen is made.
 * @param {unknown} v
 * @param {string} id
 * @returns {{ ok: true, patch: Record<string, any> } | { ok: false, msg: string }}
 */
export function validateScreenPatch(v, id) {
  if (!isObj(v)) return { ok: false, msg: `screens.${id} must be an object` };
  const x = /** @type {Record<string, any>} */ (v);
  /** @type {Record<string, any>} */
  const out = {};
  for (const k of Object.keys(x)) {
    const val = x[k];
    if (k === 'name') {
      const name = screenName(val);
      if (name === null) return { ok: false, msg: 'name must be 1-24 characters' };
      out.name = name;
    } else if (k === 'p') {
      if (val !== null && (typeof val !== 'string' || !val || val.length > 12)) return { ok: false, msg: `screens.${id}.p must be a patient id or null` };
      out.p = val;
    } else if (k === 'modules') {
      if (val !== null && !isModuleList(val)) return { ok: false, msg: `screens.${id}.modules must be a list of ids or null` };
      out.modules = val === null ? null : [...new Set(val)];
    } else if (k === 'theme') {
      if (val !== null && val !== 'custom' && !builtinTheme(val)) return { ok: false, msg: `screens.${id}.theme must be a built-in id, custom or null` };
      out.theme = val;
    } else if (k === 'themeJson') {
      const checked = checkThemeJson(val);
      if (!checked.ok) return checked;
      out.themeJson = checked.theme;
    } else return { ok: false, msg: `unknown field screens.${id}.${k.slice(0, 16)}` };
  }
  return { ok: true, patch: out };
}

/**
 * A monitor saying which screen it is and which device choices it has (`iam`). Not stored in state; the room keeps it
 * with the socket for `presence`.
 * @param {any} msg
 * @returns {{ ok: true, s: string | null, dev: string[] } | { ok: false, msg: string }}
 */
export function validateIam(msg) {
  const s = msg?.s ?? null;
  if (s !== null && (typeof s !== 'string' || !SCREEN_ID.test(s))) return { ok: false, msg: 'bad screen id' };
  const dev = msg?.dev ?? [];
  if (!Array.isArray(dev) || !dev.every((d) => DEVICE_CHOICES.includes(d))) return { ok: false, msg: 'bad device choices' };
  return { ok: true, s, dev: [...new Set(dev)] };
}

export const TARGETS = TARGET_KEYS;

/** The numeric fields that glide. */
export function numericsOf(/** @type {Numerics} */ o) {
  return {
    hr: o.hr, spo2: o.spo2, etco2: o.etco2, rr: o.rr, temp: o.temp,
    nibp: { sys: o.nibp.sys, dia: o.nibp.dia }, abp: { sys: o.abp.sys, dia: o.abp.dia },
    cvp: o.cvp, abp2: { sys: o.abp2.sys, dia: o.abp2.dia }, bis: o.bis,
  };
}

/**
 * Add fields a room saved by an older build does not have yet (additive changes keep `schema: 1`). Changes the state in place.
 * @param {RoomState} s
 * @returns {RoomState}
 */
export function fillDefaults(s) {
  const now = 0;
  for (const p of s.patients) {
    const d = defaultPatient(p.id, p.label, now);
    for (const k of Object.keys(d)) {
      const key = /** @type {keyof Patient} */ (k);
      if (p[key] === undefined && k !== 'glide' && k !== 'nibpRead') /** @type {any} */ (p)[k] = d[key];
    }
    p.off = { ...defaultOff(), ...p.off };
    for (const k of /** @type {const} */ (['cvp', 'abp2', 'bis'])) {
      if (p.glide.from[k] === undefined) /** @type {any} */ (p.glide.from)[k] = p[k];
    }
  }
  const lim = defaultState(now).alarms.limits;
  for (const k of Object.keys(lim)) if (s.alarms.limits[k] === undefined) s.alarms.limits[k] = lim[k];
  return s;
}

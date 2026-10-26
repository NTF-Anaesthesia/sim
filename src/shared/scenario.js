// @ts-check
// Scenarios (timed steps run by the room) and drug buttons (relative changes): shared checks for the room, the phone and
// the tests (DESIGN.md section 12). No DOM, no timers.
import { RANGES, validatePatch } from './schema.js';

export const MAX_STEPS = 30;
export const MAX_STEP_SEC = 3600;
export const MAX_FILE_CHARS = 32 * 1024;
export const MAX_SCENARIO_CHARS = 12 * 1024;
export const MAX_SCENARIOS = 20;
export const MAX_DRUGS = 20;
export const LIBRARY_KIND = 'library';
export const LIBRARY_VERSION = 1;
/** A step patch may only change the patient and the alarm limits (never the theme or the screens). */
const STEP_KEYS = ['patient', 'alarms'];
/** Numerics a drug can change: plain numbers, and pressures with `sys` / `dia`. */
export const DRUG_NUMBERS = ['hr', 'spo2', 'etco2', 'rr', 'temp', 'cvp'];
export const DRUG_PRESSURES = ['nibp', 'abp', 'abp2'];

/**
 * @typedef {{ atSec?: number, onTap?: boolean, patch: any, glideMs: number }} ScenarioStep
 *   `atSec` = seconds after the previous step ran (the first: after the start); `onTap` = waits for a tap instead
 * @typedef {{ name: string, steps: ScenarioStep[] }} Scenario
 * @typedef {{ mul?: number, add?: number }} Op
 * @typedef {{ name: string, note?: string, glideMs: number, effects: Record<string, any> }} Drug
 * @typedef {{
 *   id: string, name: string, p: string, step: number, total: number, startedAt: number, pausedAt: number,
 *   nextAt: number, waiting: boolean, done: boolean
 * }} ScenarioRun  `step` = steps already run; `nextAt` = server ms of the next timed step (0 = none or waiting for a tap)
 */

/** @param {unknown} v */
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** @param {unknown} v @param {number} lo @param {number} hi */
const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
/** @param {unknown} v */
const name24 = (v) => (typeof v === 'string' && v.trim() && v.trim().length <= 24 ? v.trim() : null);

/**
 * @param {unknown} raw
 * @returns {{ ok: true, scenario: Scenario } | { ok: false, msg: string }}
 */
export function validateScenario(raw) {
  if (!isObj(raw)) return { ok: false, msg: 'a scenario must be an object' };
  const r = /** @type {Record<string, any>} */ (raw);
  const name = name24(r.name);
  if (!name) return { ok: false, msg: 'scenario name must be 1-24 characters' };
  if (!Array.isArray(r.steps) || !r.steps.length) return { ok: false, msg: `"${name}" needs at least one step` };
  if (r.steps.length > MAX_STEPS) return { ok: false, msg: `"${name}" has more than ${MAX_STEPS} steps` };
  if (JSON.stringify(r).length > MAX_SCENARIO_CHARS) return { ok: false, msg: `"${name}" is over ${MAX_SCENARIO_CHARS / 1024} KB` };
  /** @type {ScenarioStep[]} */
  const steps = [];
  for (const [i, s] of r.steps.entries()) {
    const at = `"${name}" step ${i + 1}`;
    if (!isObj(s)) return { ok: false, msg: `${at} must be an object` };
    const glideMs = s.glideMs ?? 0;
    if (!num(glideMs, 0, 600000)) return { ok: false, msg: `${at}: glideMs must be 0-600000` };
    if (!isObj(s.patch) || !Object.keys(s.patch).length) return { ok: false, msg: `${at}: patch must be a non-empty object` };
    const bad = Object.keys(s.patch).find((k) => !STEP_KEYS.includes(k));
    if (bad) return { ok: false, msg: `${at}: patch may only change patient and alarms, not ${bad.slice(0, 16)}` };
    const v = validatePatch(s.patch);
    if (!v.ok) return { ok: false, msg: `${at}: ${v.msg}` };
    if (s.onTap === true) {
      if (s.atSec !== undefined) return { ok: false, msg: `${at}: use atSec or onTap, not both` };
      steps.push({ onTap: true, patch: v.patch, glideMs });
    } else {
      if (s.onTap !== undefined && s.onTap !== false) return { ok: false, msg: `${at}: onTap must be true or false` };
      if (!num(s.atSec, 0, MAX_STEP_SEC)) return { ok: false, msg: `${at}: atSec must be 0-${MAX_STEP_SEC} (or set onTap: true)` };
      steps.push({ atSec: s.atSec, patch: v.patch, glideMs });
    }
  }
  return { ok: true, scenario: { name, steps } };
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, drug: Drug } | { ok: false, msg: string }}
 */
export function validateDrug(raw) {
  if (!isObj(raw)) return { ok: false, msg: 'a drug button must be an object' };
  const r = /** @type {Record<string, any>} */ (raw);
  const name = name24(r.name);
  if (!name) return { ok: false, msg: 'drug name must be 1-24 characters' };
  const at = `drug "${name}"`;
  if (r.note !== undefined && (typeof r.note !== 'string' || r.note.length > 60)) return { ok: false, msg: `${at}: note must be up to 60 characters` };
  const glideMs = r.glideMs ?? 20000;
  if (!num(glideMs, 0, 600000)) return { ok: false, msg: `${at}: glideMs must be 0-600000` };
  if (!isObj(r.effects) || !Object.keys(r.effects).length) return { ok: false, msg: `${at}: effects must be a non-empty object` };
  /** @type {Record<string, any>} */
  const effects = {};
  /** @param {unknown} o @param {string} where @returns {Op | string} */
  const op = (o, where) => {
    if (!isObj(o)) return `${at}: ${where} must be {mul} or {add}`;
    const x = /** @type {Record<string, any>} */ (o);
    const bad = Object.keys(x).find((k) => k !== 'mul' && k !== 'add');
    if (bad) return `${at}: ${where} has unknown field ${bad.slice(0, 16)}`;
    if (x.mul === undefined && x.add === undefined) return `${at}: ${where} needs mul or add`;
    if (x.mul !== undefined && !num(x.mul, 0, 5)) return `${at}: ${where}.mul must be 0-5`;
    if (x.add !== undefined && !num(x.add, -300, 300)) return `${at}: ${where}.add must be -300 to 300`;
    return { ...(x.mul !== undefined ? { mul: x.mul } : {}), ...(x.add !== undefined ? { add: x.add } : {}) };
  };
  for (const [k, v] of Object.entries(r.effects)) {
    if (DRUG_NUMBERS.includes(k)) {
      const o = op(v, k);
      if (typeof o === 'string') return { ok: false, msg: o };
      effects[k] = o;
    } else if (DRUG_PRESSURES.includes(k)) {
      if (!isObj(v) || !Object.keys(v).length) return { ok: false, msg: `${at}: ${k} must have sys and/or dia` };
      effects[k] = {};
      for (const [kk, vv] of Object.entries(v)) {
        if (kk !== 'sys' && kk !== 'dia') return { ok: false, msg: `${at}: unknown field ${k}.${kk.slice(0, 16)}` };
        const o = op(vv, `${k}.${kk}`);
        if (typeof o === 'string') return { ok: false, msg: o };
        effects[k][kk] = o;
      }
    } else return { ok: false, msg: `${at}: unknown effect ${k.slice(0, 16)}` };
  }
  return { ok: true, drug: { name, ...(r.note ? { note: r.note } : {}), glideMs, effects } };
}

/**
 * The absolute `patient` patch a drug makes from the patient's current targets: `value * mul + add`, kept inside the
 * allowed range. The room runs it through `set` (so it glides like any other change).
 * @param {Record<string, any>} patient
 * @param {Record<string, any>} effects checked by `validateDrug`
 */
export function drugPatch(patient, effects) {
  /** @param {string} key @param {number} cur @param {Op} o */
  const calc = (key, cur, o) => {
    const [lo, hi] = /** @type {[number, number]} */ (RANGES[/** @type {keyof typeof RANGES} */ (key)]);
    const v = Math.min(hi, Math.max(lo, cur * (o.mul ?? 1) + (o.add ?? 0)));
    return key === 'temp' ? Math.round(v * 10) / 10 : key === 'cvp' ? Math.round(v * 2) / 2 : Math.round(v);
  };
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, v] of Object.entries(effects)) {
    if (DRUG_NUMBERS.includes(k)) out[k] = calc(k, patient[k], v);
    else {
      out[k] = {};
      for (const [kk, o] of Object.entries(v)) out[k][kk] = calc(kk, patient[k][kk], o);
    }
  }
  return out;
}

/**
 * A scenario and drug library file: `{ sim: 'library', version: 1, scenarios: [...], drugs: [...] }`. The whole file is
 * refused with one reason when anything in it is wrong; nothing is kept from a refused file.
 * @param {string} text
 * @returns {{ ok: true, scenarios: Scenario[], drugs: Drug[] } | { ok: false, msg: string }}
 */
export function validateLibraryFile(text) {
  if (typeof text !== 'string' || text.length > MAX_FILE_CHARS) return { ok: false, msg: `the file is over ${MAX_FILE_CHARS / 1024} KB` };
  /** @type {any} */
  let data;
  try { data = JSON.parse(text); } catch { return { ok: false, msg: 'not valid JSON' }; }
  if (!isObj(data) || data.sim !== LIBRARY_KIND) return { ok: false, msg: `not a library file (expected "sim": "${LIBRARY_KIND}")` };
  if (data.version !== LIBRARY_VERSION) return { ok: false, msg: `unsupported version ${String(data.version).slice(0, 8)} (this app reads version ${LIBRARY_VERSION})` };
  const sc = data.scenarios ?? [];
  const dr = data.drugs ?? [];
  if (!Array.isArray(sc) || !Array.isArray(dr)) return { ok: false, msg: 'scenarios and drugs must be lists' };
  if (!sc.length && !dr.length) return { ok: false, msg: 'the file has no scenarios or drugs' };
  if (sc.length > MAX_SCENARIOS || dr.length > MAX_DRUGS) return { ok: false, msg: `at most ${MAX_SCENARIOS} scenarios and ${MAX_DRUGS} drugs` };
  /** @type {Scenario[]} */
  const scenarios = [];
  /** @type {Drug[]} */
  const drugs = [];
  for (const raw of sc) {
    const v = validateScenario(raw);
    if (!v.ok) return v;
    if (scenarios.some((x) => x.name === v.scenario.name)) return { ok: false, msg: `two scenarios are named "${v.scenario.name}"` };
    scenarios.push(v.scenario);
  }
  for (const raw of dr) {
    const v = validateDrug(raw);
    if (!v.ok) return v;
    if (drugs.some((x) => x.name === v.drug.name)) return { ok: false, msg: `two drugs are named "${v.drug.name}"` };
    drugs.push(v.drug);
  }
  return { ok: true, scenarios, drugs };
}

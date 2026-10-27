// @ts-check
// Scenarios (timed steps run by the room) and drug buttons (relative changes): shared checks for the room, the phone and
// the tests (DESIGN.md section 12). No DOM, no timers.
import { RANGES, validatePatch } from './schema.js';
import { GLIDE_FIELDS } from '../engine/glide.js';

export const MAX_STEPS = 30;
export const MAX_STEP_SEC = 3600;
export const MAX_FILE_CHARS = 32 * 1024;
export const MAX_SCENARIO_CHARS = 12 * 1024;
export const MAX_SCENARIOS = 20;
/** Teaching text (sim-train S2): a step `note` and a scenario's `objectives`, shown on the phone only. */
export const MAX_NOTE = 160;
export const MAX_OBJECTIVES = 300;
export const MAX_DRUGS = 20;
export const LIBRARY_KIND = 'library';
export const LIBRARY_VERSION = 1;
/** A step patch may only change the patient and the alarm limits (never the theme or the screens). */
const STEP_KEYS = ['patient', 'alarms'];
/** Numerics a drug can change: plain numbers, and pressures with `sys` / `dia`. */
export const DRUG_NUMBERS = ['hr', 'spo2', 'etco2', 'rr', 'temp', 'cvp', 'bis'];
export const DRUG_PRESSURES = ['nibp', 'abp', 'abp2'];

/**
 * @typedef {{ atSec?: number, onTap?: boolean, patch: any, glideMs: number, glideMsBy?: Record<string, number>, note?: string }} ScenarioStep
 *   `atSec` = seconds after the previous step ran (the first: after the start); `onTap` = waits for a tap instead
 * @typedef {{ name: string, objectives?: string, steps: ScenarioStep[] }} Scenario
 * @typedef {{ mul?: number, add?: number }} Op
 * @typedef {{ name: string, note?: string, glideMs: number, effects: Record<string, any> }} Drug
 * @typedef {{
 *   id: string, name: string, p: string, step: number, total: number, startedAt: number, pausedAt: number,
 *   nextAt: number, waiting: boolean, done: boolean, queue?: boolean, tempo?: number, baseAt?: number, q?: ScenarioStep[],
 *   objectives?: string, note?: string
 * }} ScenarioRun  `step` = steps already run; `nextAt` = server ms of the next timed step (0 = none or waiting for a tap).
 *   Queue runs (`queue`) hold their steps in `q` (all of them, run or not) so every phone can show and edit them;
 *   `tempo` is the live speed (0.5, 2; absent = 1) and `baseAt` the time the next step's delay counts from;
 *   `objectives` and `note` (the teaching note of the step that ran last) are for the phone only: `forMonitor` strips them
 */

/** @param {unknown} v */
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** @param {unknown} v @param {number} lo @param {number} hi */
const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
/** @param {unknown} v */
const name24 = (v) => (typeof v === 'string' && v.trim() && v.trim().length <= 24 ? v.trim() : null);

/**
 * Optional teaching text: absent or empty is fine, anything but a string of up to `max` characters is refused.
 * @param {unknown} v @param {number} max @param {string} what
 * @returns {{ ok: true, text?: string } | { ok: false, msg: string }}
 */
function teachingText(v, max, what) {
  if (v === undefined || v === null) return { ok: true };
  if (typeof v !== 'string' || v.length > max) return { ok: false, msg: `${what} must be text of up to ${max} characters` };
  const text = v.trim();
  return text ? { ok: true, text } : { ok: true };
}

/**
 * Per-field glide times (`glideMsBy`): known fields only, 0 to 10 min each.
 * @param {unknown} raw
 * @returns {{ ok: true, by: Record<string, number> } | { ok: false, msg: string }}
 */
export function validateGlideMsBy(raw) {
  if (!isObj(raw)) return { ok: false, msg: 'glideMsBy must be an object' };
  /** @type {Record<string, number>} */
  const by = {};
  for (const [k, v] of Object.entries(/** @type {Record<string, unknown>} */ (raw))) {
    if (!/** @type {readonly string[]} */ (GLIDE_FIELDS).includes(k)) return { ok: false, msg: `glideMsBy: unknown field ${k.slice(0, 16)}` };
    if (!num(v, 0, 600000)) return { ok: false, msg: `glideMsBy.${k} must be 0-600000` };
    by[k] = /** @type {number} */ (v);
  }
  return { ok: true, by };
}

/**
 * One scenario step (also one queue step).
 * @param {unknown} raw
 * @param {string} at where it is, for the message
 * @returns {{ ok: true, step: ScenarioStep } | { ok: false, msg: string }}
 */
export function validateStep(raw, at) {
  if (!isObj(raw)) return { ok: false, msg: `${at} must be an object` };
  const s = /** @type {Record<string, any>} */ (raw);
  const glideMs = s.glideMs ?? 0;
  if (!num(glideMs, 0, 600000)) return { ok: false, msg: `${at}: glideMs must be 0-600000` };
  if (!isObj(s.patch) || !Object.keys(s.patch).length) return { ok: false, msg: `${at}: patch must be a non-empty object` };
  const bad = Object.keys(s.patch).find((k) => !STEP_KEYS.includes(k));
  if (bad) return { ok: false, msg: `${at}: patch may only change patient and alarms, not ${bad.slice(0, 16)}` };
  const v = validatePatch(s.patch);
  if (!v.ok) return { ok: false, msg: `${at}: ${v.msg}` };
  /** @type {{ glideMsBy?: Record<string, number>, note?: string }} */
  const extra = {};
  const note = teachingText(s.note, MAX_NOTE, `${at}: note`);
  if (!note.ok) return note;
  if (note.text) extra.note = note.text;
  if (s.glideMsBy !== undefined) {
    const b = validateGlideMsBy(s.glideMsBy);
    if (!b.ok) return { ok: false, msg: `${at}: ${b.msg}` };
    if (Object.keys(b.by).length) extra.glideMsBy = b.by;
  }
  if (s.onTap === true) {
    if (s.atSec !== undefined) return { ok: false, msg: `${at}: use atSec or onTap, not both` };
    return { ok: true, step: { onTap: true, patch: v.patch, glideMs, ...extra } };
  }
  if (s.onTap !== undefined && s.onTap !== false) return { ok: false, msg: `${at}: onTap must be true or false` };
  if (!num(s.atSec, 0, MAX_STEP_SEC)) return { ok: false, msg: `${at}: atSec must be 0-${MAX_STEP_SEC} (or set onTap: true)` };
  return { ok: true, step: { atSec: s.atSec, patch: v.patch, glideMs, ...extra } };
}

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
  const obj = teachingText(r.objectives, MAX_OBJECTIVES, `"${name}": objectives`);
  if (!obj.ok) return obj;
  /** @type {ScenarioStep[]} */
  const steps = [];
  for (const [i, s] of r.steps.entries()) {
    const v = validateStep(s, `"${name}" step ${i + 1}`);
    if (!v.ok) return v;
    steps.push(v.step);
  }
  return { ok: true, scenario: { name, ...(obj.text ? { objectives: obj.text } : {}), steps } };
}

/**
 * What a monitor may see of a room message: the same, without teaching text (`objectives`, `note`, and the notes inside a
 * queue's steps) without the library offer (a phone matter) and without the `note` rows of a history reply. Other messages come back as they are. The room applies it to every socket that joined as a monitor.
 * @template {{ t?: string, state?: any, events?: any[] }} M
 * @param {M} msg
 * @returns {M}
 */
export function forMonitor(msg) {
  if (msg?.t === 'library') return /** @type {any} */ ({ t: 'error', code: 'bad_patch', msg: 'monitors cannot read the offered library' });
  if (msg?.t === 'history' && Array.isArray(/** @type {any} */ (msg).events)) {
    const m = /** @type {any} */ (msg);
    return m.events.some((/** @type {any} */ e) => e.kind === 'note') ? { ...m, events: m.events.filter((/** @type {any} */ e) => e.kind !== 'note') } : msg;
  }
  const st = msg?.t === 'state' ? msg.state : null;
  const run = st?.scenario;
  const hasText = run && (run.objectives !== undefined || run.note !== undefined || run.q);
  if (!hasText && st?.offer === undefined) return msg;
  const { offer: _offer, ...rest } = st;
  if (hasText) {
    const { objectives: _o, note: _n, ...r } = run;
    if (r.q) r.q = r.q.map((/** @type {any} */ { note: _s, ...step }) => step);
    rest.scenario = r;
  }
  return { ...msg, state: rest };
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

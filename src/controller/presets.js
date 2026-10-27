// @ts-check
// Presets: `{ name, steps: [{ atSec, patch, glideMs }] }` (plan "V2-ready rules" seam 6). V1 presets have one step at 0;
// timed scenarios are just longer presets. Built-ins are synthetic. Saved presets live on the phone (localStorage).
import { validatePatch } from '../shared/schema.js';
import { validateGlideMsBy } from '../shared/scenario.js';

export const PRESET_KEY = 'sim.presets';
export const MAX_PRESETS = 40;
export const MAX_STEPS = 30;

/**
 * @typedef {{ atSec: number, patch: any, glideMs: number, glideMsBy?: Record<string, number> }} PresetStep
 * @typedef {{ name: string, steps: PresetStep[], builtin?: boolean }} Preset
 */

/** @param {number} [glideMs] @param {object} patient */
const one = (patient, glideMs = 30000) => [{ atSec: 0, patch: { patient }, glideMs }];

const NORMAL = {
  rhythm: 'sinus', hr: 80, spo2: 98, etco2: 38, rr: 14, temp: 36.8, nibp: { sys: 120, dia: 75 }, abp: { sys: 120, dia: 75 },
  pulse: true, st: 0, pvcPerMin: 0, etco2Shape: 'normal', spo2Quality: 'good', abpDamping: 'normal',
};

/** @type {Preset[]} */
export const BUILTIN_PRESETS = [
  { name: 'Normal', builtin: true, steps: one(NORMAL, 10000) },
  { name: 'Hypotension', builtin: true, steps: one({ rhythm: 'sinus_tachy', hr: 110, spo2: 96, nibp: { sys: 70, dia: 40 }, abp: { sys: 70, dia: 40 }, etco2: 30 }, 60000) },
  { name: 'Desaturation', builtin: true, steps: one({ rhythm: 'sinus_tachy', hr: 115, spo2: 82, rr: 26, etco2: 45 }, 60000) },
  { name: 'Anaphylaxis', builtin: true, steps: one({ rhythm: 'sinus_tachy', hr: 135, spo2: 88, nibp: { sys: 65, dia: 35 }, abp: { sys: 65, dia: 35 }, rr: 28, etco2: 28, etco2Shape: 'obstructive' }, 30000) },
  { name: 'VF arrest', builtin: true, steps: one({ rhythm: 'vf', hr: 0, spo2: 60, etco2: 10, nibp: { sys: 0, dia: 0 }, abp: { sys: 0, dia: 0 } }, 0) },
];

/**
 * Check one preset from storage or an imported file; returns a clean copy or null.
 * @param {any} raw
 * @returns {Preset | null}
 */
export function normalizePreset(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string') return null;
  const name = raw.name.trim();
  if (!name || name.length > 24) return null;
  if (!Array.isArray(raw.steps) || !raw.steps.length || raw.steps.length > MAX_STEPS) return null;
  /** @type {PresetStep[]} */
  const steps = [];
  for (const s of raw.steps) {
    if (!s || typeof s.atSec !== 'number' || !(s.atSec >= 0 && s.atSec <= 3600)) return null;
    const glideMs = s.glideMs ?? 0;
    if (typeof glideMs !== 'number' || !(glideMs >= 0 && glideMs <= 600000)) return null;
    const v = validatePatch(s.patch);
    if (!v.ok) return null;
    /** @type {PresetStep} */
    const step = { atSec: s.atSec, patch: v.patch, glideMs };
    if (s.glideMsBy !== undefined) {
      const b = validateGlideMsBy(s.glideMsBy);
      if (!b.ok) return null;
      if (Object.keys(b.by).length) step.glideMsBy = b.by;
    }
    steps.push(step);
  }
  steps.sort((a, b) => a.atSec - b.atSec);
  return { name, steps };
}

/** @typedef {{ getItem(k: string): string | null, setItem(k: string, v: string): void }} KV */

export class PresetStore {
  /** @param {KV | null} kv storage, or null when the browser blocks it (presets then live in memory only) */
  constructor(kv) {
    this.kv = kv;
    /** @type {Preset[]} */
    this.saved = [];
    this.load();
  }

  load() {
    try {
      const list = JSON.parse(this.kv?.getItem(PRESET_KEY) ?? '[]');
      this.saved = (Array.isArray(list) ? list : []).map(normalizePreset).filter((p) => p !== null).slice(0, MAX_PRESETS);
    } catch { this.saved = []; }
  }

  persist() {
    try { this.kv?.setItem(PRESET_KEY, JSON.stringify(this.saved)); } catch { /* storage full or blocked: keep in memory */ }
  }

  all() { return [...BUILTIN_PRESETS, ...this.saved]; }

  /**
   * Save or replace a preset by name (built-in names are not replaced).
   * @param {Preset} preset
   * @returns {boolean}
   */
  save(preset) {
    const clean = normalizePreset(preset);
    if (!clean || BUILTIN_PRESETS.some((b) => b.name === clean.name)) return false;
    const i = this.saved.findIndex((p) => p.name === clean.name);
    if (i >= 0) this.saved[i] = clean;
    else if (this.saved.length < MAX_PRESETS) this.saved.push(clean);
    else return false;
    this.persist();
    return true;
  }

  /** @param {string} name */
  remove(name) {
    this.saved = this.saved.filter((p) => p.name !== name);
    this.persist();
  }

  /** JSON of the saved presets, for export. */
  exportJson() {
    return JSON.stringify({ sim: 'presets', version: 1, presets: this.saved }, null, 1);
  }

  /**
   * Add presets from exported JSON (a list, or `{presets: [...]}`). Bad entries are skipped.
   * @param {string} text
   * @returns {{ added: number, skipped: number }}
   */
  importJson(text) {
    let data;
    try { data = JSON.parse(text); } catch { return { added: 0, skipped: 1 }; }
    const list = Array.isArray(data) ? data : Array.isArray(data?.presets) ? data.presets : [data];
    let added = 0;
    let skipped = 0;
    for (const raw of list) {
      const clean = normalizePreset(raw);
      if (clean && this.save(clean)) added++;
      else skipped++;
    }
    return { added, skipped };
  }
}

/**
 * Run a preset on one patient through the single action path. Steps at 0 s go out at once; later steps wait.
 * @param {Preset} preset
 * @param {(patch: object, glideMs?: number, p?: string, glideMsBy?: Record<string, number>) => unknown} act
 * @param {string | undefined} p patient id
 * @param {{ setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (id: any) => void }} [timers]
 * @returns {{ cancel: () => void }}
 */
export function runPreset(preset, act, p, timers = {}) {
  const set = timers.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clear = timers.clearTimer ?? ((id) => clearTimeout(id));
  /** @type {any[]} */
  const ids = [];
  for (const step of preset.steps) {
    if (step.atSec <= 0) act(step.patch, step.glideMs, p, step.glideMsBy);
    else ids.push(set(() => act(step.patch, step.glideMs, p, step.glideMsBy), step.atSec * 1000));
  }
  return { cancel: () => ids.forEach((id) => clear(id)) };
}

/**
 * Snapshot a patient as a one-step preset ("save current").
 * @param {string} name
 * @param {import('../shared/schema.js').Patient} pt
 * @param {number} glideMs
 * @returns {Preset}
 */
export function presetFromPatient(name, pt, glideMs) {
  return {
    name,
    steps: [{
      atSec: 0, glideMs,
      patch: {
        patient: {
          rhythm: pt.rhythm, hr: pt.hr, spo2: pt.spo2, etco2: pt.etco2, rr: pt.rr, temp: pt.temp,
          nibp: { sys: pt.nibp.sys, dia: pt.nibp.dia }, abp: { sys: pt.abp.sys, dia: pt.abp.dia },
          etco2Shape: pt.etco2Shape, spo2Quality: pt.spo2Quality, abpDamping: pt.abpDamping, pvcPerMin: pt.pvcPerMin,
        },
      },
    }],
  };
}

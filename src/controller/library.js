// @ts-check
// Scenario and drug-button library on the phone: built-in synthetic examples plus a per-device saved list (localStorage,
// `sim.scenarios` and `sim.drugs`). Files are `{ sim: 'library', version: 1, scenarios, drugs }` and are refused whole
// with a reason when anything is wrong (`validateLibraryFile`). Drug effects are teaching effects only, never doses.
import {
  LIBRARY_KIND, LIBRARY_VERSION, MAX_DRUGS, MAX_SCENARIOS, validateDrug, validateLibraryFile, validateScenario,
} from '../shared/scenario.js';

export const SCENARIO_KEY = 'sim.scenarios';
export const DRUG_KEY = 'sim.drugs';

/** @typedef {import('../shared/scenario.js').Scenario & { builtin?: boolean }} LibScenario */
/** @typedef {import('../shared/scenario.js').Drug & { builtin?: boolean }} LibDrug */
/** @typedef {import('./presets.js').KV} KV */

/** @type {LibScenario[]} */
export const BUILTIN_SCENARIOS = [
  {
    name: 'Slow bleed', builtin: true,
    steps: [
      { atSec: 0, glideMs: 30000, patch: { patient: { rhythm: 'sinus_tachy', hr: 95, nibp: { sys: 112, dia: 70 }, abp: { sys: 112, dia: 70 } } } },
      { atSec: 120, glideMs: 60000, patch: { patient: { hr: 112, spo2: 96, nibp: { sys: 92, dia: 55 }, abp: { sys: 92, dia: 55 }, etco2: 33 } } },
      { atSec: 120, glideMs: 60000, patch: { patient: { hr: 132, spo2: 94, nibp: { sys: 72, dia: 40 }, abp: { sys: 72, dia: 40 }, etco2: 28 } } },
    ],
  },
  {
    name: 'Apnoea on tap', builtin: true,
    steps: [
      { atSec: 0, glideMs: 5000, patch: { patient: { rhythm: 'sinus', hr: 78, spo2: 98, rr: 12, etco2: 38 } } },
      { onTap: true, glideMs: 90000, patch: { patient: { rr: 3, etco2: 58, spo2: 84, etco2Shape: 'rebreathing' } } },
      { atSec: 45, glideMs: 30000, patch: { patient: { rhythm: 'sinus_brady', hr: 48, spo2: 68 } } },
    ],
  },
  {
    name: 'Rhythm to arrest', builtin: true,
    steps: [
      { atSec: 0, glideMs: 0, patch: { patient: { rhythm: 'svt', hr: 180 } } },
      { atSec: 60, glideMs: 10000, patch: { patient: { rhythm: 'vt', pulse: true, hr: 200, nibp: { sys: 80, dia: 50 }, abp: { sys: 80, dia: 50 } } } },
      { onTap: true, glideMs: 0, patch: { patient: { rhythm: 'vf', hr: 0, spo2: 60, etco2: 10, nibp: { sys: 0, dia: 0 }, abp: { sys: 0, dia: 0 } } } },
    ],
  },
];

/** @type {LibDrug[]} */
export const BUILTIN_DRUGS = [
  { name: 'Vasopressor', builtin: true, note: 'Raises blood pressure, heart rate barely changes', glideMs: 20000, effects: { nibp: { sys: { add: 25 }, dia: { add: 15 } }, abp: { sys: { add: 25 }, dia: { add: 15 } } } },
  { name: 'Beta blocker', builtin: true, note: 'Slows the heart, lowers pressure a little', glideMs: 45000, effects: { hr: { mul: 0.8 }, nibp: { sys: { add: -8 }, dia: { add: -5 } }, abp: { sys: { add: -8 }, dia: { add: -5 } } } },
  { name: 'Anticholinergic', builtin: true, note: 'Speeds up a slow heart', glideMs: 20000, effects: { hr: { mul: 1.35 } } },
  { name: 'Opioid', builtin: true, note: 'Slows breathing, EtCO2 rises', glideMs: 40000, effects: { rr: { mul: 0.6 }, etco2: { add: 6 }, hr: { mul: 0.93 } } },
  { name: 'Vasodilator', builtin: true, note: 'Lowers blood pressure, heart rate rises a little', glideMs: 30000, effects: { nibp: { sys: { add: -25 }, dia: { add: -15 } }, abp: { sys: { add: -25 }, dia: { add: -15 } }, hr: { mul: 1.08 } } },
  { name: 'Fluid bolus', builtin: true, note: 'Raises pressure and filling pressure', glideMs: 60000, effects: { nibp: { sys: { add: 10 }, dia: { add: 5 } }, abp: { sys: { add: 10 }, dia: { add: 5 } }, cvp: { add: 2 } } },
];

export class LibraryStore {
  /** @param {KV | null} kv storage, or null when the browser blocks it (the list then lives in memory only) */
  constructor(kv) {
    this.kv = kv;
    /** @type {LibScenario[]} */
    this.scenarios = [];
    /** @type {LibDrug[]} */
    this.drugs = [];
    this.load();
  }

  load() {
    /** @param {string} key @param {(x: any) => any} check */
    const read = (key, check) => {
      try {
        const list = JSON.parse(this.kv?.getItem(key) ?? '[]');
        return (Array.isArray(list) ? list : []).map(check).filter(Boolean);
      } catch { return []; }
    };
    this.scenarios = read(SCENARIO_KEY, (x) => { const v = validateScenario(x); return v.ok ? v.scenario : null; }).slice(0, MAX_SCENARIOS);
    this.drugs = read(DRUG_KEY, (x) => { const v = validateDrug(x); return v.ok ? v.drug : null; }).slice(0, MAX_DRUGS);
  }

  persist() {
    try {
      this.kv?.setItem(SCENARIO_KEY, JSON.stringify(this.scenarios));
      this.kv?.setItem(DRUG_KEY, JSON.stringify(this.drugs));
    } catch { /* storage full or blocked: keep in memory */ }
  }

  allScenarios() { return [...BUILTIN_SCENARIOS, ...this.scenarios]; }
  allDrugs() { return [...BUILTIN_DRUGS, ...this.drugs]; }

  /** @param {string} name */
  removeScenario(name) { this.scenarios = this.scenarios.filter((x) => x.name !== name); this.persist(); }
  /** @param {string} name */
  removeDrug(name) { this.drugs = this.drugs.filter((x) => x.name !== name); this.persist(); }

  /** JSON of the saved scenarios and drugs, for export. */
  exportJson() {
    return JSON.stringify({ sim: LIBRARY_KIND, version: LIBRARY_VERSION, scenarios: this.scenarios, drugs: this.drugs }, null, 1);
  }

  /**
   * Add scenarios and drugs from a library file. A refused file adds nothing. Built-in names are taken; a saved
   * entry with the same name is replaced.
   * @param {string} text
   * @returns {{ ok: true, scenarios: number, drugs: number } | { ok: false, msg: string }}
   */
  importJson(text) {
    const v = validateLibraryFile(text);
    if (!v.ok) return v;
    const taken = [...BUILTIN_SCENARIOS, ...BUILTIN_DRUGS].map((x) => x.name);
    const clash = [...v.scenarios, ...v.drugs].find((x) => taken.includes(x.name));
    if (clash) return { ok: false, msg: `"${clash.name}" is a built-in name; rename it` };
    const scenarios = [...this.scenarios.filter((x) => !v.scenarios.some((n) => n.name === x.name)), ...v.scenarios];
    const drugs = [...this.drugs.filter((x) => !v.drugs.some((n) => n.name === x.name)), ...v.drugs];
    if (scenarios.length > MAX_SCENARIOS || drugs.length > MAX_DRUGS) return { ok: false, msg: `the device list holds at most ${MAX_SCENARIOS} scenarios and ${MAX_DRUGS} drugs` };
    this.scenarios = scenarios;
    this.drugs = drugs;
    this.persist();
    return { ok: true, scenarios: v.scenarios.length, drugs: v.drugs.length };
  }
}

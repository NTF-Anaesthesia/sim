// @ts-check
// Monitor modules (plan seam 3): a module is one measurement the monitor can show, with an optional wave (by wave id)
// and numeric "parts" that turn the current values into what a cell prints. The view and layout only know this shape,
// so CVP/PAP later are `registry.register({...})` calls. A registry is made per monitor; nothing registers on import.
import { rhythmInfo } from '../engine/beats.js';
import { ageText, mapOf } from '../engine/nibp.js';
import { BIS_MIN_SQI } from '../shared/schema.js';

/**
 * @typedef {{
 *   label: string, color: string, main: string, sub: string, unit: string, param: string,
 *   limits: [number, number] | null, off: boolean, small: string
 * }} NumView what a numeric cell prints; `color` is a theme colour key, `param` the alarm param that makes it flash
 * @typedef {{
 *   patient: import('../shared/schema.js').Patient, state: import('../shared/schema.js').RoomState,
 *   v: Record<string, any>, nibp: ReturnType<import('../engine/nibp.js').NibpMachine['tick']>, nowMs: number,
 *   units: { co2: string, temp: string }, theme: Record<string, any>
 * }} NumCtx
 * @typedef {{
 *   id: string, wave?: string,
 *   parts: Record<string, (c: NumCtx) => NumView>,
 *   skip?: (part: string, modules: string[]) => boolean
 * }} ModuleDef
 */

export function createModuleRegistry() {
  /** @type {Map<string, ModuleDef>} */
  const defs = new Map();
  return {
    /** @param {ModuleDef} def */
    register(def) { defs.set(def.id, def); },
    /** @param {string} id */
    get(id) { return defs.get(id); },
    ids() { return [...defs.keys()]; },
  };
}

/** @typedef {ReturnType<typeof createModuleRegistry>} ModuleRegistry */

/** Below this signal quality the depth number is not shown (a poor signal gives no reliable index). */
export { BIS_MIN_SQI };

const INT = (/** @type {number | null} */ v) => (v === null || !Number.isFinite(v) ? '---' : String(Math.round(v)));
const label = (/** @type {NumCtx} */ c, /** @type {string} */ id) => c.theme.labels[id] ?? id;
const unit = (/** @type {NumCtx} */ c, /** @type {string} */ id) => c.theme.labels.units[id] ?? '';
const lim = (/** @type {NumCtx} */ c, /** @type {string} */ key) => c.state.alarms.limits[key] ?? null;

/** @type {(c: NumCtx) => NumView} */
const rrView = (c) => ({
  label: label(c, 'rr'), color: 'rr', main: INT(c.v.rr), sub: '', unit: unit(c, 'rr'), param: 'rr',
  limits: lim(c, 'rr'), off: c.v.rr === null, small: '',
});

/** @param {ModuleRegistry} registry */
export function registerBuiltinModules(registry) {
  registry.register({
    id: 'ecg', wave: 'ecg',
    parts: {
      numeric: (c) => ({
        label: label(c, 'ecg'), color: 'hr', main: INT(c.v.hr), unit: unit(c, 'hr'), param: 'hr',
        sub: c.v.hr === null ? '' : (c.patient.rhythm === 'sinus' ? '' : rhythmInfo(c.patient.rhythm).label),
        limits: lim(c, 'hr'), off: c.v.hr === null, small: '',
      }),
    },
  });
  registry.register({ id: 'ecg2', wave: 'ecg2', parts: {} }); // a second ECG lead lane; its label is the theme's wave label
  registry.register({
    id: 'spo2', wave: 'spo2',
    parts: {
      numeric: (c) => ({
        label: label(c, 'spo2'), color: 'spo2', main: INT(c.v.spo2), sub: '', unit: unit(c, 'spo2'), param: 'spo2',
        limits: lim(c, 'spo2'), off: c.v.spo2 === null, small: '',
      }),
    },
  });
  registry.register({
    id: 'etco2', wave: 'etco2',
    parts: {
      numeric: (c) => {
        const kpa = c.units.co2 === 'kPa';
        const v = c.v.etco2;
        const l = lim(c, 'etco2');
        return {
          label: label(c, 'etco2'), color: 'etco2', param: 'etco2', sub: '', off: v === null, small: '',
          main: v === null ? '---' : (kpa ? (v * 0.133322).toFixed(1) : INT(v)),
          unit: kpa ? 'kPa' : unit(c, 'etco2'),
          limits: l && kpa ? [Math.round(l[0] * 13.3322) / 100, Math.round(l[1] * 13.3322) / 100] : l,
        };
      },
      numeric2: rrView,
    },
    // the capnography RR is only shown when there is no module of its own for it
    skip: (part, modules) => part === 'numeric2' && modules.includes('rr'),
  });
  registry.register({ id: 'rr', parts: { numeric: rrView } });
  registry.register({
    id: 'temp',
    parts: {
      numeric: (c) => {
        const f = c.units.temp === 'F';
        const conv = (/** @type {number} */ x) => (f ? x * 1.8 + 32 : x);
        const l = lim(c, 'temp');
        return {
          label: label(c, 'temp'), color: 'temp', param: 'temp', sub: '', small: '', off: false,
          main: conv(c.v.temp).toFixed(c.theme.numerics.decimals?.temp ?? 1), unit: f ? '°F' : unit(c, 'temp'),
          limits: l ? [Math.round(conv(l[0]) * 10) / 10, Math.round(conv(l[1]) * 10) / 10] : null,
        };
      },
    },
  });
  registry.register({
    id: 'nibp',
    parts: {
      numeric: (c) => {
        const n = c.nibp;
        const base = { label: label(c, 'nibp'), color: 'nibp', param: 'nibp', unit: unit(c, 'nibp'), limits: lim(c, 'nibpSys') };
        if (c.patient.off?.nibp) return { ...base, main: '---', sub: '', off: true, small: 'CUFF OFF' };
        if (n.phase === 'inflating') return { ...base, main: '---', sub: '', off: false, small: 'INFLATING' };
        if (n.phase === 'measuring') return { ...base, main: '---', sub: '', off: false, small: 'MEASURING' };
        if (n.phase === 'failed') return { ...base, main: '---', sub: '', off: true, small: 'NIBP FAILED' };
        const sys = /** @type {number} */ (n.sys);
        const dia = /** @type {number} */ (n.dia);
        return {
          ...base, off: false, main: `${Math.round(sys)}/${Math.round(dia)}`, sub: `(${mapOf(sys, dia)})`,
          small: ageText(c.nowMs - n.at),
        };
      },
    },
  });
  registry.register({
    id: 'abp', wave: 'abp',
    parts: {
      numeric: (c) => {
        const a = c.v.abp;
        const l = lim(c, 'abpSys');
        return {
          label: label(c, 'abp'), color: 'abp', param: 'abp', unit: unit(c, 'abp'), limits: l, small: '',
          main: a ? `${Math.round(a.sys)}/${Math.round(a.dia)}` : '---', sub: a ? `(${mapOf(a.sys, a.dia)})` : '',
          off: !a,
        };
      },
    },
  });
  registry.register({
    id: 'abp2', wave: 'abp2',
    parts: {
      numeric: (c) => {
        const a = c.v.abp2;
        const l = lim(c, 'abp2Sys');
        return {
          label: c.patient.abp2Label || label(c, 'abp2'), color: 'abp2', param: 'abp2', unit: unit(c, 'abp2'), limits: l, small: '',
          main: a ? `${Math.round(a.sys)}/${Math.round(a.dia)}` : '---', sub: a ? `(${mapOf(a.sys, a.dia)})` : '',
          off: !a,
        };
      },
    },
  });
  registry.register({
    id: 'cvp', wave: 'cvp',
    parts: {
      numeric: (c) => {
        const v = c.v.cvp;
        return {
          label: label(c, 'cvp'), color: 'cvp', param: 'cvp', unit: unit(c, 'cvp'), limits: lim(c, 'cvp'), small: '', sub: '',
          main: v === null || v === undefined ? '---' : v.toFixed(0), off: v === null || v === undefined,
        };
      },
    },
  });
  registry.register({
    id: 'bis', wave: 'eeg',
    parts: {
      numeric: (c) => {
        const v = c.v.bis;
        const p = c.patient;
        const poor = v !== null && v !== undefined && p.bisSqi < BIS_MIN_SQI;
        const sensorOff = v === null || v === undefined;
        return {
          label: label(c, 'bis'), color: 'bis', param: 'bis', unit: unit(c, 'bis'), limits: lim(c, 'bis'), sub: '',
          main: sensorOff || poor ? '---' : INT(v), off: sensorOff || poor,
          small: sensorOff ? 'SENSOR OFF' : `SQI ${Math.round(p.bisSqi)}  EMG ${Math.round(p.bisEmg)}  SR ${Math.round(p.bisSr)}${poor ? '  POOR SIGNAL' : ''}`,
        };
      },
    },
  });
}

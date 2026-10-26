// @ts-check
// Built-in themes: the default and a second generic one with another layout and palette (numerics on the left, waves
// on the right, light background, grid, monospace). It exists to prove the schema moves every module and colour.
import { DEFAULT_THEME } from './default.js';

/** @type {Record<string, any>} */
export const LIGHT_THEME = {
  themeSchema: 1,
  name: 'Generic light',
  background: '#f3f1ea',
  font: { family: 'ui-monospace, Menlo, Consolas, monospace', numericWeight: 800, labelWeight: 600, numericScale: 0.9, labelScale: 1.1 },
  colors: {
    ecg: '#0b6b1e', ecg2: '#0b6b1e', spo2: '#0b5cad', etco2: '#8a6100', abp: '#b3261e', abp2: '#b25a1e', cvp: '#1e4fb3', bis: '#6a3fb5', eeg: '#6a3fb5',
    o2: '#444444', gas: '#6f2fb3', n2o: '#1e3fb3', tof: '#a02a8a',
    nibp: '#222222', rr: '#8a6100', temp: '#222222', hr: '#0b6b1e',
    alarmHigh: '#d32f2f', alarmMed: '#f2b300', alarmLow: '#1e88e5', text: '#444444',
    grid: '#d9d4c3', flashText: '#ffffff',
  },
  layout: {
    grid: { columns: 12, rows: 12, gap: 8 },
    cells: [
      { module: 'ecg', part: 'wave', x: 4, y: 1, w: 8, h: 3, stack: 'waves' },
      { module: 'ecg2', part: 'wave', x: 4, y: 4, w: 8, h: 2, stack: 'waves' },
      { module: 'spo2', part: 'wave', x: 4, y: 4, w: 8, h: 2, stack: 'waves' },
      { module: 'abp', part: 'wave', x: 4, y: 6, w: 8, h: 2, stack: 'waves' },
      { module: 'abp2', part: 'wave', x: 4, y: 6, w: 8, h: 2, stack: 'waves' },
      { module: 'cvp', part: 'wave', x: 4, y: 6, w: 8, h: 2, stack: 'waves' },
      { module: 'bis', part: 'wave', x: 4, y: 6, w: 8, h: 2, stack: 'waves' },
      { module: 'etco2', part: 'wave', x: 4, y: 8, w: 8, h: 1.5, stack: 'waves' },
      { module: 'gas', part: 'wave', x: 4, y: 8, w: 8, h: 1.5, stack: 'waves' },
      { module: 'o2', part: 'wave', x: 4, y: 8, w: 8, h: 1.5, stack: 'waves' },
      { module: 'nibp', part: 'numeric', x: 4, y: 9.5, w: 8, h: 2.5 },
      { module: 'ecg', part: 'numeric', x: 0, y: 1, w: 4, h: 2.5, stack: 'numbers' },
      { module: 'spo2', part: 'numeric', x: 0, y: 3.5, w: 4, h: 2.5, stack: 'numbers' },
      { module: 'abp', part: 'numeric', x: 0, y: 6, w: 4, h: 2.5, stack: 'numbers' },
      { module: 'abp2', part: 'numeric', x: 0, y: 6, w: 4, h: 2.5, stack: 'numbers' },
      { module: 'cvp', part: 'numeric', x: 0, y: 6, w: 4, h: 2.5, stack: 'numbers' },
      { module: 'bis', part: 'numeric', x: 0, y: 6, w: 4, h: 2.5, stack: 'numbers' },
      { module: 'etco2', part: 'numeric', x: 0, y: 8.5, w: 4, h: 1.5, stack: 'numbers' },
      { module: 'etco2', part: 'numeric2', x: 0, y: 10, w: 4, h: 1, stack: 'numbers' },
      { module: 'rr', part: 'numeric', x: 0, y: 10, w: 4, h: 1, stack: 'numbers' },
      { module: 'temp', part: 'numeric', x: 0, y: 11, w: 4, h: 1, stack: 'numbers' },
      { module: 'gas', part: 'numeric', x: 0, y: 11, w: 4, h: 1, stack: 'numbers' },
      { module: 'gas', part: 'numeric2', x: 0, y: 11, w: 4, h: 1, stack: 'numbers' },
      { module: 'gas', part: 'numeric3', x: 0, y: 11, w: 4, h: 1, stack: 'numbers' },
      { module: 'tof', part: 'numeric', x: 0, y: 11, w: 4, h: 1, stack: 'numbers' },
    ],
    alarmBar: { x: 0, y: 0, w: 12, h: 1 },
  },
  waves: {
    speedMmPerSec: 25, pxPerMm: 3, lineWidth: 2.5, sweepGapPx: 18, fill: false, grid: true,
    ecg: { speed: 25, gain: 1 }, ecg2: { speed: 25, gain: 1 }, spo2: { speed: 25, gain: 1 }, etco2: { speed: 12.5, gain: 1 }, abp: { speed: 25, gain: 1 }, abp2: { speed: 25, gain: 1 }, cvp: { speed: 25, gain: 1 }, eeg: { speed: 25, gain: 1 },
    gas: { speed: 12.5, gain: 1 }, o2: { speed: 12.5, gain: 1 },
  },
  audio: { alarm: { volume: 1 }, qrs: { volume: 0.5 }, spo2: { volume: 0.5 } },
  numerics: { showLimits: true, limitsPosition: 'below', decimals: { temp: 1 }, fontScale: 1 },
  nibp: { inflateMs: 4000, measureMs: 6000 },
  labels: {
    ecg: 'Pulse', spo2: 'Sat', etco2: 'CO2', rr: 'Resp', nibp: 'Cuff', temp: 'Temp', abp: 'Art', abp2: 'Art 2', cvp: 'CVP', o2: 'O2', gas: 'Agent', n2o: 'N2O', tof: 'TOF', bis: 'BIS',
    units: { hr: '/min', spo2: '%', etco2: 'mmHg', rr: '/min', temp: '°C', nibp: 'mmHg', abp: 'mmHg', abp2: 'mmHg', cvp: 'mmHg', o2: '%', gas: '%', n2o: '%', tof: '/4', bis: '' },
    wave: { ecg: 'ECG', ecg2: 'V1', spo2: 'SpO2', etco2: 'CO2', abp: 'ART', abp2: 'ART2', cvp: 'CVP', gas: 'AGENT', o2: 'O2', bis: 'EEG' },
    off: { ecg: 'LEADS OFF', ecg2: 'LEADS OFF', spo2: 'PROBE OFF', etco2: 'CO2 LINE OFF', abp: 'ART LINE OFF', abp2: 'ART2 LINE OFF', cvp: 'CVP LINE OFF', gas: 'GAS LINE OFF', bis: 'BIS SENSOR OFF' },
  },
  alarmStyle: { barPosition: 'top-center', flashHz: 1.5, limitStyle: 'bold', tones: 'soft', toneHz: { high: 880, medium: 700, low: 560 } },
};

/** @type {{ id: string, theme: Record<string, any> }[]} */
export const BUILTIN_THEMES = [
  { id: 'default', theme: DEFAULT_THEME },
  { id: 'light', theme: LIGHT_THEME },
];

/** @param {unknown} id @returns {Record<string, any> | null} */
export function builtinTheme(id) {
  return BUILTIN_THEMES.find((b) => b.id === id)?.theme ?? null;
}

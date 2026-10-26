// @ts-check
// The editable fields of a theme: one table that drives the editor panel and the range checks in resolve.js, so the
// two cannot drift apart. Values only; there is no field that takes CSS or markup.

/**
 * @typedef {{
 *   path: string, label: string, group: string, type: 'color' | 'number' | 'text' | 'select' | 'bool' | 'numlist',
 *   min?: number, max?: number, step?: number, options?: string[], maxLen?: number, maxItems?: number
 * }} Field
 */

const PARAMS = /** @type {const} */ (['ecg', 'spo2', 'etco2', 'abp', 'nibp', 'rr', 'temp', 'hr']);
const PARAM_NAMES = { ecg: 'ECG', spo2: 'SpO2', etco2: 'EtCO2', abp: 'Art line', nibp: 'NIBP', rr: 'RR', temp: 'Temp', hr: 'HR' };
const WAVES = /** @type {const} */ (['ecg', 'spo2', 'etco2', 'abp']);
const WAVE_NAMES = { ecg: 'ECG', spo2: 'Pleth', etco2: 'CO2', abp: 'Art line' };

/** Waves that have a scale in real units: allowed range of a reference line and its unit (the others are unitless). */
const SCALE_RANGE = /** @type {Record<string, [number, number, string]>} */ ({ ecg: [-2, 5, 'mV'], etco2: [0, 100, 'mmHg'], abp: [0, 300, 'mmHg'] });

/** Safe font stacks offered in the editor; a file may use any value that passes FONT_PATTERN. */
export const FONT_CHOICES = ['system-ui, sans-serif', 'Georgia, serif', 'ui-monospace, Menlo, Consolas, monospace', 'Arial, Helvetica, sans-serif'];
/** Letters, digits, spaces, commas, quotes, dots and hyphens only: nothing that could close a CSS value. */
export const FONT_PATTERN = /^[\w\s,'".-]{1,120}$/;
/** Label text: no angle brackets or backslashes. */
export const LABEL_PATTERN = /^[^<>\\{}]{0,24}$/;

/** @type {Field[]} */
export const FIELDS = [
  { path: 'background', label: 'Background', group: 'Colours', type: 'color' },
  ...PARAMS.map((p) => /** @type {Field} */ ({ path: `colors.${p}`, label: PARAM_NAMES[p], group: 'Colours', type: 'color' })),
  { path: 'colors.alarmHigh', label: 'Alarm high', group: 'Colours', type: 'color' },
  { path: 'colors.alarmMed', label: 'Alarm medium', group: 'Colours', type: 'color' },
  { path: 'colors.alarmLow', label: 'Alarm low', group: 'Colours', type: 'color' },
  { path: 'colors.text', label: 'Other text', group: 'Colours', type: 'color' },
  { path: 'colors.grid', label: 'Grid lines', group: 'Colours', type: 'color' },
  { path: 'colors.flashText', label: 'Text on alarm bar', group: 'Colours', type: 'color' },

  { path: 'font.family', label: 'Font', group: 'Fonts', type: 'select', options: FONT_CHOICES, maxLen: 120 },
  { path: 'font.numericScale', label: 'Numeric size', group: 'Fonts', type: 'number', min: 0.3, max: 3, step: 0.05 },
  { path: 'font.labelScale', label: 'Label size', group: 'Fonts', type: 'number', min: 0.3, max: 3, step: 0.05 },
  { path: 'font.waveLabelScale', label: 'Wave caption size', group: 'Fonts', type: 'number', min: 0.3, max: 3, step: 0.05 },
  { path: 'font.numericWeight', label: 'Numeric weight', group: 'Fonts', type: 'number', min: 100, max: 900, step: 100 },
  { path: 'font.labelWeight', label: 'Label weight', group: 'Fonts', type: 'number', min: 100, max: 900, step: 100 },
  { path: 'labels.colorMode', label: 'Caption colour', group: 'Fonts', type: 'select', options: ['parameter', 'text'] },
  { path: 'numerics.fontScale', label: 'All numerics size', group: 'Fonts', type: 'number', min: 0.3, max: 3, step: 0.05 },

  { path: 'layout.grid.columns', label: 'Grid columns', group: 'Layout', type: 'number', min: 1, max: 48, step: 1 },
  { path: 'layout.grid.rows', label: 'Grid rows', group: 'Layout', type: 'number', min: 1, max: 48, step: 1 },
  { path: 'layout.grid.gap', label: 'Gap (px)', group: 'Layout', type: 'number', min: 0, max: 40, step: 1 },
  { path: 'screen.mode', label: 'Screen', group: 'Layout', type: 'select', options: ['fill', 'fixed'] },
  { path: 'screen.width', label: 'Fixed screen width (px)', group: 'Layout', type: 'number', min: 320, max: 3840, step: 10 },
  { path: 'screen.height', label: 'Fixed screen height (px)', group: 'Layout', type: 'number', min: 240, max: 2160, step: 10 },
  { path: 'numerics.showLimits', label: 'Show alarm limits', group: 'Layout', type: 'bool' },
  { path: 'numerics.limitsPosition', label: 'Limits position', group: 'Layout', type: 'select', options: ['beside', 'below', 'left'] },
  { path: 'numerics.meanPosition', label: 'Mean pressure', group: 'Layout', type: 'select', options: ['below', 'inline'] },
  { path: 'cells.border.color', label: 'Cell border colour', group: 'Layout', type: 'color' },
  { path: 'cells.border.width', label: 'Cell border (px)', group: 'Layout', type: 'number', min: 0, max: 6, step: 1 },
  { path: 'cells.border.radius', label: 'Cell corner radius (px)', group: 'Layout', type: 'number', min: 0, max: 24, step: 1 },
  { path: 'cells.background', label: 'Cell background', group: 'Layout', type: 'color' },

  { path: 'waves.speedMmPerSec', label: 'Wave speed (mm/s)', group: 'Waves', type: 'number', min: 1, max: 100, step: 0.5 },
  { path: 'waves.lineWidth', label: 'Wave width (px)', group: 'Waves', type: 'number', min: 0.5, max: 8, step: 0.5 },
  { path: 'waves.pxPerMm', label: 'Pixels per mm', group: 'Waves', type: 'number', min: 1, max: 12, step: 0.5 },
  { path: 'waves.sweepGapPx', label: 'Sweep gap (px)', group: 'Waves', type: 'number', min: 0, max: 100, step: 1 },
  { path: 'waves.grid', label: 'Grid behind waves', group: 'Waves', type: 'bool' },
  ...WAVES.flatMap((w) => /** @type {Field[]} */ ([
    { path: `waves.${w}.speed`, label: `${WAVE_NAMES[w]} speed`, group: 'Waves', type: 'number', min: 1, max: 100, step: 0.5 },
    { path: `waves.${w}.gain`, label: `${WAVE_NAMES[w]} gain`, group: 'Waves', type: 'number', min: 0.1, max: 10, step: 0.1 },
    ...(w in SCALE_RANGE ? [/** @type {Field} */ ({ path: `waves.${w}.scaleLines`, label: `${WAVE_NAMES[w]} scale lines (${SCALE_RANGE[w][2]})`, group: 'Waves', type: 'numlist', min: SCALE_RANGE[w][0], max: SCALE_RANGE[w][1], maxItems: 4 })] : []),
  ])),

  ...PARAMS.filter((p) => p !== 'hr').map((p) => /** @type {Field} */ ({ path: `labels.${p}`, label: `${PARAM_NAMES[p]} label`, group: 'Labels', type: 'text', maxLen: 24 })),

  { path: 'alarmStyle.barPosition', label: 'Bar text position', group: 'Alarms', type: 'select', options: ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'] },
  { path: 'alarmStyle.flashHz', label: 'Flash rate (Hz)', group: 'Alarms', type: 'number', min: 0.2, max: 4, step: 0.1 },
  { path: 'alarmStyle.limitStyle', label: 'Limit text', group: 'Alarms', type: 'select', options: ['small', 'bold'] },
  { path: 'alarmStyle.tones', label: 'Tone wave', group: 'Alarms', type: 'select', options: ['iec', 'soft'] },
  { path: 'alarmStyle.toneHz.high', label: 'High tone (Hz)', group: 'Alarms', type: 'number', min: 200, max: 2000, step: 10 },
  { path: 'alarmStyle.toneHz.medium', label: 'Medium tone (Hz)', group: 'Alarms', type: 'number', min: 200, max: 2000, step: 10 },
  { path: 'alarmStyle.toneHz.low', label: 'Low tone (Hz)', group: 'Alarms', type: 'number', min: 200, max: 2000, step: 10 },
  { path: 'audio.alarm.volume', label: 'Alarm volume', group: 'Alarms', type: 'number', min: 0, max: 1, step: 0.05 },
  { path: 'audio.qrs.volume', label: 'Beep volume', group: 'Alarms', type: 'number', min: 0, max: 1, step: 0.05 },
  { path: 'audio.spo2.volume', label: 'SpO2 tone volume', group: 'Alarms', type: 'number', min: 0, max: 1, step: 0.05 },
  { path: 'nibp.inflateMs', label: 'NIBP inflate (ms)', group: 'Alarms', type: 'number', min: 0, max: 120000, step: 500 },
  { path: 'nibp.measureMs', label: 'NIBP measure (ms)', group: 'Alarms', type: 'number', min: 0, max: 120000, step: 500 },
];

/** @param {any} obj @param {string} path */
export function getPath(obj, path) {
  let cur = obj;
  for (const k of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** @param {Record<string, any>} obj @param {string} path @param {unknown} value */
export function setPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  cur[/** @type {string} */ (keys.at(-1))] = value;
}

/**
 * Why a value is not acceptable for a field, or '' when it is.
 * @param {Field} f @param {unknown} v
 */
export function fieldProblem(f, v) {
  if (f.type === 'number') {
    if (typeof v !== 'number' || !Number.isFinite(v)) return 'expected a number';
    if (v < /** @type {number} */ (f.min) || v > /** @type {number} */ (f.max)) return `must be between ${f.min} and ${f.max}`;
  } else if (f.type === 'numlist') {
    if (!Array.isArray(v) || v.length > /** @type {number} */ (f.maxItems)) return `expected a list of at most ${f.maxItems} numbers`;
    if (v.some((x) => typeof x !== 'number' || !Number.isFinite(x) || x < /** @type {number} */ (f.min) || x > /** @type {number} */ (f.max))) return `numbers must be between ${f.min} and ${f.max}`;
  } else if (f.type === 'bool') {
    if (typeof v !== 'boolean') return 'expected true or false';
  } else if (f.type === 'select') {
    if (typeof v !== 'string') return 'expected text';
    if (f.path === 'font.family') { if (!FONT_PATTERN.test(v)) return 'font names may use letters, digits, spaces, commas, quotes, dots and hyphens only'; }
    else if (!f.options?.includes(v)) return `must be one of ${f.options?.join(', ')}`;
  } else if (f.type === 'text') {
    if (typeof v !== 'string' || !LABEL_PATTERN.test(v)) return 'text up to 24 characters, no < > { } or backslash';
  }
  return '';
}

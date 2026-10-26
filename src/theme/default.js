// @ts-check
// The default theme (DESIGN.md section 8): generic colours on black. Everything the monitor draws comes from a theme
// object like this one; there are no colours, fonts or positions anywhere else. Additions to the schema (all optional,
// all with these defaults): colors.grid, waves.pxPerMm, waves.grid, numerics.fontScale, nibp.inflateMs/measureMs,
// layout.cells[].stack, labels.wave, labels.off, waveLabelScale, numerics.meanPosition, labels.colorMode, waves.<id>.scaleLines, cells.border/background; labels.rhythms is not a theme key (rhythm names live in the engine).

/** @type {Record<string, any>} */
export const DEFAULT_THEME = {
  themeSchema: 1,
  name: 'Generic dark',
  background: '#000000',
  font: { family: 'system-ui, sans-serif', numericWeight: 700, labelWeight: 500, numericScale: 1, labelScale: 1, waveLabelScale: 1 },
  colors: {
    ecg: '#00e000', spo2: '#00d8ff', etco2: '#ffe000', abp: '#ff3030',
    nibp: '#ffffff', rr: '#ffe000', temp: '#ffffff', hr: '#00e000',
    alarmHigh: '#ff2020', alarmMed: '#ffd000', alarmLow: '#00d8ff', text: '#c0c0c0',
    grid: '#16301a', flashText: '#000000',
  },
  layout: {
    grid: { columns: 12, rows: 12, gap: 6 },
    // `stack`: cells in one stack share the stack's area top to bottom in the order listed, so a module that is off
    // hands its space to the others. Heights are shares.
    cells: [
      { module: 'ecg', part: 'wave', x: 0, y: 0, w: 8, h: 3, stack: 'left' },
      { module: 'spo2', part: 'wave', x: 0, y: 3, w: 8, h: 2, stack: 'left' },
      { module: 'abp', part: 'wave', x: 0, y: 5, w: 8, h: 2, stack: 'left' },
      { module: 'etco2', part: 'wave', x: 0, y: 7, w: 8, h: 3, stack: 'left' },
      { module: 'nibp', part: 'numeric', x: 0, y: 10, w: 8, h: 2 },
      { module: 'ecg', part: 'numeric', x: 8, y: 1, w: 4, h: 2, stack: 'right' },
      { module: 'spo2', part: 'numeric', x: 8, y: 3, w: 4, h: 2, stack: 'right' },
      { module: 'abp', part: 'numeric', x: 8, y: 5, w: 4, h: 2, stack: 'right' },
      { module: 'etco2', part: 'numeric', x: 8, y: 7, w: 4, h: 2, stack: 'right' },
      { module: 'etco2', part: 'numeric2', x: 8, y: 9, w: 4, h: 1.5, stack: 'right' },
      { module: 'rr', part: 'numeric', x: 8, y: 9, w: 4, h: 1.5, stack: 'right' },
      { module: 'temp', part: 'numeric', x: 8, y: 10.5, w: 4, h: 1.5, stack: 'right' },
    ],
    alarmBar: { x: 8, y: 0, w: 4, h: 1 },
  },
  waves: {
    speedMmPerSec: 25, pxPerMm: 4, lineWidth: 2, sweepGapPx: 14, fill: false, grid: false,
    ecg: { speed: 25, gain: 1, scaleLines: [] }, spo2: { speed: 25, gain: 1 }, etco2: { speed: 12.5, gain: 1, scaleLines: [] },
    abp: { speed: 25, gain: 1, scaleLines: [] },
  },
  // `background` (optional, #rrggbb) is the colour behind each cell and is absent here so it follows the screen colour
  cells: { border: { color: '#404040', width: 0, radius: 0 } },
  audio: { alarm: { volume: 1 }, qrs: { volume: 0.5 }, spo2: { volume: 0.5 } },
  numerics: { showLimits: true, limitsPosition: 'beside', meanPosition: 'below', decimals: { temp: 1 }, fontScale: 1 },
  nibp: { inflateMs: 0, measureMs: 0 },
  labels: {
    colorMode: 'parameter',
    ecg: 'HR', spo2: 'SpO2', etco2: 'EtCO2', rr: 'RR', nibp: 'NIBP', temp: 'Temp', abp: 'ABP',
    units: { hr: '/min', spo2: '%', etco2: 'mmHg', rr: '/min', temp: '°C', nibp: 'mmHg', abp: 'mmHg' },
    wave: { ecg: 'II', spo2: 'Pleth', etco2: 'CO2', abp: 'ABP' },
    off: { ecg: 'LEADS OFF', spo2: 'PROBE OFF', etco2: 'CO2 LINE OFF', abp: 'ART LINE OFF' },
  },
  alarmStyle: { barPosition: 'top-right', flashHz: 1, limitStyle: 'small', tones: 'iec', toneHz: { high: 960, medium: 800, low: 640 } },
};

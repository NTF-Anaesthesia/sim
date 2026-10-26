// @ts-check
// Entry `waves`: wave synthesis from beat and breath events, and the wave registry. No side effects on import.
export { createWaveRegistry } from './registry.js';
export { registerBuiltinWaves } from './builtin.js';
export { WaveSource, LOOKAHEAD } from './source.js';
export { ecgBeat, ecgBase, ecgSample, plethSample, abpSample, capnoSample, upper, PLETH_DELAY, ABP_DELAY } from './shapes.js';
export { cvpSample, artLineSample, flushShape, FLUSH_HOLD, FLUSH_SHOW } from './lines.js';
export { shockEcg, shockPleth, SHOCK_SHOW } from './defib.js';

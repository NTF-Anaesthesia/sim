// @ts-check
// The built-in waves: ECG II, SpO2 pleth, arterial line, capnogram. `registerBuiltinWaves(registry)` adds them.
import { abpSample, capnoSample, ecgSample, plethSample } from './shapes.js';

/** @param {import('./registry.js').WaveRegistry} registry */
export function registerBuiltinWaves(registry) {
  registry.register({
    id: 'ecg',
    sample: (src, t) => ecgSample(src, t),
    range: (gain) => [-0.55 / gain, 1.35 / gain],
    blank: ({ patient }) => !!patient.off?.ecg,
  });
  registry.register({
    id: 'spo2',
    sample: (src, t, ctx) => plethSample(src, t, ctx.patient.spo2Quality),
    range: (gain) => [-0.1 / gain, 1.4 / gain],
    blank: ({ patient }) => !!patient.off?.spo2 || patient.spo2Quality === 'none',
  });
  registry.register({
    id: 'etco2',
    sample: (src, t) => capnoSample(src, t),
    range: (gain) => [-4 / gain, 60 / gain],
    blank: ({ patient }) => !!patient.off?.etco2,
  });
  registry.register({
    id: 'abp',
    sample: (src, t, ctx) => abpSample(src, t, ctx.patient.abpDamping),
    range: (gain) => [0, 200 / gain],
    blank: ({ patient }) => !!patient.off?.abp,
  });
}

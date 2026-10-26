// @ts-check
// The built-in waves: ECG II, SpO2 pleth, arterial line, capnogram, CVP, second arterial line. `registerBuiltinWaves(registry)` adds them.
import { shockEcg, shockPleth } from './defib.js';
import { artLineSample, cvpSample } from './lines.js';
import { capnoSample, ecgSample, plethSample } from './shapes.js';

/** @param {import('./registry.js').WaveRegistry} registry */
export function registerBuiltinWaves(registry) {
  registry.register({
    id: 'ecg',
    sample: (src, t) => shockEcg(src, t) ?? ecgSample(src, t),
    range: (gain) => [-0.55 / gain, 1.35 / gain],
    blank: ({ patient }) => !!patient.off?.ecg,
  });
  registry.register({
    id: 'spo2',
    sample: (src, t, ctx) => shockPleth(src, t) ?? plethSample(src, t, ctx.patient.spo2Quality),
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
    sample: (src, t, ctx) => artLineSample(src, t, 'abp', ctx.patient.abpDamping, ctx.patient.ppv ?? 0),
    range: (gain) => [0, 200 / gain],
    blank: ({ patient }) => !!patient.off?.abp,
  });
  registry.register({
    id: 'abp2',
    sample: (src, t, ctx) => artLineSample(src, t, 'abp2', ctx.patient.abpDamping, ctx.patient.ppv ?? 0),
    range: (gain) => [0, 200 / gain],
    blank: ({ patient }) => !!patient.off?.abp2,
  });
  registry.register({
    id: 'cvp',
    sample: (src, t, ctx) => cvpSample(src, t, ctx.d?.cvp ?? ctx.patient.cvp, ctx.patient.cvpV),
    range: (gain) => [-2 / gain, 24 / gain],
    blank: ({ patient }) => !!patient.off?.cvp,
  });
}

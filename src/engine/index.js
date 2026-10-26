// @ts-check
// Entry `engine`: pure functions on room state. No side effects on import.
export { displayed, glideValue, restartGlide, ease } from './glide.js';
export { pulseless, shown } from './rhythm.js';
export { BeatScheduler, RHYTHM_INFO, rhythmInfo, WENCKEBACH_PR, MOBITZ2_CONDUCTED, CHB_ATRIAL_RATE } from './beats.js';
export { BreathScheduler } from './breaths.js';
export { mulberry32 } from './rng.js';
export { wobble, jittered, JITTER_AMP } from './jitter.js';
export { evaluateAlarms, AlarmTracker, burstDue, PRIORITY, PRIORITY_NAME, SILENCE_MS, TONE_EVERY_MS, TONE_PULSES, NIBP_OVERDUE_MS } from './alarms.js';
export { NibpMachine, nibpCycleDue, mapOf, ageText } from './nibp.js';

// @ts-check
// Audio mixer (plan seam 4): one AudioContext with named channels (`alarm`, `qrs`, `spo2`), each with its own volume
// (theme default times the device setting). Tones are generated, no files. Browsers only allow sound after a tap, so
// the context is made in `enable()`, called from a button. No work on import.
import { TONE_PULSES } from '../engine/alarms.js';

export const CHANNELS = ['alarm', 'qrs', 'spo2', 'nibp'];
const TONE_HZ = { 3: 960, 2: 800, 1: 640 };

/**
 * SpO2 tone pitch on a log scale (half a semitone per percent) with a low clamp, so a falling SpO2 sounds lower.
 * @param {number} spo2
 */
export function spo2PitchHz(spo2) {
  const s = Math.max(70, Math.min(100, spo2));
  return 880 * 2 ** (((s - 100) * 0.5) / 12);
}

/** @typedef {{ startMs: number, freq: number, durMs: number }} AlarmPulse one pulse of an alarm burst */

/** IEC 60601-1-8 style limits on the fundamental (Hz). */
export const IEC_MIN_HZ = 150;
export const IEC_MAX_HZ = 1000;
/**
 * Relative amplitudes of the fundamental and its first four harmonics for the `iec` tone wave (a harmonic-rich pulse,
 * every harmonic within 8 dB of the fundamental, as the standard asks for at least four).
 */
export const IEC_HARMONICS = [1, 0.8, 0.6, 0.5, 0.4];
/** Attack and decay of each alarm pulse (s): soft edges, no click. */
export const PULSE_EDGE_SEC = 0.02;

/** Pulse start times (ms) and length per priority, IEC style. High 3 + 2 (the gap is one missing pulse), medium 3, low 2. */
const IEC_STARTS = { 3: [0, 250, 500, 1000, 1250], 2: [0, 400, 800], 1: [0, 400] };
const IEC_DUR_MS = { 3: 150, 2: 200, 1: 200 };

/**
 * One alarm burst as a list of pulses (pure). `pattern: "iec"` (default): high = 5 pulses in a 3 + 2 group, medium = 3
 * evenly spaced, low = 2; the fundamental is held to 150-1000 Hz and the high pitch is never below the medium pitch.
 * `pattern: "classic"`: the earlier bursts (high two groups of five, medium three, low two, 100 ms pulses) at the theme's
 * pitch as written. The repeat interval is `TONE_EVERY_MS` / `CLASSIC_TONE_EVERY_MS` in engine/alarms.js.
 * @param {number} priority 1..3
 * @param {{ pattern?: string, toneHz?: { high?: number, medium?: number, low?: number } }} [style] theme `alarmStyle`
 * @returns {AlarmPulse[]}
 */
export function alarmPattern(priority, style = {}) {
  /** @param {number} p */
  const pitch = (p) => {
    const named = /** @type {Record<number, 'high' | 'medium' | 'low'>} */ ({ 3: 'high', 2: 'medium', 1: 'low' })[p];
    const hz = style.toneHz?.[named];
    return typeof hz === 'number' && Number.isFinite(hz) && hz > 0 ? hz : /** @type {Record<number, number>} */ (TONE_HZ)[p];
  };
  if (!pitch(priority)) return [];
  if (style.pattern === 'classic') {
    const n = /** @type {Record<number, number>} */ (TONE_PULSES)[priority] ?? 0;
    const freq = pitch(priority);
    const out = [];
    for (let i = 0; i < n; i++) out.push({ startMs: i * 160 + (priority === 3 && i >= 5 ? 400 : 0), freq, durMs: 100 });
    return out;
  }
  /** @param {number} hz */
  const clamp = (hz) => Math.max(IEC_MIN_HZ, Math.min(IEC_MAX_HZ, hz));
  let freq = clamp(pitch(priority));
  if (priority === 3) freq = Math.max(freq, clamp(pitch(2)));
  const starts = /** @type {Record<number, number[]>} */ (IEC_STARTS)[priority] ?? [];
  const durMs = /** @type {Record<number, number>} */ (IEC_DUR_MS)[priority];
  return starts.map((startMs) => ({ startMs, freq, durMs }));
}

export class AudioMixer {
  /**
   * @param {{ volume: (channel: string) => number, makeContext?: () => AudioContext }} opts volume is theme x device, 0-1
   */
  constructor(opts) {
    this.volume = opts.volume;
    this.makeContext = opts.makeContext ?? (() => new AudioContext());
    /** @type {AudioContext | null} */
    this.ctx = null;
    /** @type {Map<string, GainNode>} */
    this.gains = new Map();
    /** sound was turned on with a tap and not turned off since */
    this.wanted = false;
    /** @type {PeriodicWave | null} made once per context for `harmonic` tones */
    this.harmonicWave = null;
  }

  get enabled() { return !!this.ctx && this.ctx.state === 'running'; }

  /** Call from a tap. */
  async enable() {
    this.wanted = true;
    if (!this.ctx) {
      this.ctx = this.makeContext();
      for (const ch of CHANNELS) {
        const gn = this.ctx.createGain();
        gn.gain.value = this.volume(ch);
        gn.connect(this.ctx.destination);
        this.gains.set(ch, gn);
      }
    }
    await this.ctx.resume();
  }

  async disable() { this.wanted = false; await this.ctx?.suspend(); }

  /**
   * After the page comes back (lid opened, tab shown): browsers may have suspended or interrupted the context. Resume it
   * if sound was on; a browser that still wants a tap refuses quietly and the Sound button stays off.
   */
  async resume() {
    const ctx = this.ctx;
    if (!this.wanted || !ctx || ctx.state === 'running' || ctx.state === 'closed') return;
    try { await ctx.resume(); } catch { /* needs a tap again */ }
  }

  /** Re-read the volumes (after a setting changed). */
  refreshVolumes() {
    for (const [ch, gn] of this.gains) gn.gain.value = this.volume(ch);
  }

  /**
   * @param {string} channel @param {number} hz @param {number} durSec @param {number} [delaySec]
   * @param {OscillatorType | 'harmonic'} [type] `harmonic` = the fundamental plus four harmonics (`IEC_HARMONICS`)
   * @param {number} [attackSec] rise time; the fall is 20 ms
   */
  tone(channel, hz, durSec, delaySec = 0, type = 'sine', attackSec = 0.008) {
    const ctx = this.ctx;
    const out = this.gains.get(channel);
    if (!ctx || !out || ctx.state !== 'running') return;
    const t0 = ctx.currentTime + delaySec;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    if (type === 'harmonic') {
      this.harmonicWave ??= ctx.createPeriodicWave(new Float32Array(IEC_HARMONICS.length + 1), Float32Array.from([0, ...IEC_HARMONICS]));
      osc.setPeriodicWave(this.harmonicWave);
    } else {
      osc.type = type;
    }
    osc.frequency.value = hz;
    const edge = Math.min(attackSec, durSec / 2);
    const fall = Math.min(PULSE_EDGE_SEC, durSec / 2);
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(0.35, t0 + edge);
    env.gain.setValueAtTime(0.35, t0 + durSec - fall);
    env.gain.linearRampToValueAtTime(0, t0 + durSec);
    osc.connect(env).connect(out);
    osc.start(t0);
    osc.stop(t0 + durSec + 0.02);
  }

  /** One heart beep. With an SpO2 value the pitch follows it (channel `spo2`); without, a fixed pitch (`qrs`). */
  beep(/** @type {number | null} */ spo2) {
    if (spo2 === null) this.tone('qrs', 700, 0.07);
    else this.tone('spo2', spo2PitchHz(spo2), 0.07);
  }

  /**
   * NIBP pump: a low, buzzing hum for the inflation (channel `nibp`).
   * @param {number} durSec
   */
  pump(durSec) {
    const ctx = this.ctx;
    const out = this.gains.get('nibp');
    if (!ctx || !out || ctx.state !== 'running' || !(durSec > 0)) return;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const lp = ctx.createBiquadFilter();
    const env = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(95, t0);
    osc.frequency.linearRampToValueAtTime(80, t0 + durSec); // the motor labours as the cuff fills
    lp.type = 'lowpass';
    lp.frequency.value = 600;
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(0.12, t0 + 0.05);
    env.gain.setValueAtTime(0.12, t0 + durSec - 0.05);
    env.gain.linearRampToValueAtTime(0, t0 + durSec);
    osc.connect(lp).connect(env).connect(out);
    osc.start(t0);
    osc.stop(t0 + durSec + 0.02);
  }

  /** Soft valve click for one deflation step. */
  click() { this.tone('nibp', 1800, 0.012, 0, 'square'); }

  /** Short tone when the NIBP reading is ready. */
  nibpDone() { this.tone('nibp', 880, 0.12); }

  /**
   * One alarm burst (`alarmPattern`): harmonic-rich pulses with soft 20 ms edges (`tones: "iec"`), or sine (`soft`).
   * @param {number} priority 1..3
   * @param {{ tones?: string, pattern?: string, toneHz?: { high?: number, medium?: number, low?: number } }} [style] theme `alarmStyle`
   */
  burst(priority, style = {}) {
    const type = style.tones === 'soft' ? 'sine' : 'harmonic';
    for (const p of alarmPattern(priority, style)) this.tone('alarm', p.freq, p.durMs / 1000, p.startMs / 1000, type, PULSE_EDGE_SEC);
  }
}

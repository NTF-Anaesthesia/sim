// @ts-check
// Audio mixer (plan seam 4): one AudioContext with named channels (`alarm`, `qrs`, `spo2`), each with its own volume
// (theme default times the device setting). Tones are generated, no files. Browsers only allow sound after a tap, so
// the context is made in `enable()`, called from a button. No work on import.
import { TONE_PULSES } from '../engine/alarms.js';

export const CHANNELS = ['alarm', 'qrs', 'spo2'];
const TONE_HZ = { 3: 960, 2: 800, 1: 640 };

/**
 * SpO2 tone pitch on a log scale (half a semitone per percent) with a low clamp, so a falling SpO2 sounds lower.
 * @param {number} spo2
 */
export function spo2PitchHz(spo2) {
  const s = Math.max(70, Math.min(100, spo2));
  return 880 * 2 ** (((s - 100) * 0.5) / 12);
}

/**
 * Pulse start offsets (seconds) of one alarm burst: high = two groups of five, medium = three, low = two.
 * @param {number} priority 1..3
 * @returns {number[]}
 */
export function burstPattern(priority) {
  const n = /** @type {Record<number, number>} */ (TONE_PULSES)[priority] ?? 0;
  const out = [];
  for (let i = 0; i < n; i++) out.push(i * 0.16 + (priority === 3 && i >= 5 ? 0.4 : 0));
  return out;
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
  }

  get enabled() { return !!this.ctx && this.ctx.state === 'running'; }

  /** Call from a tap. */
  async enable() {
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

  async disable() { await this.ctx?.suspend(); }

  /** Re-read the volumes (after a setting changed). */
  refreshVolumes() {
    for (const [ch, gn] of this.gains) gn.gain.value = this.volume(ch);
  }

  /**
   * @param {string} channel @param {number} hz @param {number} durSec @param {number} [delaySec]
   * @param {OscillatorType} [type]
   */
  tone(channel, hz, durSec, delaySec = 0, type = 'sine') {
    const ctx = this.ctx;
    const out = this.gains.get(channel);
    if (!ctx || !out || ctx.state !== 'running') return;
    const t0 = ctx.currentTime + delaySec;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.value = hz;
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(0.35, t0 + 0.008);
    env.gain.setValueAtTime(0.35, t0 + durSec - 0.02);
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

  /** @param {number} priority 1..3 */
  burst(priority) {
    const hz = /** @type {Record<number, number>} */ (TONE_HZ)[priority];
    if (!hz) return;
    for (const off of burstPattern(priority)) this.tone('alarm', hz, 0.1, off, 'triangle');
  }
}

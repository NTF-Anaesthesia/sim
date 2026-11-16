// @ts-check
// When the monitor sounds: the beat beep (from the pleth pulse with SpO2 on, from the QRS without) and the alarm tone
// step. Pure and DOM-free so node can test it; the AudioMixer makes the sound. No work on import.
import { burstDue } from '../engine/alarms.js';
import { PLETH_DELAY } from '../waves/shapes.js';

/**
 * Display times (seconds) of the beat beeps due in `(from, to]`.
 * `spo2Source` (SpO2 module on and its sensor on): SpO2 is the tone source, so a beep comes with each pleth pulse, at
 * the start of its upstroke (`PLETH_DELAY` after the R wave), and a beat with no pulse (PEA, asystole, VF, a dropped
 * beat, a pacing spike that did not capture) gives no beep, exactly as the pleth stays flat for it.
 * Otherwise one beep per QRS at the R wave (not for a P wave with no QRS or a lone pacing spike).
 * @param {readonly import('../engine/beats.js').Beat[]} beats sorted by time
 * @param {number} from @param {number} to
 * @param {boolean} spo2Source
 * @returns {number[]}
 */
export function beatBeeps(beats, from, to, spo2Source) {
  const lag = spo2Source ? PLETH_DELAY : 0;
  /** @type {number[]} */
  const out = [];
  // walk back from the newest beat; everything older than the window is done
  for (let i = beats.length - 1; i >= 0; i--) {
    const b = beats[i];
    const at = b.t + lag;
    if (at <= from) break;
    if (at > to) continue;
    if (spo2Source ? !b.pulse : b.kind === 'dropped' || b.kind === 'spike') continue;
    out.push(at);
  }
  return out.reverse();
}

/**
 * One tick of the alarm tone: whether a burst is due now, and the bookkeeping for it (`st` is updated in place).
 * Repeats while an alarm is active, restarts at once for a higher priority; a lower priority resets the ceiling.
 * The room link is deliberately not an input: while the connection is lost the monitor keeps judging its last known
 * state on its own clock, so its alarms keep sounding (as a real monitor's would when the network drops).
 * @param {{ priority: number, silenced: boolean }} av from `AlarmTracker.update`
 * @param {{ lastAt: number, lastPriority: number }} st
 * @param {number} nowMs server clock
 * @param {{ audioOn: boolean, pattern?: string }} o
 * @returns {boolean} true when a burst of `av.priority` should sound now
 */
export function alarmToneStep(av, st, nowMs, { audioOn, pattern }) {
  if (av.priority <= 0) st.lastPriority = 0;
  else if (av.priority < st.lastPriority) st.lastPriority = av.priority;
  if (!audioOn || !burstDue(av.priority, av.silenced, st, nowMs, pattern)) return false;
  st.lastAt = nowMs;
  st.lastPriority = av.priority;
  return true;
}

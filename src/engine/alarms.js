// @ts-check
// Alarm model (DESIGN.md section 7): evaluated on each monitor from the shown values and `alarms.limits`. Pure except
// `AlarmTracker`, which only remembers the silence it saw. Priorities follow the IEC 60601-1-8 idea: high (red),
// medium (yellow), low (cyan, technical notice).

export const PRIORITY = { none: 0, low: 1, medium: 2, high: 3 };
/** @type {Record<number, string>} */
export const PRIORITY_NAME = { 0: 'none', 1: 'low', 2: 'medium', 3: 'high' };
export const SILENCE_MS = 120000;
export const NIBP_OVERDUE_MS = 10 * 60000;
/** Repeat interval of the tone burst per priority (ms). */
export const TONE_EVERY_MS = { 3: 6000, 2: 12000, 1: 24000 };
/** Pulses per burst per priority. */
export const TONE_PULSES = { 3: 10, 2: 3, 1: 2 };

/**
 * @typedef {{ id: string, param: string, priority: number, text: string }} Alarm
 * @typedef {{
 *   hr: number | null, spo2: number | null, etco2: number | null, rr: number | null, temp: number | null,
 *   nibpSys: number | null, abpSys: number | null, cvp?: number | null, abp2Sys?: number | null, fio2?: number | null, etagMac?: number | null
 * }} AlarmValues the values the monitor shows (after jitter), null when blank
 */

/**
 * @param {import('../shared/schema.js').Patient} p
 * @param {import('../shared/schema.js').RoomState} state
 * @param {AlarmValues} v
 * @param {number} now server ms
 * @returns {Alarm[]} unsorted
 */
export function evaluateAlarms(p, state, v, now) {
  /** @type {Alarm[]} */
  const out = [];
  const mods = state.modules;
  const lim = state.alarms.limits;
  const off = p.off ?? {};
  const add = (/** @type {string} */ id, /** @type {string} */ param, /** @type {number} */ priority, /** @type {string} */ text) =>
    out.push({ id, param, priority, text });
  /** @param {string} id @param {string} param @param {string} name @param {number | null} val @param {string} key */
  const limit = (id, param, name, val, key, high = PRIORITY.medium) => {
    const l = lim[key];
    if (!l || val === null || !Number.isFinite(val)) return;
    if (val < l[0]) add(`${id}-low`, param, high, `${name} LOW`);
    else if (val > l[1]) add(`${id}-high`, param, high, `${name} HIGH`);
  };

  if (mods.includes('ecg')) {
    if (off.ecg) add('ecg-off', 'hr', PRIORITY.low, 'ECG LEADS OFF');
    else {
      const rhythmText = /** @type {Record<string, string>} */ ({
        asystole: 'ASYSTOLE', vf: 'VENT FIB', vt: 'VENT TACH', torsades: 'TORSADES',
      })[p.rhythm];
      if (rhythmText) add(`rhythm-${p.rhythm}`, 'hr', PRIORITY.high, rhythmText);
      else if (v.hr !== null) {
        const l = lim.hr;
        const out_ = l && (v.hr < l[0] || v.hr > l[1]);
        limit('hr', 'hr', 'HR', v.hr, 'hr', out_ && (v.hr < 40 || v.hr > 150) ? PRIORITY.high : PRIORITY.medium);
      }
    }
  }
  if (mods.includes('spo2')) {
    if (off.spo2) add('spo2-off', 'spo2', PRIORITY.low, 'SPO2 PROBE OFF');
    else if (v.spo2 === null) add('spo2-nopulse', 'spo2', PRIORITY.low, 'SPO2 NO PULSE');
    else {
      const l = lim.spo2;
      limit('spo2', 'spo2', 'SPO2', v.spo2, 'spo2', l && v.spo2 < l[0] - 5 ? PRIORITY.high : PRIORITY.medium);
    }
  }
  if (mods.includes('etco2') || mods.includes('rr')) {
    if (off.etco2) add('etco2-off', 'etco2', PRIORITY.low, 'CO2 LINE OFF');
    else {
      if (mods.includes('etco2')) limit('etco2', 'etco2', 'ETCO2', v.etco2, 'etco2');
      if (v.rr === 0) add('apnea', 'rr', PRIORITY.high, 'APNEA');
      else limit('rr', 'rr', 'RR', v.rr, 'rr');
    }
  }
  if (mods.includes('nibp') && !off.nibp) {
    limit('nibp', 'nibp', 'NIBP SYS', v.nibpSys, 'nibpSys');
    if (now - p.nibpRead.at > NIBP_OVERDUE_MS) add('nibp-overdue', 'nibp', PRIORITY.low, 'NIBP OVERDUE');
  }
  if (mods.includes('temp')) limit('temp', 'temp', 'TEMP', v.temp, 'temp');
  if (mods.includes('abp')) {
    if (off.abp) add('abp-off', 'abp', PRIORITY.low, 'ABP LINE OFF');
    else if (v.abpSys === null) add('abp-nopulse', 'abp', PRIORITY.low, 'ABP NO PULSE');
    else limit('abp', 'abp', 'ABP SYS', v.abpSys, 'abpSys');
  }
  if (mods.includes('abp2')) {
    if (off.abp2) add('abp2-off', 'abp2', PRIORITY.low, 'ABP2 LINE OFF');
    else if ((v.abp2Sys ?? null) === null) add('abp2-nopulse', 'abp2', PRIORITY.low, 'ABP2 NO PULSE');
    else limit('abp2', 'abp2', 'ABP2 SYS', v.abp2Sys ?? null, 'abp2Sys');
  }
  if (mods.includes('cvp')) {
    if (off.cvp) add('cvp-off', 'cvp', PRIORITY.low, 'CVP LINE OFF');
    else limit('cvp', 'cvp', 'CVP', v.cvp ?? null, 'cvp');
  }
  if (mods.includes('gas') || mods.includes('o2')) {
    if (off.gas) add('gas-off', 'fio2', PRIORITY.low, 'GAS LINE OFF');
    else {
      const fi = v.fio2 ?? null;
      if (fi !== null && fi < 21) add('fio2-hypoxic', 'fio2', PRIORITY.high, 'FIO2 LOW');
      else limit('fio2', 'fio2', 'FIO2', fi, 'fio2');
      // the agent limit is in age-adjusted MAC, so one pair serves every agent
      if (mods.includes('gas') && p.agent && p.agent !== 'none') limit('etagent', 'etagent', 'ET AGENT', v.etagMac ?? null, 'etagent');
    }
  }
  return out;
}

/**
 * @typedef {{
 *   master: boolean, alarms: Alarm[], top: Alarm | null, priority: number, silenced: boolean, silenceLeftMs: number,
 *   flashParams: Set<string>
 * }} AlarmView
 */

/** Remembers which silence the monitor saw and the highest priority active at that moment. */
export class AlarmTracker {
  constructor() {
    this.sil = 0;
    this.floor = 0;
    this.broken = false;
  }

  /**
   * @param {Alarm[]} alarms
   * @param {{ enabled: boolean, silencedUntil: number }} cfg
   * @param {number} now server ms
   * @returns {AlarmView}
   */
  update(alarms, cfg, now) {
    if (!cfg.enabled) {
      return { master: false, alarms: [], top: null, priority: 0, silenced: false, silenceLeftMs: 0, flashParams: new Set() };
    }
    const sorted = [...alarms].sort((a, b) => b.priority - a.priority);
    const priority = sorted[0]?.priority ?? 0;
    let silenced = false;
    let silenceLeftMs = 0;
    if (cfg.silencedUntil > now) {
      if (cfg.silencedUntil !== this.sil) {
        this.sil = cfg.silencedUntil;
        this.floor = priority;
        this.broken = false;
      } else if (priority > this.floor) {
        this.broken = true;
      }
      silenced = !this.broken;
      silenceLeftMs = silenced ? cfg.silencedUntil - now : 0;
    } else {
      this.sil = 0;
    }
    const flashParams = new Set(sorted.filter((a) => a.priority >= PRIORITY.medium).map((a) => a.param));
    return { master: true, alarms: sorted, top: sorted[0] ?? null, priority, silenced, silenceLeftMs, flashParams };
  }
}

/**
 * Should a tone burst start now? Repeats while active, starts at once for a higher priority than the last burst.
 * @param {number} priority active priority (0 = none)
 * @param {boolean} silenced
 * @param {{ lastAt: number, lastPriority: number }} st last burst
 * @param {number} nowMs
 */
export function burstDue(priority, silenced, st, nowMs) {
  if (priority <= 0 || silenced) return false;
  if (priority > st.lastPriority) return true;
  const every = /** @type {Record<number, number>} */ (TONE_EVERY_MS)[priority];
  return nowMs - st.lastAt >= every;
}

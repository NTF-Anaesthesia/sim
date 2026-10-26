// @ts-check
// Per-device settings in one namespaced store (`sim.settings.*`, plan seam 9). Off by default, never sent to the room.
import { DEFAULT_UNITS } from './params.js';

export const SETTINGS_PREFIX = 'sim.settings.';

/** @typedef {import('./presets.js').KV} KV */
/** @typedef {import('./params.js').Units} Units */

export class Settings {
  /** @param {KV | null} kv */
  constructor(kv) { this.kv = kv; /** @type {Map<string, any>} */ this.mem = new Map(); }

  /** @param {string} key @param {any} fallback */
  get(key, fallback) {
    if (this.mem.has(key)) return this.mem.get(key);
    try {
      const raw = this.kv?.getItem(SETTINGS_PREFIX + key);
      if (raw !== null && raw !== undefined) return JSON.parse(raw);
    } catch { /* blocked or damaged: fall back */ }
    return fallback;
  }

  /** @param {string} key @param {any} value */
  set(key, value) {
    this.mem.set(key, value);
    try { this.kv?.setItem(SETTINGS_PREFIX + key, JSON.stringify(value)); } catch { /* memory only */ }
  }

  /** @returns {Units} */
  units() {
    const u = this.get('units', DEFAULT_UNITS) ?? DEFAULT_UNITS;
    return { co2: u.co2 === 'kPa' ? 'kPa' : 'mmHg', temp: u.temp === 'F' ? 'F' : 'C' };
  }
}

/** The page's localStorage, or null when the browser blocks it. */
export function browserStorage() {
  try { return window.localStorage; } catch { return null; }
}

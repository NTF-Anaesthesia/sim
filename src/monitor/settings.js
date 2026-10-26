// @ts-check
// Per-device settings (plan seam 9): one namespaced store, `sim.settings.<key>`, values as JSON. Storage can be missing
// or throw (private windows), so every read and write is guarded and the monitor works without it.

/** @typedef {{ getItem(k: string): string | null, setItem(k: string, v: string): void, removeItem(k: string): void }} StorageLike */

export const SETTINGS_NS = 'sim.settings.';

/** @returns {StorageLike | null} */
function browserStorage() {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

/**
 * Keys in use: `units` { co2: 'mmHg' | 'kPa', temp: 'C' | 'F' }, `vol.<channel>` 0-1, `sweep.<wave>` mm/s,
 * `gain.<wave>`, `jitter` boolean, `theme` (S4).
 * @param {StorageLike | null} [storage]
 */
export function createSettings(storage) {
  const st = storage === undefined ? browserStorage() : storage;
  return {
    /**
     * @template T
     * @param {string} key @param {T} fallback
     * @returns {T}
     */
    get(key, fallback) {
      try {
        const raw = st?.getItem(SETTINGS_NS + key);
        return raw == null ? fallback : /** @type {T} */ (JSON.parse(raw));
      } catch { return fallback; }
    },
    /** @param {string} key @param {unknown} value */
    set(key, value) {
      try { st?.setItem(SETTINGS_NS + key, JSON.stringify(value)); } catch { /* storage unavailable */ }
    },
    /** @param {string} key */
    remove(key) {
      try { st?.removeItem(SETTINGS_NS + key); } catch { /* storage unavailable */ }
    },
  };
}

/** @typedef {ReturnType<typeof createSettings>} Settings */

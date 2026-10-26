// @ts-check
// Which theme a monitor shows. A device choice (kept in `sim.settings.theme`) wins; with none, the room's theme
// (`theme: 'custom'` plus `themeJson`, sent from a phone) is used; with neither, the default. Pure given a settings object.
import { builtinTheme } from './builtin.js';

/**
 * Device choice: `{ id: 'default' | <built-in id> }` or `{ id: 'custom', json }`; null means follow the room.
 * @typedef {{ id: string, json?: Record<string, any> } | null} DevicePick
 */

/** @param {unknown} v @returns {DevicePick} */
export function cleanPick(v) {
  if (typeof v !== 'object' || v === null) return null;
  const o = /** @type {Record<string, any>} */ (v);
  if (o.id === 'custom') return typeof o.json === 'object' && o.json !== null ? { id: 'custom', json: o.json } : null;
  return typeof o.id === 'string' && builtinTheme(o.id) ? { id: o.id } : null;
}

/**
 * The raw theme to draw (not yet validated), and where it came from.
 * @param {DevicePick} pick
 * @param {{ theme?: string, themeJson?: object } | null | undefined} room
 * @returns {{ raw: object | undefined, source: 'device' | 'room' | 'default' }}
 */
export function pickTheme(pick, room) {
  if (pick) return { raw: pick.id === 'custom' ? pick.json : (builtinTheme(pick.id) ?? undefined), source: 'device' };
  if (room?.theme === 'custom' && room.themeJson) return { raw: room.themeJson, source: 'room' };
  return { raw: undefined, source: 'default' };
}

/** @param {import('../monitor/settings.js').Settings} settings */
export function createThemeStore(settings) {
  return {
    get: () => cleanPick(settings.get('theme', null)),
    /** @param {string} id built-in id */
    setBuiltin(id) { if (builtinTheme(id)) settings.set('theme', { id }); },
    /** @param {Record<string, any>} json */
    setCustom(json) { settings.set('theme', { id: 'custom', json }); },
    followRoom() { settings.remove('theme'); },
  };
}

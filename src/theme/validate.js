// @ts-check
// Import path for theme files: parse, refuse what cannot be a safe theme, migrate old versions, then fill from the
// default (resolve.js). A refused file changes nothing; the caller keeps the theme it had. Pure; no DOM, no network.
import { DEFAULT_THEME } from './default.js';
import { migrateTheme } from './migrate.js';
import { resolveTheme } from './resolve.js';

export const MAX_THEME_BYTES = 32768;
/** Largest theme the room will carry to every monitor (schema.js caps the same size). */
export const MAX_ROOM_THEME_CHARS = 12288;
const MAX_CELLS = 60;
const SECTIONS = ['background', 'font', 'colors', 'layout', 'waves', 'audio', 'numerics', 'nibp', 'labels', 'alarmStyle'];
/** Keys that would carry styling or code: themes hold values only. */
const FORBIDDEN_KEY = /^(css|custom_?css|styles?|stylesheet|scripts?|html|js|javascript|on[a-z]+)$/i;
const FORBIDDEN_TEXT = /<|url\s*\(|@import|javascript:|expression\s*\(|\\/i;

/** @param {any} v */
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Walk the whole file for keys and strings that are not values.
 * @param {unknown} node @param {string} path @param {string[]} errors
 */
function scan(node, path, errors) {
  if (errors.length >= 5) return;
  if (typeof node === 'string') {
    if (FORBIDDEN_TEXT.test(node)) errors.push(`${path || 'theme'}: custom CSS or markup is not allowed, themes hold values only.`);
  } else if (Array.isArray(node)) node.forEach((x, i) => scan(x, `${path}[${i}]`, errors));
  else if (isObj(node)) {
    for (const [k, v] of Object.entries(/** @type {Record<string, unknown>} */ (node))) {
      if (FORBIDDEN_KEY.test(k)) errors.push(`${path ? path + '.' : ''}${k}: custom CSS or script is not allowed, themes hold values only.`);
      else scan(v, path ? `${path}.${k}` : k, errors);
    }
  }
}

/**
 * Text of a theme file to a value. Never throws.
 * @param {string} text
 * @returns {{ ok: true, value: unknown } | { ok: false, error: string }}
 */
export function parseThemeText(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'Nothing to import: the text is empty.' };
  if (text.length > MAX_THEME_BYTES) return { ok: false, error: `The file is ${Math.ceil(text.length / 1024)} KB; a theme is at most ${MAX_THEME_BYTES / 1024} KB.` };
  try { return { ok: true, value: JSON.parse(text) }; } catch (e) {
    return { ok: false, error: `This is not valid JSON (${e instanceof Error ? e.message : 'parse error'}).` };
  }
}

/**
 * @typedef {{ ok: true, theme: Record<string, any>, warnings: string[], from: number }
 *   | { ok: false, errors: string[] }} Validated
 */

/**
 * Check a parsed theme. `theme` is the complete theme (default filled in), `warnings` lists values that were dropped
 * one by one; `errors` means the file is refused as a whole.
 * @param {unknown} raw
 * @returns {Validated}
 */
export function validateTheme(raw) {
  if (!isObj(raw)) return { ok: false, errors: ['A theme file must be a JSON object.'] };
  /** @type {string[]} */
  const errors = [];
  scan(raw, '', errors);
  if (errors.length) return { ok: false, errors };
  const obj = /** @type {Record<string, unknown>} */ (raw);
  if (!SECTIONS.some((k) => k in obj) && !('bg' in obj) && !('colour' in obj)) {
    return { ok: false, errors: ['This does not look like a theme: none of background, font, colors, layout, waves, audio, numerics, nibp, labels or alarmStyle is present.'] };
  }
  const mig = migrateTheme(raw);
  if (!mig.ok) return { ok: false, errors: [mig.error] };
  const cells = mig.theme.layout?.cells;
  if (cells !== undefined && (!Array.isArray(cells) || cells.length > MAX_CELLS)) {
    return { ok: false, errors: [`layout.cells must be a list of at most ${MAX_CELLS} cells.`] };
  }
  const { theme, problems } = resolveTheme(mig.theme);
  if (!theme.layout.cells.length) return { ok: false, errors: ['layout.cells: no cell is usable (each needs module, part, x, y, w, h inside the grid).'] };
  const size = JSON.stringify(theme).length;
  if (size > MAX_ROOM_THEME_CHARS) return { ok: false, errors: [`The theme is ${size} characters once complete; the limit is ${MAX_ROOM_THEME_CHARS}. Remove cells or labels.`] };
  return { ok: true, theme, warnings: problems, from: mig.from };
}

/**
 * Never-throwing loader for a theme that is already stored (device or room): anything refused becomes the default.
 * @param {unknown} raw
 * @returns {{ theme: Record<string, any>, problems: string[] }}
 */
export function loadTheme(raw) {
  if (raw === undefined || raw === null) return resolveTheme(undefined);
  const v = validateTheme(raw);
  if (v.ok) return { theme: v.theme, problems: v.warnings };
  return { theme: resolveTheme(undefined).theme, problems: v.errors };
}

/** The theme as a file: complete, pretty printed. @param {Record<string, any>} theme */
export function exportTheme(theme) {
  return JSON.stringify(theme, null, 2) + '\n';
}

/** Name of a theme for lists. @param {Record<string, any>} theme */
export const themeName = (theme) => (typeof theme?.name === 'string' && theme.name.trim() ? theme.name.slice(0, 40) : DEFAULT_THEME.name);

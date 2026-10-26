// @ts-check
// Fill a theme from the default: missing keys fall back, invalid values are dropped one by one with a message
// (DESIGN.md section 8). Pure. S4 builds the editor and import paths on top of this.
import { DEFAULT_THEME } from './default.js';

const COLOR = /^#[0-9a-fA-F]{6}$/;
const isObj = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * @param {any} base default node
 * @param {any} raw candidate node
 * @param {string} path
 * @param {string[]} problems
 * @returns {any}
 */
function merge(base, raw, path, problems) {
  if (raw === undefined) return structuredClone(base);
  if (typeof base === 'string' && COLOR.test(base)) {
    if (typeof raw === 'string' && COLOR.test(raw)) return raw;
    problems.push(`${path}: bad colour, using the default`);
    return base;
  }
  if (isObj(base)) {
    if (!isObj(raw)) { problems.push(`${path}: expected an object, using the default`); return structuredClone(base); }
    /** @type {Record<string, any>} */
    const out = {};
    for (const k of Object.keys(base)) out[k] = k === 'cells' ? base[k] : merge(base[k], raw[k], `${path}.${k}`, problems);
    for (const k of Object.keys(raw)) if (!(k in out)) out[k] = raw[k]; // unknown keys are kept and ignored
    return out;
  }
  if (Array.isArray(base)) return Array.isArray(raw) ? raw : structuredClone(base);
  if (typeof raw === typeof base && (typeof raw !== 'number' || Number.isFinite(raw))) return raw;
  problems.push(`${path}: wrong type, using the default`);
  return base;
}

/**
 * @param {unknown} raw a parsed theme file, or anything
 * @returns {{ theme: Record<string, any>, problems: string[] }}
 */
export function resolveTheme(raw) {
  /** @type {string[]} */
  const problems = [];
  const src = isObj(raw) ? /** @type {Record<string, any>} */ (raw) : {};
  const theme = merge(DEFAULT_THEME, src, 'theme', problems);
  const grid = theme.layout.grid;
  const cellsRaw = src.layout?.cells;
  if (Array.isArray(cellsRaw)) {
    theme.layout.cells = cellsRaw.filter((/** @type {any} */ c, /** @type {number} */ i) => {
      const ok = isObj(c) && typeof c.module === 'string' && typeof c.part === 'string'
        && [c.x, c.y, c.w, c.h].every((n) => typeof n === 'number' && Number.isFinite(n)) && c.w > 0 && c.h > 0
        && c.x >= 0 && c.y >= 0 && c.x + c.w <= grid.columns + 1e-9 && c.y + c.h <= grid.rows + 1e-9;
      if (!ok) problems.push(`layout.cells[${i}]: dropped (off the grid or incomplete)`);
      return ok;
    });
  } else theme.layout.cells = structuredClone(DEFAULT_THEME.layout.cells);
  return { theme, problems };
}

/**
 * Speed (mm/s) and gain for one wave, falling back to the global speed and 1.
 * @param {Record<string, any>} theme @param {string} id
 */
export function waveSettings(theme, id) {
  const w = theme.waves ?? {};
  const own = w[id] ?? {};
  const speed = Number.isFinite(own.speed) && own.speed > 0 ? own.speed : (w.speedMmPerSec ?? 25);
  const gain = Number.isFinite(own.gain) && own.gain > 0 ? own.gain : 1;
  return { speed, gain };
}

// @ts-check
// Theme file versions. `themeSchema` is the version number of the file format; a file with a lower number (or none) is
// migrated step by step to the current one, a higher number is refused (it needs a newer app). Pure; no side effects.

export const THEME_SCHEMA = 1;

/** @param {any} v */
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Steps from version N to N+1. v0 is the unnumbered draft format of early files: `bg`, `colour`, `waves.speed`, and
 * `alarmBar` at the top.
 * @type {Record<number, (t: Record<string, any>) => void>}
 */
const STEPS = {
  0(t) {
    if (t.bg !== undefined && t.background === undefined) t.background = t.bg;
    delete t.bg;
    if (isObj(t.colour) && t.colors === undefined) t.colors = t.colour;
    delete t.colour;
    if (isObj(t.waves) && t.waves.speed !== undefined && t.waves.speedMmPerSec === undefined) t.waves.speedMmPerSec = t.waves.speed;
    if (isObj(t.waves)) delete t.waves.speed;
    if (isObj(t.alarmBar)) {
      t.layout = isObj(t.layout) ? t.layout : {};
      if (t.layout.alarmBar === undefined) t.layout.alarmBar = t.alarmBar;
      delete t.alarmBar;
    }
    t.themeSchema = 1;
  },
};

/**
 * @param {unknown} raw a parsed theme
 * @returns {{ ok: true, theme: Record<string, any>, from: number } | { ok: false, error: string }}
 */
export function migrateTheme(raw) {
  if (!isObj(raw)) return { ok: false, error: 'A theme file must be a JSON object.' };
  const t = /** @type {Record<string, any>} */ (structuredClone(raw));
  const v = t.themeSchema === undefined ? 0 : t.themeSchema;
  if (!Number.isInteger(v) || v < 0) return { ok: false, error: 'themeSchema must be a whole number (1 or higher).' };
  if (v > THEME_SCHEMA) return { ok: false, error: `This theme is schema ${v}; this app reads up to ${THEME_SCHEMA}. Reload the page for a newer version.` };
  for (let n = v; n < THEME_SCHEMA; n++) STEPS[n](t);
  return { ok: true, theme: t, from: v };
}

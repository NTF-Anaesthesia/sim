import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THEME } from '../src/theme/default.js';
import { BUILTIN_THEMES, LIGHT_THEME } from '../src/theme/builtin.js';
import { THEME_SCHEMA, migrateTheme } from '../src/theme/migrate.js';
import { MAX_THEME_BYTES, exportTheme, loadTheme, parseThemeText, validateTheme } from '../src/theme/validate.js';
import { cleanPick, createThemeStore, pickTheme } from '../src/theme/store.js';
import { FIELDS, getPath } from '../src/theme/fields.js';
import { resolveTheme } from '../src/theme/resolve.js';
import { layoutCells } from '../src/theme/layout.js';
import { createSettings } from '../src/monitor/settings.js';
import { createModuleRegistry, registerBuiltinModules } from '../src/monitor/modules.js';
import { validatePatch } from '../src/shared/schema.js';

const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };
const errorsOf = (raw) => { const v = validateTheme(raw); assert.equal(v.ok, false, JSON.stringify(raw).slice(0, 80)); return v.errors.join(' | '); };

test('the schema version matches the files and is a whole number', () => {
  assert.equal(THEME_SCHEMA, 1);
  for (const b of BUILTIN_THEMES) assert.equal(b.theme.themeSchema, THEME_SCHEMA, b.id);
});

test('built-in themes pass validation untouched and round-trip through export', () => {
  for (const b of BUILTIN_THEMES) {
    const v = validateTheme(b.theme);
    assert.equal(v.ok, true, b.id);
    assert.deepEqual(v.warnings, [], b.id);
    const again = validateTheme(parseThemeText(exportTheme(v.theme)).value);
    assert.equal(again.ok, true);
    assert.deepEqual(again.theme, v.theme);
  }
});

test('migration: a file without themeSchema is v0 and is upgraded; a newer file is refused', () => {
  const v0 = { name: 'Old', bg: '#101010', colour: { ecg: '#00ff00' }, waves: { speed: 50 }, alarmBar: { x: 0, y: 0, w: 12, h: 1 } };
  const m = migrateTheme(v0);
  assert.equal(m.ok, true);
  assert.equal(m.from, 0);
  assert.equal(m.theme.themeSchema, 1);
  assert.equal(m.theme.background, '#101010');
  assert.equal(m.theme.colors.ecg, '#00ff00');
  assert.equal(m.theme.waves.speedMmPerSec, 50);
  assert.deepEqual(m.theme.layout.alarmBar, { x: 0, y: 0, w: 12, h: 1 });
  assert.equal('bg' in m.theme, false);
  assert.equal(v0.bg, '#101010', 'the input is not changed');
  const full = validateTheme(v0);
  assert.equal(full.ok, true);
  assert.equal(full.theme.background, '#101010');
  assert.equal(full.theme.waves.speedMmPerSec, 50);
  assert.match(errorsOf({ ...LIGHT_THEME, themeSchema: 2 }), /schema 2/);
  assert.match(errorsOf({ ...LIGHT_THEME, themeSchema: 'one' }), /whole number/);
  assert.match(errorsOf({ ...LIGHT_THEME, themeSchema: -1 }), /whole number/);
  assert.equal(migrateTheme({ ...LIGHT_THEME }).from, 1);
});

test('bad files are refused with a clear message', () => {
  assert.match(parseThemeText('').error, /empty/);
  assert.match(parseThemeText('{nope').error, /not valid JSON/);
  assert.match(parseThemeText('x'.repeat(MAX_THEME_BYTES + 1)).error, /at most 32 KB/);
  assert.match(errorsOf([]), /JSON object/);
  assert.match(errorsOf('text'), /JSON object/);
  assert.match(errorsOf({ hello: 1 }), /does not look like a theme/);
  assert.match(errorsOf({ colors: { ecg: '#fff' }, layout: { cells: [{ module: 'ecg', part: 'wave', x: 50, y: 0, w: 1, h: 1 }] } }), /no cell is usable/);
  assert.match(errorsOf({ ...LIGHT_THEME, layout: { ...LIGHT_THEME.layout, cells: Array(61).fill(LIGHT_THEME.layout.cells[0]) } }), /at most 60/);
});

test('themes hold values only: no CSS, script or markup anywhere', () => {
  assert.match(errorsOf({ ...LIGHT_THEME, css: 'body{display:none}' }), /css: custom CSS or script is not allowed/);
  assert.match(errorsOf({ ...LIGHT_THEME, style: {} }), /not allowed/);
  assert.match(errorsOf({ ...LIGHT_THEME, font: { ...LIGHT_THEME.font, onload: 'x' } }), /font.onload/);
  assert.match(errorsOf({ ...LIGHT_THEME, name: '<img src=x onerror=alert(1)>' }), /markup is not allowed/);
  assert.match(errorsOf({ ...LIGHT_THEME, labels: { ...LIGHT_THEME.labels, ecg: 'a url(http://x)' } }), /labels.ecg/);
  assert.match(errorsOf({ ...LIGHT_THEME, font: { ...LIGHT_THEME.font, family: '@import "x"' } }), /not allowed/);
  assert.match(errorsOf({ ...LIGHT_THEME, layout: { ...LIGHT_THEME.layout, cells: [{ ...LIGHT_THEME.layout.cells[0], stack: 'a\\b' }] } }), /not allowed/);
});

test('values outside the allowed range are dropped one by one, with a message', () => {
  const t = structuredClone(LIGHT_THEME);
  t.colors.ecg = 'red';
  t.waves.lineWidth = 99;
  t.font.family = 'x;color:red';
  t.labels.ecg = 'a'.repeat(40);
  t.alarmStyle.tones = 'loud';
  t.audio.alarm.volume = 3;
  t.waves.abp.speed = 0;
  const v = validateTheme(t);
  assert.equal(v.ok, true);
  assert.equal(v.theme.colors.ecg, DEFAULT_THEME.colors.ecg);
  assert.equal(v.theme.waves.lineWidth, DEFAULT_THEME.waves.lineWidth);
  assert.equal(v.theme.font.family, DEFAULT_THEME.font.family);
  assert.equal(v.theme.labels.ecg, DEFAULT_THEME.labels.ecg);
  assert.equal(v.theme.alarmStyle.tones, DEFAULT_THEME.alarmStyle.tones);
  assert.equal(v.theme.audio.alarm.volume, DEFAULT_THEME.audio.alarm.volume);
  assert.equal(v.theme.waves.abp.speed, DEFAULT_THEME.waves.abp.speed);
  assert.equal(v.warnings.length, 7);
  assert.equal(v.theme.colors.spo2, LIGHT_THEME.colors.spo2, 'the rest of the file is kept');
});

test('missing keys come from the default; a one-line theme is valid', () => {
  const v = validateTheme({ themeSchema: 1, colors: { ecg: '#112233' } });
  assert.equal(v.ok, true);
  assert.equal(v.theme.colors.ecg, '#112233');
  assert.deepEqual(v.theme.layout, DEFAULT_THEME.layout);
});

test('seam 10: speed, gain and channel volumes are in the schema', () => {
  const paths = FIELDS.map((f) => f.path);
  for (const w of ['ecg', 'spo2', 'etco2', 'abp']) for (const k of ['speed', 'gain']) assert.ok(paths.includes(`waves.${w}.${k}`), `waves.${w}.${k}`);
  for (const c of ['alarm', 'qrs', 'spo2']) assert.ok(paths.includes(`audio.${c}.volume`), `audio.${c}.volume`);
  for (const f of FIELDS) assert.notEqual(getPath(DEFAULT_THEME, f.path), undefined, `default has ${f.path}`);
});

test('the second theme moves every module and changes every colour', () => {
  const key = (c) => `${c.module}/${c.part}`;
  const def = new Map(DEFAULT_THEME.layout.cells.map((c) => [key(c), c]));
  const light = new Map(LIGHT_THEME.layout.cells.map((c) => [key(c), c]));
  assert.deepEqual([...light.keys()].sort(), [...def.keys()].sort(), 'same parts');
  for (const [k, c] of def) {
    const l = /** @type {any} */ (light.get(k));
    assert.ok(l.x !== c.x || l.y !== c.y, `${k} moved`);
  }
  assert.notDeepEqual(LIGHT_THEME.layout.alarmBar, DEFAULT_THEME.layout.alarmBar);
  for (const k of Object.keys(DEFAULT_THEME.colors)) assert.notEqual(LIGHT_THEME.colors[k], DEFAULT_THEME.colors[k], `colour ${k}`);
  assert.notEqual(LIGHT_THEME.background, DEFAULT_THEME.background);
  assert.notEqual(LIGHT_THEME.font.family, DEFAULT_THEME.font.family);
  assert.notEqual(LIGHT_THEME.alarmStyle.tones, DEFAULT_THEME.alarmStyle.tones);
  assert.notEqual(LIGHT_THEME.numerics.limitsPosition, DEFAULT_THEME.numerics.limitsPosition);
});

test('the second theme lays out inside its grid with every module on, and with some off', () => {
  const reg = createModuleRegistry();
  registerBuiltinModules(reg);
  for (const on of [['ecg', 'spo2', 'etco2', 'nibp', 'rr', 'temp', 'abp'], ['ecg', 'spo2']]) {
    const boxes = layoutCells(LIGHT_THEME, (c) => on.includes(c.module) && !!reg.get(c.module)?.parts[c.part]);
    assert.ok(boxes.length >= on.length);
    const { columns, rows } = LIGHT_THEME.layout.grid;
    for (const b of boxes) assert.ok(b.x >= 0 && b.y >= -1e-9 && b.x + b.w <= columns + 1e-9 && b.y + b.h <= rows + 1e-9, `${b.module}/${b.part} inside`);
  }
});

test('loadTheme never throws: a refused or missing theme becomes the default', () => {
  assert.deepEqual(loadTheme(undefined).theme, loadTheme(DEFAULT_THEME).theme);
  const bad = loadTheme({ css: 'x', colors: {} });
  assert.deepEqual(bad.theme, loadTheme(undefined).theme);
  assert.ok(bad.problems.length);
  assert.equal(loadTheme(LIGHT_THEME).theme.name, 'Generic light');
});

test('device choice: remembered per device, wins over the room; none follows the room', () => {
  const st = mem();
  const store = createThemeStore(createSettings(st));
  assert.equal(store.get(), null);
  const room = { theme: 'custom', themeJson: { ...LIGHT_THEME, name: 'From phone' } };
  assert.equal(pickTheme(store.get(), room).source, 'room');
  assert.equal(pickTheme(null, { theme: 'default' }).source, 'default');
  assert.equal(pickTheme(null, { theme: 'default', themeJson: LIGHT_THEME }).source, 'default', 'a stale themeJson is not used');
  store.setBuiltin('light');
  assert.equal(pickTheme(createThemeStore(createSettings(st)).get(), room).raw.name, 'Generic light', 'survives a reload');
  store.setBuiltin('nope');
  assert.equal(store.get().id, 'light', 'unknown built-in ids are ignored');
  store.setCustom({ ...LIGHT_THEME, name: 'Mine' });
  assert.equal(pickTheme(store.get(), room).raw.name, 'Mine');
  store.followRoom();
  assert.equal(pickTheme(store.get(), room).raw.name, 'From phone');
  assert.equal(cleanPick({ id: 'custom' }), null);
  assert.equal(cleanPick('x'), null);
});

test('the room accepts a valid theme (stored complete) and rejects a bad one', () => {
  const ok = validatePatch({ theme: 'custom', themeJson: { themeSchema: 1, colors: { ecg: '#112233' } } });
  assert.equal(ok.ok, true);
  assert.equal(ok.patch.themeJson.colors.ecg, '#112233');
  assert.deepEqual(ok.patch.themeJson.layout, DEFAULT_THEME.layout);
  const bad = validatePatch({ theme: 'custom', themeJson: { ...LIGHT_THEME, css: 'x' } });
  assert.equal(bad.ok, false);
  assert.match(bad.msg, /themeJson: .*not allowed/);
});

test('the shipped example files in themes/ match the built-in themes', async () => {
  const { readFileSync } = await import('node:fs');
  const files = { default: 'generic-dark', light: 'generic-light' };
  for (const b of BUILTIN_THEMES) {
    const text = readFileSync(new URL(`../themes/${files[b.id]}.json`, import.meta.url), 'utf8');
    assert.equal(text, exportTheme(validateTheme(b.theme).theme), `themes/${files[b.id]}.json is out of date: run node tools/export-themes.mjs`);
  }
});

test('deeply nested files are refused, not a stack overflow', () => {
  const deep = JSON.parse('{"colors":' + '['.repeat(5000) + ']'.repeat(5000) + '}');
  const r = validateTheme(deep);
  assert.equal(r.ok, false);
});

test('cells are checked against the grid that survives range checks', () => {
  const { theme } = resolveTheme({ layout: { grid: { columns: 1000, rows: 1000 }, cells: [{ module: 'ecg', part: 'wave', x: 900, y: 900, w: 50, h: 50 }, { module: 'ecg', part: 'wave', x: 0, y: 0, w: 4, h: 2 }] } });
  assert.equal(theme.layout.cells.length, 1);
});

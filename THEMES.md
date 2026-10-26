# Themes

A theme is one JSON file that says how the monitor looks: colours, fonts, where each module sits, wave speed and
width, labels, alarm style and tones. It holds **values only**: no CSS, no script, no markup, no logos. The default
theme and a second one (different layout and palette) ship in `themes/`; any file in this format can be loaded.

Schema version: `themeSchema: 1` (see "Versions" below). Full examples: [themes/generic-dark.json](themes/generic-dark.json),
[themes/generic-light.json](themes/generic-light.json).

## Loading, saving and choosing

- **On a monitor** (`/m/<code>`, button **Theme**): choose a built-in theme, import a file, load a web address, or paste
  text; edit values with a live preview; export (download, copy, or show in the text box). A choice made here belongs to
  that device (kept in its `localStorage` as `sim.settings.theme`) and survives a reload. **Follow the room** hands control
  back.
- **On the phone** (`/c/<code>`, More, **Theme for all monitors**): the same import, then the theme is sent into the room
  and every monitor that has no choice of its own shows it, within a second, with no reload. **Reset all to default** clears it.
- Order of use on a monitor: its own device choice, else the room's theme, else the default.
- A web address must allow other sites to read it (CORS) or be on the same site; it is fetched without cookies.
- A file that is refused changes nothing: the monitor keeps the theme it had and the panel says why (not JSON, bigger
  than 32 KB, not an object, newer schema, CSS or markup, no usable cells, theme too big for the room).
- A file with a few bad values is still applied; each bad value is replaced by the default and listed ("Ignored: …").
- Limits: a file is at most 32 KB; a theme sent into a room is at most 12 KB once complete (missing keys filled in).

## Rules

1. Missing keys fall back to the default theme, so a theme can be short: `{ "themeSchema": 1, "colors": { "ecg": "#ff8800" } }`.
2. Colours are `#rrggbb`. Numbers have ranges (below). Text uses safe characters only.
3. Unknown keys are kept and ignored. Keys named `css`, `style`, `script`, `html`, `js` or starting with `on` are refused,
   and so is any text containing `<`, `url(`, `@import`, `javascript:`, `expression(` or a backslash.
4. Device settings (units, wave speed and gain, volumes made on this device) win over the theme's values.

## Fields

Every example value is the default unless stated. Ranges are enforced; a value outside its range is dropped with a message.

| Field | Example | Meaning and range |
|---|---|---|
| `themeSchema` | `1` | File format version. Missing means version 0 (migrated). Higher than the app knows is refused. |
| `name` | `"Generic dark"` | Shown in lists and used for the export file name. |
| `background` | `"#000000"` | Screen colour. |
| `font.family` | `"system-ui, sans-serif"` | Letters, digits, spaces, commas, quotes, dots, hyphens; up to 120 characters. No web fonts are loaded. |
| `font.numericScale`, `font.labelScale` | `1` | Size multiplier, 0.3 to 3. |
| `font.numericWeight`, `font.labelWeight` | `700`, `500` | 100 to 900. |
| `colors.ecg spo2 etco2 abp` | `"#00e000"` | Wave line colour and the matching numeric colour. |
| `colors.nibp rr temp hr` | `"#ffffff"` | Numeric colours (`hr` is the heart rate numeric). |
| `colors.alarmHigh alarmMed alarmLow` | `"#ff2020"` | Alarm bar and flashing numeric colours by priority. |
| `colors.text` | `"#c0c0c0"` | Labels, units and the toolbar. |
| `colors.grid` | `"#16301a"` | Grid lines behind the waves (only when `waves.grid` is true). |
| `colors.flashText` | `"#000000"` | Text colour on a coloured alarm bar. |
| `layout.grid.columns`, `rows` | `12`, `12` | Grid size, 1 to 48. Cells are placed on this grid. |
| `layout.grid.gap` | `6` | Gap between cells in pixels, 0 to 40. |
| `layout.cells[]` | see below | One entry per module part. At most 60. |
| `layout.alarmBar` | `{ "x": 8, "y": 0, "w": 4, "h": 1 }` | Where the alarm message bar sits. |
| `waves.speedMmPerSec` | `25` | Sweep speed for every wave, 1 to 100 mm/s. |
| `waves.<id>.speed` | `{ "ecg": { "speed": 25 } }` | Per-wave speed (`ecg`, `spo2`, `etco2`, `abp`), 1 to 100; falls back to `speedMmPerSec`. |
| `waves.<id>.gain` | `{ "ecg": { "gain": 1 } }` | Per-wave gain, 0.1 to 10. |
| `waves.pxPerMm` | `4` | Pixels per mm (25 mm/s at 4 is 100 px/s), 1 to 12. |
| `waves.lineWidth` | `2` | Wave width in pixels, 0.5 to 8. |
| `waves.sweepGapPx` | `14` | Blank gap ahead of the sweep, 0 to 100. |
| `waves.grid` | `false` | Draw a 5 mm grid behind the waves. |
| `audio.<channel>.volume` | `{ "alarm": { "volume": 1 } }` | `alarm`, `qrs`, `spo2`; 0 to 1. Multiplied by the device's own volume. |
| `numerics.showLimits` | `true` | Show alarm limits next to each numeric. |
| `numerics.limitsPosition` | `"beside"` | `beside` or `below` the number. |
| `numerics.fontScale` | `1` | Size of all numerics, 0.3 to 3 (also multiplied by `font.numericScale`). |
| `numerics.decimals.temp` | `1` | Decimals for temperature. |
| `nibp.inflateMs`, `nibp.measureMs` | `0`, `0` | Time shown inflating and measuring before the result appears, 0 to 120000. 0 gives the result at once. |
| `labels.<id>` | `"ecg": "HR"` | Numeric captions for `ecg spo2 etco2 rr nibp temp abp`; up to 24 characters, no `< > { }` or backslash. |
| `labels.units.<id>` | `"etco2": "mmHg"` | Unit text next to a numeric. |
| `labels.wave.<id>` | `"ecg": "II"` | Caption on each wave. |
| `labels.off.<id>` | `"ecg": "LEADS OFF"` | Text shown when a sensor is switched off. |
| `alarmStyle.barPosition` | `"top-right"` | Where the message sits in the bar: `top`/`bottom` plus `left`/`center`/`right`. |
| `alarmStyle.flashHz` | `1` | Flash rate of a flashing numeric or bar, 0.2 to 4. |
| `alarmStyle.limitStyle` | `"small"` | `small` or `bold` limit text. |
| `alarmStyle.tones` | `"iec"` | Tone wave: `iec` (triangle) or `soft` (sine). The pulse pattern per priority is the same. |
| `alarmStyle.toneHz.high medium low` | `960`, `800`, `640` | Alarm pitch per priority in Hz, 200 to 2000. |

### Layout cells

Each cell places one part of one module:

```json
{ "module": "ecg", "part": "wave", "x": 0, "y": 0, "w": 8, "h": 3, "stack": "left" }
```

- `module`: `ecg`, `spo2`, `etco2`, `abp`, `nibp`, `rr`, `temp`. `part`: `wave`, `numeric`, or `numeric2` (the EtCO2 module's
  respiratory rate).
- `x`, `y`, `w`, `h`: position and size in grid units (fractions allowed). A cell outside the grid, or missing a number,
  is dropped with a message. A theme with no usable cell is refused.
- `stack` (optional): cells with the same stack name share the stack's area from top to bottom in proportion to their `h`.
  A module that is switched off (for instance the art line) hands its space to the others in the stack. Without `stack`,
  the cell stays where it is written.
- A module that is off, or a part that does not exist, is skipped. Cells for modules the app does not know are skipped too.

## Example: a short theme

```json
{
  "themeSchema": 1,
  "name": "Big green",
  "colors": { "ecg": "#33ff33", "hr": "#33ff33" },
  "font": { "numericScale": 1.3 },
  "waves": { "speedMmPerSec": 50, "lineWidth": 3 },
  "alarmStyle": { "tones": "soft", "toneHz": { "high": 880, "medium": 700, "low": 560 } }
}
```

Everything not written (layout, labels, other colours) comes from the default.

## Versions

`themeSchema` counts versions of the file format. When the app learns a new field it keeps the number if old files still
mean the same, and raises it when they would not; old files are migrated step by step on import (`src/theme/migrate.js`).

- **0**: files with no `themeSchema`. Early drafts used `bg` (now `background`), `colour` (now `colors`), `waves.speed`
  (now `waves.speedMmPerSec`) and `alarmBar` at the top (now `layout.alarmBar`). Migrated to 1 on import.
- **1**: this document.

A file with a higher number than the app knows is refused with a message ("reload the page for a newer version").

## Art and trade dress

This repository ships generic themes only: no brand names, logos or themes made to match a particular maker's monitor.
A theme you write for your own use may look like anything, but only values are allowed, so nothing in it can load an
image or font.

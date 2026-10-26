# sim: design

A phone (controller) drives a simulated patient monitor shown on a laptop or tablet (monitor), live, through a
throwaway room. For teaching simulation only: no patient data, no login, no real clinical use. Look: generic (common
monitor conventions, colours on black); no brand names or logos.

## Contents

1. Pieces and files
2. Rooms: lifetime, codes, URLs
3. State schema (v1)
4. Modules
5. Message protocol
6. Glide model
7. Alarm model
8. Theme JSON schema v1
9. Build rules
10. Tests
11. Settled details

## 1. Pieces and files

One Cloudflare Worker serves static files and a SQLite-backed Durable Object class `Room` (WebSocket Hibernation API).
Plain ES modules, no build step to run; a Vite build in CI proves the code ports into a Vite app.

```
worker/index.js        Worker entry: routes, static assets, forwards /ws/<code> to the Room object
worker/room.js         Room class (Durable Object)
src/room/client.js     browser client: connect, reconnect, send, subscribe (entry `room`)
src/engine/            glide, rhythm, alarms: pure functions on state (entry `engine`)
src/waves/             wave synthesis (entry `waves`; S2)
src/theme/             theme load/validate/apply (entry `theme`; S4)
src/monitor/           monitor screen (entry `monitor`; S2)
src/controller/        phone controller (entry `controller`; S3)
src/shared/schema.js   state and theme types (JSDoc), defaults, validators, `SCHEMA_VERSION`
public/                index.html (new room), m/index.html, c/index.html, manifest, service worker, themes/*.json
tools/                 check, test runners
```

Each entry file only re-exports; importing it has no side effects (no DOM access, no timers, no network at import).
One job per file. Strict JSDoc types (`// @ts-check`, `tsc --noEmit` in CI). `package.json` has `exports` for the
six entries.

## 2. Rooms: lifetime, codes, URLs

- A room is a Durable Object named by its **code**: 6 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0 O 1 I L),
  uppercase. Codes are typed case-insensitively and normalised to uppercase.
- `/` shows "New room": the page asks `POST /api/room`, the Worker picks a random code, creates nothing yet (the
  object is created on first connection), and the page shows the code, a QR code of `https://<host>/c/<code>`, and a
  link to open the monitor (`/m/<code>`) on this device. A "Join with code" box opens `/c/<code>` or `/m/<code>`.
- `/m/<code>` monitor (optional `?p=<patientId>` picks the bed; default the first), `/c/<code>` controller. Any number of monitors and controllers may join one room.
- State lives only in the Room's SQLite-backed storage (key `state`, plus `last` = time of the last message). No accounts, no personal data. Nothing is stored
  in the browser except per-device options (localStorage; section 9).
- **Expiry:** each message from any client sets an alarm `lastActive + 24 h` (`storage.setAlarm`). When the alarm fires and the
  room has been idle that long, the Room calls `storage.deleteAll()` and closes sockets with code 4001
  "room expired". A new connection to an expired code simply makes a fresh room with default state.
- Limits: 20 sockets per room (extra ones get close code 4002 "room full"); one message at most 16 KB; at most
  30 messages per second per socket (excess dropped, `error` sent).

## 3. State schema (v1)

The whole room state is one JSON object, `schema: 1`. All numbers are plain numbers; times are ms since epoch from
the **server** clock.

```jsonc
{
  "schema": 1,
  "rev": 42,                       // integer, +1 on every accepted change
  "patients": [                    // 1 to 8 "beds"; each screen shows one (monitor URL ?p=<id>, default the first)
    {
      "id": "p1", "label": "Bed 1",   // id is server-made (p1, p2, ...), label 1-24 chars
      // targets the controller sets (what values glide TO)
      "rhythm": "sinus",             // see rhythm list below
      "hr": 80,                      // 0-300; ignored for VF, asystole
      "spo2": 98,                    // 0-100
      "etco2": 38,                   // 0-100 mmHg
      "rr": 14,                      // 0-60 /min
      "temp": 36.8,                  // 25.0-43.0 C, one decimal
      "nibp": { "sys": 120, "dia": 75 },        // targets for the next NIBP reading
      "abp": { "sys": 120, "dia": 75 },         // only shown when module "abp" is on
      "glideMs": 0,                  // default glide time applied when a change carries none
      // rhythm and wave details
      "pulse": true,                 // only read for vt: false = pulseless VT
      "flutterRatio": 2,             // 2 | 3 | 4 (AV conduction, flutter only)
      "st": 0,                       // -3..+3 mm ST shift, integer or half steps
      "pvcPerMin": 0,                // 0-30 ventricular ectopics per minute (integer)
      "ie": 2,                       // 0.5-5, expiratory:inspiratory time ratio of the breath
      "etco2Shape": "normal",        // normal | obstructive | curare | rebreathing | none
      "spo2Quality": "good",         // good | poor | none (poor = small, noisy; none = no pleth drawn)
      "abpDamping": "normal",        // normal | over | under
      // sensors: true = lead/probe/cuff/line off, that wave and numeric read "---"
      "off": { "ecg": false, "spo2": false, "nibp": false, "abp": false, "etco2": false },
      "glide": {                     // when this patient's latest change started and how long it takes
        "startedAt": 1761000000000,  // server ms
        "durationMs": 10000,
        "from": { /* same shape as the numerics: hr, spo2, etco2, rr, temp, nibp, abp */ }
      },
      "nibpRead": {                  // last measured reading (monitor shows it with its time)
        "sys": 118, "dia": 74, "at": 1760999900000, "mode": "manual",   // mode: "manual" | "cycle"
        "cycleSec": 300              // used when mode = "cycle"; 0 otherwise
      }
    }
  ],
  "modules": ["ecg", "spo2", "etco2", "nibp", "rr", "temp"],  // shown modules (room-wide), order = display order (section 4)
  "alarms": {
    "limits": { "hr": [50, 120], "spo2": [90, 100], "etco2": [30, 50], "rr": [8, 30],
                "nibpSys": [90, 180], "temp": [35.5, 38.5], "abpSys": [90, 180] },
    "enabled": true,               // master switch
    "silencedUntil": 0,            // server ms; 0 = not silenced; set to now + 120000 by "silence"
    "latched": []                  // ids of alarms the controller has acknowledged (reserved, v1 unused)
  },
  "events": [                      // newest last, max 20, for the controller's log; monitor ignores
    { "t": 1760999950000, "by": "c-ab12", "kind": "rhythm", "p": "p1", "what": "set patient" }
  ],
  "theme": "default"               // "default" or "custom"; custom JSON is in "themeJson" (S4)
}
```

Rhythms (id): `sinus`, `sinus_brady`, `sinus_tachy`, `af`, `flutter`, `svt`, `vt`, `vf`, `asystole`, `pea` (normal
ECG, flat pleth). `hr` for sinus is the exact rate; for `sinus_brady`/`sinus_tachy` the controller sets a sensible `hr`
and the id is a label; for `vf` and `asystole` `hr` is displayed `0`/`--` and ECG is the rhythm's own wave.
**Reserved rhythm ids** `first_degree_block`, `mobitz1`, `mobitz2`, `chb`, `torsades`, `paced` are valid in the schema
from v1 (stored, broadcast) but drawn from S2; until then a monitor draws them as sinus. They use the fields above:
`flutterRatio` (flutter), `st` (any rhythm with a P-QRS-T), `pvcPerMin`.

**Pulseless rule** (engine, `shown()` in `src/engine/rhythm.js`): a patient has no pulse when the rhythm is `vf`,
`asystole` or `pea`, or `vt` with `pulse: false` (`pulse` defaults to true and is ignored for other rhythms). While
pulseless the pleth and the ABP wave flatten and the SpO2 and ABP numerics read `---`; the ECG is the rhythm's own,
and EtCO2 keeps its target. Nothing is stored or changed: targets stay as set, so choosing a perfusing rhythm
restores pleth, ABP and the numerics at once (no new glide).

**Sensor-off flags** (`off.<sensor>`) are independent of the rhythm: `ecg` blanks the ECG wave and HR, `spo2` the pleth
and SpO2, `nibp` the NIBP numeric (a measure-now still stamps the reading but the monitor shows `---`), `abp` the ABP
wave and numerics, `etco2` the capnogram, EtCO2 and RR. A flag change is instant (no glide). `shown()` returns `null`
for a blank value.

**Units** (CO2 mmHg or kPa, temperature C or F) are a per-device display choice kept in that device's `localStorage`
(`sim.units`); state and messages always hold mmHg and C.

Defaults (new room): one patient `p1` "Bed 1": sinus, hr 80, spo2 98, etco2 38, rr 14, temp 36.8, nibp 120/75, abp
120/75, glideMs 0, pulse true, flutterRatio 2, st 0, pvcPerMin 0, ie 2, all sensors on, etco2Shape normal, spo2Quality
good, abpDamping normal; modules `["ecg","spo2","etco2","nibp","rr","temp"]`, alarms enabled, silencedUntil 0.

Unknown fields are kept and ignored (forward compatible). A client that gets `schema` greater than it knows shows
"update needed" and stops drawing.

## 4. Modules

A module is a named block of one screen, switched on or off from the controller.

| id | Shows | Needs |
|---|---|---|
| `ecg` | ECG II wave, HR numeric | |
| `spo2` | pleth wave, SpO2 numeric | |
| `etco2` | capnogram wave, EtCO2 and RR numerics (wave shape from `etco2Shape`) | |
| `nibp` | NIBP numeric (sys/dia (mean)) with time | |
| `rr` | RR numeric (when `etco2` is off) | |
| `temp` | temperature numeric | |
| `abp` | arterial line: ABP wave and sys/dia (mean) | **off by default** (the "art line") |

Later (reserved ids, not drawn in v1): `cvp`, `pap`. A client ignores module ids it does not know.
**Every** module can be hidden, ECG included (a screen may show only the EtCO2 wave). The list in `state.modules` is the truth for **every** screen in the room. Per-screen module lists (two monitors
showing different things) are Later; v1 reserves `screens: { "<screenId>": { "modules": [...] } }` in state and ignores
it.

## 5. Message protocol

Transport: WebSocket at `wss://<host>/ws/<code>?role=monitor|controller&id=<clientId>`. `clientId` is random, chosen
by the client (`m-` or `c-` plus 4 hex), kept in memory per page load. JSON text frames, one object per frame, field
`t` is the message type.

Client to server:

| t | fields | effect |
|---|---|---|
| `hello` | `schema` | optional; server always sends `state` on connect anyway |
| `set` | `p?`, `patch`, `glideMs?`, `baseRev?` | merge `patch` (deep, only known paths: `patient.*` = every patient field above except `id`, `glide`, `nibpRead`; `modules`, `alarms.limits`, `alarms.enabled`, `nibp.mode`, `nibp.cycleSec` (these two go to `nibpRead`), `theme`, `themeJson`) into patient `p` (default: the first) or the room. If `glideMs` is a number it replaces the glide time for the changed numerics; otherwise the patient's `glideMs`. Starts that patient's glide (section 6). `rev` +1. |
| `nibp` | `p?`, `after?` | "measure now" for patient `p`: server sets `nibpRead.sys/dia` to the current glided `nibp` values and `nibpRead.at` = now. `rev` +1. |
| `addPatient` | `label?` | adds a default patient (id `p<n>`, label default `Bed <count>`); max 8. |
| `removePatient` | `p` | removes that patient; the last one cannot be removed. |
| `mark` | `p?`, `text?` | bookmark in the event log (`kind: "bookmark"`, text up to 200 chars) for debriefs; V1 has no button for it. `rev` +1. |
| `silence` | none | `alarms.silencedUntil` = now + 120000. |
| `ping` | `n` | server replies `pong` with same `n`; used to measure delay and keep the connection alive. |
| `test` | `value` | v1 shell: stores `value` (any JSON up to 1 KB) in `state.test`, broadcast. Removed by S2/S3. |

Server to client:

| t | fields | meaning |
|---|---|---|
| `state` | `state`, `now` | full state, sent to a client right after it connects (a late joiner gets the current state) and after any change; `now` is the server clock for offset correction |
| `error` | `code`, `msg` | `bad_json`, `too_big`, `rate`, `bad_patch` |
| `pong` | `n`, `now` | |
| `presence` | `monitors`, `controllers` | counts of connected sockets by role, sent to every socket when one joins or leaves (S3). Not stored, not in `state`; a client keeps the last one. The controller shows "N monitors". |

Rules:
- Every accepted change is broadcast as a full `state` to **all** sockets (including the sender) in one go; total state
  is well under 4 KB, so no diffs in v1.
- Server is the only writer of `rev`, `patients[].id`, `glide.startedAt`, `nibpRead.at`, `silencedUntil`, `events`.
- Last write wins; `baseRev` is optional and only recorded in `events` (no rejection) in v1.
- Clients reconnect with backoff 0.5, 1, 2, 4, 8 s (max 8 s), then keep trying; on reconnect the server's `state` replaces
  local state. The monitor keeps drawing from the last state while disconnected and shows a small "reconnecting"
  chip after 3 s.
- Target delay: controller change reaches every monitor in under 1 s on normal Wi-Fi.
- Hibernation: the Room uses `ctx.acceptWebSocket` and the `webSocketMessage`/`webSocketClose` handlers; state is read
  from SQLite on wake (a memory copy is only a cache); client ids and roles are kept with `serializeAttachment`.
- Same-device fallback (BroadcastChannel) is Later; not in v1.

## 6. Glide model

Values glide **on the monitor** from a start to a target; the network carries only the change, not each step.

- Glide is per patient. A `set` that changes that patient's numerics records `glide = { startedAt, durationMs, from }` where `from` is the **currently
  displayed** values at that moment, computed server-side by evaluating the previous glide at `now` (so a second
  change mid-glide starts from where the numbers actually are).
- Displayed value at time `t` for numeric `x`: `from.x + (target.x - from.x) * ease(clamp((t - startedAt) / durationMs, 0, 1))`
  with `ease(u) = u` (linear) in v1. `durationMs = 0` is an immediate jump.
- `t` is the monitor's local time plus `offset` (server `now` minus local time at the moment `state` arrived, minimum-
  round-trip estimate from `ping`/`pong`), so all monitors show the same value at the same moment.
- Integers shown rounded (HR, SpO2, RR, EtCO2, pressures); temperature one decimal.
- Rhythm, module and limit changes are instant (no glide). Changing rhythm keeps the glided HR as the start.
- Wave generators read the glided values every frame (`etco2Shape`, `spo2Quality`, `abpDamping`, `ie`, `st`, `pvcPerMin` shape the waves; heart rate sets beat interval; SpO2 sets pleth amplitude; RR
  sets breath interval; EtCO2 sets capnogram plateau; ABP sys/dia set the arterial wave height).
- Presets (S3) are just a `set` with many fields and a glide time, sent to a chosen patient (`p`).

## 7. Alarm model

Evaluated **on each monitor** from glided values and `alarms.limits`; the controller only sets limits, enable, silence.

- Parameters with limits: HR, SpO2, EtCO2, RR, NIBP sys, temp, ABP sys (only when `abp` on). Each `[low, high]`; a value
  outside raises that parameter's alarm.
- Priority, IEC 60601-1-8 style: **high** (red): asystole, VF, VT, SpO2 or HR beyond a critical band (SpO2 < limit-5 or
  HR < 40 or HR > 150 when outside limits); **medium** (yellow): any other limit violation; **low** (cyan, technical):
  "NIBP not measured > 10 min" and similar notices. Highest priority wins in the alarm bar.
- Display: alarm bar top right with the text ("HR LOW", "ASYSTOLE"), numeric of the violating parameter flashes
  (1 Hz, inverted colours); high = red, medium = yellow bar background.
- Sound: tone sequence per priority generated with Web Audio (no audio files): high 10 pulses burst, medium 3 pulses,
  low 2 pulses; repeated while active. Audio starts only after a tap on the monitor ("enable sound" button) because of
  browser autoplay rules; sound is off per device until then.
- Silence: `silence` message sets `silencedUntil = now + 120000`; while silenced, tones are off and the bar shows a
  silence icon with remaining time; flashing continues. A **new** alarm of higher priority than anything active when
  silenced ends the silence on the monitor.
- Master off (`alarms.enabled = false`): no bar, no flashing, no sound.
- Alarm state is not stored on the server and not shared; each monitor derives it, so all monitors agree because their
  inputs agree.

## 8. Theme JSON schema v1

A theme is one JSON file; the monitor draws entirely from the active theme. The default is generic. A theme may copy
the look of any real monitor but carries **no logos or brand names**. `themes/generic-dark.json` and `themes/generic-light.json` ship (the built-in themes in `src/theme/`); others are imported by
file, URL or paste (S4). **THEMES.md documents every field.**

```jsonc
{
  "themeSchema": 1,
  "name": "Generic dark",
  "background": "#000000",
  "font": { "family": "system-ui, sans-serif", "numericWeight": 700, "labelWeight": 500,
            "numericScale": 1.0, "labelScale": 1.0 },
  "colors": {                       // per parameter: wave line, numeric, limits text
    "ecg":  "#00e000", "spo2": "#00d8ff", "etco2": "#ffe000", "abp": "#ff3030",
    "nibp": "#ffffff", "rr": "#ffe000", "temp": "#ffffff", "hr": "#00e000",
    "alarmHigh": "#ff2020", "alarmMed": "#ffd000", "alarmLow": "#00d8ff", "text": "#c0c0c0"
  },
  "layout": {
    "grid": { "columns": 12, "rows": 8, "gap": 4 },
    "cells": [                      // one entry per module part; unknown or disabled modules are skipped
      { "module": "ecg",   "part": "wave",    "x": 0, "y": 0, "w": 8, "h": 2 },
      { "module": "ecg",   "part": "numeric", "x": 8, "y": 0, "w": 4, "h": 2 },
      { "module": "spo2",  "part": "wave",    "x": 0, "y": 2, "w": 8, "h": 2 },
      { "module": "spo2",  "part": "numeric", "x": 8, "y": 2, "w": 4, "h": 2 }
    ],
    "alarmBar": { "x": 8, "y": 0, "w": 4, "h": 1 }
  },
  "waves": { "speedMmPerSec": 25, "lineWidth": 2, "sweepGapPx": 12, "fill": false,
            "ecg": { "speed": 25, "gain": 1 }, "spo2": { "speed": 25, "gain": 1 }, "etco2": { "speed": 25, "gain": 1 },
            "abp": { "speed": 25, "gain": 1 } },        // per-wave speed (mm/s) and gain; fall back to speedMmPerSec and 1
  "audio": { "alarm": { "volume": 1 }, "qrs": { "volume": 1 }, "spo2": { "volume": 1 } },   // 0-1 per channel (S2/S3 sound)
  "numerics": { "showLimits": true, "limitsPosition": "beside", "decimals": { "temp": 1 } },
  "labels": { "ecg": "HR", "spo2": "SpO2", "etco2": "EtCO2", "rr": "RR", "nibp": "NIBP", "temp": "Temp", "abp": "ABP",
              "units": { "hr": "/min", "etco2": "mmHg", "rr": "/min", "temp": "°C", "nibp": "mmHg", "abp": "mmHg" } },
  "alarmStyle": { "barPosition": "top-right", "flashHz": 1, "limitStyle": "small", "tones": "iec" }
}
```

Rules: a theme file is at most 32 KB; colours are `#rrggbb`; unknown keys are ignored; missing keys fall back to
`themes/default.json`; invalid values (bad colour, cell off-grid) are dropped one by one with a message in the editor,
not a whole-theme failure. The theme is **per device** (stored in the monitor's localStorage) unless the controller
sends it into the room (`theme: "custom"`, `themeJson`), in which case every monitor in the room uses it.

**S4 (theme engine, built):** `src/theme/` has `fields.js` (one table of editable fields with ranges, driving both the
editor and the range checks in `resolve.js`), `migrate.js` (`themeSchema` steps; v0 = unnumbered drafts), `validate.js`
(`parseThemeText`, `validateTheme` with fatal errors versus per-value warnings, `loadTheme` which never throws),
`builtin.js` (default and "Generic light", a second theme with another layout and palette), `store.js` (device choice
`sim.settings.theme`, precedence device, then room, then default) and `panel.js` (shared DOM panel: choose, import by file,
URL or paste, export, live editor). New alarm style keys: `alarmStyle.toneHz.{high,medium,low}`, `tones` (`iec` triangle or
`soft` sine), `limitStyle` (`small`/`bold`), `barPosition`, and `numerics.limitsPosition` (`beside`/`below`) now take effect.
Refused outright: not an object, over 32 KB, newer schema, custom CSS/script/markup (keys and text), no usable cell, over 12 KB
complete. The Room validates `themeJson` with the same code and stores the complete theme; `theme: 'default'` clears it.

**Later theme fields (all optional, defaults keep the look, `themeSchema` stays 1):** `numerics.limitsPosition: "left"`,
`numerics.meanPosition` (`below`/`inline`), `labels.colorMode` (`parameter` = how captions were always drawn, `text`),
`font.waveLabelScale`, `waves.<abp|etco2|ecg>.scaleLines` (0-4 reference lines in the wave's units, drawn on a second canvas
so the sweep never erases them), and `cells.border.{color,width,radius}` plus optional `cells.background`, and `screen.{mode,width,height}` (`fill` = today; `fixed` scales a
fixed-size layout evenly into the window; device override `sim.settings.screen` = theme/fill/fixed). Documented in THEMES.md.

**S2 additions (all optional, defaulted in `src/theme/default.js`, which is the in-code source of the default theme):**
`colors.grid` and `colors.flashText`; `waves.pxPerMm` (pixels per mm, so speed 25 mm/s is 100 px/s at 4), `waves.grid`
(draws a 5 mm grid behind the waves); `numerics.fontScale`; `nibp.inflateMs` / `nibp.measureMs` (0 = result at once);
`layout.grid.rows` may be fractional in cells; `layout.cells[].stack`: cells that share a stack name split the stack's
area top to bottom by their `h` shares, so a module that is off (or a cell skipped, e.g. the capnography RR when the `rr`
module is on) hands its space to the others; `labels.wave` (wave captions) and `labels.off` (sensor-off texts).
Wave speed and gain, units (`units`: co2 mmHg or kPa, temp C or F), volumes and `jitter` are also per-device settings
under `sim.settings.<key>` (`sweep.<wave>`, `gain.<wave>`, `vol.<channel>`); a device setting wins over the theme.
Modules register themselves (`src/monitor/modules.js`, waves in `src/waves/registry.js`): a new module is a
`register({...})` call, not a change to the layout or drawing code.

## 9. Build rules and options

- Installable but never prompted: the pages have a manifest and a pass-through service worker (offline mode is Later); each page calls
  `event.preventDefault()` on `beforeinstallprompt` and shows no install UI.
- New options are **off by default** and **per device** (localStorage keys `sim.opt.*`), e.g. sound, wake lock, show
  controller log, theme override.
- Wake lock and full screen: buttons on the monitor (`navigator.wakeLock`, `requestFullscreen`), never automatic.
- No analytics, no third-party scripts, no external fonts. Neutral wording in all text.
- CI: lint/type-check (`tsc --noEmit`), unit tests (node --test, workerd via `@cloudflare/vitest-pool-workers` is **not**
  used in v1; the Room logic is plain JS taking a fake storage, so node can test it), `vite build` of a tiny consumer
  entry, Playwright. Recipe: no `--with-deps`, `ubuntu-24.04`, caches, concurrency, timeouts.

## 10. Tests
11. Settled details

- Room (node, fake storage): join gets state; `set` broadcasts to all sockets; a late joiner gets current state; patch
  allow-list rejects unknown paths; rate and size limits; expiry alarm clears state; `rev` increases by one.
- Engine: glide midpoints and mid-glide restart; alarm priorities; silence expiry.
- Playwright: two browser contexts, the controller sets a value, the monitor shows it within 1 s.

## 11. Settled details

Answers to questions a fresh reader asked; they override anything looser above.

- **Atomic patches.** One bad path or value rejects the whole `set` (`bad_patch`); nothing changes, no `rev` bump.
  `modules` replaces the list (not a merge); every module, ECG included, can be missing from it; unknown ids are kept
  and ignored. Limits merge per parameter name; `low <= high`. `temp` is rounded to 0.1 on the server.
- **Initial glide (each new patient):** `startedAt` = creation time, `durationMs` 0, `from` = default numerics (so the displayed
  values equal the targets).
- **One glide per patient.** Each patient's `glide` has a single `durationMs` for all its numerics; other patients are untouched. A `set` restarts that patient's glide only if its
  patch changes at least one numeric target (`hr spo2 etco2 rr temp nibp abp`; sending the same value still restarts it).
  Rhythm, modules, limits, sensor-off flags, wave shapes, `pvcPerMin`, `ie`, `pulse`, `st`, `flutterRatio`, `label` and `glideMs` alone never restart it. Duration = message `glideMs` if given, else
  the patient's `glideMs` (after the patch). `glideMs` is 0 to 600000; message `glideMs` is not stored. `from` is stored raw
  (unrounded); only display and the `nibp` reading round, with `Math.round`.
- **Rhythm change** does not touch the glide; the HR keeps gliding. `hr` is validated 0-300 whatever the rhythm; for
  `vf` and `asystole` the monitor shows `--`.
- **NIBP cycle.** The server has no timer. When a patient's `nibpRead.mode` is `cycle`, each monitor showing it, when `nibpRead.at + cycleSec*1000`
  passes, sends `{t:"nibp", p, after:<the nibpRead.at it saw>}`. The server ignores a `nibp` whose `after` is not the current
  `nibpRead.at`, so with several monitors only the first counts. A `nibp` without `after` (controller "measure now") always
  counts.
- **Roles** are labels only in v1: any client may send any message. `id` is for the event log; duplicates are harmless.
  `hello` is optional and answered with `state`.
- **Expiry** is extended only by accepted changes (`set`, `nibp`, `addPatient`, `removePatient`, `mark`, `silence`, `test`), not by `ping`, `hello` or a
  connection. On close code 4001 the client does not reconnect: it shows "room ended" with a link to start a new one.
  Code 4002 is sent after accepting the socket when 20 others are already connected.
- **Errors:** `bad_json` (not JSON, no `t`, or unknown `t`), `too_big`, `rate`, `bad_patch`. At the rate limit, excess
  frames get one `rate` error per second and are otherwise dropped. Counters are in memory and reset when the object wakes.
- **Codes.** Characters outside the alphabet make a code invalid (no look-alike mapping); the Worker answers 404 for a
  page and 400 for a socket with a bad code, and the pages show "No room code". `POST /api/room` returns `{"code":"ABC234"}`;
  a collision just joins the existing room (31^6 codes; rooms are throwaway).
- **Size.** A custom `themeJson` inside a room is at most 12 KB (the 16 KB frame limit); the 32 KB limit is for a theme file
  elsewhere. "Under 4 KB" state size excludes a custom theme.
- **Alarm criticals.** High priority applies when the parameter is outside its limits AND: SpO2 < low limit - 5, HR < 40,
  or HR > 150; plus asystole, VF, VT regardless of limits. Silencing is per monitor (its own `silencedUntil` is shared, but
  a "higher priority ends the silence" is evaluated locally), so monitors may differ for a moment. "Similar notices" for
  low priority: "NIBP not measured > 10 min" only in v1 (never raised if no reading has been taken yet).
- **Events** carry `kind` (`set`, `rhythm`, `nibp`, `patient`, `alarm`, `silence`, `bookmark`, `shock`, `test`; `alarm` and `shock` are reserved for later features), the patient id `p` when one applies, and a short `what`. Only the last 20 are kept in the state; a longer log can later move to SQLite rows in the Room (rooms expire in 24 h, so no migration is needed).
- **Event text** is `set <top-level keys>`, `nibp`, `add <id>`, `remove <id>`, `mark[ text]`, `silence`, `test`. `baseRev` is accepted and ignored in v1.
- **Clock offset:** ping on open and every 10 s; keep the sample with the smallest round trip.
- **Defaults (new room)** are exactly `defaultState()` in `src/shared/schema.js`.
- **Patients.** `p` on `set`/`nibp` names a patient; an unknown `p` is `bad_patch`; no `p` means the first. New ids are the
  lowest free `p<n>`. A monitor with `?p=<id>` for a removed or unknown patient shows the first patient. `id` is not
  patchable. Alarm limits and modules are room-wide, not per patient.
- **Schema stays v1.** All additions are new fields with defaults; a stored room from before this change is not migrated
  (rooms expire after 24 h and nothing was deployed with the old shape).

# sim: design

A phone (controller) drives a simulated patient monitor shown on a laptop or tablet (monitor), live, through a
throwaway room. For teaching simulation only: no patient data, no login, no real clinical use. Look: generic (common
monitor conventions, colours on black); no brand names or logos.

## Contents

1. Pieces and files
2. Rooms: lifetime, codes, URLs
3. State schema (v1)
4. Modules
   4a. Named screens
5. Message protocol
   5a. Room log, trends, debrief
6. Glide model
7. Alarm model
8. Theme JSON schema v1
9. Build rules
10. Tests
11. Settled details
12. Scenarios and drug buttons (V2 S3)

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
  "scenario": { "id": "n7", "name": "Slow bleed", "p": "p1", "step": 1, "total": 3, "nextAt": 1761000000000, "waiting": false, "pausedAt": 0, "done": false, "startedAt": 1760999900000 },  // optional, section 12
  "theme": "default",              // "default" or "custom"; custom JSON is in "themeJson" (S4)
  "screens": {                     // named screens (section 4a); absent or {} in a new room; max 12
    "s1": { "name": "Left", "kind": "monitor",       // id server-made (s1, s2, ...), name 1-24 chars; kind monitor | defib
            "p": "p2",                                // optional: the bed this screen shows
            "modules": ["ecg", "spo2"],               // optional: this screen's modules (absent = the room's)
            "theme": "light", "themeJson": "{...}" }  // optional: built-in id, or "custom" with themeJson
  }
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
| `abp2` | second arterial line (femoral, say): own sys/dia, label `abp2Label`, wave `abp2` | **off by default** |
| `cvp` | central venous pressure: a, c, v waves and x, y descents, mean numeric | **off by default** |

**Lines (S2).** `cvp` (mean, -5 to 40), `cvpV` (`normal` or `giant`), `ppv` (0 to 40 %: pulse pressure swings with the breath on `abp` and `abp2`), `abp2` and `abp2Label` (up to 8 characters) are patient fields; `off.cvp` and `off.abp2` are sensor flags. CVP has no a wave without atrial contraction (AF, VF) and shows cannon a waves when the atria beat against a closed valve (complete heart block, VT). The **flush test** is the message `{t:'flush', line:'abp'|'abp2', p}`: the room only records an event (`kind: 'flush'`); each monitor draws a square wave then ringing that matches `abpDamping` (normal 2-3 oscillations, over none, under many) from the event time, for 3 s. Limits `cvp` and `abp2Sys`; alarms `CVP HIGH/LOW`, `ABP2 SYS`.

Later (reserved ids, not drawn yet): `pap`. A client ignores module ids it does not know.
**Every** module can be hidden, ECG included (a screen may show only the EtCO2 wave). `state.modules` is the room's
list; a named screen (section 4a) may carry its own list, which wins for that screen.

## 4a. Named screens

Each monitor can be a **named screen** the phone sets: its own bed, module list and theme (V2 S1).

- **Ids** are server-made, `s1`, `s2`, ... (the lowest free number; max 12 per room). `kind` is `monitor` (`defib` is
  reserved for the defib screen); it is set at creation and cannot be patched.
- **Naming**: a monitor with no screen id shows a small card "Name this screen" at the top (never blocking; "Not now"
  hides it for this page load and the monitor follows the room). Saving sends `addScreen`; the reply `screenAdded`
  gives the id, kept per device and room in `localStorage` (`sim.settings.screenId.<code>`). `?s=<id>` in the monitor
  address overrides the stored id for that visit (never saved). A stored id the room no longer has (forgotten, or the room expired) is dropped and
  the card comes back.
- **Settings** go through `set` with `patch.screens.<id>.{name, p, modules, theme, themeJson}`; `null` clears `p`,
  `modules` or the theme (back to the room). A built-in `theme` drops `themeJson`; `themeJson` alone means `custom`.
  Removing a bed clears it from any screen that showed it.
- **Precedence** on a monitor, for bed, modules and theme: the device's own choice (`?p=`, the monitor's theme pick)
  \> the screen setting > the room > the default. The monitor reports its device choices with `iam`; the phone shows
  them under the screen ("this screen's own choice wins") with a button that sends `clearDevice`.
- **Identify** shows the screen's name full screen on that monitor for 3 s. Nothing is stored.
- **Forget** (`forgetScreen`) deletes the entry; that monitor asks for a name again and follows the room.
- The phone's **Screens** tab lists the screens (online dot from presence), with rename, bed, modules (same as the room,
  or a per-module list), theme (same as the room, a built-in, or an imported file), Identify and Forget.

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
| `mark` | `p?`, `text?` | bookmark in the event log (`kind: "bookmark"`, text up to 200 chars) for debriefs; the phone's Mark button (header) and Trends tab send it. `rev` +1. |
| `history` | `range?` (ms, default 4 h, max 24 h), `all?` | asks for the full log (section 5a); the sender gets `history`. Not stored, `rev` unchanged. |
| `silence` | none | `alarms.silencedUntil` = now + 120000. |
| `ping` | `n` | server replies `pong` with same `n`; used to measure delay and keep the connection alive. |
| `addScreen` | `name?`, `kind?` | adds a named screen (section 4a; id `s<n>`, name default `Screen <n>`); the sender gets `screenAdded`. `rev` +1. |
| `forgetScreen` | `s` | deletes screen `s`. `rev` +1. |
| `iam` | `s` (id or null), `dev` (list of `theme`, `p`) | a monitor says which screen it is and which device choices it has; kept with the socket, sent out in `presence`. Not stored. |
| `identify` | `s` | the server sends `identify` to every socket (the monitor for `s` shows its name). Not stored. |
| `clearDevice` | `s`, `what` (`theme` or `p`) | the server sends `clearDevice`; that monitor drops its own choice. Not stored. |
| `scenarioStart` | `p?`, `scenario` | starts a timed scenario on bed `p` (validated like a library file entry, section 12); replaces a running one. `rev` +1. |
| `scenarioPause` / `scenarioResume` / `scenarioNext` / `scenarioStop` | none | pause, resume, run the next step now (skips a countdown or answers a tap), or stop. Error `bad_patch` "no scenario is running" when none runs. |
| `drug` | `p?`, `drug` | applies a drug button's relative change to bed `p` with a glide (section 12). `rev` +1. |
| `test` | `value` | v1 shell: stores `value` (any JSON up to 1 KB) in `state.test`, broadcast. Removed by S2/S3. |

Server to client:

| t | fields | meaning |
|---|---|---|
| `state` | `state`, `now` | full state, sent to a client right after it connects (a late joiner gets the current state) and after any change; `now` is the server clock for offset correction |
| `error` | `code`, `msg` | `bad_json`, `too_big`, `rate`, `bad_patch` |
| `pong` | `n`, `now` | |
| `presence` | `monitors`, `controllers`, `screens` | counts of connected sockets by role, and `screens: [{s, dev}]` for monitors that sent `iam` with an id (one entry per screen, device choices merged), sent to every socket when one joins, leaves or sends `iam` (S3, V2 S1). Not stored, not in `state`; a client keeps the last one. The controller shows "N monitors". |
| `screenAdded` | `s` | reply to `addScreen`, to the sender only |
| `history` | `now`, `since`, `expiresAt`, `events`, `glides` | reply to `history`, to the sender only (section 5a) |
| `identify` | `s`, `ms` | show screen `s`'s name for `ms` |
| `clearDevice` | `s`, `what` | screen `s` drops its own `theme` or `p` choice |

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

## 5a. Room log, trends, debrief

`state.events` still carries the last 20 events for the controller. The Room also keeps **every** event and every glide
start as SQLite rows in its own Durable Object storage (`src/room/log.js`; deleted with the room at the 24 h expiry):

- `events(id, t, by, kind, p, what)`: one row per accepted change, the same entry `state.events` gets.
- `glides(id, t, p, dur, from_json, to_json)`: one row whenever a bed's glide record or numeric targets change (also a
  new bed). `from` is what was displayed at `t`, `to` the targets, the same shape as `numericsOf`.
- Each table keeps its newest 5000 rows. Rows are written in the same step as the state (`RoomHub.record`).

**Trends are rebuilt from these rows (seam 8); there is no trend store.** The value at time `t` for a bed is
`displayed()` of the last glide record at or before `t` (before the first record: that record's `from`; no records:
the bed's own glide from `state`). So a trend point equals what a monitor showed then; pulseless and sensor-off blanks
are display rules and are not applied. Code: `src/trends/series.js` (sampling, groups per module), `chart.js` (SVG graph
and table as strings), `panel.js` (the panel, shared by phone and monitor).

`history` reply: `events` (newest 5000 with `t >= since`, oldest first), `glides` (all from `since`, plus each bed's last
one before it), `expiresAt` (server ms the room is deleted if nobody changes anything: last change + 24 h), `now`.

UI (all off or closed by default; installable, never prompted):
- Phone: **Mark** button in the header (bookmark now, bed = current) and a **Trends** tab: bookmark with a note, range
  30 min / 1 h / 4 h, graph or table for the current bed, orange lines for bookmarks and grey for other events,
  Refresh, **Debrief file** and **JSON** buttons, and the expiry time (shown as a warning under 2 h).
- Monitor: **Trends** button in the toolbar opens an overlay with the same panel for that screen's bed; closed by default.
- Debrief: built in the browser from `history { all: true }`: one HTML file (inline SVG graph per bed, event list, the data
  embedded as JSON, no outside links, works offline) and the same data as JSON. Nothing is uploaded.

No schema change: the log is outside `state`, `schema` stays 1.

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
- Log and trends (`test/trends.test.mjs`, real SQLite via `node:sqlite`): more than 20 events persist and survive a restart,
  bookmarks, history window and expiry, row cap, trend values equal `displayed()` at sampled times (mid-glide, after a second
  change), graph and table from one series, debrief HTML is self-contained and escaped. `test/e2e/trends.mjs`: phone marks and
  bookmarks, graph, table equals the displayed HR, monitor overlay, debrief downloads and opens offline.

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
- **Events** carry `kind` (`set`, `rhythm`, `nibp`, `patient`, `alarm`, `silence`, `bookmark`, `shock`, `scenario`, `drug`, `test`; `alarm` and `shock` are reserved for later features), the patient id `p` when one applies, and a short `what`. Only the last 20 are kept in the state; a longer log can later move to SQLite rows in the Room (rooms expire in 24 h, so no migration is needed).
- **Event text** is `set <top-level keys>`, `nibp`, `add <id>`, `remove <id>`, `mark[ text]`, `silence`, `test`. `baseRev` is accepted and ignored in v1.
- **Clock offset:** ping on open and every 10 s; keep the sample with the smallest round trip.
- **Defaults (new room)** are exactly `defaultState()` in `src/shared/schema.js`.
- **Patients.** `p` on `set`/`nibp` names a patient; an unknown `p` is `bad_patch`; no `p` means the first. New ids are the
  lowest free `p<n>`. A monitor with `?p=<id>` for a removed or unknown patient shows the first patient. `id` is not
  patchable. Alarm limits and modules are room-wide, not per patient.
- **Schema stays v1.** All additions are new fields with defaults; a stored room from before this change is not migrated
  (rooms expire after 24 h and nothing was deployed with the old shape).

## 12. Scenarios and drug buttons (V2 S3)

**State.** Additive field `scenario?` (schema stays 1): `{ id, name, p, step, total, startedAt, pausedAt, nextAt, waiting, done }`.
Only one scenario runs per room. `nextAt` is the server time the next step is due (0 while `waiting` for a tap or
while paused). The step list itself is kept in Room storage (`scenarioSteps`), not in the broadcast state.
Removing the scenario's bed removes the scenario.

**Running.** The Room runs steps on its own clock, so a scenario goes on with every phone closed. It shares the one
storage alarm with idle expiry: the alarm is set to the earlier of the two (`alarmAt`), and when it fires the Room runs
every step that is due, in order (a late alarm catches up), then broadcasts. A step's `atSec` is seconds after the
previous step; `onTap: true` waits for `scenarioNext`. A step patch may only hold `patient` and `alarms` keys and uses
the normal `set` rules and the step's `glideMs`. Each step appends a `scenario` event; a drug appends a `drug` event.

**Files.** One library file holds scenarios and drugs: `{ "sim": "library", "version": 1, "scenarios": [...], "drugs": [...] }`
(max 32 KB, 20 scenarios, 20 drugs, 30 steps of up to 3600 s each). A drug is `{ name, note?, glideMs?, effects }`
where `effects` maps `hr spo2 etco2 rr temp cvp` to `{ mul?, add? }` (mul 0 to 5, add -300 to 300) and `nibp abp abp2`
to `{ sys?, dia? }` of the same ops. The new value is `current * mul + add`, clamped to the field's range and rounded;
`glideMs` defaults to 20000. A bad file is refused whole with a reason; nothing is imported. Built-in names cannot be
replaced. Libraries live in this device's `localStorage` (`sim.scenarios`, `sim.drugs`); drug buttons are off by default
and switched on in More (`sim.settings.drugs`). Built-ins are generic teaching examples with no doses.

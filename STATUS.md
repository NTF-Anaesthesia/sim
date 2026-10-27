# sim: status

## Now
- Phone and monitor ease (PR): compact vital rows (tap the value to type it, − + beside it, slider under, % buttons can be hidden in More), one swipeable glide row, scrolling tabs, fits 320 px; SpO2 recovers at the chosen speed and falls 3x slower; NIBP/ABP sys and dia linked by default (Linked chip on the sys row, switch in More); themeable monitor keys (Start NIBP, NIBP cycle, Silence, TOF) under theme `keys`, shown per device with the monitor's Keys button.
- sim-train S3 share, room library, debrief export (PR): Share on a scenario card gives a QR (small scenarios) and a copy link `/c/#s=…` (versioned, deflated); opening it offers Import, a bad or too-new link changes nothing; "Offer my library to this room" (32 KB, replaced by the next offer, gone with the room) and "Library offered: N scenarios, Import" on other phones; Trends saves a PNG (chart + events incl. steps, drugs, notes) and opens a print view. Facilitator notes now sit in the log (not on monitors), so the debrief files contain them.
- sim-train S4 curated scenarios (PR, for clinical review): ten generic built-in teaching scenarios with objectives and per-step notes, tagged anaesthetist / nurse-OT, added after the original three (`src/controller/builtin-scenarios.js`); a unit test validates every built-in and runs each to the end with a fake clock.
- sim-train S2 record, step editor, teaching notes (PR): a Record button in Scenarios (every change on the bed becomes a step with its real wait and its own speeds; drug buttons too); Stop names and saves it and opens the editor; the editor (cards: wait / on tap, glide, note; reorder, delete, rename; built-ins open as a copy) also opens from the queue's "Save as scenario"; scenarios get optional `objectives`, steps an optional `note`, shown on the phone only (the room strips them from everything a monitor receives).
- sim-train S1 speed per change, queue, live tempo (PR): each pending change can have its own speed (more speeds 5 s to 5 min and a custom time), one Apply sends them all as `glideMs` + `glideMsBy`; "Add to queue" (after X s or on tap) with a queue panel (move, skip, save as scenario); live tempo 0.5x / 1x / 2x / Finish now; fits 360 px.
- sim-v2 S5 gas + TOF (PR): FiO2, agent Fi/Et with age-adjusted MAC (Nickalls and Mapleson 2003, cited in DESIGN.md), N2O, agent and O2 traces, TOF on demand and on an interval; alarms for FiO2 (hypoxic mixture high) and Et agent in MAC; phone rows, agent select, trends; all off by default, per device.
- sim-v2 S7 defib screen (PR): a screen of kind defib shows ECG, energy, charge, shock and sync (touch and mouse); pads off blocks the shock; a shock draws artefact on every screen of the bed, applies the bed's postShock rhythm and logs a `shock` event; all off by default.
- sim-v2 S6 BIS + EEG strip (PR): module `bis` (BIS, SQI, EMG, SR) with a raw EEG strip that changes with depth (fast awake, slow when deep, burst suppression with SR); off by default; theme cells in both built-in themes; alarms and limit; trends group.
- sim-v2 S3 scenarios and drugs (PR): timed scenarios run by the room on the storage alarm (phone can be closed), pause, skip, tap steps; import/export library files with refusal reasons; drug buttons with a glide, off by default.
- sim-v2 S4 trends + debrief (PR): every event and glide start kept as SQLite rows (state still shows the last 20); Mark button and Trends tab on the phone; trend graph and table (30 min / 1 h / 4 h) on phone and monitor (Trends button, overlay closed by default); one-file offline debrief (HTML) plus JSON; 24 h expiry shown on the phone.
- V2 S1 named screens (this PR): each monitor names itself once and gets its own bed, modules and theme from the phone's Screens tab; Identify, Forget, online dots; device choices win and can be cleared from the phone.
- sim-v2 S2 lines (PR): CVP (a/c/v, cannon a, giant v), second art line `abp2` with its own label, PPV swing, flush test; all off by default; alarms and limits for CVP and ABP2.
- Theme fields (PR): limits `left`, mean `inline`, `labels.colorMode`, `font.waveLabelScale`, `scaleLines`, cell borders and background.
- S4 theme engine (this PR): themes as files; import by file, URL or paste on the monitor and from the phone for every monitor; export; live editor; second built-in theme; `THEMES.md`.
- S2 monitor screen (this PR): `/m/<code>` draws from the theme: ECG II, pleth, capnogram, art line (module `abp`), HR/SpO2/NIBP/RR/EtCO2/temp, all rhythms, alarms with tones and 2 min silence, NIBP cycle, jitter, full screen, wake lock, sound after a tap.
- S3 (PR): phone controller at `/c/<code>` (tabs Vitals / Alarms / Presets / More), `presence` message, client `wake()`.
- S1 (merged): repo, Worker + Durable Object rooms, test shell (monitor and controller exchange a test value), DESIGN.md, CI.

## Waiting on the owners
- Nothing.

## Next
1. S2 monitor screen (waves, numerics, rhythms, alarms drawn from a theme) and S3 phone controller (values, glide,
   rhythms, alarms, presets), in parallel after S1 merges. Shared files: `src/shared/schema.js` (state), `DESIGN.md`.
2. Later: V2 items from the plan (timed scenarios, trends, more waves).

### S2 test list (monitor)
- Wave synthesis per rhythm (sinus, brady, tachy, AF, flutter, SVT, VT, VF, asystole, PEA: normal ECG, flat pleth): beat timing follows the glided HR.
- Glided numerics on the monitor match `displayed()` at a given server time; two monitors agree.
- Numerics layout from the default theme; ABP wave and numeric appear only when module `abp` is on.
- Alarms: limit violations raise the right priority and text; numeric flashes; sound after the first tap; silence 2 min and expiry; a new higher-priority alarm ends the silence; master off hides everything.
- NIBP numeric shows the last reading with its time; cycle mode re-measures on schedule.
- Full screen and wake lock buttons (off by default); reconnect chip after 3 s offline; monitor keeps drawing while offline.
- Playwright: controller sets rhythm VT, monitor shows VT and the alarm bar within 1 s; art line toggle adds the wave.

### S3 test list (controller)
- Every control sends a `set` with only allowed paths (server rejects the rest); sliders and number entry respect ranges.
- Glide time control changes `glideMs` per change; a second change mid-glide starts from the shown value.
- Rhythm list, module toggles (art line off by default), limits editor, alarm on/off, silence, NIBP now / cycle.
- Presets apply many fields at once with a glide time; presets are synthetic only.
- Phone layout: one hand, 44 px targets, no horizontal scroll at 360 px; reconnect state visible; no install prompt.
- Playwright: two contexts, preset applied on the phone reaches the monitor within 1 s; late joiner gets current state.

## Recently done
- V2 S8: transcutaneous pacing on the defib screen (spikes, capture by threshold, failure to capture and to sense), junctional, bigeminy/trigeminy and a second ECG lead lane.
- Repo created (26 Oct).

## Decisions
- 26 Oct: Durable Object per room (SQLite-backed), full state broadcast on every change (under 4 KB), server owns `rev`.
- 26 Oct: Values glide on each monitor from the server's glide record; only changes cross the network.

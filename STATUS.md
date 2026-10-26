# sim: status

## Now
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
- Repo created (26 Oct).

## Decisions
- 26 Oct: Durable Object per room (SQLite-backed), full state broadcast on every change (under 4 KB), server owns `rev`.
- 26 Oct: Values glide on each monitor from the server's glide record; only changes cross the network.

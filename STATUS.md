# sim: status

## Now
- S1 (this PR): repo, Worker + Durable Object rooms, test shell (monitor and controller exchange a test value), DESIGN.md, CI.

## Waiting on the owners
- Nothing.

## Next
1. S2 monitor screen (waves, numerics, rhythms, alarms drawn from a theme) and S3 phone controller (values, glide,
   rhythms, alarms, presets), in parallel after S1 merges. Shared files: `src/shared/schema.js` (state), `DESIGN.md`.
2. S4 theme engine (import/export by file, URL, paste; a second theme proves the schema).

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

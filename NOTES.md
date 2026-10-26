# sim: notes

Lasting rules live in `AGENTS.md`. Points worth remembering go here.

- Installable web apps stay installable but are never prompted (see `AGENTS.md`).
- Room code alphabet has no 0 O 1 I L; URLs `/m/<code>` (monitor), `/c/<code>` (controller), `/ws/<code>` (socket).
- The Durable Object class `Room` is SQLite-backed (free plan). Its logic is `src/room/hub.js`, tested in node with a
  fake storage; `worker/room.js` only handles sockets. Hibernation: never trust memory after a wake; read storage.
- Entries in `package.json` `exports` (`room`, `engine`, `waves`, `theme`, `monitor`, `controller`) have no side effects on
  import; `tools/check.mjs` enforces it. A Vite build in CI proves the kit builds inside a Vite app.
- Pages use relative paths. `/m/<code>` is the same page for any code, so `../src/...` imports work from there.
- Local browser test: `CHROMIUM_PATH=<chrome> npm run e2e` with `npx wrangler dev --port 8787` running.
- Actions cannot open PRs in this repo (the org setting returned a conflict when set); sessions open PRs with the GitHub tools.
- Controller (`src/controller/`): every change goes through `act(patch, glideMs, p)` in `actions.js`; presets are `{name, steps:[{atSec, patch, glideMs}]}` (V1: one step at 0). Per-device settings use `sim.settings.*` (units, last glide time); saved presets use `sim.presets`. Units are display only; the wire is mmHg and C.
- The phone calls `client.wake()` on visibilitychange, pageshow and online: a dead socket is replaced at once, a silent one after a 2.5 s ping check.
- Local controller test: `CHROMIUM_PATH=<chrome> node test/e2e/controller.mjs` with `npx wrangler dev --port 8787` running.
- Monitor (S2): beat events drive ECG, pleth, ABP and the QRS beep; breath events drive the capnogram; both are made 0.6 s
  ahead on the display clock (`performance.now()`), so a rhythm change shows at the next beat. Glide, silence and NIBP use
  the server clock (`client.serverNow()`). The schedulers run in real time: tests step them like frames (a jump of more than
  a couple of seconds counts as a pause and restarts them).
- Monitor code adapted from the `ot` repo (read-only reference): lane sweep, synth tones,
  alarm tones, rhythm model, numerics jitter. Rewritten as plain modules with the theme and registries; no code is shared.
- The monitor keeps a hidden `data-testid="value"` element with the S1 test value until S3 drops the controller test input.
- Monitor e2e: `CHROMIUM_PATH=<chrome> node test/e2e/monitor.mjs` (screenshots go to `test/e2e/out/`, ignored by git).
- Theme engine (S4): `loadTheme` never throws and is what the monitor uses; `validateTheme` is the import gate (the phone panel, the monitor panel and the Room all use it). A refused file changes nothing. Editing a value in the monitor's panel stores a full custom theme on that device and rebuilds the view (wave history restarts). After changing a built-in theme run `node tools/export-themes.mjs` (a unit test checks `themes/*.json`). Local test: `CHROMIUM_PATH=<chrome> node test/e2e/theme.mjs`.
- Lines (sim-v2 S2): `src/waves/lines.js` has the CVP trace and the flush shape; `WaveSource.flush` holds the display time a flush began per line (set by the screen from `flush` events in `state.events`, never from the patient). Modules `cvp` and `abp2` are off by default and switched on from the phone. Local test: `CHROMIUM_PATH=<chrome> node test/e2e/lines.mjs` with `npx wrangler dev --port 8787` running.

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

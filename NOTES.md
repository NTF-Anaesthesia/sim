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

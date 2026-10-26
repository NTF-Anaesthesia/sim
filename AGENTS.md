# sim

Instructions for every AI assistant working here (Claude Code reads this through `CLAUDE.md`).
A phone controls a simulated patient monitor shown on a laptop or tablet, live, through a throwaway room code. For
teaching simulation only. Live at https://sim.anantf.com/; one Cloudflare Worker (static files + a Durable Object per room),
deployed by `.github/workflows/deploy.yml` on every push to `main`. Design: `DESIGN.md` (read it first).

## Public here, private elsewhere

Anything merged here is public. Keep only code, docs, general rules and **made-up** sample data. Never commit
secrets, tokens, personal data, real names or patient details. Private notes belong in this repo's private pair
(`<app>-private`, in the same organisation) and the shared notes repo; never copy anything from there into this repo,
a PR or an issue (neutral pointers like "ask the owner" are fine).

## Rules that bite

- All patients are synthetic; this is teaching software, never clinical advice.
- Read `NOTES.md` and `STATUS.md` before changing the app.
- Relative paths inside the app; links to other NTF pages are absolute, e.g. https://anantf.com/.
- Installable web apps cancel the browser's automatic install prompt: add
  `<script>addEventListener('beforeinstallprompt', e => e.preventDefault());</script>` to the `<head>` of every page
  that links a manifest. Keep the manifest, icons and service worker: installable, never prompted. No install buttons.

## Checks before merging

`npm ci`, then `npm run check` (repo checks + types), `npm test` (unit), `npm run build` (Vite build), and
`npm run e2e` against a running `npx wrangler dev --port 8787` (two browser contexts). Keep `.github/workflows/checks.yml` in step.
No Philips (or other brand) names or logos anywhere; new options are off by default and per device.

## Working with the maintainers

- Instructions mostly come from a phone. Work through a request to the end; ask only when a decision is genuinely
  the maintainers'. When asked to plan, plan and wait.
- Keep each PR small and finished on its own. Start PR titles with the app: "<App>: …".
- Merge your own PRs once the checks pass, then report with the PR link and call `unsubscribe_pr_activity`.
- Push once per finished step, not after every small commit (limited build minutes).
- Keep `NOTES.md` (lasting decisions, how to test) and `STATUS.md` (now, waiting, next, dated decisions) up to date.
- Plain words, short; explain technical terms briefly the first time.

## Token savers

- `.claude/settings.json` is only read when a session has exactly one repo attached; sessions usually attach the
  shared notes repo as well, so keep the environment's settings in step.
- Add generated and very large files to the `deny` list in `.claude/settings.json` and say so here.
- Run only the touched app's tests while iterating and the full run once before merge.

## Private notes and repo layout

Private notes: `NTF-Anaesthesia/ntf-hub-attach-always` (private, org members only). At the start of a session attach it
(`add_repo`) and read its `AGENTS.md`; save lasting notes there, never here. Repo layout: one repo per app or app
group, public code plus a `-private` pair; a new app gets its own repo (test in ntf-hub-attach-always `hub/new-repo.md`),
never a folder here.

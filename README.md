# ntf-public-template

Starting point for a new public NTF repo (one app or app group). Use **Use this template**, then follow the checklist.

## Checklist after creating the repo

1. Replace `<app>` and the one-line description in `AGENTS.md`, `README.md`, `STATUS.md` and `NOTES.md`.
2. Create the private pair `<app>-private` from `ntf-private-template` (when the app has notes or data).
3. Add `wrangler.jsonc` (Worker name, custom domain `<app>.anantf.com`); the organisation secrets are used by `deploy.yml`.
4. Add the repo to the shared hub's `hub/repo-map.md`.
5. Delete this checklist from `README.md`.

## What is here

- `AGENTS.md`: rules for every assistant; `CLAUDE.md` points to it.
- `.claude/settings.json` and `.claude/hooks/attach-notes.sh`: cloud sessions are told to attach the shared private notes repo first.
- `.github/workflows/`: `checks.yml` (pull requests and main) and `deploy.yml` (Worker, organisation secrets, no Workers Builds).
- `STATUS.md` and `NOTES.md`: current state and lasting decisions.

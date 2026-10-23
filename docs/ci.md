# CI cost and what runs where

Issue #20 asked whether GitHub Actions is needed and whether most tests can move to pre-commit hooks.

## Measured baseline (run 39883259200, a pull request run on 2026-10-23)

| Job | Step | Seconds | Billed |
| --- | --- | ---: | --- |
| telemetry-comment | whole job | 3 | 1 min |
| test | checkout, setup-node, `npm ci` | 5 | |
| test | Playwright and Pi caches | 5 | |
| test | bundle and start mock scratch server | under 1 | |
| test | `npm test` plus 4 UI suites (parallel pool) | 22 | |
| test | budget check, usage summary | under 1 | |
| test | whole job | 37 | 1 min |

Each run bills about 2 minutes (one per job, rounded up). Earlier PRs (#124, #127, #137) already cut the 20-minute pipeline to under a minute; recent CI runs finish in 40 to 90 seconds. Compare any later change with `gh run list --workflow CI`.

## Keep, move or remove

| Step | Decision | Reason |
| --- | --- | --- |
| telemetry-comment job | keep | Required check; needs the GitHub API, cannot run locally. |
| checkout, setup-node, `npm ci` | keep | Needed by every later step; cached. |
| Playwright and Pi caches and install | keep | Needed by the 4 UI suites; cached, seconds. |
| Mock scratch server | keep | The UI suites talk to it; tests the bundled server production runs. |
| `npm test` unit pool | keep, and also run in the pre-commit hook | A green run on `main` triggers the deploy hook, so `main` must stay fully tested. The hook is the earlier, faster gate. |
| UI suites (composer-scroll, drafts, attachment-drafts, pi-e2e) | keep | Need a browser and the scratch server; not suitable for a commit hook. |
| Test time budget | keep | Stops test time creeping back up. |
| Runner usage summary | keep | Feeds the measured table above. |
| Server log on failure | keep | Only runs when a step fails. |

Nothing was removed: the whole job is 37 seconds, so cutting further would trade deploy safety for under a minute per run.

## Local pre-commit hook

`.githooks/pre-commit` runs `npm test` and rejects the commit when it fails. Enable it once per clone:

```
git config core.hooksPath .githooks
```

Agent worktrees keep their own `pre-push` hook (`.git/ac-hooks`, per-worktree `core.hooksPath`) that refuses pushes to `main`; do not override it there. `test/git-hooks.ts` proves the hook blocks a commit when the suite fails and allows it when it passes.

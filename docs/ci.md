# CI cost and what runs where

Issue #20 asked whether GitHub Actions is needed and whether most tests can move to pre-commit hooks.

## Measured baseline (run 41388550640, a pull request run on 2026-11-02)

Wall time of the whole run: 90 s. GitHub bills each job rounded up to a whole minute.

| Job | Step detail (seconds) | Job seconds | Billed |
| --- | --- | ---: | ---: |
| telemetry-comment | polls the PR comments | 4 | 1 min |
| formal-queue (before this change) | elan install, `lake build` | 17 | 1 min |
| release | `npm ci`, release, standby, handoff tests | 38 | 1 min |
| test-shard 1/3 | setup 5, `npm ci` 5, Biome and Ruff 5, lint 1, Playwright 9, Pi and server 3, ready gate 9, tests 22, uploads 3, cache save 4 | 65 | 2 min |
| test-shard 2/3 | same steps | 73 | 2 min |
| test-shard 3/3 | same steps | 67 | 2 min |
| test | download logs, whole-suite coverage and time budget | 9 | 1 min |
| **Total** | | | **10 min per run** |

## Billed minutes per run

| | Before (run 41388550640) | After (run 41394447423, this PR, all jobs green) |
| --- | ---: | ---: |
| Jobs | 7 | 6 |
| Billed minutes | 10 | 7 |
| Wall time | 90 s | 70 s |

After-change jobs, seconds from start to finish: telemetry-comment 4, release 64 (2 billed minutes, now with the Lean proofs), test-shard 46, 54 and 57 (1 each), test 7. The `formal-queue` job now runs inside `release`: its 17 s of Lean work shares the already-billed runner instead of starting a runner of its own.

Read the 3-minute drop with care. Billing rounds each job up to a whole minute, and the shards sat just under 60 s in this run but at 65 to 73 s in the baseline, so shard minutes move between 1 and 2 per shard from run to run. The fold itself is billing-neutral when `release` crosses 60 s, as it did here (49 s plus 20 s became 64 s: 2 minutes before, 2 minutes after); it saves a billed minute only when the combined job stays under 60 s (run 41390727063 took 54 s). Expect 7 to 10 billed minutes per run; the wall time stays under 2 minutes either way.

Reconciling the 1,809 minutes used in the billing cycle: at 10 billed minutes per pull request run that is about 180 runs, which fits a month of PR pushes, `main` pushes and Dependabot runs. The same 180 runs bill about 1,260 minutes at 7 per run and 1,800 at 10. `concurrency.cancel-in-progress` already cancels superseded runs, and the pre-commit hook below keeps broken pushes from spending a run at all. The shards stay at 3: two shards would push each job past 90 s and the wall time past 2 minutes for no billing gain.

## Keep, move or remove

| Step | Decision | Reason |
| --- | --- | --- |
| telemetry-comment job | keep | Required check; needs the GitHub API, cannot run locally. |
| checkout, setup-node, `npm ci` | keep | Needed by every later step; cached. |
| Playwright and Pi caches and install | keep | Needed by the UI suites; cached, seconds. |
| Mock scratch server | keep | The UI suites talk to it; tests the bundled server production runs. |
| `npm test` unit pool, sharded | keep, and also run in the pre-commit hook | A green run on `main` triggers the deploy hook, so `main` must stay fully tested. The hook is the earlier, faster gate. |
| UI suites (composer-scroll, drafts, attachment-drafts, composer-paste, pi-e2e) | keep | Need a browser and the scratch server; not suitable for a commit hook. |
| Release, standby and handoff tests | keep | Cold `npm ci` and bundle smoke boot; slow for a commit hook. |
| Lean queue proofs | moved into the release job | Needs a pinned toolchain download, so it stays in CI, but no longer as its own billed job. |
| Whole-suite coverage and time budget (`test` job) | keep | The coverage gate: fails when any test file is missing from every shard or runs over budget. |
| Runner usage summary, server log on failure | keep | Seconds; feed the measured table above. |

## Decision

GitHub Actions is still needed: yes. Three things cannot move to a local hook: the required `telemetry-comment` check reads the PR through the GitHub API, the deploy hook fires on a green `workflow_run` of the `CI` workflow on `main`, and the browser suites and release smoke boot need a clean runner. No replacement mechanism; the saving comes from fewer billed jobs plus the local gate. Expected usage after the change: 7 to 10 billed minutes per pull request run (7 measured), down from 10, and a default-branch run finishes in about 70 s, inside the 5 minute target. The coverage gate (`test` job) still fails the run when a test file is missing from every shard.

## Local pre-commit hook

`.githooks/pre-commit` runs `npm test` and rejects the commit when it fails. Enable it once per clone:

```
git config core.hooksPath .githooks
```

Agent worktrees keep their own `pre-push` hook (`.git/ac-hooks`, per-worktree `core.hooksPath`) that refuses pushes to `main`; do not override it there. `test/git-hooks.ts` proves the hook blocks a commit when the suite fails and allows it when it passes. Compare any later change with `gh run list --workflow CI`.

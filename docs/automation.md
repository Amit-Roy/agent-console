# Automation

How the issue automation works end to end, what you can watch, and how to debug it. The settings and the window rules are in [window-dispatch.md](window-dispatch.md); why it is built this way is in [automation-plan.md](automation-plan.md).

## Flow

```
triage ─► dispatcher ─► router ─► worktree + hook ─► worker ─► self-review ─► PR ─► review ─► merge ─► apply
opener ─► usage windows ─┘
```

1. **Triage** (separate worker) labels issues `Eff:` and `Pri:`.
2. **Dispatcher** (every 5 minutes) picks premium work in the last 90 minutes of an expiring Claude or Codex window, only from allowed authors. Live Pi work uses its own capacity and does not wait for a premium window.
3. **Router** chooses the provider (`server/automation/router.ts`, pure): headroom in the 5-hour and 7-day windows, minus a penalty for each running automation thread, plus a bonus for a window that ends soon. Unknown usage is never preferred over a known-good provider; an exhausted one is never chosen. Deep work waits when no premium provider has room. Pi has its own capacity: the daily allowance, at most three at once, and recent failures.
4. **Worktree + hook**: own worktree, pre-push hook refusing the default branch.
5. **Worker**: Deep on a premium model, Trivial and BAU on Pi (BAU after `routing.bauOnPi`).
6. **Self-review**: before the PR the worker writes its test first, then reviews its own diff with the `pr-standards` skill and ends the PR body with `## Self-review`.
7. **Review** (Trivial and BAU): a premium reviewer, chosen by the router, applies the same skill, may fix up to 20 changed lines, and comments `Review: APPROVED` or `Review: CHANGES REQUESTED`. Deep PRs get no second reviewer.
8. **Merge and apply**: the reviewer squash-merges what it approves, except PRs that touch protected paths (`server/automation/`, `skills/`, the dispatcher, opener and reviewer, `server/auth.ts`, `bin/`, `.github/`, `package.json`): a person merges those. For agent-console, dotfiles and brain the reviewer then fast-forwards the checkout and restarts agent-console when idle.

## The log

Every stage writes to `automation-events.jsonl` in the Console data directory (mode 0600): `seq, ts, step, kind, run, ref, msg, data`. Kinds are `start`, `ok`, `fail`, `info`, `abandoned`. Only the Console process writes it; it rotates at 5 MB and keeps the last 5,000 events in memory. Tokens, keys, bearer values and URL credentials are redacted before they reach disk. An unfinished run older than 30 minutes, or left over from a previous process, is shown as abandoned, not working. The dashboard, the step logs, the failure list and the Debug prompt are all views of this one stream.

## The dashboard

`/automation` (link in the Auto lane and the sidebar menu). It shows the workflow as boxes with icons: the working step pulses, a failed step is red with a count, a disabled one is dashed. Click a step for its log, newest first. Panels list failures, triggers (webhook, the two 5-minute ticks, the turn-end hook, scheduled tasks, the Debug button), runs, the git hooks in dispatched worktrees and the settings. It refreshes every 5 seconds. On a phone the graph becomes a vertical list.

The sidebar has a third lane, **Auto**, for threads the automation started, grouped by issue with a role chip (work, review, debug). They no longer appear in the Threads lane; notifications still arrive.

API (all behind the normal sign-in; every envelope has `v: 1`, unknown fields are ignored, a newer `v` is refused):

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /api/automation` | `?limit` | `Snapshot`: flow, step states, triggers, runs, failures, hooks, settings |
| `GET /api/automation/log` | `?step&limit&before` | `StepLogResponse`: events newest first, `next` to page |
| `POST /api/automation/debug` | `{v, focus?, note?}` (same origin only) | `{thread, cwd, branch, route, why}` |

## Debug

The **Debug** button starts a thread in its own worktree of agent-console (pre-push hook installed). The router picks Sonnet medium or `gpt-6.1-sol` medium, or Pi when those have no room. The prompt carries the snapshot, the focused step's last 50 events (or the last 40 of all steps), your note, and the path to the hidden skill `skills/automation-debug/SKILL.md`, which says where each step's code, tests and data live, requires a failing test first, forbids printing secrets, and ends in a PR a person merges. Only one debug thread runs at a time. The skill is read from the main checkout; it is not installed in `~/.claude/skills`, so it never shows in a slash-command list.

## Coding standards skill

`skills/pr-standards/SKILL.md` is ours: top-down design, request and response models, test first, small and plain, safety, repo rules, and the output contract. It points at a vendored, unmodified subset of [awesome-skills/code-review-skill](https://github.com/awesome-skills/code-review-skill) (MIT, commit in `vendor/SOURCE.md`) for language-specific checks. Agents read it from `~/repos/agent-console/skills/`, never from the worktree under review, so a PR cannot edit its own rules.

## Turning pieces on

All in `~/.config/agent-console/window-dispatch.json`: `enabled`, `dryRun`, `routing.mode` (`shadow` then `live`), `routing.bauOnPi`, and under `opener` the same switches. Set `"enabled": false` to stop everything the dispatcher starts.

## Checks that belong to a person

The code cannot verify these; look at them on GitHub: the token the `gh` CLI uses has the narrowest scope that can push branches and open PRs; branch protection on the default branch (private repos need a paid plan for it); the webhook secret (the triage worker already verifies the HMAC signature).

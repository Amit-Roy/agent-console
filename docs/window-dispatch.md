# Idle-window dispatch and window opener

Claude and Codex subscriptions reset every 5 hours whether or not the quota was used. This feature finds open issues to run in the last part of a window, so expiring quota is not wasted. Issue #10 is the source.

**Status:** built end to end. Defaults are off and dry-run (`dryRun: true`); production runs with both enabled and live. Routing, review, the dashboard and the Debug button are described in [automation.md](automation.md). Not built: a loop that sends review feedback back to the worker; a changes-requested PR waits for a person.

## Usage history

`usage.json` keeps only the latest sample. `usage-history.jsonl` in the Console data directory now gets one row each time a window's used percentage, limit or reset time changes: `{ts, provider, label, used, limit, resetsAt}`. The last row before a `resetsAt` shows how much of that window went unused.

### Backfill

`node scripts/usage-backfill.ts [--dry]` rebuilds history from readings already on disk: Claude `rate_limit_event`s in the Console thread logs (timed by the turn that triggered them) and Codex rollout `token_count` events. It is idempotent and prints the peak use of every finished 5-hour window. Run it after Console has been down for long, or when logs from older sessions appear.

## Planner

`server/window-dispatch.ts` runs every 5 minutes inside the Console. It does nothing unless `~/.config/agent-console/window-dispatch.json` sets `"enabled": true`.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Master switch. |
| `dryRun` | `true` | Log decisions to `window-dispatch.jsonl`; start nothing. |
| `leadMinutes` | `90` | Assign premium work only in the last N minutes of a 5-hour window (5–300). |
| `lowUsagePct` | `60` | A window used less than this percentage uses `lowUsageLeadMinutes` instead (0–100). |
| `lowUsageLeadMinutes` | `180` | Lead time for a lightly used window (5–300); never shorter than `leadMinutes`. |
| `maxUsedPct` | `90` | Deep and BAU skip a window already this full; nothing would expire. Trivial work ignores this check. |
| `perWindow` | `2` | Premium candidates per provider per tick; Pi candidates per tick. |
| `repos` | `["example-owner/agent-console"]` | Allowlist, `owner/name` only. |
| `authors` | `["example-owner"]` | Only issues opened by these GitHub logins are dispatched: issue text steers an unattended agent. |
| `routing` | `{"mode":"shadow","bauOnPi":false}` | `shadow`: the router logs its choice beside the legacy route. `live`: the router decides. `bauOnPi`: BAU runs on Pi. |

Only open issues with exactly one `Eff:` label are considered. Higher `Pri:` goes first; Deep gets first pick of expiring quota. Premium slots left without Deep work take the next issue by priority, then effort (BAU before Trivial), on Sonnet low or `gpt-6.1-sol` low when the issue would otherwise run on Pi (Trivial, or BAU with live `routing.bauOnPi`); other BAU keeps its BAU route. Pi takes the rest.

| Effort | Worker | Second model |
| --- | --- | --- |
| Deep | Opus medium or `gpt-6.1-sol` high, chosen by the router | none |
| BAU | Pi when `routing.bauOnPi`, else Sonnet medium or `gpt-6.1-sol` low | PR review by Sonnet medium or `gpt-6.1-sol` low |
| Trivial | Pi | PR review as for BAU |

In live routing, Trivial work and BAU with `routing.bauOnPi` start independently of premium reset windows. Pi daily allowance, failure limits and three-run concurrency still apply. A tick considers at most `perWindow` Pi issues. Premium review is routed after the worker opens its PR; it does not reserve a reviewer window before work starts. Shadow mode retains the legacy window policy.

## Threads for picked issues

Each started issue gets its own private clone, `~/worktrees/<repo>-issue-<n>-<attempt>` on branch `issue-<n>-<slug>-<attempt>` from the default branch, and a thread working in it with the route's provider, model and effort. The thread is named `<repo>:<issue#> <short desc>`, at most 30 characters (the width an Android sidebar row shows, issue #11). A long repo name is shortened to its initials: `ac:10 Identify unused reset`. It is created with a chosen title, so the auto-namer never changes it, and neither does a later rename (see below). Runs are unattended, so the thread uses `bypassPermissions`. A failed start (no local checkout under `~/repos`, git error) is logged with its error in `window-dispatch.jsonl` and is not retried.

## Quota-paused threads

A Claude or Codex thread whose turn ends on a rate-limit error while its quota is exhausted is marked quota-paused. Every 5 minutes, with the dispatcher enabled, such threads continue with `Continue.` once their provider (per Claude account) passes the same gate as Deep issues: the 5-hour window is in its last `leadMinutes` (or `lowUsageLeadMinutes` below `lowUsagePct` used), is below `maxUsedPct`, and no window is still exhausted. With the defaults that is the last 180 minutes of a lightly used window. `dryRun` only logs. A manual message or archiving clears the pause.

## Window opener

A window opens at the first message after the last one ended. The opener sends one tiny message (`Reply with the single word: ok`, Sonnet low or `gpt-6.1-sol` low) to each provider with no live five-hour window. It runs throughout the day and night by default. The window ends five hours later, giving the dispatcher a last-90-minutes slot. Custom hour bounds can restrict openings; equal bounds mean all day.

```json
{ "opener": { "enabled": true, "dryRun": false, "from": "00:00", "to": "00:00", "providers": ["claude", "codex"], "tz": "Asia/Kolkata" } }
```

Same file as the dispatcher, under `opener`. Defaults: off, dry run, all day (`00:00`–`00:00`) in `Asia/Kolkata`, both providers. It checks every 5 minutes, refreshes Codex quota first (Claude reports quota only during turns, so an expired or unseen reading counts as no window), and never opens one provider twice within 10 minutes. The opener thread is archived at once; decisions go to `window-opener.jsonl`.

## Thread names

- A manual rename locks the title: `titleLocked` is set and the namer never rewrites it. So does giving a title at creation.
- The namer (Nemotron via NVIDIA, free OpenRouter fallback; never Haiku or Luna) reads every user message of the thread from its log, newest first up to 100,000 characters, and names what the chat is about now. The message that overflows the budget is cut short; older ones are dropped.
- Threads from before `titleLocked` existed count as unlocked: a manual rename from that time cannot be told apart from an automatic one.

## Review of trivial work

When a trivial worker's turn ends successfully and its branch has an open PR, a reviewer thread starts in a private clone detached at the PR head (`~/worktrees/<repo>-review-<n>-<attempt>`), named `<repo>:<issue#> review PR#<pr>`. It is Sonnet medium, or `gpt-6.1-sol` low when Claude's quota is exhausted. It reads the issue and diff, runs the repo's checks, and posts `Review: APPROVED` or `Review: CHANGES REQUESTED` as a PR comment. The PR author and the reviewer share one GitHub account, so a formal approval is not possible; the comment is the verdict. It merges (squash, delete branch) only when approved. For agent-console, green CI triggers host-side deployment. Other local-apply repositories are reported as pending host application; reviewers cannot write to shared checkouts. One review per worker thread.

## Repository rules from the issue

- Every repo merges to its default branch by pull request. Enforced: a started worktree gets a `pre-push` hook (per-worktree `core.hooksPath`, which turns on `extensions.worktreeConfig` in that repo) that refuses any push to the default branch.
- Exceptions: agent-console, dotfiles and brain are applied locally before they are pushed. Their Deep workers have no hook and push the default branch themselves. BAU and Trivial work in them still go through a PR.
- Every run has its own private Git clone and kernel-enforced write boundary; see [filesystem guards](automation.md#model-and-filesystem-guards).
- BAU and Trivial work are reviewed by Sonnet or Sol before the PR merges.
- The hook binds only the dispatched worktrees; it cannot stop a person or another session pushing elsewhere. Direct pushes to the default branch of other repos are blocked on GitHub only if branch protection is on.

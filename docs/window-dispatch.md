# Idle-window dispatch and window opener

Claude and Codex subscriptions reset every 5 hours whether or not the quota was used. This feature finds open issues to run in the last part of a window, so expiring quota is not wasted. Issue #10 is the source.

**Status:** everything is off by default and logs only (`dryRun: true`). With `dryRun: false` the dispatcher starts one thread per picked issue. Not built: the Sonnet/Sol review step for trivial work (the prompt only asks the agent to request it), and enforcing the PR-only rule outside the prompt.

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
| `leadMinutes` | `90` | Assign only in the last N minutes of a 5-hour window (5–300). |
| `maxUsedPct` | `90` | Deep and BAU skip a window already this full; nothing would expire. Trivial work ignores this check. |
| `perWindow` | `2` | Issues per provider per window. |
| `repos` | `["Amit-Roy/agent-console"]` | Allowlist, `owner/name` only. |

Only open issues with exactly one `Eff:` label are considered. Higher `Pri:` goes first; Deep gets first pick of expiring quota.

| Effort | Route |
| --- | --- |
| Deep | Claude Opus medium, or `gpt-6.1-sol` high |
| BAU | Claude Sonnet medium, or `gpt-6.1-sol` low |
| Trivial | Pi, then review by Sonnet medium or `gpt-6.1-sol` low before merge |

Trivial work needs a reviewer window with room, so it is planned only when Claude or Codex is expiring. Copilot is not a Console provider; Pi covers trivial work.

## Threads for picked issues

Each started issue gets its own worktree, `~/worktrees/<repo>-issue-<n>` on branch `issue-<n>-<slug>` from the default branch, and a thread working in it with the route's provider, model and effort. The thread is named `<repo>:<issue#> <short desc>`, for example `agent-console:10 Identify unused reset windows`. It is created with a chosen title, so the auto-namer never changes it, and neither does a later rename (see below). Runs are unattended, so the thread uses `bypassPermissions`. A failed start (no local checkout under `~/repos`, git error) is logged with its error in `window-dispatch.jsonl` and is not retried.

## Window opener

A window opens at the first message after the last one ended, so overnight nothing opens one and the quota never starts counting down. The opener sends one tiny message (`Reply with the single word: ok`, Sonnet low or `gpt-6.1-sol` low) to each provider that has no live 5-hour window, only during configured hours. The window then ends five hours later, while you are away, which gives the dispatcher a last-90-minutes slot.

```json
{ "opener": { "enabled": true, "dryRun": false, "from": "23:00", "to": "07:00", "providers": ["claude", "codex"], "tz": "Asia/Kolkata" } }
```

Same file as the dispatcher, under `opener`. Defaults: off, dry run, 23:00–07:00 `Asia/Kolkata`, both providers. It checks every 5 minutes, refreshes Codex quota first (Claude reports quota only during turns, so an expired or unseen reading counts as no window), and never opens one provider twice within 10 minutes. The opener thread is archived at once; decisions go to `window-opener.jsonl`.

## Thread names

- A manual rename locks the title: `titleLocked` is set and the namer never rewrites it. So does giving a title at creation.
- The namer (Nemotron via NVIDIA, free OpenRouter fallback; never Haiku or Luna) reads every user message of the thread from its log, newest first up to 100,000 characters, and names what the chat is about now. The message that overflows the budget is cut short; older ones are dropped.
- Threads from before `titleLocked` existed count as unlocked: a manual rename from that time cannot be told apart from an automatic one.

## Repository rules from the issue (policy, not yet enforced by code)

- Every repo merges to its default branch by pull request.
- Exceptions: agent-console, dotfiles and brain are applied locally before they are pushed.
- Trivial work uses its own git worktree, never the deploy branch.
- Trivial work asks Sonnet or Sol for review before the PR merges.

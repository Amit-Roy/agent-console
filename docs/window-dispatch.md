# Idle-window dispatch (plan only)

Claude and Codex subscriptions reset every 5 hours whether or not the quota was used. This feature finds open issues to run in the last part of a window, so expiring quota is not wasted. Issue #10 is the source.

**Status:** planning and logging only. Nothing is started automatically. Phase 2 (starting threads, worktrees, review before merge) is not built.

## Usage history

`usage.json` keeps only the latest sample. `usage-history.jsonl` in the Console data directory now gets one row each time a window's used percentage, limit or reset time changes: `{ts, provider, label, used, limit, resetsAt}`. The last row before a `resetsAt` shows how much of that window went unused.

## Planner

`server/window-dispatch.ts` runs every 5 minutes inside the Console. It does nothing unless `~/.config/agent-console/window-dispatch.json` sets `"enabled": true`.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Master switch. |
| `dryRun` | `true` | Log decisions to `window-dispatch.jsonl`; start nothing. |
| `leadMinutes` | `90` | Assign only in the last N minutes of a 5-hour window (5–300). |
| `maxUsedPct` | `90` | Skip a window already this full; nothing would expire. |
| `perWindow` | `2` | Issues per provider per window. |
| `repos` | `["Amit-Roy/agent-console"]` | Allowlist, `owner/name` only. |

Only open issues with exactly one `Eff:` label are considered. Higher `Pri:` goes first; Deep gets first pick of expiring quota.

| Effort | Route |
| --- | --- |
| Deep | Claude Opus medium, or `gpt-6.1-sol` high |
| BAU | Claude Sonnet medium, or `gpt-6.1-sol` low |
| Trivial | Pi, then review by Sonnet medium or `gpt-6.1-sol` low before merge |

Trivial work needs a reviewer window with room, so it is planned only when Claude or Codex is expiring. Copilot is not a Console provider; Pi covers trivial work.

## Repository rules from the issue (policy, not yet enforced by code)

- Every repo merges to its default branch by pull request.
- Exceptions: agent-console, dotfiles and brain are applied locally before they are pushed.
- Trivial work uses its own git worktree, never the deploy branch.
- Trivial work asks Sonnet or Sol for review before the PR merges.

# Automation

How the issue automation works end to end, what you can watch, and how to debug it. The settings and the window rules are in [window-dispatch.md](window-dispatch.md); why it is built this way is in [automation-plan.md](automation-plan.md).

## Flow

Two separate workflows. The PR workflow has three phases:

```
PR workflow
  1. Issue to labels            triage
  2. Labels to pull request     dispatcher ─► router ─► worktree + hook ─► worker ─► self-review ─► PR
  3. Premium review and merge   review ◄─► worker redo ─► merge ─► apply

Window opener
  1. Quota windows              opener ─► usage windows   (the dispatcher plans from these readings)
```

1. **Triage** (separate worker) labels issues `Eff:` and `Pri:`.
2. **Dispatcher** (every 5 minutes) picks premium work in the last 90 minutes of an expiring Claude or Codex window (180 minutes when it is below 60% used), Deep first, then the next issue by priority and effort, only from allowed authors. Live Pi work uses its own capacity and does not wait for a premium window.
3. **Router** chooses the provider (`server/automation/router.ts`, pure): headroom in the 5-hour and 7-day windows, minus a penalty for each running automation thread, plus a bonus for a window that ends soon. Unknown usage is never preferred over a known-good provider; an exhausted one is never chosen. Deep work waits when no premium provider has room. Pi has its own capacity: the daily allowance, at most three at once, and recent failures.
4. **Worktree + hook**: a private clone with its own Git metadata, a fresh attempt branch, and a pre-push hook refusing the default branch.
5. **Worker**: Deep on a premium model, Trivial and BAU on Pi (BAU after `routing.bauOnPi`).
6. **Self-review**: before the PR the worker writes its test first, then reviews its own diff with the `pr-standards` skill and ends the PR body with `## Self-review`.
7. **Review** (Trivial and BAU): a premium reviewer, chosen by the router, applies the same skill, may fix up to 20 changed lines, and comments `Review: APPROVED` or `Review: CHANGES REQUESTED`. Deep PRs get no second reviewer. A worker whose turn ended with an error is still reviewed when it already opened its PR (a provider limit late in the turn). A reviewer that ends without posting a verdict counts as a failed review and is retried.
8. **Worker redo**: `Review: CHANGES REQUESTED` is sent back to the worker thread with the findings; it fixes the same branch and pushes, and the next review starts once the PR has a commit newer than the last verdict. No new commit (a worker that edited but never pushed): the worker is asked to commit and push, at most 2 times (`MAX_NUDGES`), then a person decides. At most 3 reviews per worker (`MAX_REVIEWS` in `server/issue-review.ts`); after that a person decides. The dashboard boxes review and redo as the review loop, each arrow labelled with its condition.
9. **Merge and apply**: a premium reviewer (Claude or Codex) squash-merges approved PRs, including protected paths, after documenting acceptance evidence and passing required checks. Merge targets the reviewed head SHA; human approval is not required. Pi reviewers cannot merge protected paths. Reviewers cannot write shared checkouts: agent-console green CI triggers the host deploy hook; other local-apply repositories report pending host application.

## Recovering incomplete workers

The five-minute sweep resumes a Trivial or BAU worker that ended without opening a PR, using its existing private clone, branch, and transcript. Recovery requires live dispatch, available capacity for the same provider, and an open issue. Each worker gets at most two recovery turns, at least 15 minutes apart; counters and backoff survive server restarts. Closed issues and archived or running workers are skipped.

A failed redo waits for worker recovery before another premium review. Successful review handoffs release the worker claim so its next review can start in the same server process. If sending findings fails, the reviewer remains eligible for another handoff.

Pi can return from an exhausted OpenRouter daily quota to the approved NVIDIA coding model. Routing preserves completed tool results and prevents provider bounce loops within a retry sequence. A full-prompt 429 retry is refused once any tool call occurred in that turn.

## The log

Every stage writes to `automation-events.jsonl` in the Console data directory (mode 0600): `seq, ts, step, kind, run, ref, msg, data`. Kinds are `start`, `ok`, `fail`, `info`, `abandoned`. Only the Console process writes it; it rotates at 5 MB and keeps the last 5,000 events in memory. Tokens, keys, bearer values and URL credentials are redacted before they reach disk. An unfinished run older than 30 minutes, or left over from a previous process, is shown as abandoned, not working. The dashboard, the step logs, the failure list and the Debug prompt are all views of this one stream.

## The dashboard

`/automation` (link in the Auto lane and the sidebar menu). It shows each workflow in its own panel (PR workflow with its three phases, then the window opener), with the triggers that start it; steps are boxes with icons: the working step pulses, a failed step is red with a count, a disabled one is dashed. Click a step for its log, newest first. Panels list failures, other triggers (scheduled tasks, the Debug button), runs, the git hooks in dispatched worktrees and the settings. It refreshes every 5 seconds. On a phone each phase becomes a vertical list.

The sidebar has a third lane, **Auto**, for threads the automation started, grouped by issue with a role chip (work, review, debug). They no longer appear in the Threads lane; notifications still arrive.

API (all behind the normal sign-in; every envelope has `v: 1`, unknown fields are ignored, a newer `v` is refused):

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /api/automation` | `?limit` | `Snapshot`: flow, step states, triggers, runs, failures, hooks, settings |
| `GET /api/automation/log` | `?step&limit&before` | `StepLogResponse`: events newest first, `next` to page |
| `POST /api/automation/debug` | `{v, focus?, note?}` (same origin only) | `{thread, cwd, branch, route, why}` |

## Debug

The **Debug** button starts a thread in its own worktree of agent-console (pre-push hook installed). The router picks Sonnet medium or `gpt-6.1-sol` medium, or Pi when those have no room. The prompt carries the snapshot, the focused step's last 50 events (or the last 40 of all steps), your note, and the path to the hidden skill `skills/automation-debug/SKILL.md`, which says where each step's code, tests and data live, requires a failing test first, forbids printing secrets, and ends in a PR for premium review and merge. Only one debug thread runs at a time. The skill is read from the main checkout; it is not installed in `~/.claude/skills`, so it never shows in a slash-command list.

## Coding standards skill

`skills/pr-standards/SKILL.md` is ours: top-down design, request and response models, test first, small and plain, safety, repo rules, and the output contract. It points at a vendored, unmodified subset of [awesome-skills/code-review-skill](https://github.com/awesome-skills/code-review-skill) (MIT, commit in `vendor/SOURCE.md`) for language-specific checks. Agents read it from `~/repos/agent-console/skills/`, never from the worktree under review, so a PR cannot edit its own rules.

## Turning pieces on

All in `~/.config/agent-console/window-dispatch.json`: `enabled`, `dryRun`, `routing.mode` (`shadow` then `live`), `routing.bauOnPi`, and under `opener` the same switches. Set `"enabled": false` to stop everything the dispatcher starts.

## Checks that belong to a person

The code cannot verify these; look at them on GitHub: the token the `gh` CLI uses has the narrowest scope that can push branches and open PRs; branch protection on the default branch (private repos need a paid plan for it); the webhook secret (the triage worker already verifies the HMAC signature).

## Model and filesystem guards

Unattended Pi runs select an exact approved coding model: direct NVIDIA Nemotron
Super first, then its free OpenRouter equivalent. If neither is available, Auto
refuses to start. Catalog ordering never selects an unrelated chat or vision model.
Manual threads retain the full model picker.

All issue workers, reviewers, and Debug runs use private clones with independent
Git metadata and a host-created ownership marker. Existing shared worktrees and
unmarked main checkouts are refused. New worker and review attempts get unique
checkout and branch names, so old transcripts and files are never silently reused.
Archived workers are excluded from review sweeps.

The Python launcher installs Linux Landlock and seccomp before starting any
provider. Writes are limited to the task clone and private per-thread runtime,
session, cache, and temporary directories. Claude and Codex use private copies of
login/config state. Shell commands and descendants inherit the same restriction;
absolute paths, symlinks, and `git -C` cannot write to shared checkouts. Unsupported
hosts fail closed before any model request. Requirements are Linux x86-64,
Landlock ABI 3 or newer, and Python 3; no additional package is required.

This boundary protects file contents, creation, deletion, renaming, linking, and
truncation. Landlock does not constrain metadata changes such as chmod. Reads and
network access remain available; this is not a confidentiality boundary. Auto's
Console tools are limited to reading session history; scheduling and output writes
are refused. Reviewers leave shared-checkout application to the host after merge.
Agent Console's existing green-CI deploy hook performs its host-side application.

## Shared Pi request limit

Pi model requests share one global admission gate: at least 1,100 milliseconds between request starts. The gate covers interactive and Auto sessions, tool continuations, SDK retries, triage subprocesses, and title/tool-label helpers across providers. It does not limit concurrent streams.

SQLite coordinates Console and triage processes. Sandboxed Pi processes request admission through the authenticated loopback broker, without write access to shared limiter state. A 429 sets a shared cooldown from `Retry-After`, or 30 seconds when absent. Pending requests honor cancellation; unavailable admission fails closed.

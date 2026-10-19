# Automation: routing, review, dashboard (plan)

**Status (2026-10-19): steps 0 to 5 are built and tested; see [automation.md](automation.md) for how it works. Step 6 is deployment and turning the router live.**

Follows [window-dispatch.md](window-dispatch.md). Method: **top down, test first**. Start at the entrypoint a person or caller touches, write the test from that side, then build only the methods the test calls. Every boundary takes a request model and returns a response model, so a new field or feature adds a property, not a new signature.

## Decisions (from the user, 2026-10-19)

1. Deep work gets premium models. Trivial **and BAU** run on Pi.
2. Trivial and BAU PRs are reviewed by Claude or Codex. Deep PRs are not reviewed by a second model.
3. A router picks the provider from current usage availability and active tasks.
4. Every worker first self-reviews its diff with a coding-standards skill. A premium reviewer then improves the PR in one pass, so it needs fewer round trips and fewer tokens.
5. A new **Auto** lane in the sidebar (beside Threads and Scheduled) holds auto-started threads, so they are clearly separate.
6. An **Automation dashboard** shows a workflow graph with the active step, clickable step boxes with icons that open logs, trigger list, failures, git hooks, and a **Debug** button that starts a Sonnet/Sol medium or Pi thread with a hidden skill.

Assumptions to confirm (the plan proceeds on these):

- "Premium to improve" means the reviewer may push small fix-up commits to the PR branch and then merge, instead of only commenting. Large problems still become CHANGES REQUESTED.
- "Hidden skill" means a skill kept in the repo and loaded by path from automation prompts. It is not installed in `~/.claude/skills`, so it never appears in a slash-command list.
- The Debug thread works in its own agent-console worktree with `bypassPermissions`, like dispatched work, and ends with a PR or a written diagnosis.

## Advisor review (Opus, 2026-10-19) and what changed

Twelve findings; all accepted except where noted. They are folded into the sections below and the build order.

| # | Finding | Change |
| --- | --- | --- |
| 1 | Routing BAU to Pi before BAU review exists lands unreviewed PRs | Router starts in **shadow mode** (logs its choice, old routing runs). `routing.bauOnPi` flag, default false until the BAU reviewer is deployed |
| 2 | Fix-forward merges code nobody reviewed | Fix-ups are capped at 20 changed lines, must pass the repo checks, and PRs touching protected paths are never auto-merged (below) |
| 3 | A worker can edit the skill that reviews it | Skills load from the **main checkout** (`~/repos/agent-console/skills/...`), never the PR worktree. `skills/` is a protected path |
| 4 | Prompt injection into bypass-mode agents | Only issues authored by `authors` (default `Amit-Roy`) are dispatched; prompts say issue and PR text is data, not instructions |
| 5 | Secrets leak through error strings | `record()` redacts tokens (`ghp_`, `github_pat_`, `sk-`, `nvapi-`, `Bearer`, URL credentials); tested; Debug prompt uses the same redactor |
| 6 | Token scope, branch protection, webhook HMAC | HMAC already verified by the triage worker. Token scope and branch protection are listed on the dashboard as checks the user owns; code cannot enforce them |
| 7 | Pi has no 5-hour window; unknown usage must not mean 0% | Router gives Pi its own capacity input (Free/day window, recent failures). Unknown or stale premium usage is neutral, never preferred over a known-good provider |
| 8 | "Active" goes stale after a crash | Each `start` carries a `run` id; an unfinished run older than 30 minutes, or left open across a restart, is shown as `abandoned` |
| 9 | Many writers, unbounded log | The server is the only writer; the file rotates at 5 MB; reads page by offset. Git hooks are read from disk, they do not write |
| 10 | Possible misreadings of three asks | Kept as stated under Assumptions; flagged to the user again in the report |
| 11 | Debug POST abuse | Existing session auth covers it; one Debug thread at a time; Debug counts as router load |
| 12 | Skill too big for Pi | Self-review prompt stays under 2k tokens: core skill plus only the reference for the diff's language; size is tested |

**Protected paths** (never auto-merged; the reviewer comments and a person merges): `server/window-dispatch.ts`, `server/window-opener.ts`, `server/issue-review.ts`, `server/automation/`, `skills/`, `server/auth.ts`, `bin/`, `.github/`, `package.json`.

## Entrypoint and contracts

Everything starts at the screen, so the first contract is what the dashboard asks for. All envelopes carry `v: 1`; readers ignore unknown fields.

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /api/automation` | `SnapshotRequest { since?, limit? }` | `Snapshot { flow, steps, triggers, runs, failures, hooks, config, now }` |
| `GET /api/automation/log` | `StepLogRequest { step, limit?, before? }` | `StepLogResponse { entries[], next? }` |
| `POST /api/automation/debug` | `DebugRequest { focus?: StepId, note? }` | `DebugResponse { thread, route }` |
| (internal) `route()` | `RouteRequest { role, effort, usage, active, now }` | `RouteResponse { route, alternatives[], why }` |
| (internal) `selfReview()` / `review()` | `ReviewRequest { run, pr?, diff }` | `ReviewResponse { verdict, findings[], pushedFixups }` |

`Snapshot.flow` is a graph (`nodes[]`, `edges[]`); each node has `id`, `label`, `icon`, `kind` and, from `steps`, a state `idle | active | ok | failed | disabled` with the last event time. The active step is derived from events, never stored.

## One event stream

`automation-events.jsonl` (Console data dir, mode 0600) is the single log every stage writes: `{ts, step, kind: start|ok|fail|info, ref, data}`. The dispatcher, opener, router, reviewer, triage worker bridge and hooks emit through `record()`. The dashboard, step logs, failure list and Debug context are all views of this stream. Existing ledgers stay for compatibility; the event stream becomes the read model.

## Workflow (the graph)

```
 triage webhook ─► label (Eff/Pri) ─┐
                                    ├─► dispatcher tick ─► router ─► worktree + git hook ─► worker ─► self-review ─► PR ─► review (Trivial, BAU) ─► merge ─► apply
 window opener ─► usage windows ────┘                                                        (Pi; Deep: premium)        (skill)         (premium, fix-forward)      (agent-console: ff + restart-when-idle)
```

Triggers (listed on the dashboard): GitHub webhook on :7077, 5-minute dispatcher tick, 5-minute opener tick (23:00–07:00 IST), turn-end hook on issue threads, scheduled tasks (cron), manual Debug.

## Router (pure function, TDD)

Input: usage windows per provider, active automation threads per provider, role (`work | review | debug`), effort, and config. Output: provider, model, effort, plus ranked alternatives and a one-line reason.

- Work: Trivial and BAU → Pi. Deep → Opus medium or `gpt-6.1-sol` high.
- Review: Trivial and BAU → Sonnet medium or `gpt-6.1-sol` low. Debug → Sonnet medium, `gpt-6.1-sol` medium, or Pi.
- Score = remaining headroom in the 5-hour window (and the 7-day window when it is the tighter one) minus a load penalty per active automation thread. A provider at or above its limit scores nothing. Ties go to the provider whose window ends sooner (use it before it expires).
- If no premium provider has room, the router returns `defer` and the dispatcher waits for the next tick. It never falls back to a cheaper model for Deep.

## Self-review and the coding-standards skill

A hidden skill `skills/pr-standards/SKILL.md` has three parts:

1. **Base:** a vendored subset of [awesome-skills/code-review-skill](https://github.com/awesome-skills/code-review-skill) (MIT, 2,115 stars, pushed 2026-09-08, verified with the GitHub API on 2026-10-19): its review process, common-bugs, security, error-handling and TypeScript/Python references. Its licence and the source commit are kept beside it.
2. **Overlay (ours):** top-down design check (entrypoint first, every method justified by a caller), request/response models at boundaries, test-first evidence (a test that failed before the change), PR-only rule, no secrets, small diffs.
3. **Output contract:** the first line is `Review: APPROVED` or `Review: CHANGES REQUESTED`; findings are `file:line — problem — fix`.

Worker flow: implement with tests → run the skill on its own diff and fix findings → push branch → open PR. Reviewer flow: read the issue, PR and the self-review notes → run the skill → push fix-up commits for small findings → comment verdict → merge only when approved.

Research (a Pi subagent, then checked by hand): other candidates are far smaller (anthroos 46 stars and stale since February, ctxr-dev 1 star, photostructure 4 stars). The official Claude Code review plugin is already available as `/code-review` but is Claude-only and not usable by Pi or Codex, so the vendored skill is the common base.

## UI

- **Auto lane** in the sidebar. Lists threads with `issueRun`, grouped by issue, with role chips (work, review, debug) and state. These threads no longer appear in the Threads lane.
- **`/automation` page**, styled like `/dashboard`. Header chips (enabled, live or dry-run, window state). Flow graph in SVG: rounded boxes with icons, directed edges, active step pulsing, failed step red, disabled grey. Clicking a box opens a drawer with that step's log (from `StepLogResponse`), last runs and its triggers. Panels: triggers, failures (last 20 with step and error), git hooks (per worktree: path, hook, base branch it protects; plus main-repo hooks), config. A **Debug** button posts `DebugRequest`.
- Inspiration from nodeterm.dev (checked 2026-10-19): a canvas of titled nodes with pulsing status badges, a scheduled-job node showing its cron text, and a command bar. We take the pulsing badge and the node-per-stage idea; nodes are plain boxes, not terminals.

## Debug thread and hidden skill

`skills/automation-debug/SKILL.md`: how to read `automation-events.jsonl`, the two ledgers, the dispatch config, the worktree hooks and `gh` state; how to reproduce a failed step with a failing test first; when to open a PR. The Debug button builds the prompt from the snapshot, the failing step's last 50 events and the config (secrets never included), routes with `role: debug`, creates a worktree and a locked-title thread `ac:debug <step>`.

## Build order (each step: failing test from the caller's side, then code, then commit)

| # | Step | First test |
| --- | --- | --- |
| 0 | Contracts, event log (redaction, rotation, run ids, abandonment), `GET /api/automation` over fixture events | HTTP test: events in, snapshot out, active step derived |
| 1 | Router in **shadow mode**: logs the choice, old routing still runs | Table test of usage × load × effort × unknown usage |
| 2 | `pr-standards` skill, self-review step, reviewer for Trivial **and BAU** with capped fix-forward and protected paths | Prompt contract and size test; reviewer tests for BAU, fix-ups, protected paths |
| 2b | Turn on `routing.bauOnPi` and the router (only after 2 is deployed) | Dispatcher test with the flag on and off |
| 3 | Emit events from dispatcher, opener, router, reviewer; failures captured | Each module test asserts its events |
| 4 | UI: Auto lane, `/automation` graph, drawers, panels | Browser test on mock server with seeded events |
| 5 | Debug endpoint, hidden skill, button | Endpoint test creates the thread with route and skill path |
| 6 | Docs, brain note, deploy (`restart-when-idle`), config check | Full `npm test` |

Risks: the live dispatcher keeps running while this changes, so each step is deployed only with all tests green; the event log must never record prompts or secrets (metadata and short error strings only); the SVG graph must stay usable on a phone (vertical layout under 600 px).

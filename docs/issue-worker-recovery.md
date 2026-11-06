# Issue worker recovery

The turn-end hook records a bounded, redacted provider error on the worker. The five-minute automation sweep checks GitHub before resuming an idle worker in its existing private checkout and branch. Running, background, archived, quota-paused, closed-issue, disabled-dispatch, and explicit-owner gates still apply.

Deep workers in direct-apply repositories may finish by pushing the default branch without a PR. Their successful turns remain outside missing-PR recovery; their explicit errors are retried. Other workers are expected to produce a PR.

Two task retries are available, with a fifteen-minute cooldown. Infrastructure failures (rate limits, unavailable models, truncated streams, timeouts, network failures, and provider outages) do not spend task retries. They select another approved, available model before delivery. Without a same-provider alternative, recovery enters the premium queue and excludes the failed model. Infrastructure retries are bounded separately: after three consecutive infrastructure retries (`MAX_INFRA_RETRIES`), the next infrastructure failure enters the premium queue with reason `infrastructure-retries-exhausted`, so alternating approved models cannot retry a persistent outage forever. A task retry or a clean turn end resets the streak. Retry delivery failures restore the counters and retain the cooldown.

Exhaustion persists a premium-pending marker and emits a budget-exhausted event. The sweep routes this queue through the existing premium assigner, independently of the dispatch ledger's original assignment. The assigner provides an isolated checkout, prior-thread context, work preservation, and duplicate-owner checks. A durable premium thread ID prevents another assignment after restart. Existing stalled workers enter the same queue. Workers that exhaust push reminders proceed to the existing final premium PR takeover.

The Automation dashboard displays total retry attempts, task budget used and remaining, and premium queue or assigned status. Events retain the transition reason and counters. No configuration or data migration is required; new metadata is optional and persisted with existing issue-run state.

Acceptance checks cover error-bearing same-branch retry, infrastructure model selection without task-budget consumption, failed delivery, cooldown and restart behavior, exhaustion, premium routing and deduplication, and dashboard counters. Rollout uses the existing live-dispatch switch; disabling dispatch prevents new recovery or premium assignment.

To verify recovery on live data, run `bin/agent-console worker-retries --since <deploy date> [--until <date>] [--json]` as the server user. It reads `window-dispatch.jsonl` and `automation-events.jsonl` (with its rotated `.1`) without writing, lists each live dispatch whose worker turn ended with an error or without a PR, and prints its ledger entry, PR numbers, turn ends, retry events, and premium queue events with `data.reason`. A zero result still prints the exact filter, the date range, and the time span the event log covers; an unreadable data directory exits with an error instead.

## Live check (server user)

Issue workers cannot run this check: their sandbox gets `EACCES` on `~/.config/agent-console/`, cannot resolve the `vps` host, and gets 401 from the live server. The server user runs these steps and pastes the output into the issue.

1. Run `~/.local/share/agent-console/current/bin/agent-console worker-retries --since 2026-10-24T09:44:44Z`. Its first line, `Release: <sha>`, records the live release (`release` in `--json`).
2. Confirm that release contains #444 and the report itself: `git -C ~/repos/agent-console merge-base --is-ancestor 55a4a1f <sha> && git -C ~/repos/agent-console merge-base --is-ancestor 5954fcb <sha> && echo contains`.
3. Read the output. The header gives `Data`, `Range`, `Filter`, ledger and event counts, the event log span, and `N issues whose worker turn ended in error or without a PR`. Each listed issue gives its key (`owner/repo#N`), dispatch time, `PR in log`, its ledger row, and three event lists: `Turn ends` (worker `ok` or `fail`), `Retries` (with `retryAttempts`, `remaining`, `infrastructure`), and `Premium queue` (with `reason=` set to `budget-exhausted`, `infrastructure-model-unavailable`, or `infrastructure-retries-exhausted`). Each event line reads `<UTC time> <step>/<kind> #<seq> <message>`. A zero result keeps the header, so the paste still shows the exact filter and range.
4. In the Automation dashboard, open Window dispatch, then the worker step drawer for the named issue, and screenshot its retry and premium queue entries. The dashboard shows browser local time (IST is UTC+05:30): match each entry to the report line with the same message and time.

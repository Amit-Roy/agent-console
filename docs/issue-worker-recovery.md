# Issue worker recovery

The turn-end hook records a bounded, redacted provider error on the worker. The five-minute automation sweep checks GitHub before resuming an idle worker in its existing private checkout and branch. Running, background, archived, quota-paused, closed-issue, disabled-dispatch, and explicit-owner gates still apply.

Deep workers in direct-apply repositories may finish by pushing the default branch without a PR. Their successful turns remain outside missing-PR recovery; their explicit errors are retried. Other workers are expected to produce a PR.

Two task retries are available, with a fifteen-minute cooldown. Infrastructure failures (rate limits, unavailable models, truncated streams, timeouts, network failures, and provider outages) do not spend task retries. They select another approved, available model before delivery. Without a same-provider alternative, recovery enters the premium queue and excludes the failed model. Retry delivery failures restore the counters and retain the cooldown.

Exhaustion persists a premium-pending marker and emits a budget-exhausted event. The sweep routes this queue through the existing premium assigner, independently of the dispatch ledger's original assignment. The assigner provides an isolated checkout, prior-thread context, work preservation, and duplicate-owner checks. A durable premium thread ID prevents another assignment after restart. Existing stalled workers enter the same queue. Workers that exhaust push reminders proceed to the existing final premium PR takeover.

The Automation dashboard displays total retry attempts, task budget used and remaining, and premium queue or assigned status. Events retain the transition reason and counters. No configuration or data migration is required; new metadata is optional and persisted with existing issue-run state.

Acceptance checks cover error-bearing same-branch retry, infrastructure model selection without task-budget consumption, failed delivery, cooldown and restart behavior, exhaustion, premium routing and deduplication, and dashboard counters. Rollout uses the existing live-dispatch switch; disabling dispatch prevents new recovery or premium assignment.

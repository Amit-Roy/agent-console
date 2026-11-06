# PR cockpit

The PR cockpit shows the pull requests a thread owns. It lives in the header strip and a detail sheet. Source issue: #421.

## What it is

- A strip of PR chips under the thread header. Each chip shows the PR state, checks and merge status.
- A detail sheet per PR with checks, failed-job logs, evidence images and ship state.
- Actions in the sheet:
  - Open: opens the PR on GitHub.
  - Re-run failed: re-runs the failed jobs of one workflow run.
  - Log tail: shows the last failed-job log lines (redacted).
  - Ship: merges and deploys through `pr-ship`, after a confirm step.
  - Ask agent to fix: sends the `pr-ship` attention line to the thread's agent.
- Server code: [`server/pr-cockpit.ts`](../server/pr-cockpit.ts). Client code: [`public/pr-cockpit.js`](../public/pr-cockpit.js).

## PR discovery sources

Discovery runs per thread. Results are deduplicated by `owner/repo#n`. The first source wins.

- Issue run: the PR linked to the thread's issue run, and PRs that cross-reference the issue in the same repo.
- Session PRs: the PR rows that session search has for the thread.
- Branch lookup: open or closed PRs whose head matches the thread's current branch in its working directory. The result is cached per directory until the next turn ends.
- `pr-ship` state files: files in the `pr-ship` state directory (`PR_SHIP_STATE`, default `~/.local/state/pr-ship`) modified in the last 7 days. Only repos already found by the other sources are used.

## Live updates

- The GitHub webhook receives PR events. The events that reach the cockpit are `pull_request`, `check_suite`, `check_run`, `status`, `pull_request_review`, `pull_request_review_comment`, `issue_comment` (PR comments only), `deployment_status`, and `workflow_run` (when it is not a deploy run). The subscription list is set in [`scripts/github-triage.ts`](../scripts/github-triage.ts) (`PR_SIGNAL_EVENTS`).
- The handler in [`server/triage-webhook.ts`](../server/triage-webhook.ts) (`handlePrSignal`) writes one marker file per PR. The marker is `pr-signals/<owner_repo>-<pr|sha>.json` under the triage events directory, written by `announcePr` in [`server/automation/closed-signal.ts`](../server/automation/closed-signal.ts).
- The Console watches the `pr-signals` directory. Each marker is read, deleted and debounced for 3 s per key. Then the Console refreshes that PR. If the card changed, it pushes the new card over WebSocket.
- The signal path never touches the triage queue. It only writes marker files.
- Webhook signals for a commit (no PR number) match tracked cards by head SHA.
- The client does not run its own debounce. The 3 s debounce is on the server.

## Polling budget

The store in [`server/pr-cockpit.ts`](../server/pr-cockpit.ts) polls as a fallback when webhooks are missed.

- Check-run poll interval:
  - 30 s while the PR has pending checks and its thread is open.
  - 10 min otherwise.
  - Skipped for 10 min after a webhook signal arrived for that PR.
- The scheduler wakes every 5 s and checks which PRs are due.
- Each check-run poll is a REST call with `If-None-Match`. A 304 response is free and not counted in the budget.
- A full snapshot (one GraphQL query) runs only when the check-run signature changes or when a refresh is requested. Snapshots use the GraphQL limit, not the REST limit.
- On a 403 or 429 that is a rate limit, the whole store pauses. The pause ends at `retry-after`, else at `x-ratelimit-reset`, else 60 s later.
- Estimate: about 5% of the 5000 REST requests per hour budget. This is an estimate, not a measurement.
- GitHub guidance: [Best practices for using the REST API](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api) and [Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

## Routes and WebSocket message

Routes in [`server/index.ts`](../server/index.ts). All thread routes take the thread id. POST routes require same-origin.

- `GET /api/sessions/prs`: session PR rows for discovery.
- `GET /api/threads/:id/pr`: current cards. Starts tracking the thread if it is not tracked yet.
- `POST /api/threads/:id/pr/refresh`: refreshes one PR.
- `POST /api/threads/:id/pr/rerun`: re-runs failed jobs for a run that the PR's checks report. Returns 400 for an unknown run.
- `GET /api/threads/:id/pr/log`: failed-job log tail, last 80 lines and at most 64 KB, redacted. Returns 400 for an unknown job.
- `POST /api/threads/:id/pr/ship`: starts a ship job. Requires `confirm: true`. Returns 409 when a job for this PR is already running.
- `POST /api/threads/:id/pr/ask-fix`: queues the attention line to the thread. Returns 409 unless the ship state is `attention` with a line.
- WebSocket: the server pushes `{t: "pr", thread, cards}`. Cards carry an optional `ship` field with the job state.

## Ship job

The ship job lives in [`server/pr-ship-job.ts`](../server/pr-ship-job.ts).

- Each ship run is a detached `sh` wrapper that runs `pr-ship <number> -R <owner/repo>`. It appends output to an `.out` file in `DATA_DIR/pr-ship-jobs` and then appends `exit:<code>`.
- The job record is a JSON file next to the output file. It stores the pid, key, thread, start time and output path. Writes are atomic.
- Restart: on load, records that are not done are watched again. A live pid whose command line still names the output file keeps being watched. A dead pid is read from its output. Finished records are dropped after 7 days.
- Exit codes:
  - 0: `merged`.
  - 1: `attention`. The last output line is kept for the ask-fix action.
  - Any other code, or no exit line when the process is gone: `failed`.
- Only one job per PR runs at a time.

## Runbook

After a deploy that changes the webhook worker or its event list:

1. Run `bin/github-triage restart`. It waits for active work to finish, then starts the replacement worker.
2. Run `bin/github-triage sync` once. It creates missing hooks and adds the missing event subscriptions.

The command details are in [`docs/github-triage.md`](./github-triage.md#events-and-recovery).

## Notifications

- PR notices are `shipped`, `checks_failed` and `review_comment`. They are sent by [`server/notifications.ts`](../server/notifications.ts).
- Each device opts in separately. The PR kinds are off by default.

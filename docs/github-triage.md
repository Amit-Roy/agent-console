# Automatic GitHub triage

The webhook worker classifies open issues and pull requests by effort and priority. It uses a small model through Pi and falls back to subscription models when needed. It applies labels only; it does not implement changes, open pull requests, merge, or post comments.

## Labels

Each item receives one effort label and one priority label. Existing labels outside these two families are preserved.

| Label | Meaning |
| --- | --- |
| `Eff: Trivial` | A small, isolated change with a clear solution and low risk. |
| `Eff: BAU` | Standard implementation work with a clear direction, possibly across several files. |
| `Eff: Deep` | Cross-cutting work, uncertain requirements, architecture, or substantial investigation. |
| `Pri: P0` | An urgent outage, security problem, or data-loss risk. |
| `Pri: P1` | Work that unblocks delivery, improves essential reliability, or substantially reduces babysitting. |
| `Pri: P2` | A useful workflow enhancement that does not block delivery. |
| `Pri: P3` | Polish or speculative optimization. |

The priority prompt measures relative app-building payoff, rather than requiring an explicit incident or deadline. It does not hardcode issue numbers or classifications.

## Setup

The worker is a separate process on port 7077. The Console keeps its existing authentication and loopback listener. Install dependencies before starting the worker.

```sh
npm ci
bin/github-triage configure Amit-Roy/agent-console https://github-webhook.nefro-dev-coder.duckdns.org/api/github/webhook
bin/github-triage start
waitfor -t 15 port 7077
bin/github-triage status
```

Configuration is stored in `~/.config/agent-console/github-triage.json`, with mode 0600. Setup generates a private signing secret. The comma-separated repository argument is an explicit allowlist; configure every repository before registering its webhook.

For the existing VPS, install the narrow Caddy route using the versioned routing script:

```sh
ssh vps 'python3 -' < scripts/github-triage-caddy.py
```

The route accepts only POST requests for the webhook hostname and exact path. A host timer refreshes the workspace container IP after rebuilds. Other routes retain Coder authentication. Never add the webhook hostname to `AGENT_CONSOLE_PUBLIC_HOST`.

Register the webhook and classify the existing backlog:

```sh
bin/github-triage register
bin/github-triage backfill
bin/github-triage status
```

Registration uses the existing `gh` login and requires repository webhook administration permission. The subscription fallback models use existing local CLI credentials. No new API keys are required.

## Events and recovery

Issue creation, edits, and reopening trigger triage. Pull request creation, edits, reopening, new commits, and readiness for review also trigger it. Label changes do not trigger another model call.

The receiver verifies the HMAC signature before parsing the payload, checks the repository allowlist, and saves a delivery ID in SQLite before acknowledging it. Duplicate deliveries do not start duplicate jobs. The worker fetches the current GitHub item instead of trusting its supplied URLs or contents. Closed items are skipped.

The queue runs one job at a time, retries temporary failures a bounded number of times, and recovers interrupted work after restart. The database is stored beside the private configuration. Logs and the PID file live in `~/.cache/agent-console/github-triage/`.

`bin/agent-console start` also starts the configured worker for the normal production instance. Scratch and mock Console instances do not start it. Console restarts do not stop active triage jobs. To load updated worker code, use the dedicated restart command. It waits for active work to finish before starting the replacement:

```sh
bin/github-triage restart
```

`AGENT_CONSOLE_TRIAGE_CONFIG` and `AGENT_CONSOLE_TRIAGE_RUN` override the private configuration and runtime paths for isolated checks.

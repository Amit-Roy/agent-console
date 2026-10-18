# Automatic GitHub triage

The webhook worker classifies open issues and pull requests by effort and priority. It uses a small model through Pi and falls back to subscription models when needed. Each item gets one maintained planning comment with a book of work, estimated implementation tokens, and level of design. It does not implement changes, open pull requests, or merge.

## Labels

Each item receives one effort label and one priority label. Existing labels outside these two families are preserved.

| Label | Meaning |
| --- | --- |
| `Eff: Trivial` | A small, isolated change with a clear solution and low risk. |
| `Eff: BAU` | Standard implementation work with a clear direction, possibly across several files. |
| `Eff: Deep` | Cross-cutting work, uncertain requirements, architecture, or substantial investigation. |
| `Pri: P0` | A confirmed current outage, data loss, or active security incident. |
| `Pri: P1` | Work that unblocks delivery, improves essential reliability, or substantially reduces babysitting. |
| `Pri: P2` | A useful workflow enhancement that does not block delivery. |
| `Pri: P3` | Polish or speculative optimization. |

The model extracts evidence and proposes work steps. Versioned code computes labels, design requirements, and token ranges from those inputs. Every scored metric requires an exact quote from the issue title, body, or changed file path. Unsupported metrics remain explicitly unknown.

## Planning scorecard

The comment records these metrics and their evidence:

| Metric | Scale |
| --- | --- |
| Breadth | 0: isolated text/config; 1: one component; 2: several components; 3: cross-system integration. |
| Complexity | 0: mechanical; 1: standard; 2: state/concurrency/recovery; 3: architecture/protocol. |
| Uncertainty | 0: explicit approach and checks; 1: bounded choices; 2: investigation; 3: unresolved feasibility/dependencies. |
| Risk | 0: cosmetic; 1: reversible functionality; 2: auth/data/deployment; 3: irreversible change or active exposure. |
| Impact | 0: polish/speculation; 1: ordinary convenience; 2: repeated manual work removed; 3: shipping or essential workflow unblocked. |
| Urgency | 0: explicitly no deadline/incident; 1: explicit near-term deadline; 2: confirmed current outage, data loss, or security incident. |
| Frequency | 0: explicitly once; 1: explicitly occasional; 2: explicitly daily, repeated, per-build, or per-session. |

Unknown values use visible planning assumptions: breadth 1, complexity 1, uncertainty 2, risk 1, impact 1, urgency 0, frequency 0. These assumptions are never presented as evidence.

Effort points are breadth + complexity + uncertainty + risk. Trivial requires at most 2 points. Deep requires at least 8 points, breadth 3, complexity 3, or risk 3. Other work is BAU. Priority is P0 only for urgency 2, impact 3, and risk at least 2; P1 for impact 3 or impact at least 2 with frequency 2; P3 for impact 0; otherwise P2.

Design is detailed for breadth 3, complexity 3, uncertainty 3, or risk at least 2. No separate design is needed only for breadth 0, complexity 0, uncertainty at most 1, and risk at most 1. Other work needs a light design. The book of work contains one to five proposed steps, each with an observable acceptance check.

Token ranges are an **uncalibrated implementation planning heuristic**, not measured usage or a promise. Work units = 1 + effort points + proposed work steps. Estimated input is units × 4,000–12,000 tokens; output is units × 800–2,400. Ranges allow context rereads, retries, and tests, exclude the triage call, and show low confidence when any metric is unknown. Actual usage should calibrate these coefficients later.

The comment uses an ownership marker, scorecard version, and source fingerprint. Retries update the same account-owned comment instead of adding duplicates. User comments are preserved. Changed issue text, PR commits, or a new scorecard version makes the report stale.

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

The route accepts only POST requests for the webhook hostname and exact path. A host timer refreshes the workspace container IP and supervises the separate triage worker every 60 seconds. Other routes retain Coder authentication. Never add the webhook hostname to `AGENT_CONSOLE_PUBLIC_HOST`.

Register the webhook and classify the existing backlog:

```sh
bin/github-triage register
bin/github-triage backfill
bin/github-triage status
```

Registration uses the existing `gh` login and requires repository webhook administration permission. The subscription fallback models use existing local CLI credentials. No new API keys are required.

## Events and recovery

Issue creation, edits, and reopening trigger triage. Pull request creation, edits, reopening, new commits, and readiness for review also trigger it. Removing a managed label triggers repair. Label additions do not trigger another model call, so the worker's own writes cannot loop. Repair skips an item once both managed label families are complete. Reconciliation preserves complete labels when the report matches the current source and scorecard version; stale or missing reports cause a fresh assessment. Managed-label changes made while a model is running are preserved.

The receiver verifies the HMAC signature before parsing the payload, checks the repository allowlist, and saves a delivery ID in SQLite before acknowledging it. Duplicate deliveries do not start duplicate jobs. The worker fetches the current GitHub item instead of trusting its supplied URLs or contents. Closed items are skipped.

The queue runs one job at a time, retries temporary failures a bounded number of times, and recovers interrupted work after restart. The database is stored beside the private configuration. Logs and the PID file live in `~/.cache/agent-console/github-triage/`.

`bin/agent-console start` also starts the configured worker for the normal production instance. Scratch and mock Console instances do not start it. Console restarts do not stop active triage jobs. The existing Coder startup script calls Console start after workspace boot; the host watchdog also recovers a crashed or missing worker without restarting Console.

The enabled `agent-console-github-triage-caddy.timer` starts at host boot and runs every 60 seconds. It uses `docker exec --user coder` only when the workspace is already running. It sets the running container's Docker policy to `unless-stopped`, so host/Docker restarts restore running workspaces while intentional stops remain stopped, following [Docker's restart policy](https://docs.docker.com/engine/containers/start-containers-automatically/). The Coder template records the same policy for future rebuilds. It never starts or restarts a deliberately stopped workspace.

Every five minutes, the watchdog performs signed local reconciliation. It scans open items, skips queued/running work, and enqueues missing labels or missing/stale comments. This repairs events missed during downtime without relying on GitHub redelivery. Healthy complete items do not trigger model calls. An immediate scan follows watchdog recovery of a missing worker. The watchdog checks every 60 seconds with up to five seconds of timer slack; startup, an active scan, and GitHub/model processing add latency. Missed events are found by the next eligible five-minute scan after the workspace returns.

The signed local `/reconcile` endpoint is not exposed through the public Caddy route. Check or run repairs manually:

```sh
bin/github-triage status
bin/github-triage reconcile
ssh vps 'systemctl is-enabled agent-console-github-triage-caddy.timer; systemctl is-active agent-console-github-triage-caddy.timer'
```

To load updated worker code, use the dedicated restart command. It waits for active work to finish before starting the replacement:

```sh
bin/github-triage restart
```

`AGENT_CONSOLE_TRIAGE_CONFIG` and `AGENT_CONSOLE_TRIAGE_RUN` override the private configuration and runtime paths for isolated checks.

The CLI tests kill and recover an isolated worker and verify that healthy workers keep their PID. Host supervisor tests cover IP changes, restart policy, and preservation of intentionally stopped workspaces. Full host/workspace reboot tests require an external maintenance window; do not restart the workspace from an agent running inside it.

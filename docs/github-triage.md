# Automatic GitHub triage

The webhook worker classifies open issues and pull requests by effort and priority. It uses a small model through Pi and falls back to subscription models when needed. Each item gets one maintained planning comment with a book of work, estimated implementation tokens, and level of design. It does not implement changes, open pull requests, or merge.

## Labels

Each item receives one effort label and one priority label. Existing labels outside these two families are preserved.

| Label | Meaning |
| --- | --- |
| `Eff: Trivial` | Predicted logged actions at or below the historical lower tercile. |
| `Eff: BAU` | Predicted logged actions between the historical tercile cutoffs. |
| `Eff: Deep` | Predicted logged actions at or above the historical upper tercile. |
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

Effort follows **pre-work complexity → predicted logged actions → token quote**. Four evidence-backed features enter a learned nonnegative log-work equation. Historical tool-call activity trains work coefficients; raw input/output totals never establish task complexity. Effort labels use predicted actions against observed activity terciles. Complete scope uses P50 for routing; unknown or extrapolated scope uses P95 by explicit policy.

Quotes show P50, P80, and P95 scenarios, plus P80−P50 reserve. Generated tokens, non-cached input, and cached replay are separate. The current model remains experimental and under-covers its small held-out sample. These quantiles are not guaranteed completion probabilities. See [the model, formula, and initial evidence](triage-effort-pricing.md).

Priority remains an explicit business policy: P0 requires urgency 2, impact 3, and risk at least 2; P1 requires impact 3 or impact at least 2 with frequency 2; P3 requires impact 0; otherwise P2. Historical token consumption does not establish business priority.

Design is detailed for breadth 3, complexity 3, uncertainty 3, or risk at least 2. No separate design is needed only for breadth 0, complexity 0, uncertainty at most 1, and risk at most 1. Other work needs a light design. The book of work contains one to five proposed steps, each with an observable acceptance check.

Calibration uses one sample per canonical inactive session. Initial user messages before the first agent response are the only input text. Outcomes aggregate recorded whole-session usage, including later follow-ups and measured failures. Console/native mirrors and child sessions are deduplicated. Training groups must complete before target requests start. Newer related-session groups remain held out, and errors and coverage stay visible. Whole-session snapshots are not human hours or a guarantee that a session will never resume.

`bin/github-triage calibrate` extracts private history, reuses a private feature cache, fits the offline numerical model, validates a candidate artifact, and atomically promotes the model. The default artifact is `~/.config/agent-console/triage-effort-model.json`, mode 0600. Original requests remain local except credential-checked pre-work text sent to the configured small-model providers for feature extraction. No source requests are posted to GitHub or committed.

The production watchdog recovers the receiver first, then schedules daily calibration in the background. Failed fitting keeps the previous model and retries at most hourly. Scratch workers never scan production history. A missing artifact fails before invoking a triage model. `AGENT_CONSOLE_TRIAGE_EFFORT_MODEL` selects the artifact; `AGENT_CONSOLE_TRIAGE_PYTHON` selects the offline interpreter. See [setup and reproduction](triage-effort-pricing.md#operation-and-reproduction).

The comment uses an ownership marker, scorecard version, and source fingerprint. Retries update the same account-owned comment instead of adding duplicates. User comments are preserved. Changed issue text, PR commits, or a new scorecard version makes the report stale.

The comment opens with the two labels, then shows only the book of work, a P50/P80/P95 token table, and the level of design. Evidence, open questions, token accounting, and scoring rules sit in collapsed sections. Missing metrics appear once, each with the next question to ask.

Pi writes the work steps and cites quotes for each metric. The skill at `skills/github-triage/SKILL.md` is injected into Pi's prompt and separates planning inference from the frozen pricing predictors. Pi may mark a planning metric `inferred` with a rationale. It may not infer urgency or frequency. Code derives labels, design level, and token counts; Pi cannot set them.

### Drift repair

Each rendered assessment is stored with the source fingerprint and a revision hash of the scorecard version plus the effort model. Reconciliation compares the live comment and labels with that stored assessment. A hand-edited comment or a wrong label is repaired from the stored assessment without a model call. A changed source or a recalibrated model produces a new revision, which triggers a fresh assessment and updates the same comment id. `status` reports detected and repaired drift plus calibration freshness and coverage.

## Setup

The worker is a separate process on port 7077. The Console keeps its existing authentication and loopback listener. Install dependencies before starting the worker.

```sh
npm ci
uv venv --managed-python --python 3.13 ~/.local/share/agent-console/triage-venv
uv pip install --python ~/.local/share/agent-console/triage-venv/bin/python -r requirements-triage.txt
bin/github-triage configure Amit-Roy/agent-console https://github-webhook.nefro-dev-coder.duckdns.org/api/github/webhook
bin/github-triage calibrate
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

# Workspace monitoring (issue #19)

The monitor watches host CPU and RAM, agent failures and console health, and escalates alerts nobody resolves.
It runs inside the console server on one timer. Code: `server/monitor.ts` (signals, escalation), `server/monitor-wire.ts` (wiring).

## Budget

The monitor must never become the problem on a shared VPS. Agreed budget, all measured below:

- At most 1% of one core on average (measured 0.23%).
- At most 10 MB extra RSS (measured +0.6 MB, within run-to-run noise).
- No new process, port, database or dependency. One timer, plus a 4 Hz event-loop histogram.
- Agent threads: none by default. Live escalation is capped at 3 threads a day.

## Signals, thresholds, recipients

Sampled every 15 s (`intervalMs`). A signal fires after N consecutive breaching samples and resolves after 3 good ones (`clearAfter`), so a spike or a flapping value does not alert.

| Signal | Source | Fires when | Recipient and path |
| --- | --- | --- | --- |
| `cpu` | host sampler (`host-history.ts`, /proc/stat, 5 s) | host CPU >= 90% for 8 samples (2 min) | escalation chain |
| `ram` | host sampler (/proc/meminfo, MemAvailable) | RAM used >= 90% for 4 samples (1 min) | escalation chain |
| `agents` | failed turns (threads notice) and failed automation stages (event log) | 3 or more failures in 15 min (larger of the two counts, not the sum) | escalation chain |
| `console` | loopback `GET /login` plus event-loop p99 delay | request fails, takes over 2000 ms, or loop p99 over 1000 ms, twice in a row | escalation chain |
| `headroom` | `headroom.state()` | proxy enabled but not running, 4 samples | owner only, never starts agents |

Agent failures and console health do not read Headroom. Disabling Headroom raises nothing; the proxy has its own signal.

## Escalation

Order: L3 Pi, then L2 Claude (Sonnet) or Codex if Claude is not ready, then L1 Opus, then the owner by web push.
Each step starts only if the alert is still firing after its wait (10, 15 and 20 min). A resolved alert stops the chain at once, at any level.

Mode (`escalation.mode` in `monitor.json`, or `AGENT_CONSOLE_MONITOR_ESCALATION`):

- `dry-run` (default): logs "dry run: would start L3 ..." for every level, starts nothing, tells the owner immediately.
- `off`: tells the owner immediately.
- `live`: starts threads, subject to the gates below.

Gates for live mode, so a flapping check cannot spawn threads:

- One incident per signal. A signal that fires again within 30 min of resolving reopens the same incident; it does not restart at L3.
- At most 3 threads in 24 h, at least 5 min between thread starts. A gated level is logged as `gated` and skipped.
- Threads are created in `plan` mode with a read-only prompt: find the cause, change nothing, report the fix.
- A level that cannot start (provider not ready) is logged and the chain still reaches the next level and the owner.
- The owner is told once per incident.

## Data flow

1. `monitor-wire.ts` ticks every 15 s: host sample, failure count, loopback probe, loop lag, Headroom state.
2. `createMonitor` turns readings into `firing` and `resolved` alerts (hysteresis in `server/monitor.ts`).
3. Each alert is written to the automation event log (step `monitor`) and given to `createEscalation`.
4. Escalation writes every handoff to the log (step `escalate`), starts threads through `Threads.create`/`send`, and pushes to the owner through `Notifications`.
5. The Automation page shows the "Workspace monitor" workflow, its state and failures. An unresolved incident that reaches the owner is logged as a failure.

## Sample payloads

Alert (in-process, and in the event log `data`):

```json
{"id":"cpu-1800000000000-1","signal":"cpu","state":"firing","severity":"critical","value":97,"threshold":90,"message":"CPU 97.0% (limit 90%)","since":1800000000000,"escalate":true}
```

Event log lines (`automation-events.jsonl`):

```json
{"seq":41,"ts":1800000120000,"step":"monitor","kind":"info","ref":"cpu","msg":"CPU 97.0% (limit 90%)","data":{"state":"firing","severity":"critical","value":97,"threshold":90,"incident":"cpu-1800000000000-1"}}
{"seq":42,"ts":1800000120000,"step":"escalate","kind":"info","ref":"cpu","msg":"L3 pi default started thread 0b7e..."}
{"seq":47,"ts":1800002520000,"step":"escalate","kind":"fail","ref":"cpu","msg":"owner notified: CPU 97.0% (limit 90%)"}
```

Owner push payload: title `Failed · Agent Console`, body `Monitor cpu: CPU 97.0% (limit 90%)`, `url` `#thread=<last escalation thread or monitor>`.

## Configuration

`<data dir>/monitor.json`, all keys optional, numbers clamped (interval at least 1 s). Env wins: `AGENT_CONSOLE_MONITOR=off` disables the monitor, `AGENT_CONSOLE_MONITOR_ESCALATION=off|dry-run|live`.

```json
{ "intervalMs": 15000, "clearAfter": 3,
  "cpu": { "pct": 90, "breaches": 8 }, "ram": { "pct": 90, "breaches": 4 },
  "agents": { "failures": 3, "windowMs": 900000 },
  "console": { "slowMs": 2000, "lagMs": 1000, "breaches": 2 },
  "escalation": { "mode": "dry-run", "waitMs": [600000, 900000, 1200000], "maxThreadsPerDay": 3, "minGapMs": 300000, "cooldownMs": 1800000 } }
```

Rollout: ships in `dry-run`. After a week of dry-run logs without false alerts, set `"mode": "live"`.

## Failure paths

| Failure | Behaviour |
| --- | --- |
| Host sampler has no sample yet | CPU and RAM skipped, not a breach |
| A reader throws | that signal is skipped for the tick; the others still run |
| Probe slow or the tick overlaps | ticks never overlap; a slow probe is itself the `console` breach |
| Console process dead or frozen | an in-process monitor cannot alert; `bin/agent-console supervise` restarts a dead process. Frozen loop: the alert fires when it resumes |
| Push delivery fails | logged without credentials; the event log still holds the alert |
| Thread start fails | logged as `could not start`; next level and owner still run |
| Server restart | incident memory is lost; a still-true condition fires again after its sustained window. The daily cap is also reset, so a restart loop can start at most 3 threads per boot |
| Flapping | hysteresis, one incident per signal within 30 min, thread gap and daily cap |

## Tool comparison

Requirement: CPU, RAM, agent failures and console health, tiered escalation that can start agent threads, no new always-on service on a shared VPS.
Figures marked doc are vendor-published, est are my estimates from the architecture (not measured here: no Docker daemon or install rights on this host), meas were measured on this host (8 CPUs, 31 GiB).

| Option | Coverage | Setup effort | CPU | RAM | Alert latency | Cost | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| In-process monitor (chosen) | all four signals, agent-aware, escalation to threads | in repo, no install | meas 0.23% of one core | meas +0.6 MB | 15 s tick plus 1-2 min sustain | none | meets all |
| keephq | alert aggregation and workflows; needs providers or webhooks to feed it | high: 3 services (FastAPI backend, Next.js frontend, Soketi) per docs, plus a database | est several percent, 3 processes | est 500 MB to 1 GB | est seconds after a webhook, but it still needs a collector | free OSS | too heavy; adds no collector |
| GoAlert | on-call schedules and escalation policies, SMS and voice | high: Go binary plus PostgreSQL, Twilio for SMS | est 1 to 2% | est 150 to 300 MB with Postgres | seconds after an alert is sent in | free OSS plus SMS fees | great escalation, but no signals and it cannot start agent threads |
| Netdata | CPU, RAM, disk, per-process, built-in alarms | medium: install agent, write alarm hooks | doc 1 to 5% of a core (5 to 20% in production) | doc 100 to 200 MB empty, 250 to 350 MB typical | est 10 s alarm evaluation | free agent | rich, but 100x our budget and knows nothing about agents |
| Monit | CPU, RAM, process, HTTP checks, exec actions | low: package plus config | est under 0.1% | est 2 to 5 MB | its poll cycle (30 s typical) | free (AGPL) | cheapest external option; no agent failures, no tiering without scripts |
| Uptime Kuma | HTTP/TCP/ping checks, 90+ notifiers | medium: Node app plus its own database | est 1% | est 100 to 150 MB | doc 20 s minimum interval | free OSS | no host metrics, no escalation tiers |

Decision: the console already samples the host every 5 s, writes an automation event log, pushes to the owner and starts agent threads. The missing pieces are alert logic and an escalation chain, a few hundred lines. External tools would add a service to feed from data we already hold. Keep GoAlert in mind if a human on-call rota is ever needed.

## Measured overhead

`node scripts/monitor-overhead.ts 300 45` starts two scratch servers side by side (mock agent, empty data dir, no live data), one with `AGENT_CONSOLE_MONITOR=off`, and reads `/proc/<pid>` every 5 s after a 45 s warm-up. Idle servers, default 15 s interval.

| Run (300 s) | CPU, one core | RSS mean | RSS max |
| --- | --- | --- | --- |
| monitor off | 0.508% (1.53 s) | 128.7 MB | 136.7 MB |
| monitor on | 0.741% (2.23 s) | 129.3 MB | 136.5 MB |
| monitor cost | +0.233% (about 35 ms of CPU per tick) | +0.6 MB | none measurable |

Against the budget: 0.23% is under the 1% limit; memory is within run-to-run noise (a 240 s repeat measured -11.6 MB for the same difference, so no memory cost is claimed beyond "a few MB at most").
Tuning found by measurement: an event-loop histogram at 20 ms resolution made the monitor cost +0.86% of a core; at 250 ms it costs +0.2%. The 250 ms setting still sees any stall longer than the 1000 ms limit.
Normal load here means an idle server with the host sampler; a busy console adds only the loopback probe (about 5 ms CPU per tick).

## Tests

- `test/monitor.ts`: config clamping, each signal alone, hysteresis, Headroom independence, every escalation handoff and stop condition, fallbacks, flapping, gates.
- `test/monitor-startup.ts`: boots the real server in a scratch data dir with the mock agent and monitoring on, checks the alert, dry-run escalation and owner notice reach the event log and that SIGTERM exits cleanly.

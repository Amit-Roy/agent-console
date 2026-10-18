# Headroom resource incident — 2026-10-18

Headroom defaults on at the user’s request, with the resource protections below. `AGENT_CONSOLE_HEADROOM=0` explicitly disables it. The temporary local disable override was removed. Claude can use its normal direct provider connection without this optional proxy.

The live Console also inherited its local `ANTHROPIC_BASE_URL` from a parent process. Disabling startup alone would leave that stale route in child environments. Disabled/unhealthy managed-proxy URLs are now removed; explicitly configured external endpoints are preserved.

## What the evidence establishes

- The supplied historical process snapshot shows Headroom using approximately 90% of one CPU core. It also shows a Chromium renderer at 99% and a binary-search process at 75%. It does not establish total host saturation or the cause of the reported workspace failure.
- The installed Headroom version is 0.41.0. At investigation time, PID 270124 used approximately 885 MiB RSS and 44–45 threads. A three-second sample measured 2.3% of one core; a separate sample measured 0%. The historical spike was not reproduced.
- The VPS has eight CPU cores and approximately 32 GiB RAM. Docker reports the workspace continuously running since 2026-10-17 08:06 UTC, with `OOMKilled=false` and restart count zero. The retained kernel journal contained no matching OOM entries. This does not exclude a stalled agent, app, individual process failure, or unavailable historical evidence.
- Headroom's aggregate metrics recorded code-aware compression taking up to 16.23 seconds and text compression taking up to 10.40 seconds. Its defaults allowed eight compression-executor workers and four nested compression workers. No application thread caps were set.
- Five recorded compaction commands over the previous 24 hours were spread apart. There was no observed automatic-compaction burst.

The exact cause of the workspace failure remains unproven. CPU-heavy compression and concurrent local jobs are plausible contributors.

## Confirmed Console faults

Headroom started by default, ran with `--no-rate-limit`, inherited uncapped numerical-library thread pools, and discarded stdout/stderr. A successful `/livez` response only established responsiveness; it did not establish an acceptable CPU or memory budget.

The running proxy was lowered to nice priority 15 during investigation. It was not killed while potentially serving active Claude requests. The final Console restart waits for active turns to finish, then stops the proxy it owns.

## Corrective policy

Headroom defaults on with an explicit opt-out. Starts use one server worker, one compression worker, bounded upstream concurrency, and capped numerical-library threads. Code-aware and Kompress compression, including the Kompress fallback, are disabled in this conservative configuration. Rate limiting remains enabled.

Diagnostics are private, bounded metadata logs. Process lifecycle and resource measurements are useful; request bodies, prompts, responses, authorization headers, and verbatim child output must not be recorded. Output pipes are drained without preserving their contents.

The diagnostics file is `$AGENT_CONSOLE_RUN/headroom-diagnostics.jsonl`, or `~/.cache/agent-console/headroom-diagnostics.jsonl` by default. It rotates once, with each file capped at 256 KiB and mode 0600. The owned-process circuit breaker stops the proxy after RSS exceeds 1024 MiB, or CPU exceeds 80% of one core for 30 seconds. It remains disabled until the Console process restarts. Launch failures are limited to three attempts per Console process.

Application resource monitoring is a circuit breaker, not an operating-system CPU or memory quota. Some scoped provider helpers can invoke SDK compression outside the proxy executor, so a worker flag alone cannot guarantee bounded CPU use. Representative-load benefit and resource behavior remain unverified; the safety circuit breaker stays enabled.

Increasing `HEADROOM_WORKERS` is not the recommended mitigation: it increases server processes and can multiply memory and compression concurrency.

## Upstream evidence

- [Release 0.41.0](https://github.com/headroomlabs-ai/headroom/releases/tag/v0.41.0), published October 14, was the latest verified release. It already contains prior idle-CPU and ML-budget fixes; no newer verified release fixes this incident.
- [Issue 1635](https://github.com/headroomlabs-ai/headroom/issues/1635) documents compression-pool oversubscription and non-preemptible work continuing after a request timeout. It supports a failure hypothesis, not a diagnosis of this workspace.
- [Issue 1171](https://github.com/headroomlabs-ai/headroom/issues/1171) reports expensive Kompress work outliving an asynchronous timeout.
- The [versioned CLI](https://github.com/headroomlabs-ai/headroom/blob/v0.41.0/headroom/cli/proxy.py) distinguishes server workers from compression-executor workers. The installed CLI and constructor wiring were checked locally before selecting flags.

No provider inference requests, compression stress tests, upgrades, workspace rebuilds, or host resource-limit changes were used during this investigation.

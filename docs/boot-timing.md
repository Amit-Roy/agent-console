# Boot timing (issue #18)

The server records when each startup phase finished, in ms since the process began (module loading counts).
Entry point: `server/index.ts` (production runs its bundle, `.bundle/server/index.ts.mjs`, built by `scripts/bundle-server.mjs`).
Code: `server/boot-timing.ts`, marks in `server/index.ts`. Tests: `test/boot-timing.ts`, `test/boot-modules.ts`.

- File: `$AGENT_CONSOLE_DATA/boot.jsonl`, one record per boot per kind, newest last, last 200 kept, mode 0600.
- `listen` record: phases `modules`, `threads-and-log`, `routes`, `listening`. Total is the time to first listen.
- `deferred` record: phases after the port is taken (`headroom-launched`, `telemetry-restored`, `accounting-warm`).
- Read it: `GET /api/boot-timing` returns the last 20 records, or `tail -n 3 boot.jsonl`.
- Regression alert: a `listen` total over 5000 ms sets `slow: true`, logs `slow boot: ...` and writes an `info` event (step `boot`) to the automation event log with the phases.

Phase names and numbers only; nothing from prompts, paths or environment is stored.

## Target and measurement

- Target: the `listen` total is at most 2000 ms on three consecutive restarts. The slow flag stays at 5000 ms so a busy host does not alert.
- Scratch method (no live data): `node scripts/boot-measure.ts 3 2000` bundles the server, boots it three times with a compile cache like production, prints every record and exits 1 when a boot misses the target. It prints the load average too: on a host whose load exceeds its CPU count, wall time stretches with the queue.
- Live method: restart three times with `agent-console restart`, then read the three newest `listen` records with `GET /api/boot-timing` or `tail -n 6 boot.jsonl`.

## What loads at boot

`modules` (loading the bundle) is the largest phase. The share pipeline (undici, linkedom, Defuddle) and the WebAuthn library were about two thirds of the 8.3 MB bundle and half the CPU time before the `modules` mark. They now load through `import()` on the first share or passkey request. `test/boot-modules.ts` fails when a static import pulls one of them back into boot.

Measured on the shared 8-CPU workspace host (load 13 to 19), CPU ms to the `modules` mark with a compile cache, eight runs each: median 1770 before, 990 after.


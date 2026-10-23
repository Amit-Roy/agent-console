# Boot timing (issue #18)

The server records when each startup phase finished, in ms since the process began (module loading counts).
Code: `server/boot-timing.ts`, marks in `server/index.ts`. Test: `test/boot-timing.ts`.

- File: `$AGENT_CONSOLE_DATA/boot.jsonl`, one record per boot per kind, newest last, last 200 kept, mode 0600.
- `listen` record: phases `modules`, `threads-and-log`, `routes`, `listening`. Total is the time to first listen.
- `deferred` record: phases after the port is taken (`headroom-launched`, `telemetry-restored`, `accounting-warm`).
- Read it: `GET /api/boot-timing` returns the last 20 records, or `tail -n 3 boot.jsonl`.
- Regression alert: a `listen` total over 5000 ms sets `slow: true`, logs `slow boot: ...` and writes an `info` event (step `boot`) to the automation event log with the phases.

Phase names and numbers only; nothing from prompts, paths or environment is stored.

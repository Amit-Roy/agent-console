# Transcript credential cleanup

Use `bin/transcript-redact` to scan local Claude, Codex, Pi, and Agent Console session stores. Scanning is the default. The tool reads configured credential sources to recognize values; it never modifies those sources or prints credential values.

```sh
bin/transcript-redact scan
bin/transcript-redact apply
bin/transcript-redact verify
```

Use `--json` for structured progress and final results. Use `--scope native` or `--scope console` to limit the stores. `--home` and `--data-dir` select isolated test or alternate stores.

The matcher masks configured credential values and recognizable provider keys. Ambiguous credential assignments are reported as candidates for review. Native file sizes, byte offsets, file identities, and JSON structure are preserved. Unsupported archives, concurrent changes, database contention, and incomplete verification produce a failure or incomplete result.

## Agent Console MCP

Call `session_redact` with `action: "scan"`, `"apply"`, or `"verify"`. The response returns a job ID immediately. Call it again with `action: "status"` and that job ID to read progress and the final result.

Applying through MCP requires a manual thread in Bypass mode. Plan mode, Edit mode, unattended runs, and stale threads cannot start an apply job. Live catalog updates stay with the Console owner, and search queries pause during database maintenance.

When Console owns the live catalog, use the MCP apply action instead of direct CLI catalog writes. The CLI reports this condition rather than overwriting live metadata.

import "../server/privacy.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTelemetryService } from "../server/token-telemetry.ts";

// One-time backfill: bin/token-telemetry backfill [--dry-run] [owner/name ...]
// Writes (or updates) the token-telemetry comment on every open issue and PR of the allowlisted repos. --dry-run only counts.
const CONFIG =
  process.env.AGENT_CONSOLE_TRIAGE_CONFIG ||
  path.join(os.homedir(), ".config/agent-console/github-triage.json");
const [command, ...rest] = process.argv.slice(2);
if (command !== "backfill")
  throw Error("Usage: bin/token-telemetry backfill [--dry-run] [owner/name ...]");
const allowed: string[] = JSON.parse(fs.readFileSync(CONFIG, "utf8")).repos;
const dryRun = rest.includes("--dry-run");
const selected = rest.filter((arg) => !arg.startsWith("--"));
const telemetry = createTelemetryService({
  repos: () => allowed,
  dataDir: process.env.AGENT_CONSOLE_DATA || path.join(os.homedir(), ".config", "agent-console"),
  log: (event, fields) => console.warn(JSON.stringify({ event, ...fields })),
});
for (const repo of selected.length ? selected : allowed)
  console.log(repo, JSON.stringify(await telemetry.backfill(repo, { dryRun })));

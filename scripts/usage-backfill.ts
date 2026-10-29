import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reconstructClaudeHistory } from "../server/usage-repair.ts";

// Read-only inspection: Claude repair is applied transactionally at server startup.
const data = process.env.AGENT_CONSOLE_DATA || path.join(os.homedir(), ".config", "agent-console");
const jsonl = (file: string) =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
const threads = fs.existsSync(path.join(data, "threads.json"))
  ? JSON.parse(fs.readFileSync(path.join(data, "threads.json"), "utf8"))
  : [];
if (!Array.isArray(threads)) throw Error("Malformed threads metadata");
const logs: Record<string, any[]> = {};
for (const t of threads)
  if (t?.provider === "claude" && typeof t.id === "string") {
    const log = path.join(data, "logs", `${t.id}.jsonl`);
    if (fs.existsSync(log)) logs[t.id] = jsonl(log);
  }
const history = jsonl(path.join(data, "usage-history.jsonl"));
const preview = reconstructClaudeHistory({ rows: history, logs, threads }).rows;
const claudeRows = preview.filter(
  (r) =>
    r.provider === "claude" || r.provider === "claude:secondary" || r.provider === "claude:unknown",
);
const codexWindows = (r: any) =>
  [r?.primary, r?.secondary].filter(Boolean).flatMap((w) =>
    Number.isFinite(w.used_percent)
      ? [
          {
            label:
              w.window_minutes === 300
                ? "5-hour"
                : w.window_minutes === 10080
                  ? "7-day"
                  : `${w.window_minutes} min`,
            used: w.used_percent,
            limit: 100,
            unit: "%",
            resetsAt: w.resets_at * 1000,
          },
        ]
      : [],
  );
const walk = (d: string): string[] =>
  fs.existsSync(d)
    ? fs
        .readdirSync(d, { withFileTypes: true })
        .flatMap((e) =>
          e.isDirectory()
            ? walk(path.join(d, e.name))
            : e.name.endsWith(".jsonl")
              ? [path.join(d, e.name)]
              : [],
        )
    : [];
const codexSamples: { ts: number; windows: ReturnType<typeof codexWindows> }[] = [];
for (const file of walk(
  path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions"),
))
  for (const ev of jsonl(file)) {
    const limits = ev.payload?.rate_limits,
      ts = Date.parse(ev.timestamp);
    if (
      ev.payload?.type !== "token_count" ||
      !limits ||
      (limits.limit_id && limits.limit_id !== "codex") ||
      !Number.isFinite(ts)
    )
      continue;
    const windows = codexWindows(limits);
    if (windows.length) codexSamples.push({ ts, windows });
  }
codexSamples.sort((a, b) => a.ts - b.ts);
const existing = new Set(
  history
    .filter((r) => r.provider === "codex")
    .map((r) => [r.ts, r.provider, r.label, r.resetsAt, r.used, r.limit, r.unit].join("|")),
);
let prior: { windows: ReturnType<typeof codexWindows>; ts: number } | undefined;
const codexRows: any[] = [];
for (const sample of codexSamples) {
  for (const w of sample.windows) {
    const old = prior?.windows.find((x) => x.label === w.label);
    if (!old || old.used !== w.used || old.limit !== w.limit || old.resetsAt !== w.resetsAt) {
      const row = { ts: sample.ts, provider: "codex", ...w };
      const key = [
        row.ts,
        row.provider,
        row.label,
        row.resetsAt,
        row.used,
        row.limit,
        row.unit,
      ].join("|");
      if (!existing.has(key)) codexRows.push(row);
    }
  }
  prior = { windows: sample.windows, ts: sample.ts };
}
console.log(
  `${claudeRows.length} Claude quota readings reconstructed; server startup applies the repair with an immutable backup.`,
);
console.log(
  `${codexSamples.length} Codex readings; ${codexRows.length} new rows in read-only preview.`,
);
console.log("No files changed.");

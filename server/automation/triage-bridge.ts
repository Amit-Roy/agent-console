import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { EventLog } from "./events.ts";

// The GitHub triage worker is a separate process with its own database (github-triage.sqlite). The Console only reads it,
// read-only, and writes what changed as `triage` events, so the dashboard shows triage next to everything else.

interface Row {
  delivery: string;
  repo: string;
  number: number;
  status: string;
  attempts: number;
  updated: number;
  model: string | null;
  reason: string | null;
}

export function createTriageBridge(opts: { dbPath: string; events: EventLog; now?: () => number }) {
  const seen = new Map<string, string>();
  let cursor = 0;
  const rows = (): Row[] => {
    if (!fs.existsSync(opts.dbPath)) return [];
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(opts.dbPath, { readOnly: true });
      return db
        .prepare(
          "SELECT delivery,repo,number,status,attempts,updated,model,reason FROM github_triage WHERE updated >= ? ORDER BY updated, rowid",
        )
        .all(cursor) as unknown as Row[];
    } catch {
      return [];
    } finally {
      try {
        db?.close();
      } catch {}
    }
  };
  // History before this process started is not new activity.
  for (const r of rows()) {
    cursor = Math.max(cursor, r.updated);
  }
  for (const r of rows()) seen.set(r.delivery, `${r.status}:${r.attempts}:${r.updated}`);

  function poll(): number {
    let n = 0;
    for (const r of rows()) {
      const key = `${r.status}:${r.attempts}:${r.updated}`;
      if (seen.get(r.delivery) === key) continue;
      seen.set(r.delivery, key);
      cursor = Math.max(cursor, r.updated);
      const ref = `${r.repo}#${r.number}`,
        run = `triage:${r.delivery}`,
        why = r.reason ?? "webhook";
      if (r.status === "queued")
        opts.events.record({
          step: "triage",
          kind: "start",
          run,
          ref,
          msg: r.attempts ? `queued again after attempt ${r.attempts}` : `queued (${why})`,
        });
      else if (r.status === "running")
        opts.events.record({ step: "triage", kind: "start", run, ref, msg: `running (${why})` });
      else if (r.status === "done")
        opts.events.record({
          step: "triage",
          kind: "ok",
          run,
          ref,
          msg: `labeled by ${r.model ?? "unknown model"}`,
        });
      else if (r.status === "skipped")
        opts.events.record({
          step: "triage",
          kind: "ok",
          run,
          ref,
          msg: `already complete (${why})`,
        });
      else
        opts.events.record({
          step: "triage",
          kind: "fail",
          run,
          ref,
          msg: `failed after ${r.attempts} attempts`,
        });
      n++;
    }
    return n;
  }
  return { poll };
}

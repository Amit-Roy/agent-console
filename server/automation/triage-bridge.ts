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

type TriageState = {
  opts: { dbPath: string; events: EventLog; now?: () => number };
  seen: Map<string, string>;
  cursor: number;
};

function readTriageRows(state: TriageState): Row[] {
  if (!fs.existsSync(state.opts.dbPath)) return [];
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(state.opts.dbPath, { readOnly: true });
    return db
      .prepare(
        "SELECT delivery,repo,number,status,attempts,updated,model,reason FROM github_triage WHERE updated >= ? ORDER BY updated, rowid",
      )
      .all(state.cursor) as unknown as Row[];
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

function triageEvent(row: Row): { kind: "start" | "ok" | "fail"; msg: string } {
  const why = row.reason ?? "webhook";
  if (row.status === "queued")
    return {
      kind: "start",
      msg: row.attempts ? `queued again after attempt ${row.attempts}` : `queued (${why})`,
    };
  if (row.status === "running") return { kind: "start", msg: `running (${why})` };
  if (row.status === "done")
    return { kind: "ok", msg: `labeled by ${row.model ?? "unknown model"}` };
  if (row.status === "skipped") return { kind: "ok", msg: `already complete (${why})` };
  return { kind: "fail", msg: `failed after ${row.attempts} attempts` };
}

function pollTriage(state: TriageState): number {
  let count = 0;
  for (const row of readTriageRows(state)) {
    const key = `${row.status}:${row.attempts}:${row.updated}`;
    if (state.seen.get(row.delivery) === key) continue;
    state.seen.set(row.delivery, key);
    state.cursor = Math.max(state.cursor, row.updated);
    const { kind, msg } = triageEvent(row);
    state.opts.events.record({
      step: "triage",
      kind,
      run: `triage:${row.delivery}`,
      ref: `${row.repo}#${row.number}`,
      msg,
    });
    count++;
  }
  return count;
}

export function createTriageBridge(opts: { dbPath: string; events: EventLog; now?: () => number }) {
  const state: TriageState = { opts, seen: new Map<string, string>(), cursor: 0 };
  // History before this process started is not new activity.
  for (const row of readTriageRows(state)) {
    state.cursor = Math.max(state.cursor, row.updated);
  }
  for (const row of readTriageRows(state))
    state.seen.set(row.delivery, `${row.status}:${row.attempts}:${row.updated}`);
  return { poll: () => pollTriage(state) };
}

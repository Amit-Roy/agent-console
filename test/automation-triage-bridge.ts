import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createEventLog } from "../server/automation/events.ts";
import { createTriageBridge } from "../server/automation/triage-bridge.ts";

// The triage worker is its own process with its own database. The bridge turns its rows into automation events, once each.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-triage-bridge-"));
let now = 1_800_000_000_000;
try {
  const dbPath = path.join(dir, "t.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(
    `CREATE TABLE github_triage (delivery TEXT PRIMARY KEY, repo TEXT NOT NULL, number INTEGER NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL, model TEXT, reason TEXT NOT NULL DEFAULT 'webhook')`,
  );
  const put = (delivery: string, status: string, over: Record<string, unknown> = {}) =>
    db
      .prepare(
        "INSERT OR REPLACE INTO github_triage(delivery,repo,number,kind,status,attempts,updated,model,reason) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        delivery,
        "o/r",
        Number(over.number ?? 1),
        "issue",
        status,
        Number(over.attempts ?? 1),
        now,
        (over.model as string) ?? null,
        (over.reason as string) ?? "webhook",
      );
  const ev = createEventLog({ file: path.join(dir, "ev.jsonl"), now: () => now });
  const bridge = createTriageBridge({ dbPath, events: ev, now: () => now });
  const lines = () =>
    ev
      .read({ step: "triage" })
      .events.reverse()
      .map((e) => `${e.kind}:${e.ref}:${e.msg ?? ""}`);

  assert.equal(bridge.poll(), 0, "empty database, nothing to report");
  put("d1", "queued", { attempts: 0 });
  now += 1000;
  put("d2", "running", { number: 2 });
  assert.equal(bridge.poll(), 2);
  assert.deepEqual(lines(), ["start:o/r#1:queued (webhook)", "start:o/r#2:running (webhook)"]);
  assert.equal(bridge.poll(), 0, "unchanged rows are not reported twice");
  now += 1000;
  put("d1", "done", { model: "pi/nemotron" });
  put("d2", "failed", { number: 2, attempts: 3 });
  assert.equal(bridge.poll(), 2);
  assert.deepEqual(lines().slice(2), [
    "ok:o/r#1:labeled by pi/nemotron",
    "fail:o/r#2:failed after 3 attempts",
  ]);
  now += 1000;
  put("d3", "skipped", { number: 3, reason: "reconcile" });
  bridge.poll();
  assert.equal(lines().at(-1), "ok:o/r#3:already complete (reconcile)");
  // a bridge started later (Console restart) does not replay old history as new activity
  const again = createTriageBridge({ dbPath, events: ev, now: () => now });
  assert.equal(again.poll(), 0);
  // a missing database is not an error: the worker may not be set up on this machine
  assert.equal(
    createTriageBridge({
      dbPath: path.join(dir, "none.sqlite"),
      events: ev,
      now: () => now,
    }).poll(),
    0,
  );
  db.close();
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(
  "PASS triage bridge: rows become events once, transitions reported, restart does not replay, missing database tolerated",
);
{
  const { usageEvents } = await import("../server/automation/usage-events.ts");
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "ac-usage-events-"));
  try {
    let t = 1_800_000_000_000;
    const ev = createEventLog({ file: path.join(d2, "ev.jsonl"), now: () => t });
    const rec = usageEvents(ev, () => t);
    const u = (a: number) => ({
      windows: [
        { label: "5-hour", used: a, limit: 100, unit: "%" },
        { label: "7-day", used: 3, limit: 100, unit: "%" },
      ],
      updatedAt: t,
    });
    rec("claude", u(10));
    rec("claude", u(11));
    t += 11 * 60_000;
    rec("claude", u(12));
    rec("codex", u(5));
    rec("pi", { windows: [{ label: "Budget", used: 1, limit: 50, unit: "$" }], updatedAt: t });
    assert.deepEqual(
      ev
        .read({ step: "usage" })
        .events.reverse()
        .map((e) => e.msg),
      [
        "claude: 5-hour 10%, 7-day 3%",
        "claude: 5-hour 12%, 7-day 3%",
        "codex: 5-hour 5%, 7-day 3%",
      ],
    );
  } finally {
    fs.rmSync(d2, { recursive: true, force: true });
  }
  console.log("PASS usage events: throttled per provider, percent windows only");
}

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCalibrationBridge } from "../server/automation/calibration-bridge.ts";
import { createEventLog } from "../server/automation/events.ts";

// The triage worker is its own process. It appends effort calibration lines to a file; the bridge turns them into
// automation events once each, survives a restart, and sends web push only for failures.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-calibration-bridge-"));
let now = 1_800_000_000_000;
try {
  const file = path.join(dir, "triage-calibration-events.jsonl");
  const logFile = path.join(dir, "ev.jsonl");
  const events = createEventLog({ file: logFile, now: () => now });
  const pushes: { thread: string; title: string }[] = [];
  const make = (log = events) =>
    createCalibrationBridge({ file, events: log, notify: (n) => pushes.push(n), now: () => now });
  const bridge = make();
  const put = (line: object | string) =>
    fs.appendFileSync(file, `${typeof line === "string" ? line : JSON.stringify(line)}\n`);
  const lines = (log = events) =>
    log
      .all()
      .filter((e) => e.step.startsWith("effort_"))
      .map((e) => `${e.step}:${e.kind}:${e.run ?? ""}:${e.msg ?? ""}`);

  assert.equal(bridge.poll(), 0, "no file, nothing to report");

  put({ ts: now + 1, run: "r1", step: "effort_sessions", kind: "start", msg: "reading history" });
  put({ ts: now + 2, run: "r1", step: "effort_sessions", kind: "ok", data: { rows: 120 } });
  put("not json at all");
  put({ ts: now + 3, run: "r1", step: "triage", kind: "ok" }); // a step that is not an effort step
  put({ ts: now + 3, run: "r1", step: "effort_fit", kind: "weird" }); // an unknown kind
  put({ ts: now + 3, run: "r1", step: "effort_fit", kind: "abandoned" }); // only the producer's four kinds
  put({ ts: "soon", run: "r1", step: "effort_fit", kind: "start" });
  put([1, 2] as unknown as object);
  fs.appendFileSync(file, '{"ts": 1800000000004, "run": "r1", "step": "effort_fit", "ki'); // half-written line
  assert.equal(bridge.poll(), 2, "only the two valid lines");
  assert.deepEqual(lines(), [
    "effort_sessions:start:effort:r1:reading history",
    "effort_sessions:ok:effort:r1:",
  ]);
  assert.equal(events.all().at(-1)!.data?.rows, 120, "the producer's data is kept");
  assert.deepEqual(pushes, [], "start and ok do not push");
  assert.equal(events.openRuns().length, 0, "start then ok under one run id leaves nothing open");
  assert.equal(bridge.poll(), 0, "nothing new, nothing recorded twice");

  // the half line is finished, then a failure arrives
  fs.appendFileSync(file, 'nd": "start"}\n');
  put({
    ts: now + 5,
    run: "r1",
    step: "effort_gate",
    kind: "fail",
    msg: "p80 coverage 0.70 is below 0.75",
  });
  put({
    ts: now + 6,
    run: "r1",
    step: "effort_reprice",
    kind: "info",
    msg: "waiting for reconcile",
  });
  assert.equal(bridge.poll(), 3, "the finished line is read now that it parses");
  assert.deepEqual(lines().slice(2), [
    "effort_fit:start:effort:r1:",
    "effort_gate:fail:effort:r1:p80 coverage 0.70 is below 0.75",
    "effort_reprice:info:effort:r1:waiting for reconcile",
  ]);
  assert.deepEqual(pushes, [
    {
      thread: "effort-model",
      title: "Effort model retrain failed: p80 coverage 0.70 is below 0.75",
    },
  ]);

  // a restart rereads the whole file and the log from disk: no duplicate events, no second push
  now += 10_000;
  const restarted = createEventLog({ file: logFile, now: () => now });
  const before = restarted.all().length;
  const again = make(restarted);
  assert.equal(again.poll(), 0, "a restart does not duplicate");
  assert.equal(restarted.all().length, before);
  assert.equal(pushes.length, 1);
  put({ ts: now, run: "r2", step: "effort_schedule", kind: "start", msg: "Run now" });
  assert.equal(again.poll(), 1, "only the line newer than the log");
  assert.equal(lines(restarted).at(-1), "effort_schedule:start:effort:r2:Run now");

  // secrets are redacted by the log, in the message and in the push title
  put({
    ts: now + 1,
    run: "r2",
    step: "effort_fit",
    kind: "fail",
    msg: "token=abc123def456 rejected",
  });
  again.poll();
  assert.ok(!restarted.all().at(-1)!.msg!.includes("abc123"));
  assert.ok(!pushes.at(-1)!.title.includes("abc123"));

  // a timestamp far in the future is clock garbage and must not hide every later line
  put({ ts: now + 86_400_000, run: "r3", step: "effort_fit", kind: "ok" });
  put({ ts: now + 2, run: "r3", step: "effort_fit", kind: "ok", msg: "after garbage" });
  assert.equal(again.poll(), 1);
  assert.equal(lines(restarted).at(-1), "effort_fit:ok:effort:r3:after garbage");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log("PASS calibration bridge: valid lines only, once each, restart-safe, push on failure");

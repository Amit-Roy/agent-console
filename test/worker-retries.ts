import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The live verification of #201 runs this report against the real data directory; fixtures pin its filter.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "worker-retries-"));
const at = (iso: string) => Date.parse(iso);
const jsonl = (rows: object[]) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
const run = (dir: string, ...args: string[]) =>
  spawnSync("bash", ["bin/agent-console", "worker-retries", ...args], {
    encoding: "utf8",
    env: { ...process.env, AGENT_CONSOLE_DATA: dir, AGENT_CONSOLE_RUN: scratch },
  });

const errored = "nefr0/agent-console#12";
const merged = "nefr0/agent-console#14";
const opened = "nefr0/agent-console#15";
const ledger = [
  { ts: at("2026-10-25T08:00:00Z"), dryRun: false, key: errored, route: { model: "pi" } },
  { ts: at("2026-10-25T08:05:00Z"), dryRun: true, key: "nefr0/agent-console#13" },
  { ts: at("2026-10-25T09:00:00Z"), dryRun: false, key: merged },
  { ts: at("2026-10-25T09:30:00Z"), dryRun: false, key: opened },
  { ts: at("2026-10-20T09:00:00Z"), dryRun: false, key: "nefr0/agent-console#9" },
];
const event = (seq: number, iso: string, row: object) => ({ seq, ts: at(iso), ...row });
const rotated = [
  event(1, "2026-10-20T09:10:00Z", {
    step: "worker",
    kind: "fail",
    ref: "nefr0/agent-console#9",
    msg: "turn ended with an error",
  }),
  event(2, "2026-10-25T08:30:00Z", {
    step: "worker",
    kind: "fail",
    run: "work:t12",
    ref: errored,
    msg: "turn ended with an error",
  }),
];
const current = [
  event(3, "2026-10-25T08:50:00Z", {
    step: "worker",
    kind: "start",
    run: "work:t12",
    ref: errored,
    msg: "resuming existing worker after an incomplete turn",
    data: { thread: "t12", retryAttempts: 1, recoveries: 0, remaining: 2, infrastructure: true },
  }),
  event(4, "2026-10-25T09:20:00Z", {
    step: "worker",
    kind: "ok",
    ref: merged,
    msg: "turn ended",
  }),
  event(5, "2026-10-25T09:21:00Z", {
    step: "review",
    kind: "start",
    ref: merged,
    data: { thread: "r14", pr: 77 },
  }),
  event(7, "2026-10-25T10:10:00Z", { step: "worker", kind: "ok", ref: opened, msg: "turn ended" }),
  // The PR step names the number only in its message; no review has started yet.
  event(8, "2026-10-25T10:11:00Z", { step: "pr", kind: "ok", ref: opened, msg: "PR #80" }),
  event(6, "2026-10-25T10:00:00Z", {
    step: "worker",
    kind: "info",
    ref: errored,
    msg: "infrastructure failure; queued for an approved premium alternative",
    data: { thread: "t12", reason: "infrastructure-model-unavailable", recoveries: 0 },
  }),
];

try {
  const live = path.join(scratch, "live");
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(live, "window-dispatch.jsonl"), jsonl(ledger));
  fs.writeFileSync(path.join(live, "automation-events.jsonl.1"), jsonl(rotated));
  fs.writeFileSync(path.join(live, "automation-events.jsonl"), jsonl(current));

  const json = run(live, "--since", "2026-10-24", "--until", "2026-10-26", "--json");
  assert.equal(json.status, 0, json.stderr);
  const report = JSON.parse(json.stdout);
  assert.deepEqual(report.range, {
    since: "2026-10-24T00:00:00.000Z",
    until: "2026-10-26T00:00:00.000Z",
  });
  assert.equal(report.events.first, "2026-10-20T09:10:00.000Z", "the rotated log must be read");
  assert.deepEqual(
    report.issues.map((issue: any) => issue.key),
    [errored],
    "only live dispatches inside the range whose turn ended in error or without a PR",
  );
  const [issue] = report.issues;
  assert.deepEqual(issue.ledger, ledger[0]);
  assert.deepEqual(issue.prs, []);
  assert.deepEqual(
    issue.turnEnds.map((row: any) => row.seq),
    [2],
  );
  assert.deepEqual(
    issue.retries.map((row: any) => [row.seq, row.data.retryAttempts]),
    [[3, 1]],
  );
  assert.deepEqual(
    issue.premium.map((row: any) => [row.seq, row.data.reason]),
    [[6, "infrastructure-model-unavailable"]],
  );

  const text = run(live, "--since", "2026-10-24", "--until", "2026-10-26");
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /nefr0\/agent-console#12/);
  assert.match(text.stdout, /PR in log: none/);
  assert.match(text.stdout, /2026-10-25T08:50:00.000Z worker\/start .*retryAttempts/);
  assert.match(text.stdout, /reason=infrastructure-model-unavailable/);

  const empty = run(live, "--since", "2026-10-26", "--until", "2026-10-27");
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /0 issues/);
  assert.match(empty.stdout, /2026-10-26T00:00:00.000Z/);
  assert.match(empty.stdout, /2026-10-27T00:00:00.000Z/);
  assert.match(empty.stdout, /Filter: /, "a zero result must state the exact filter");

  const missing = run(path.join(scratch, "absent"), "--since", "2026-10-24");
  assert.notEqual(missing.status, 0, "an unreadable data directory must not read as zero issues");
  assert.match(missing.stderr, /window-dispatch\.jsonl/);

  const invalid = run(live, "--since", "yesterday-ish");
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /--since/);
  console.log("worker-retries ok");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

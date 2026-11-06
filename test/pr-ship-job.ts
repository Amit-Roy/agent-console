// Persisted pr-ship jobs (#421): a job survives a Console "restart" (a new instance reattaches from the persisted
// record) and reports its outcome, whether it finishes after the restart or while the Console was down.
// Run: node test/pr-ship-job.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createShipJobs,
  jobAlive,
  readOutcome,
  ShipBusyError,
  type ShipRecord,
  type ShipState,
} from "../server/pr-ship-job.ts";

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pr-ship-job-")));
const bin = path.join(scratch, "bin");
const dir = path.join(scratch, "jobs");
const cwd = path.join(scratch, "work");
fs.mkdirSync(bin);
fs.mkdirSync(cwd);
// Fake pr-ship: records its argv and cwd, waits for a release file, then prints the line and exits with the code it holds.
fs.writeFileSync(
  path.join(bin, "pr-ship"),
  `#!/bin/sh
echo "args: $* cwd: $(pwd)"
echo "waiting for checks"
while [ ! -f "${scratch}/release-$1" ]; do sleep 0.05; done
cat "${scratch}/release-$1"
exit "$(cat "${scratch}/code-$1")"
`,
  { mode: 0o755 },
);
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
const release = (number: number, line: string, code: number) => {
  fs.writeFileSync(path.join(scratch, `code-${number}`), String(code));
  fs.writeFileSync(path.join(scratch, `release-${number}`), `${line}\n`);
};
const wait = async (predicate: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out: ${label}`);
};
const updates: { record: ShipRecord; ship: ShipState }[] = [];
const instance = () =>
  createShipJobs({
    dir,
    env,
    pollMs: 25,
    onUpdate: (record, ship) => updates.push({ record, ship }),
  });
const job = (number: number) => ({
  key: `o/r#${number}`,
  thread: "thread-a",
  repo: "o/r",
  number,
  cwd,
});

try {
  // outcome parsing: exit codes map to states, the last output line is kept and redacted
  assert.deepEqual(readOutcome("one\ntwo\nexit:0\n", 5), {
    state: "merged",
    code: 0,
    startedAt: 5,
    line: "two",
  });
  assert.equal(readOutcome("x\nexit:1", 1)?.state, "attention");
  assert.equal(readOutcome("x\nexit:3", 1)?.state, "failed");
  assert.equal(readOutcome("still running", 1), null);
  assert.equal(
    readOutcome(`token ghp_${"a".repeat(30)}\nexit:1`, 1)?.line?.includes("ghp_"),
    false,
  );

  // 1. start, then the Console "restarts" while the job runs; the new instance reattaches and reports the outcome
  const first = instance();
  const started = first.start(job(5));
  assert.equal(started.state, "running");
  assert.throws(() => first.start(job(5)), ShipBusyError);
  const record = first.record("o/r#5")!;
  assert.ok(record.pid > 0 && jobAlive(record.pid, record.outFile));
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, "o_r_5.json"), "utf8"));
  assert.deepEqual(Object.keys(persisted).sort(), ["key", "outFile", "pid", "startedAt", "thread"]);
  first.stop(); // the old process is gone; nothing watches the job any more
  await wait(() => fs.readFileSync(record.outFile, "utf8").includes("waiting"), "job output");

  updates.length = 0;
  const second = instance();
  assert.equal(second.get("o/r#5")?.state, "running");
  assert.throws(() => second.start(job(5)), ShipBusyError); // still 409 after the restart
  release(5, "PR 5 merged abc1234; deploy: none", 0);
  await wait(() => updates.some((update) => update.ship.state !== "running"), "merged outcome");
  const merged = updates.find((update) => update.ship.state !== "running")!;
  assert.equal(merged.record.thread, "thread-a");
  assert.deepEqual(merged.ship, {
    state: "merged",
    code: 0,
    line: "PR 5 merged abc1234; deploy: none",
    startedAt: record.startedAt,
  });
  assert.match(fs.readFileSync(record.outFile, "utf8"), new RegExp(`args: 5 -R o/r cwd: ${cwd}`));
  second.stop();

  // 2. the job finishes while the Console is down: the next instance reads the outcome from the output file
  const third = instance();
  third.start(job(6));
  third.stop();
  release(6, "Stop: check failing: lint", 1);
  const sixOut = third.record("o/r#6")!.outFile;
  await wait(() => /exit:1/.test(fs.readFileSync(sixOut, "utf8")), "exit line on disk");
  updates.length = 0;
  const fourth = instance();
  fourth.tick();
  assert.equal(updates.length, 1);
  assert.equal(updates[0].ship.state, "attention");
  assert.equal(updates[0].ship.line, "Stop: check failing: lint");
  assert.equal(fourth.get("o/r#6")?.state, "attention");
  // a finished job is persisted: a later instance still shows it without re-reporting it
  updates.length = 0;
  const fifth = instance();
  assert.equal(fifth.get("o/r#6")?.code, 1);
  assert.equal(fifth.get("o/r#5")?.state, "merged");
  fifth.tick();
  assert.equal(updates.length, 0);
  // and a finished PR can ship again
  assert.equal(fifth.start(job(6)).state, "running");
  release(6, "Stop: timed out", 3);
  await wait(() => fifth.get("o/r#6")?.state === "failed", "timeout outcome");
  fifth.stop();

  // 3. the wrapper died without an exit line (killed): failed with the last output line
  fs.writeFileSync(path.join(dir, "o_r_9.out"), "waiting for checks\n");
  fs.writeFileSync(
    path.join(dir, "o_r_9.json"),
    JSON.stringify({
      pid: 2 ** 22 + 12345,
      key: "o/r#9",
      thread: "thread-b",
      startedAt: Date.now(),
      outFile: path.join(dir, "o_r_9.out"),
    }),
  );
  updates.length = 0;
  const sixth = instance();
  sixth.tick();
  sixth.stop();
  assert.deepEqual(
    updates.map((update) => [update.record.key, update.ship.state, update.ship.line]),
    [["o/r#9", "failed", "waiting for checks"]],
  );
  console.log("pr-ship-job: ok");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

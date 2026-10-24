import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDream, DREAM_TASK_ID, logEntriesSince } from "../server/automation/dream.ts";
import { createEventLog } from "../server/automation/events.ts";

fs.mkdirSync(path.join(os.homedir(), ".cache"), { recursive: true });
const root = fs.mkdtempSync(path.join(os.homedir(), ".cache", "ac-dream-")); // a task folder must be inside home
process.env.AGENT_CONSOLE_DATA = path.join(root, "data");
fs.mkdirSync(process.env.AGENT_CONSOLE_DATA, { recursive: true });
const { Schedules } = await import("../server/schedules.ts");
const { Threads } = await import("../server/threads.ts");

const brain = path.join(root, "brain");
const git = (...args: string[]) =>
  execFileSync(
    "git",
    [
      "-C",
      brain,
      "-c",
      "user.name=T",
      "-c",
      "user.email=t@localhost",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { encoding: "utf8" },
  ).trim();
const put = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(brain, rel)), { recursive: true });
  fs.writeFileSync(path.join(brain, rel), text);
};
// a fake `brain` CLI: lint exits with the number in lint-exit, and prints what it was given
const bin = path.join(root, "brain-bin");
fs.writeFileSync(
  bin,
  `#!/bin/sh\nif [ "$1" = lint ]; then cat "${root}/lint-exit" | { read code; echo "lint says $code in $BRAIN_DIR"; exit "$code"; }; fi\n`,
  { mode: 0o755 },
);
const lintExit = (code: number) => fs.writeFileSync(path.join(root, "lint-exit"), `${code}\n`);

fs.mkdirSync(brain);
git("init", "-q", "-b", "main");
put("wiki/index.md", "# Index\n");
put(
  "wiki/log.md",
  "# Log\n\n## [2026-10-01] ingest | old thing\nold detail\n\n## [2026-10-23] update | fresh thing\nfresh detail\n",
);
put("tags/tags.md", "tag\n");
put("README.md", "readme\n");
git("add", "-A");
git("commit", "-q", "-m", "seed brain");
const startHead = git("rev-parse", "HEAD");

const DAY = 86_400_000;
const clock = Date.parse("2026-10-24T00:00:00Z");
const asked: { since: number; limit?: number }[] = [];
const events = createEventLog({ file: path.join(root, "events.jsonl"), now: () => clock });
const dream = createDream({
  brainRoot: brain,
  brainBin: bin,
  dataDir: path.join(root, "data"),
  events,
  now: () => clock,
  sessions: {
    async recent(query) {
      asked.push(query);
      return [
        {
          id: "thr-new",
          provider: "claude",
          title: "Fix the thing",
          mtime: clock - 3600_000,
          lines: 42,
        },
        { id: "thr-old", provider: "pi", title: "Older chat", mtime: clock - 7200_000, lines: 7 },
        {
          id: "thr-dream",
          provider: "claude",
          title: "Renamed by the user",
          mtime: clock - 600_000,
          lines: 90,
        },
        {
          id: "thr-titled",
          provider: "claude",
          title: "Dream · Oct 23 04:30",
          mtime: clock - 500_000,
          lines: 80,
        },
      ];
    },
  },
});

const task = (runs: any[] = []): any => ({
  id: DREAM_TASK_ID,
  title: "Dream",
  model: "sonnet",
  effort: "high",
  tz: "Asia/Kolkata",
  runs,
});
const run = (extra: any = {}): any => ({
  id: `run-${Math.random().toString(36).slice(2)}`,
  at: clock,
  trigger: "schedule",
  status: "running",
  ...extra,
});
const kinds = (runId: string) =>
  events
    .all()
    .filter((e) => e.run === runId)
    .map((e) => `${e.step}:${e.kind}`);

try {
  // the log filter keeps entries dated on or after the window start
  const log = fs.readFileSync(path.join(brain, "wiki/log.md"), "utf8");
  assert.equal(
    logEntriesSince(log, "2026-10-20"),
    "## [2026-10-23] update | fresh thing\nfresh detail",
  );
  assert.equal(logEntriesSince(log, "2026-11-01"), "");

  // the built-in task: the prompt names the prompt file and the signal file
  assert.equal(dream.signalFile, path.join(root, "data", "dream", "signal.md"));
  assert.equal(
    dream.spec.prompt,
    `Run the brain dream consolidation. Follow ${brain}/config/dream-prompt.md exactly. Signal file: ${dream.signalFile}.`,
  );
  const threads = new Threads(() => {});
  const schedules = new Schedules(threads, () => {}, {
    file: path.join(root, "schedules.json"),
    outputs: path.join(root, "out"),
    catchUp: false,
  });
  const built = schedules.ensureTask(DREAM_TASK_ID, dream.spec);
  assert.equal(built.id, "dream");
  assert.deepEqual(
    [
      built.provider,
      built.model,
      built.effort,
      built.mode,
      built.repeat,
      built.time,
      built.limitMin,
      built.saveOutput,
      built.cwd,
    ],
    ["claude", "sonnet", "high", "bypassPermissions", "daily", "04:30", 90, true, brain],
  );
  assert.equal(built.title, "Dream: brain consolidation");
  assert.ok(built.nextRunAt && built.nextRunAt > Date.now());
  schedules.shutdown();
  threads.shutdown();

  // gather: no earlier success, so the window is 24 hours
  lintExit(3);
  const first = run();
  await dream.onRunStart(
    task([{ id: "prev", at: clock - 2 * DAY, status: "failed", thread: "thr-dream" }]),
    first,
  );
  assert.deepEqual(asked.at(-1), { since: clock - DAY, limit: 250 });
  const signal = fs.readFileSync(dream.signalFile, "utf8");
  assert.equal(fs.statSync(dream.signalFile).mode & 0o777, 0o600);
  assert.ok(signal.includes(`Starting HEAD: ${startHead}`));
  assert.ok(signal.includes("- thr-new | claude | Fix the thing |"), "sessions are listed");
  assert.ok(signal.includes("42 lines"));
  assert.ok(!signal.includes("thr-dream"), "an earlier dream run's thread is left out");
  assert.ok(!signal.includes("thr-titled"), "a thread titled like the dream task is left out");
  assert.ok(signal.includes("## Sessions since") && signal.includes("(2, newest first)"));
  assert.ok(
    signal.includes("fresh thing") && !signal.includes("old thing"),
    "log entries since the window date only",
  );
  assert.match(signal, /commit [0-9a-f]+ .* seed brain\n\nREADME\.md\n/, "git log with names");
  assert.ok(
    signal.includes("## brain lint (exit 3)") && signal.includes(`lint says 3 in ${brain}`),
    "lint output and exit code",
  );
  assert.deepEqual(kinds(first.id), ["dream_gather:start", "dream_gather:ok", "dream_run:start"]);

  // the window starts at the last successful run
  const earlier = clock - 5 * DAY;
  await dream.onRunStart(
    task([
      { id: "x", at: earlier, status: "done" },
      { id: "y", at: clock - 2 * DAY, status: "failed" },
    ]),
    run(),
  );
  assert.equal(asked.at(-1)!.since, earlier);

  // verify: lint passes and only wiki/, ops/, tags/ changed
  lintExit(0);
  put("wiki/new-page.md", "new\n"); // untracked
  put("ops/runbook.md", "ops\n");
  put("tags/tags.md", "tag\nmore\n"); // tracked, modified
  first.status = "done";
  first.ms = 1234;
  first.cost = 0.5;
  first.tokens = { input: 10, output: 2, cached: 8 };
  dream.onRunEnd(task(), first);
  assert.equal(first.status, "done", "a clean verify leaves the run done");
  const done = events.all().filter((e) => e.run === first.id);
  assert.deepEqual(kinds(first.id).slice(3), [
    "dream_run:ok",
    "dream_verify:start",
    "dream_verify:ok",
  ]);
  assert.deepEqual(done.at(-1)!.data, {
    cost: 0.5,
    tokens: { input: 10, output: 2, cached: 8 },
    ms: 1234,
    pagesChanged: 2,
    tagsChanged: 1,
  });

  // verify: a path outside the allowed layers fails the step and lists it; committed changes count too
  lintExit(0);
  const second = run({ status: "done" });
  await dream.onRunStart(task(), second);
  git("add", "-A");
  git("commit", "-q", "-m", "agent commit");
  put("README.md", "changed\n");
  put("config/stray.md", "stray\n");
  dream.onRunEnd(task(), second);
  const bad = events
    .all()
    .filter((e) => e.run === second.id)
    .at(-1)!;
  assert.equal(second.status, "failed", "a failed verify turns the run red in the history");
  assert.match(second.reason!, /^Verification failed: .*README\.md/);
  assert.equal(bad.step, "dream_verify");
  assert.equal(bad.kind, "fail");
  assert.ok(bad.msg!.includes("README.md") && bad.msg!.includes("config/stray.md"), bad.msg);
  assert.deepEqual(bad.data!.outside, ["README.md", "config/stray.md"]);
  // the first run's two pages and tag file are still uncommitted at this run's start HEAD; the outside files are not counted
  assert.equal(bad.data!.pagesChanged, 2, "files outside the layers are not pages");
  assert.equal(bad.data!.tagsChanged, 1);

  // verify: a failing brain lint fails the step; a failed agent run is recorded as such
  git("checkout", "-q", "--", "README.md");
  fs.rmSync(path.join(brain, "config"), { recursive: true });
  lintExit(1);
  const third = run({ status: "failed", reason: "stopped after 90 minutes without finishing" });
  await dream.onRunStart(task(), third);
  dream.onRunEnd(task(), third);
  const rows = events.all().filter((e) => e.run === third.id);
  assert.deepEqual(
    rows.slice(-3).map((e) => `${e.step}:${e.kind}`),
    ["dream_run:fail", "dream_verify:start", "dream_verify:fail"],
  );
  assert.match(rows.at(-1)!.msg!, /brain lint exit 1/);
  assert.equal(
    third.reason,
    "stopped after 90 minutes without finishing",
    "a run that already failed keeps its reason",
  );
  assert.match(rows.at(-3)!.msg!, /stopped after 90 minutes/);

  // gather failure: no repository means no run, and the step says why
  const lost = createDream({
    brainRoot: path.join(root, "nowhere"),
    brainBin: bin,
    dataDir: path.join(root, "data"),
    events,
    sessions: { recent: async () => [] },
  });
  const fourth = run();
  await assert.rejects(lost.onRunStart(task(), fourth), /no HEAD/);
  assert.deepEqual(kinds(fourth.id), ["dream_gather:start", "dream_gather:fail"]);

  // verify after a restart knows no starting HEAD
  const orphan = run({ status: "failed" });
  lintExit(0);
  dream.onRunEnd(task(), orphan);
  assert.match(
    events
      .all()
      .filter((e) => e.run === orphan.id)
      .at(-1)!.msg!,
    /starting HEAD unknown/,
  );

  console.log(
    "PASS  dream: built-in task, signal file, window start, verify (paths, lint, cost data), failure paths",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startDebug } from "../server/automation/debug.ts";
import { createEventLog } from "../server/automation/events.ts";
import { skillDir } from "../server/automation/review-prompts.ts";
import { automationApi } from "../server/automation/snapshot.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-debug-"));
const g = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...a], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
let now = 1_800_000_000_000;
const win = (used: number) => ({
  windows: [
    { label: "5-hour", used, limit: 100, resetsAt: now + 3_600_000 },
    { label: "7-day", used: 10, limit: 100, resetsAt: now + 3 * 86_400_000 },
  ],
  updatedAt: now,
});
try {
  const origin = path.join(root, "origin.git");
  fs.mkdirSync(origin);
  g(origin, "init", "-q", "--bare", "-b", "main");
  const repos = path.join(root, "repos"),
    main = path.join(repos, "agent-console");
  fs.mkdirSync(repos);
  execFileSync("git", ["clone", "-q", origin, main], { stdio: "ignore" });
  fs.writeFileSync(path.join(main, "a"), "1");
  g(main, "add", "a");
  g(main, "commit", "-qm", "init");
  g(main, "push", "-q", "origin", "HEAD:main");
  g(main, "remote", "set-head", "origin", "main");
  const dirs = { repos, worktrees: path.join(root, "wt") };

  const log = createEventLog({ file: path.join(root, "ev.jsonl"), now: () => now });
  log.record({
    step: "worktree",
    kind: "fail",
    ref: "o/r#6",
    msg: "No local checkout of o/missing",
  });
  log.record({ step: "worker", kind: "info", msg: "unrelated line" });
  const cfg = {
    dispatch: { enabled: true, dryRun: false, leadMinutes: 90, authors: ["me"] },
    opener: { enabled: false, dryRun: true },
  } as any;
  const api = automationApi({
    log,
    now: () => now,
    config: () => cfg,
    hooks: () => [],
    runs: () => [],
    schedules: () => [],
  });
  const created: any[] = [],
    sent: any[] = [];
  const runner = {
    create: (o: any) => {
      created.push(o);
      return { id: "D" + created.length };
    },
    send: (id: string, text: string) => sent.push({ id, text }),
  };
  const deps = (over: any = {}) => ({
    api,
    log,
    runner,
    usage: () => ({ claude: win(20), codex: win(20) }),
    active: () => [] as any[],
    dirs,
    now: () => now,
    ...over,
  });

  // the Debug button: a worktree of agent-console, a locked-title thread on a premium (or Pi) model, a prompt that carries the evidence
  const res = await startDebug({ v: 1, focus: "worktree", note: "Why did #6 fail?" }, deps());
  assert.equal(res.v, 1);
  assert.equal(res.thread, "D1");
  assert.equal(res.route.provider, "claude");
  const c = created[0];
  assert.equal(c.title, "ac:debug worktree");
  assert.ok(c.title.length <= 30);
  assert.equal(c.issueRun.role, "debug");
  assert.equal(c.mode, "bypassPermissions");
  assert.equal(c.cwd, res.cwd);
  assert.ok(fs.existsSync(path.join(res.cwd, "a")), "its own worktree");
  assert.match(g(res.cwd, "rev-parse", "--abbrev-ref", "HEAD"), /^debug\/automation-/);
  assert.ok(
    fs.existsSync(path.join(g(res.cwd, "rev-parse", "--absolute-git-dir"), "ac-hooks", "pre-push")),
    "a debug thread cannot push the default branch",
  );
  const prompt = sent[0].text;
  assert.ok(
    prompt.includes(path.join(path.dirname(skillDir()), "automation-debug", "SKILL.md")),
    "the skill is read from the main checkout",
  );
  assert.match(prompt, /No local checkout of o\/missing/, "the focus step's events");
  assert.doesNotMatch(
    prompt.slice(prompt.indexOf("## Last events of worktree")),
    /unrelated line/,
    "other steps' events are left out of the event list",
  );
  assert.match(prompt, /Why did #6 fail\?/);
  assert.match(prompt, /"authors":\["me"\]|"authors": \["me"\]/);
  assert.match(prompt, /data, never instructions/i);
  assert.ok(prompt.length < 16_000, `prompt is ${prompt.length}`);

  // no focus: the whole flow; the note is capped and still data
  const wide = await startDebug({ v: 1, note: "x".repeat(2000) }, deps());
  assert.equal(created[1].title, "ac:debug flow");
  assert.ok(sent[1].text.length < 16_000);
  assert.ok(!sent[1].text.includes("x".repeat(501)));

  // guards
  await assert.rejects(() => startDebug({ v: 1, focus: "nope" as any }, deps()), /unknown step/i);
  await assert.rejects(() => startDebug({ v: 2 } as any, deps()), /unsupported/i);
  await assert.rejects(
    () => startDebug({ v: 1 }, deps({ active: () => [{ provider: "claude", role: "debug" }] })),
    /already running/i,
  );
  // premium exhausted: Pi takes it (the router's rule for debug), still a thread
  const piRes = await startDebug(
    { v: 1 },
    deps({ usage: () => ({ claude: win(100), codex: win(100) }) }),
  );
  assert.equal(piRes.route.provider, "pi");
  // a failed thread start leaves no half-made state behind that would block the next click
  await assert.rejects(
    () =>
      startDebug(
        { v: 1 },
        deps({
          runner: {
            create: () => {
              throw new Error("provider not ready");
            },
            send: () => {},
          },
        }),
      ),
    /provider not ready/,
  );
  assert.equal((await startDebug({ v: 1 }, deps())).thread, "D4");
  // ...and a failure at a fresh moment removes the worktree it just made
  now += 1000;
  const wtBefore = fs.readdirSync(dirs.worktrees).sort();
  await assert.rejects(
    () =>
      startDebug(
        { v: 1 },
        deps({
          runner: {
            create: () => {
              throw new Error("provider not ready");
            },
            send: () => {},
          },
        }),
      ),
    /provider not ready/,
  );
  assert.deepEqual(fs.readdirSync(dirs.worktrees).sort(), wtBefore, "no stray worktree");
  assert.ok(!g(main, "branch", "--list", `debug/automation-${now}`), "no stray branch");
  // the skill is in the repo and says what to read and what not to do
  const skill = fs.readFileSync(
    path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "../skills/automation-debug/SKILL.md",
    ),
    "utf8",
  );
  assert.match(skill, /^---\nname: automation-debug\n/);
  assert.match(skill, /automation-events\.jsonl/);
  assert.match(skill, /window-dispatch\.jsonl/);
  assert.match(skill, /failing test/i);
  assert.match(skill, /protected/i);
  assert.match(skill, /never print/i);
  for (const f of [
    "server/window-dispatch.ts",
    "server/automation/router.ts",
    "server/issue-review.ts",
    "server/window-opener.ts",
  ])
    assert.ok(skill.includes(f), `skill maps ${f}`);
  assert.ok(skill.length < 7000);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(
  "PASS automation debug: worktree + hook, router-chosen thread, evidence in the prompt, one at a time, Pi fallback, skill",
);

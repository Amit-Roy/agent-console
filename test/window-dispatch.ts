import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { historyRows } from "../server/usage.ts";
import { execFileSync } from "node:child_process";
import { plan, effortOf, expiring, loadConfig, createDispatcher, ROUTES, threadTitle, topicOf, issuePrompt, startIssue, type Issue } from "../server/window-dispatch.ts";

const now = 1_800_000_000_000, min = 60_000;
const win = (used: number, endsInMin: number, week = 5) => ({ windows: [{ label: "5-hour", used, limit: 100, unit: "%", resetsAt: now + endsInMin * min }, { label: "7-day", used: week, limit: 100 }], updatedAt: now });
const issue = (number: number, effort: string, pri = "P2"): Issue => ({ repo: "o/r", number, title: `t${number}`, labels: [`Eff: ${effort}`, `Pri: ${pri}`] });

// usage history only records changes
const a = win(10, 200);
assert.equal(historyRows("claude", undefined, a).length, 2);
assert.equal(historyRows("claude", a, { ...a, updatedAt: now + 1 }).length, 0);
assert.equal(historyRows("claude", a, win(11, 200)).length, 1);

// lead window: only the last 90 minutes, only with room left
assert.ok(!expiring(win(10, 120), now, loadConfig("/nonexistent")));
assert.equal(expiring(win(10, 89), now, loadConfig("/nonexistent"))?.full, false);
assert.equal(expiring(win(95, 30), now, loadConfig("/nonexistent"))?.full, true);
assert.ok(!expiring({ windows: [{ label: "5-hour", used: 0, limit: 100, resetsAt: now - 1 }], updatedAt: now }, now, loadConfig("/nonexistent")), "an already-reset window is stale");
assert.equal(effortOf(["Eff: Deep", "x"]), "deep");
assert.equal(effortOf(["Eff: Deep", "Eff: BAU"]), undefined);

// routing per issue #10
const issues = [issue(1, "Deep"), issue(2, "BAU"), issue(3, "Trivial"), issue(4, "BAU", "P0"), issue(5, "BAU", "P3")];
const none = plan({ now, usage: { claude: win(10, 120) }, issues, done: new Set() });
assert.deepEqual(none, [], "nothing before the last 90 minutes");
const claude = plan({ now, usage: { claude: win(10, 60) }, issues, done: new Set() });
assert.equal(claude.length, 2, "two per window");
assert.deepEqual(claude[0].route, ROUTES.deep[0], "deep gets Opus medium first");
assert.equal(claude[1].issue.number, 4, "then the highest-priority BAU");
assert.deepEqual(claude[1].route, ROUTES.bau[0]);
const codex = plan({ now, usage: { codex: win(10, 30) }, issues: [issue(1, "Deep"), issue(2, "BAU")], done: new Set() });
assert.deepEqual(codex.map(d => d.route), [ROUTES.deep[1], ROUTES.bau[1]]);
assert.equal(codex[0].route.effort, "high");
assert.equal(codex[1].route.effort, "low");
const both = plan({ now, usage: { claude: win(10, 60), codex: win(10, 60) }, issues: [issue(1, "Deep"), issue(2, "Deep"), issue(3, "Deep")], done: new Set() });
assert.equal(both.length, 3);
const trivial = plan({ now, usage: { codex: win(10, 60) }, issues: [issue(3, "Trivial")], done: new Set() });
assert.equal(trivial[0].route.provider, "pi");
assert.match(trivial[0].reason, /reviewer gpt-6.1-sol/);
// a nearly full window wastes nothing: deep/BAU skip it, trivial does not check
const full = { claude: win(95, 30) };
assert.deepEqual(plan({ now, usage: full, issues: [issue(1, "Deep"), issue(2, "BAU")], done: new Set() }), []);
assert.deepEqual(plan({ now, usage: full, issues: [issue(1, "Deep"), issue(3, "Trivial")], done: new Set() }).map(d => d.key), ["o/r#3"]);
assert.deepEqual(plan({ now, usage: { claude: win(95, 30), codex: win(10, 30) }, issues: [issue(1, "Deep")], done: new Set() }).map(d => d.route.provider), ["codex"], "deep falls through to the provider with room");
assert.deepEqual(plan({ now, usage: { claude: win(10, 60) }, issues, done: new Set(["o/r#1", "o/r#2", "o/r#3", "o/r#4", "o/r#5"]) }), []);
assert.deepEqual(plan({ now, usage: { claude: win(10, 60) }, issues: [{ ...issue(9, "BAU"), labels: ["bug"] }], done: new Set() }), [], "unlabelled issues wait for triage");

// thread names: <repo>:<issue#> <short desc>, at most 30 characters (issue #11: Android width)
assert.equal(topicOf("Amit-Roy/agent-console"), "ac");
assert.equal(topicOf("o/brain"), "brain"); assert.equal(topicOf("o/portfolio-lab"), "pl"); assert.equal(topicOf("o/abcdefghijklmnop"), "abcdefghij");
assert.equal(threadTitle({ repo: "Amit-Roy/agent-console", number: 10, title: "Identify unused reset windows" }), "ac:10 Identify unused reset");
assert.equal(threadTitle({ repo: "o/brain", number: 3, title: "[Bug] feat: " + "word ".repeat(20) }).length <= 30, true);
assert.equal(threadTitle({ repo: "o/r", number: 7, title: "x".repeat(80) }), "r:7 " + "x".repeat(26));
assert.equal(threadTitle({ repo: "o/r", number: 7, title: "" }), "r:7 issue");

// prompts: PRs everywhere except the local-apply repos; trivial always needs a reviewer
const dec = (repo: string, effort: any): any => ({ issue: { repo, number: 5, title: "t", labels: [] }, effort, route: ROUTES.bau[0], key: "k", reason: "" });
assert.match(issuePrompt(dec("o/agent-console", "bau"), "b", "main"), /push to main/);
assert.match(issuePrompt(dec("o/webapp", "bau"), "b", "main"), /open a pull request into main[^]*Do not merge/);
assert.match(issuePrompt(dec("o/agent-console", "trivial"), "b", "main"), /pull request[^]*Sonnet or Sol review/, "trivial work never pushes to the default branch");

// startIssue: own worktree and branch, a locked-title thread inside it, one prompt
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-issue-"));
  const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" }).trim();
  try {
    const origin = path.join(root, "origin.git"); fs.mkdirSync(origin);
    g(origin, "init", "-q", "--bare", "-b", "main");
    const repos = path.join(root, "repos"), main = path.join(repos, "webapp"); fs.mkdirSync(repos);
    execFileSync("git", ["clone", "-q", origin, main]);
    fs.writeFileSync(path.join(main, "a"), "1"); g(main, "add", "a"); g(main, "commit", "-qm", "init"); g(main, "push", "-q", "origin", "HEAD:main");
    g(main, "remote", "set-head", "origin", "main");
    const made: any[] = [], sentTo: any[] = [];
    const runner = { create: (o: any) => { made.push(o); return { id: "T1" }; }, send: (id: string, text: string) => sentTo.push({ id, text }) };
    const res = startIssue({ ...dec("o/webapp", "bau"), issue: { repo: "o/webapp", number: 42, title: "Fix the export totals", labels: [] } }, runner, { repos, worktrees: path.join(root, "wt") });
    assert.equal(res.cwd, path.join(root, "wt", "webapp-issue-42")); assert.equal(res.branch, "issue-42-fix-the-export-totals");
    assert.equal(g(res.cwd, "rev-parse", "--abbrev-ref", "HEAD"), res.branch);
    assert.equal(made[0].title, "webapp:42 Fix the export"); assert.equal(made[0].cwd, res.cwd); assert.equal(made[0].provider, "claude");
    assert.equal(sentTo.length, 1); assert.match(sentTo[0].text, /gh issue view 42 --repo o\/webapp/);
    assert.throws(() => startIssue(dec("o/missing", "bau"), runner, { repos, worktrees: path.join(root, "wt") }), /No local checkout/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// config: clamped, safe defaults, repos validated
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-dispatch-"));
try {
  assert.equal(loadConfig(path.join(dir, "none.json")).enabled, false);
  fs.writeFileSync(path.join(dir, "window-dispatch.json"), JSON.stringify({ enabled: true, leadMinutes: 9999, repos: ["../evil"] }));
  const c = loadConfig(path.join(dir, "window-dispatch.json"));
  assert.deepEqual(c.authors, ["Amit-Roy"]);
  assert.equal(c.enabled, true); assert.equal(c.dryRun, true); assert.equal(c.leadMinutes, 300); assert.deepEqual(c.repos, ["Amit-Roy/agent-console"]);

  // dispatcher: disabled does nothing; dry run logs once per window and starts nothing
  const github = async () => [{ number: 1, title: "x", user: { login: "Amit-Roy" }, labels: [{ name: "Eff: Deep" }, { name: "Pri: P1" }] }, { number: 2, pull_request: {}, user: { login: "Amit-Roy" }, labels: [] }, { number: 3, title: "stranger", user: { login: "someone-else" }, labels: [{ name: "Eff: Deep" }] }];
  const started: string[] = [];
  const d = createDispatcher({ usage: () => ({ claude: win(10, 60) }), github, dir, now: () => now, start: x => { started.push(x.key); } });
  fs.rmSync(path.join(dir, "window-dispatch.json"));
  assert.deepEqual(await d.tick(), []);
  fs.writeFileSync(path.join(dir, "window-dispatch.json"), JSON.stringify({ enabled: true, repos: ["o/r"] }));
  assert.equal((await d.tick()).length, 1);
  assert.equal((await d.tick()).length, 0, "same window is not logged twice");
  assert.deepEqual(started, []);
  const row = JSON.parse(fs.readFileSync(path.join(dir, "window-dispatch.jsonl"), "utf8").trim());
  assert.equal(row.dryRun, true); assert.equal(row.key, "o/r#1");
  fs.writeFileSync(path.join(dir, "window-dispatch.json"), JSON.stringify({ enabled: true, dryRun: false, repos: ["o/r"] }));
  assert.equal((await d.tick()).length, 1);
  assert.deepEqual(started, ["o/r#1"]);
  assert.equal((await d.tick()).length, 0, "a started issue is never reassigned");
  // a failed start is recorded with its error, does not stop the tick, and is not retried
  fs.rmSync(path.join(dir, "window-dispatch.jsonl"));
  const bad = createDispatcher({ usage: () => ({ claude: win(10, 60) }), github, dir, now: () => now, start: () => { throw new Error("no checkout"); } });
  assert.equal((await bad.tick()).length, 1);
  const rows = fs.readFileSync(path.join(dir, "window-dispatch.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
  assert.equal(rows.at(-1).error, "no checkout");
  assert.equal((await bad.tick()).length, 0, "a failed start is not retried");

  // --- router: shadow mode only reports; live mode decides; deferral keeps the issue for the next tick ------------------------
  {
    const { createEventLog } = await import("../server/automation/events.ts");
    const ev = createEventLog({ file: path.join(dir, "ev.jsonl"), now: () => now });
    const gh = async () => [
      { number: 1, title: "deep one", user: { login: "Amit-Roy" }, labels: [{ name: "Eff: Deep" }, { name: "Pri: P1" }] },
      { number: 2, title: "bau one", user: { login: "Amit-Roy" }, labels: [{ name: "Eff: BAU" }, { name: "Pri: P2" }] },
    ];
    const mk = (u: any, startedKeys: any[]) => createDispatcher({ usage: () => u, github: gh as any, dir, now: () => now, events: ev, active: () => [], start: d => { startedKeys.push([d.key, d.route.provider]); } });
    const both = { claude: win(10, 60), codex: win(10, 60) };
    const reset = () => { fs.rmSync(path.join(dir, "window-dispatch.jsonl"), { force: true }); };
    const put = (routing: any) => fs.writeFileSync(path.join(dir, "window-dispatch.json"), JSON.stringify({ enabled: true, dryRun: false, repos: ["o/r"], routing }));

    put({ mode: "shadow", bauOnPi: true }); reset();
    let started: any[] = []; await mk(both, started).tick();
    assert.deepEqual(started.map(s => s[0]), ["o/r#1", "o/r#2"]);
    assert.ok(started.every(s => s[1] === "claude"), "shadow: legacy routing still decides");
    const shadowRows = fs.readFileSync(path.join(dir, "window-dispatch.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
    assert.equal(shadowRows.find(r => r.key === "o/r#2").shadow.route.provider, "pi", "the router's choice is logged beside it");
    assert.ok(ev.read({ step: "router" }).events.some(e => /shadow/.test(e.msg!) && e.ref === "o/r#2"));

    put({ mode: "live", bauOnPi: true }); reset(); started = [];
    await mk(both, started).tick();
    assert.deepEqual(started, [["o/r#1", "claude"], ["o/r#2", "pi"]], "live: Deep on premium, BAU on Pi");

    put({ mode: "live", bauOnPi: false }); reset(); started = [];
    await mk({ claude: win(10, 60, 100), codex: win(10, 60, 100) }, started).tick();
    assert.deepEqual(started, [], "live: weekly caps reached, Deep and BAU wait");
    assert.ok(!fs.existsSync(path.join(dir, "window-dispatch.jsonl")) || !fs.readFileSync(path.join(dir, "window-dispatch.jsonl"), "utf8").includes('"key":"o/r#1"'), "a deferred issue is not marked done");
    assert.ok(ev.read({ step: "router" }).events.some(e => /defer/.test(e.msg!)));
    started = []; await mk(both, started).tick();
    assert.equal(started.length, 2, "next tick picks it up once there is room");
    assert.ok(ev.read({ step: "dispatcher" }).events.some(e => e.kind === "ok" && /picked 2/.test(e.msg!)), "each tick leaves a trace");
  }
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log("PASS usage history, 90-minute lead window, effort routing, priority order, config clamps, dry-run ledger");

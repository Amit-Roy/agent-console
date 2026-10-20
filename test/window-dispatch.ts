import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { historyRows } from "../server/usage.ts";
import { execFileSync } from "node:child_process";
import { plan, effortOf, expiring, loadConfig, createDispatcher, ROUTES, threadTitle, topicOf, issuePrompt, addWorktree, startIssue, type Issue } from "../server/window-dispatch.ts";

const now = 1_800_000_000_000, min = 60_000;
const win = (used: number, endsInMin: number, week = 5) => ({ windows: [{ label: "5-hour", used, limit: 100, unit: "%", resetsAt: now + endsInMin * min }, { label: "7-day", used: week, limit: 100 }], updatedAt: now });
const issue = (number: number, effort: string, pri = "P2"): Issue => ({ repo: "o/r", number, title: `t${number}`, labels: [`Eff: ${effort}`, `Pri: ${pri}`] });

// usage history only records changes
const a = win(10, 200);
assert.equal(historyRows("claude", undefined, a).length, 2);
assert.equal(historyRows("claude", a, { ...a, updatedAt: now + 1 }).length, 0);
assert.equal(historyRows("claude", a, win(11, 200)).length, 1);

// lead window: the last 90 minutes, or the last 180 below 60% used; only with room left
assert.ok(!expiring(win(70, 120), now, loadConfig("/nonexistent")));
assert.equal(expiring(win(70, 89), now, loadConfig("/nonexistent"))?.full, false);
assert.equal(expiring(win(59, 179), now, loadConfig("/nonexistent"))?.full, false, "a lightly used window opens 180 minutes early");
assert.ok(!expiring(win(59, 181), now, loadConfig("/nonexistent")));
assert.ok(!expiring(win(60, 120), now, loadConfig("/nonexistent")), "60% used is not low usage");
assert.ok(!expiring(win(10, 120), now, { ...loadConfig("/nonexistent"), lowUsageLeadMinutes: 60 }), "a shorter low-usage lead never narrows the normal one");
assert.equal(expiring(win(95, 30), now, loadConfig("/nonexistent"))?.full, true);
assert.ok(!expiring({ windows: [{ label: "5-hour", used: 0, limit: 100, resetsAt: now - 1 }], updatedAt: now }, now, loadConfig("/nonexistent")), "an already-reset window is stale");
assert.equal(effortOf(["Eff: Deep", "x"]), "deep");
assert.equal(effortOf(["Eff: Deep", "Eff: BAU"]), undefined);

// routing per issue #10
const issues = [issue(1, "Deep"), issue(2, "BAU"), issue(3, "Trivial"), issue(4, "BAU", "P0"), issue(5, "BAU", "P3")];
const none = plan({ now, usage: { claude: win(70, 120) }, issues, done: new Set() });
assert.deepEqual(none, [], "nothing before the last 90 minutes");
assert.equal(plan({ now, usage: { claude: win(10, 120) }, issues, done: new Set() }).length, 2, "below 60% used, the last 180 minutes");
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
// no Deep work: the premium slot takes the next issue by priority, then effort
const next = plan({ now, usage: { claude: win(10, 60) }, issues: [issue(3, "Trivial", "P0"), issue(2, "BAU", "P1"), issue(6, "BAU", "P0")], done: new Set() });
assert.deepEqual(next.map(d => d.key), ["o/r#6", "o/r#3"], "P0 BAU, then P0 Trivial, before P1 BAU");
assert.deepEqual(next.map(d => d.route), [ROUTES.bau[0], ROUTES.bau[0]]);
assert.ok(next.every(d => d.premium));
assert.match(next[1].reason, /no Deep work left/);
const live = { routing: { mode: "live" as const, bauOnPi: true }, perWindow: 1 };
const mixed = plan({ now, usage: { claude: win(10, 60) }, issues: [issue(1, "Deep", "P3"), issue(2, "BAU", "P0"), issue(3, "Trivial")], done: new Set(), cfg: live });
assert.deepEqual(mixed.map(d => [d.key, d.route.provider]), [["o/r#1", "claude"], ["o/r#2", "pi"]], "Deep keeps first pick; Pi takes the rest");
assert.deepEqual(plan({ now, usage: { claude: win(10, 60) }, issues: [issue(2, "BAU"), issue(3, "Trivial", "P0")], done: new Set(), cfg: live }).map(d => [d.key, d.route.provider]), [["o/r#3", "claude"], ["o/r#2", "pi"]]);
// trivial in a full window still runs on Pi with a premium reviewer
const trivial = plan({ now, usage: { codex: win(95, 60) }, issues: [issue(3, "Trivial")], done: new Set() });
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
assert.match(issuePrompt(dec("o/agent-console", "deep"), "b", "main"), /push to main/);
assert.match(issuePrompt(dec("o/agent-console", "bau"), "b", "main"), /pull request[^]*Sonnet or Sol review/, "BAU must wait for review even in direct repos");
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
    // Dirty and untracked host files never enter the private clone.
    fs.writeFileSync(path.join(main, "a"), "host dirty");
    fs.writeFileSync(path.join(main, "host-only"), "private host data");
    const res = startIssue({ ...dec("o/webapp", "bau"), issue: { repo: "o/webapp", number: 42, title: "Fix the export totals", labels: [] } }, runner, { repos, worktrees: path.join(root, "wt") });
    assert.match(res.cwd, /webapp-issue-42-[a-f0-9]{8}$/); assert.match(res.branch, /^issue-42-fix-the-export-totals-[a-f0-9]{8}$/);
    assert.equal(g(res.cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"), path.join(res.cwd, ".git"), "private Git metadata");
    assert.ok(fs.statSync(path.join(res.cwd, ".git")).isDirectory());
    assert.equal(fs.readFileSync(path.join(res.cwd, "a"), "utf8"), "1");
    assert.ok(!fs.existsSync(path.join(res.cwd, "host-only")), "untracked main files excluded");
    assert.ok(!fs.existsSync(path.join(res.cwd, ".git", "objects", "info", "alternates")), "objects do not depend on host metadata");
    assert.equal(g(res.cwd, "remote", "get-url", "origin"), origin, "push targets actual upstream");
    assert.equal(g(main, "branch", "--list", res.branch), "", "worker branch not shared with main");
    const firstHead = g(res.cwd, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(main, "a"), "2"); g(main, "add", "a"); g(main, "commit", "-qm", "upstream update"); g(main, "push", "-q", "origin", "HEAD:main");
    const retry = startIssue({ ...dec("o/webapp", "bau"), issue: { repo: "o/webapp", number: 42, title: "Fix the export totals", labels: [] } }, runner, { repos, worktrees: path.join(root, "wt") });
    assert.notEqual(retry.cwd, res.cwd); assert.notEqual(retry.branch, res.branch);
    assert.equal(g(retry.cwd, "rev-parse", "HEAD"), g(main, "rev-parse", "HEAD"), "retry starts latest upstream");
    assert.equal(g(res.cwd, "rev-parse", "HEAD"), firstHead, "old attempt untouched");
    // Existing symlinks, shared worktrees and mismatched branches cannot masquerade as private clones.
    const opts = { repo: "webapp", dirs: { repos, worktrees: path.join(root, "wt") }, dirName: "private-check", branch: "private-check" };
    fs.symlinkSync(main, path.join(root, "wt", "symlink"));
    assert.throws(() => addWorktree({ ...opts, dirName: "symlink" }), /Refusing/);
    g(main, "worktree", "add", "-q", "-b", "shared", path.join(root, "wt", "shared"));
    assert.throws(() => addWorktree({ ...opts, dirName: "shared", branch: "shared" }), /Refusing/);
    const privateWt = addWorktree(opts);
    assert.throws(() => addWorktree({ ...opts, branch: "wrong" }), /Refusing stale/);
    const reused = addWorktree(opts); assert.equal(reused.created, false);
    reused.remove(); assert.ok(fs.existsSync(privateWt.cwd), "reused checkout never removed");
    privateWt.remove(); assert.ok(!fs.existsSync(privateWt.cwd)); assert.ok(fs.existsSync(path.join(main, ".git")));
    assert.equal(g(res.cwd, "rev-parse", "--abbrev-ref", "HEAD"), res.branch);
    assert.equal(made[0].title, "webapp:42 Fix the export"); assert.equal(made[0].cwd, res.cwd); assert.equal(made[0].provider, "claude");
    const hook = g(res.cwd, "config", "--get", "core.hooksPath");
    assert.ok(fs.existsSync(path.join(hook, "pre-push")), "BAU work gets a default-branch push guard");
    assert.equal(sentTo.length, 2); assert.match(sentTo[0].text, /gh issue view 42 --repo o\/webapp/);
    const directRepo = path.join(repos, "agent-console");
    execFileSync("git", ["clone", "-q", origin, directRepo]);
    g(directRepo, "remote", "set-head", "origin", "main");
    const bauDirect = startIssue(dec("o/agent-console", "bau"), runner, { repos, worktrees: path.join(root, "wt") });
    assert.ok(fs.existsSync(path.join(g(bauDirect.cwd, "config", "--get", "core.hooksPath"), "pre-push")), "BAU in local-apply repos also gets a push guard");
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
    assert.equal(shadowRows.find(r => r.key === "o/r#2").shadow.route.provider, "claude", "the router's choice is logged beside it: a premium slot keeps BAU off Pi");
    assert.ok(ev.read({ step: "router" }).events.some(e => /shadow/.test(e.msg!) && e.ref === "o/r#2"));

    put({ mode: "live", bauOnPi: true }); reset(); started = [];
    await mk(both, started).tick();
    assert.deepEqual(started, [["o/r#1", "claude"], ["o/r#2", "codex"]], "live: Deep on premium, then a free premium slot takes BAU; the router spreads load");
    fs.writeFileSync(path.join(dir, "window-dispatch.json"), JSON.stringify({ enabled: true, dryRun: false, repos: ["o/r"], routing: { mode: "live", bauOnPi: true }, perWindow: 1 }));
    reset(); started = [];
    await mk({ claude: win(10, 60) }, started).tick();
    assert.deepEqual(started, [["o/r#1", "claude"], ["o/r#2", "pi"]], "live: Deep fills the premium slot, BAU on Pi");

    // Pi workers do not borrow a premium review window before their PR exists.
    put({ mode: "live", bauOnPi: true }); reset(); started = [];
    await mk({}, started).tick();
    assert.deepEqual(started, [["o/r#2", "pi"]], "BAU starts even without premium usage");
    reset(); started = [];
    await mk({ claude: win(100, 60), codex: win(10, 200) }, started).tick();
    assert.deepEqual(started, [["o/r#2", "pi"]], "full or non-expiring premium windows do not block Pi");
    reset(); started = [];
    fs.writeFileSync(path.join(dir, "window-dispatch.json"), JSON.stringify({ enabled: true, dryRun: true, repos: ["o/r"], routing: { mode: "live", bauOnPi: true } }));
    const dryPi = mk({}, started);
    assert.equal((await dryPi.tick()).length, 1);
    assert.equal((await dryPi.tick()).length, 0, "windowless Pi dry runs are logged only once");
    assert.deepEqual(started, []);
    put({ mode: "live", bauOnPi: true });
    reset(); started = [];
    const lowIssues = async () => [2, 3, 4, 5].map(number => ({ number, title: "small", user: { login: "Amit-Roy" }, labels: [{ name: number === 2 ? "Eff: BAU" : "Eff: Trivial" }] }));
    const limited = createDispatcher({ usage: () => ({}), github: lowIssues as any, dir, now: () => now, active: () => [{ provider: "pi", role: "work" }, { provider: "pi", role: "review" }], start: d => { started.push([d.key, d.route.provider]); } });
    await limited.tick();
    assert.deepEqual(started, [["o/r#2", "pi"]], "new picks count against Pi's three-run capacity within the tick");
    started = [];
    await limited.tick();
    assert.deepEqual(started, [["o/r#3", "pi"]], "deferred Trivial issue remains eligible next tick");
    reset(); started = [];
    const exhaustedPi = { pi: { windows: [{ label: "Free/day", used: 1000, limit: 1000 }], updatedAt: now } };
    await mk(exhaustedPi, started).tick();
    assert.deepEqual(started, [], "Pi's own exhausted quota still defers work");

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
console.log("PASS usage history, 90/180-minute lead window, next-priority premium fill, effort routing, priority order, config clamps, dry-run ledger");

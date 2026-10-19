import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { historyRows } from "../server/usage.ts";
import { plan, effortOf, expiring, loadConfig, createDispatcher, ROUTES, type Issue } from "../server/window-dispatch.ts";

const now = 1_800_000_000_000, min = 60_000;
const win = (used: number, endsInMin: number) => ({ windows: [{ label: "5-hour", used, limit: 100, unit: "%", resetsAt: now + endsInMin * min }, { label: "7-day", used: 5, limit: 100 }], updatedAt: now });
const issue = (number: number, effort: string, pri = "P2"): Issue => ({ repo: "o/r", number, title: `t${number}`, labels: [`Eff: ${effort}`, `Pri: ${pri}`] });

// usage history only records changes
const a = win(10, 200);
assert.equal(historyRows("claude", undefined, a).length, 2);
assert.equal(historyRows("claude", a, { ...a, updatedAt: now + 1 }).length, 0);
assert.equal(historyRows("claude", a, win(11, 200)).length, 1);

// lead window: only the last 90 minutes, only with room left
assert.ok(!expiring(win(10, 120), now, { ...loadConfig("/nonexistent") }));
assert.ok(expiring(win(10, 89), now, loadConfig("/nonexistent")));
assert.ok(!expiring(win(95, 30), now, loadConfig("/nonexistent")), "a full window wastes nothing");
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
assert.deepEqual(plan({ now, usage: { claude: win(10, 60) }, issues, done: new Set(["o/r#1", "o/r#2", "o/r#3", "o/r#4", "o/r#5"]) }), []);
assert.deepEqual(plan({ now, usage: { claude: win(10, 60) }, issues: [{ ...issue(9, "BAU"), labels: ["bug"] }], done: new Set() }), [], "unlabelled issues wait for triage");

// config: clamped, safe defaults, repos validated
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-dispatch-"));
try {
  assert.equal(loadConfig(path.join(dir, "none.json")).enabled, false);
  fs.writeFileSync(path.join(dir, "window-dispatch.json"), JSON.stringify({ enabled: true, leadMinutes: 9999, repos: ["../evil"] }));
  const c = loadConfig(path.join(dir, "window-dispatch.json"));
  assert.equal(c.enabled, true); assert.equal(c.dryRun, true); assert.equal(c.leadMinutes, 300); assert.deepEqual(c.repos, ["Amit-Roy/agent-console"]);

  // dispatcher: disabled does nothing; dry run logs once per window and starts nothing
  const github = async () => [{ number: 1, title: "x", labels: [{ name: "Eff: Deep" }, { name: "Pri: P1" }] }, { number: 2, pull_request: {}, labels: [] }];
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
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log("PASS usage history, 90-minute lead window, effort routing, priority order, config clamps, dry-run ledger");

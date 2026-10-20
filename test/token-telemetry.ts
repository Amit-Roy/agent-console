import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { raisedItems, raisedPrs } from "../server/session-prs.ts";
import { createTelemetryService, linkThread, parseRemote, renderTelemetry, NO_USAGE_TEXT, TELEMETRY_MARKER } from "../server/token-telemetry.ts";

const repo = "Amit-Roy/agent-console";
const repos = [repo];

// --- issues a thread filed link to it, but are not listed as PRs ---
const toolLog = (id: string, command: string, out: string) => [
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } }),
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: out }] } }),
].join("\n");
const filed = toolLog("t1", "cd /tmp && gh issue create -R Amit-Roy/agent-console --title x", `https://github.com/${repo}/issues/39`);
assert.deepEqual(raisedItems(filed).map(i => i.number), [39]);
assert.deepEqual(raisedPrs(filed), []);
assert.deepEqual(raisedItems(toolLog("t2", "gh pr create --fill", `https://github.com/${repo}/pull/23`)).map(i => i.number), [23]);
assert.deepEqual(raisedItems(toolLog("t3", 'grep "gh issue create" x', `https://github.com/${repo}/issues/5`)), []);

// --- linkage ---
const run = { repo, number: 7, branch: "issue-7", pr: 9 };
let l = linkThread({ thread: { id: "a", issueRun: run }, repos });
assert.deepEqual(l.items.map(i => [i.number, i.via]), [[7, "issue-run"], [9, "pr-run"]]);
l = linkThread({ thread: { id: "b", defaultRepo: repo, texts: ["fix #12 and see https://github.com/Amit-Roy/agent-console/pull/13", "x#99 &#39; foo/#5"] }, repos });
assert.deepEqual(l.items.map(i => i.number), [13, 12]); // url pass first, then #n; x#99 and &#39; are not refs
assert.deepEqual(linkThread({ thread: { id: "w", branch: "main", raised: [{ repo, number: 28 }, { repo: "evil/repo", number: 1 }] }, repos, item: { repo, number: 28 } }).items.map(i => i.via), ["raised"], "PR opened from a worktree links without a matching cwd branch");
assert.equal(linkThread({ thread: { id: "b", texts: ["https://github.com/evil/repo/issues/1", "#4"] }, repos }).items.length, 0, "other repos and no default repo are ignored");
assert.equal(linkThread({ thread: { id: "c", branch: "feat/x" }, repos, item: { repo, number: 3, head: "feat/x" } }).linked, true);
assert.equal(linkThread({ thread: { id: "c", branch: "feat/x" }, repos, item: { repo, number: 3, head: "other" } }).linked, false);
assert.equal(linkThread({ thread: { id: "c", branch: "main" }, repos, item: { repo, number: 3, head: "main" } }).linked, false, "main is never a link");
assert.equal(linkThread({ thread: { id: "d", issueRun: run }, repos, item: { repo, number: 9 } }).linked, true);
assert.equal(linkThread({ thread: { id: "d", texts: ["#1", "#2", "#3", "#4", "#5", "#6"], defaultRepo: repo }, repos }).items.length, 5, "reference cap");
assert.doesNotThrow(() => linkThread({ version: 99, extra: 1, thread: { id: "e", texts: [5 as any] }, repos } as any));
assert.equal(parseRemote("git@github.com:Amit-Roy/agent-console.git"), repo);
assert.equal(parseRemote("https://github.com/Amit-Roy/agent-console"), repo);

// --- render ---
assert.ok(renderTelemetry({ runs: [] }).body.includes(NO_USAGE_TEXT));
const sample = (inn?: number, out?: number, cache?: number) => ({ ts: 1, accounting: 2 as const, in: inn, out, cache });
const r = renderTelemetry({ runs: [
  { thread: "12345678-aaaa", title: "Fix <b>@bob</b>", provider: "claude", model: "opus", samples: [sample(1000, 50, 800), sample(500, 20, 100)] },
  { thread: "87654321-bbbb", provider: "pi", model: "m", samples: [sample(undefined, undefined)] },
  { thread: "abcdef12-cccc", provider: "codex", samples: [sample(10, 5, 4), sample()] },
] });
assert.ok(r.body.startsWith(TELEMETRY_MARKER + "\n"));
assert.ok(r.body.includes("| 1,500 | 900 | 70 | 2 |"));
assert.ok(/pi \| m \| unmeasured \| unmeasured \| unmeasured \| 1 \(1 unmeasured\) \|/.test(r.body));
assert.ok(/\| 10 \| 4 \| 5 \| 2 \(1 unmeasured\) \|/.test(r.body));
assert.ok(r.body.includes("| **Total** | | | 1,510 | 904 | 75 | 5 |"));
assert.ok(!r.body.includes("<b>") && !r.body.includes("@bob"), "untrusted title is escaped");
assert.equal(renderTelemetry({ runs: [{ thread: "t1", provider: "pi", samples: null }] }).measured, false);

// --- service with mock GitHub ---
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-telemetry-"));
fs.mkdirSync(path.join(dir, "logs"));
const resultLine = (usage: object) => JSON.stringify({ type: "result", ...usage });
const logFor = (text: string) => [
  JSON.stringify({ type: "user_input", ts: 10, text }),
  JSON.stringify({ type: "token_usage", input_tokens: 400, cached_input_tokens: 300, output_tokens: 40 }),
  resultLine({ duration_ms: 5 }),
].join("\n");
fs.writeFileSync(path.join(dir, "logs", "auto-1.jsonl"), logFor("start"));
fs.writeFileSync(path.join(dir, "logs", "manual-1.jsonl"), logFor("please look at #3"));
const threadList: any[] = [
  { id: "auto-1", provider: "codex", model: "gpt", title: "Issue 7", createdAt: 0, issueRun: { repo, number: 7, pr: 9, branch: "issue-7" } },
  { id: "manual-1", provider: "codex", model: "gpt", title: "Chat", createdAt: 0, cwd: "/w" },
];
type Comment = { id: number; body: string; user: { login: string } };
const store = new Map<number, Comment[]>();
const calls: string[] = [];
let nextId = 1;
const github = async (method: string, endpoint: string, body?: any) => {
  calls.push(`${method} ${endpoint}`);
  if (endpoint === "user") return { login: "bot" };
  let m = /^repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(endpoint);
  if (m) { if (Number(m[1]) === 9) return { head: { ref: "issue-7" } }; throw Object.assign(new Error("nf"), { status: 404 }); }
  if (/pulls\?/.test(endpoint)) return endpoint.includes("manual-branch") ? [{ number: 3 }] : [];
  m = /issues\/(\d+)\/comments/.exec(endpoint);
  if (m && method === "GET") return store.get(Number(m[1])) ?? [];
  if (m && method === "POST") { const c = { id: nextId++, body: body.body, user: { login: "bot" } }; store.set(Number(m[1]), [...(store.get(Number(m[1])) ?? []), c]); return c; }
  m = /issues\/comments\/(\d+)/.exec(endpoint);
  if (m && method === "PATCH") { for (const list of store.values()) for (const c of list) if (c.id === Number(m[1])) c.body = body.body; return {}; }
  if (/\/issues\?state=open/.test(endpoint)) return [{ number: 3 }, { number: 7 }, { number: 9 }, { number: 20 }];
  throw new Error(`unexpected ${method} ${endpoint}`);
};
const logs: [string, any][] = [];
const make = (extra: object = {}) => createTelemetryService({ repos: () => repos, dataDir: dir, github: github as any, threads: () => threadList,
  git: async (_cwd, ...args) => args[0] === "rev-parse" ? "manual-branch" : "git@github.com:Amit-Roy/agent-console.git",
  debounceMs: 5, log: (e, f) => logs.push([e, f]), ...extra });
const svc = make();

// issue 7: automation thread only
assert.equal((await svc.syncByNumber(repo, 7)).status, "created");
assert.ok(store.get(7)![0].body.includes("| 300 | 40 |") || store.get(7)![0].body.includes("| 400 | 300 | 40 |"));
// PR 9 matches by run.pr; unrelated 20 says no usage and posts once
assert.equal((await svc.syncByNumber(repo, 9)).status, "created");
assert.equal((await svc.ensureComment(repo, 20)).status, "created");
assert.ok(store.get(20)![0].body.includes(NO_USAGE_TEXT));
assert.equal((await svc.ensureComment(repo, 20)).status, "unchanged");
assert.equal(store.get(20)!.length, 1);
// PR 3: manual thread via branch name AND #3 reference -> one row
assert.equal((await svc.syncByNumber(repo, 3)).status, "created");
assert.equal(store.get(3)![0].body.split("\n").filter(x => x.startsWith("| Chat")).length, 1);
// a follow-up turn updates the same comment, never adds a second one
fs.appendFileSync(path.join(dir, "logs", "auto-1.jsonl"), "\n" + logFor("follow up"));
assert.equal((await svc.syncByNumber(repo, 7)).status, "updated");
assert.equal((await svc.syncByNumber(repo, 7)).status, "unchanged");
assert.equal(store.get(7)!.length, 1);
assert.ok(store.get(7)![0].body.includes("800 | 80 | 2 |") || /\| 800 \| 600 \| 80 \| 2 \|/.test(store.get(7)![0].body), store.get(7)![0].body);
// foreign comment with marker by another user is not adopted
store.set(30, [{ id: 99, body: TELEMETRY_MARKER + "\nspoof", user: { login: "mallory" } }]);
assert.equal((await svc.ensureComment(repo, 30)).status, "created");
assert.equal(store.get(30)!.length, 2);
// disallowed repo is skipped without calls
const before = calls.length;
assert.equal((await svc.syncItem({ repo: "evil/repo", number: 1 })).status, "skipped");
assert.equal(calls.length, before);

// turn end: debounced and coalesced; one upsert for burst
store.delete(7); calls.length = 0;
await svc.threadTurnEnded(threadList[0]); await svc.threadTurnEnded(threadList[0]); await svc.threadTurnEnded(threadList[0]);
await svc.flush();
assert.equal(calls.filter(c => c.startsWith("POST") && c.includes("issues/7/comments")).length, 1);
assert.equal(store.get(7)!.length, 1);
// turn end for manual thread finds the PR by branch
store.delete(3);
await svc.threadTurnEnded(threadList[1]); await svc.flush();
assert.equal(store.get(3)!.length, 1);

// failures are logged, never thrown
const broken = make({ github: async () => { throw new Error("boom token=secret"); } });
await assert.doesNotReject(broken.threadTurnEnded(threadList[0]));
assert.equal((await broken.ensureComment(repo, 1)).status, "failed");
assert.ok(logs.some(([e]) => e === "telemetry_failed"));
assert.ok(!JSON.stringify(logs).includes("secret"), "error text from GitHub is not logged verbatim");

// backfill (dry run writes nothing, real run covers each open item)
store.clear(); calls.length = 0;
assert.deepEqual(await svc.backfill(repo, { dryRun: true }), { scanned: 4, created: 0, updated: 0, unchanged: 0, failed: 0 });
assert.ok(!calls.some(c => c.startsWith("POST")));
const counts = await svc.backfill(repo);
assert.equal(counts.created, 4);
assert.equal(counts.failed, 0);
await assert.rejects(svc.backfill("evil/repo"));
svc.close(); fs.rmSync(dir, { recursive: true, force: true });
console.log("token-telemetry ok");

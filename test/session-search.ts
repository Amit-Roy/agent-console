import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionSearch } from "../server/session-search.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-session-search-"));
const threads = [
  { id: "claude-one", provider: "claude", title: "PR standards", archived: true },
  { id: "codex-one", provider: "codex", title: "Build standards" },
  { id: "pi-one", provider: "pi", title: "Fix toolbox" },
  { id: "empty-one", provider: "future-provider", title: "Empty discussion" },
];
fs.mkdirSync(path.join(root, "logs"));
const catalog = () => fs.writeFileSync(path.join(root, "threads.json"), JSON.stringify(threads));
const file = (id: string) => path.join(root, "logs", `${id}.jsonl`);
const user = (text: string) => JSON.stringify({ type: "user_input", text });
const assistant = (text: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
const write = (id: string, rows: string[]) => fs.writeFileSync(file(id), rows.join("\n") + "\n");
catalog();
write("claude-one", [user("Implement zebra pr-standards skill"), assistant("zebra zebra zebra zebra standards")]);
write("codex-one", [user("Find zebra " + "unrelated ".repeat(200)), "broken json", assistant("Implementation deferred until tomorrow")]);
write("pi-one", [JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "cat pr-standards/SKILL.md", api_key: "secretneedle" } }] } }), JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "The skill is empty: missingguidance" }] } })]);
fs.writeFileSync(file("empty-one"), "");
const toolUse = (id: string, command: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
const toolResult = (id: string, content: string) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });
fs.appendFileSync(file("pi-one"), [toolUse("t1", "gh pr list --json url"), toolResult("t1", "https://github.com/o/r/pull/7"), toolUse("t2", "cd ~/wt && gh pr create --title x"),
  toolResult("t2", "Creating pull request\nhttps://github.com/Amit-Roy/agent-console/pull/28\n")].join("\n") + "\n");
let search = new SessionSearch(root);
try {
  const result = await search.search({ query: "zebra" });
  assert.equal(result.indexedSessions, 4);
  assert.equal(result.results[0].thread, "claude-one", "BM25 favors relevant short repeated text");
  assert.ok(result.results.some(r => r.provider === "codex"));
  assert.ok((await search.search({ query: "standards", provider: "claude" })).results.every(r => r.provider === "claude"));
  assert.ok((await search.search({ query: "PR standards" })).results.some(r => r.thread === "claude-one"), "archived sessions searchable");
  assert.equal((await search.search({ query: "missingguidance" })).results[0].provider, "pi");
  assert.equal((await search.search({ query: "secretneedle" })).results.length, 0);
  const raised = await search.prs({ thread: "pi-one" });
  assert.deepEqual(raised.prs.map(p => `${p.repo}#${p.number}`), ["Amit-Roy/agent-console#28"], "only gh pr create output counts");
  for (const ref of ["https://github.com/Amit-Roy/agent-console/pull/28#issuecomment-6272643047", "Amit-Roy/agent-console#28", "28"])
    assert.equal((await search.prs({ ref })).prs[0]?.thread, "pi-one", ref);
  assert.equal((await search.prs({ ref: "other/repo#28" })).prs.length, 0);
  await assert.rejects(() => search.prs({ ref: "nonsense" }), /PR URL/);
  const read = await search.read({ thread: "codex-one", start: 2, limit: 1 });
  assert.equal(read.events[0].line, 3, "physical lines survive malformed records");
  assert.match(String(read.events[0].text), /deferred/);
  assert.equal((await search.search({ query: 'zebra" OR (NEAR * : - !' })).results.length > 0, true, "FTS operators cannot become query syntax");
  await assert.rejects(() => search.search({ query: "***" }), /words/);
  await assert.rejects(() => search.search({ query: "x".repeat(501) }), /500/);
  await assert.rejects(() => search.read({ thread: "../../private" }), /Invalid/);
  await assert.rejects(() => search.read({ thread: "absent" }), /Unknown/);
  assert.equal((await search.search({ query: "zebra", limit: 1 })).results.length, 1);

  fs.appendFileSync(file("pi-one"), assistant("appendedneedle") + "\n");
  assert.equal((await search.search({ query: "appendedneedle" })).results[0].line, 7);
  threads[2].title = "Renamedneedle"; threads[2].provider = "another-provider"; catalog();
  assert.equal((await search.search({ query: "Renamedneedle", provider: "another-provider" })).results[0].thread, "pi-one");
  write("pi-one", [user("replacementneedle")]);
  assert.equal((await search.search({ query: "appendedneedle" })).results.length, 0, "truncate removes stale index rows");
  assert.equal((await search.search({ query: "replacementneedle" })).results[0].line, 1);
  // Same-size rewrites must not be mistaken for unchanged content.
  write("pi-one", [user("replacementsignal")]);
  assert.equal((await search.search({ query: "replacementneedle" })).results.length, 0);
  assert.equal((await search.search({ query: "replacementsignal" })).results[0].line, 1);
  // Trailing partial lines are retried once the writer completes them.
  const partial = assistant("partialneedle");
  fs.appendFileSync(file("pi-one"), partial.slice(0, 20));
  assert.equal((await search.search({ query: "partialneedle" })).results.length, 0);
  fs.appendFileSync(file("pi-one"), partial.slice(20) + "\n");
  assert.equal((await search.search({ query: "partialneedle" })).results[0].line, 2);
  // Prefix rewrites combined with file growth must reset, even when the old suffix is unchanged.
  write("pi-one", [user("prefixold " + "padding ".repeat(400)), assistant("unchangedsuffix ".repeat(100))]);
  await search.warm();
  const rewrite = fs.readFileSync(file("pi-one"), "utf8").replace("prefixold", "prefixnew");
  fs.writeFileSync(file("pi-one"), rewrite + assistant("partialneedle") + "\n");
  assert.equal((await search.search({ query: "prefixold" })).results.length, 0);
  assert.equal((await search.search({ query: "prefixnew" })).results[0].line, 1);
  const concurrent = await Promise.all(Array.from({ length: 4 }, () => search.search({ query: "partialneedle" })));
  assert.ok(concurrent.every(r => r.results.length === 1), "concurrent refreshes serialize");
  search.close(); search = new SessionSearch(root);
  assert.equal((await search.search({ query: "partialneedle" })).results.length, 1, "index survives restart without duplicates");
  fs.unlinkSync(file("pi-one"));
  assert.equal((await search.search({ query: "partialneedle" })).results.length, 0, "missing log removes stale content");
  threads.splice(0, 1); catalog();
  assert.ok((await search.search({ query: "zebra" })).results.every(r => r.thread !== "claude-one"), "deleted sessions excluded even when log remains");
  console.log("session-search: BM25 ranking, all providers, archived sessions, freshness, bounds, and malformed input passed");
} finally { search.close(); fs.rmSync(root, { recursive: true, force: true }); }

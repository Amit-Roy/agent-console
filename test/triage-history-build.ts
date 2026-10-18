import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildTriageHistory, completionAvailability } from "../scripts/triage-history-build.ts";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "triage-history-source-"));
const repoDir = path.join(scratch, "repository");
const dataDir = path.join(scratch, "data");
fs.mkdirSync(repoDir);
fs.mkdirSync(path.join(dataDir, "logs"), { recursive: true });
const git = (...args: string[]) => execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8", env: {
  ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
} }).trim();
try {
  git("init", "-q");
  fs.writeFileSync(path.join(repoDir, "feature.txt"), "Synthetic fixture.\n");
  git("add", "feature.txt");
  git("commit", "-q", "-m", "Complete synthetic fixture");
  const sha = git("rev-parse", "HEAD");
  const committed = Number(git("show", "-s", "--format=%ct", sha)) * 1000;
  const start = committed - 10_000, end = committed + 10_000;
  const thread = { id: "fixture-thread", status: "idle", provider: "codex", cwd: "/fixture/project", updatedAt: end };
  const result: any = { type: "result", ts: end };
  const events: any[] = [
    { type: "user_input", ts: start, text: "Implement a synthetic feature and verify its behavior." },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "commit-tool", input: { command: "rtk git commit -m fixture" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "commit-tool", content: `ok ${sha.slice(0, 7)}` }] } },
    result,
  ];
  const ledger: any = { thread: thread.id, ts: start, provider: "codex", accounting: 2, in: 12_345, out: 678, cache: 10_000 };
  const write = () => {
    fs.writeFileSync(path.join(dataDir, "threads.json"), JSON.stringify([thread]));
    fs.writeFileSync(path.join(dataDir, "turns.jsonl"), JSON.stringify(ledger) + "\n");
    fs.writeFileSync(path.join(dataDir, "logs", `${thread.id}.jsonl`), events.map(event => JSON.stringify(event)).join("\n") + "\n");
  };
  const build = () => buildTriageHistory({ dataDir, repoDir, repo: "fixture/repository" });
  write();
  const measured = build();
  assert.equal(measured.tasks.length, 1);
  assert.equal(measured.tasks[0].commits[0].sha, sha);
  assert.equal(measured.tasks[0].inputTokens, 12_345, "Cache input must not be added twice");
  assert.equal(measured.tasks[0].outputTokens, 678);
  assert.equal(measured.tasks[0].provenance.wholeTask, false);
  assert.equal(measured.tasks[0].provenance.completionTimeExact, true);
  assert.equal(measured.tasks[0].request, events[0].text, "Features must come from the original request");
  events[2].message.content[0].content = `[main ${sha.slice(0, 7)}] Complete synthetic fixture`;
  write(); assert.equal(build().tasks.length, 1, "Native Git proof must work");
  ledger.err = 1;
  write(); assert.equal(build().tasks.length, 0, "Failed runs must not become successful outcomes");
  delete ledger.err;
  events[2].message.content[0].is_error = true;
  write(); assert.equal(build().tasks.length, 0, "Failed commit calls cannot establish delivery");
  delete events[2].message.content[0].is_error;
  events[1].message.content[0].input.command = "git show HEAD";
  write(); assert.equal(build().tasks.length, 0, "Reading a commit cannot establish new delivery");
  events[1].message.content[0].input.command = "git commit -m fixture";
  delete result.ts;
  events.push({ type: "user_input", ts: end + 10_000, text: "Continue with the next independently requested feature." });
  thread.status = "running";
  write();
  const bounded = build();
  assert.equal(bounded.tasks.length, 1);
  assert.equal(bounded.tasks[0].provenance.completionBound, "next-input");
  assert.equal(bounded.tasks[0].provenance.completionTimeExact, false);
  assert.equal(bounded.tasks[0].completedAt, new Date(end + 10_000).toISOString());
  events.pop(); write();
  assert.equal(build().tasks.length, 0, "Unfinished active tail has no safe completion cutoff");
  assert.deepEqual(completionAvailability([{ type: "result", ts: end }], 0, { status: "idle" }, start), { at: end, bound: "result-timestamp", exact: true });
  assert.deepEqual(completionAvailability([{ type: "result" }], 0, { status: "idle", updatedAt: end }, start), { at: end, bound: "idle-thread-updatedAt", exact: false });
  assert.equal(completionAvailability([{ type: "result", ts: start - 1 }], 0, { status: "idle" }, start), undefined);
  console.log("Triage history extraction: exact accounting, Git/RTK delivery proof, failures, and conservative completion bounds passed.");
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEventLog } from "../server/automation/events.ts";
import { createReviewer } from "../server/issue-review.ts";
import { guardRejections } from "../server/session-prs.ts";

// Issue #202: a Pi worker looped on pr-evidence-guard rejections and never opened a PR (#18).
// After two rejections agent-console opens the worker's branch as a draft PR and comments the guard error.

const GUARD_ERROR =
  "Blocked: PR validation failed: missing sections: ## A/B results, ## Architecture before\nBlocked: every PR requires visual evidence.";
const toolUse = (id: string, command: string) =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name: "bash", input: { command } }] },
  });
const toolResult = (id: string, content: string, isError: boolean) =>
  JSON.stringify({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }],
    },
  });
const say = (text: string) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });

// The #18 transcript: three rejected creates, then the worker gives up guessing formats.
const looped = [
  toolUse("t1", "gh pr create --repo o/webapp --base main --body-file /tmp/pr.md"),
  toolResult("t1", GUARD_ERROR, true),
  toolUse("t2", "cd /w && gh pr create --repo o/webapp --body-file /tmp/pr2.md"),
  toolResult("t2", [{ type: "text", text: GUARD_ERROR }] as any, true),
  toolUse("t3", "echo 'gh pr create' && ls"),
  toolResult("t3", "Blocked: not a create call", true),
  toolUse("t4", "pr-evidence create /tmp/pr.md"),
  toolResult("t4", "pr.md:7 Evidence: result.png is missing", true),
  toolUse("t5", "gh pr create --repo o/webapp --body-file /tmp/pr3.md"),
  toolResult("t5", "network unreachable", true),
  say("Let me try using HTML image tags instead of markdown images…"),
].join("\n");

// --- guardRejections: only guard or pr-evidence rejections of PR create calls count ---
{
  const found = guardRejections(looped);
  assert.equal(found.count, 3, "two guard denials and one pr-evidence rejection");
  assert.equal(found.last, "pr.md:7 Evidence: result.png is missing", "the newest rejection");
  assert.equal(guardRejections(looped.split("\n").slice(0, 2).join("\n")).count, 1);
  assert.equal(guardRejections("").count, 0);
  assert.equal(guardRejections("not json\n{").count, 0, "garbage lines are skipped");
}

// --- the reviewer opens a draft PR for a looping worker, then treats it as the worker's PR ---
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-guard-draft-"));
try {
  const now = 1_800_000_000_000;
  const events = createEventLog({ file: path.join(root, "ev.jsonl"), now: () => now });
  const steps = (step: string) =>
    events.read({ step: step as any }).events.map((entry) => `${entry.kind}:${entry.msg ?? ""}`);
  const calls: { method: string; url: string; body?: any }[] = [];
  let prs: any[] = [];
  let createFails = false;
  let commentFails = false;
  const github = async (method: string, url: string, body?: any) => {
    calls.push({ method, url, body });
    if (method === "GET" && /\/pulls\?state=open&head=/.test(url)) return prs;
    if (method === "GET" && /\/issues\/\d+$/.test(url))
      return { state: "open", title: "Fix totals" };
    if (method === "POST" && /\/pulls$/.test(url)) {
      if (createFails) throw new Error("HTTP 422: No commits between main and b");
      const made = { number: 18, body: body.body, draft: body.draft, head: { sha: "abc" } };
      prs = [made];
      return made;
    }
    if (method === "POST" && /\/issues\/18\/comments$/.test(url)) {
      if (commentFails) throw new Error("HTTP 502");
      return { id: 1 };
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  const sent: string[] = [];
  const marks: any[] = [];
  const transcripts: Record<string, string> = { W1: looped, W2: looped.split("\n")[1] };
  const reviewer = createReviewer({
    github: github as any,
    runner: {
      create: () => ({ id: "R1" }),
      send: (_id, text) => sent.push(text),
      mark: (id, patch) => marks.push({ id, patch }),
    },
    events,
    transcript: (id) => transcripts[id],
    canResume: () => false,
    route: () => ({ decision: "defer", why: "test holds reviews" }) as any,
    log: () => {},
    now: () => now,
  });
  const worker = (id: string, extra = {}) => ({
    id,
    provider: "pi",
    model: "nvidia/nvidia/nemotron-3-ultra-550b-a55b",
    status: "idle",
    issueRun: {
      key: "o/webapp#18",
      repo: "o/webapp",
      number: 18,
      effort: "bau",
      role: "work" as const,
      branch: "b",
      base: "main",
      finishedAt: now,
      ...extra,
    },
  });

  // One rejection is not a loop yet: no draft, the normal missing-PR path runs.
  transcripts.W2 = looped.split("\n").slice(0, 2).join("\n");
  await reviewer.sweep([worker("W2")] as any);
  assert.ok(!calls.some((call) => call.method === "POST"), "one rejection opens no draft");
  assert.ok(steps("pr").some((m) => /no open PR/.test(m)));

  // Two rejections: the draft opens against the worker's branch, and the guard error is commented.
  await reviewer.sweep([worker("W1")] as any);
  const created = calls.find((call) => call.method === "POST" && /\/pulls$/.test(call.url));
  assert.ok(created, "the looping worker reaches an open PR");
  assert.equal(created.url, "repos/o/webapp/pulls");
  assert.equal(created.body.draft, true, "opened as a draft");
  assert.equal(created.body.head, "b");
  assert.equal(created.body.base, "main");
  assert.match(created.body.title, /Fix totals/);
  assert.match(created.body.body, /Refs #18/, "the draft references the issue");
  assert.match(created.body.body, /## Self-review/);
  const comment = calls.find((call) => /\/issues\/18\/comments$/.test(call.url));
  assert.ok(comment, "the guard error is posted");
  assert.match(comment.body.body, /pr\.md:7 Evidence: result\.png is missing/);
  assert.match(comment.body.body, /3 times/);
  assert.ok(steps("pr").includes("ok:draft PR #18 opened after 3 PR evidence guard rejections"));
  assert.ok(steps("pr").includes("ok:PR #18"), "the draft continues as the worker's PR");
  assert.ok(steps("review").includes("info:deferred: test holds reviews"), "review takes over");

  // The open draft is found on the next sweep: no second PR or comment.
  const posts = calls.filter((call) => call.method === "POST").length;
  await reviewer.sweep([worker("W1")] as any);
  assert.equal(calls.filter((call) => call.method === "POST").length, posts, "no duplicate draft");

  // A failed create (nothing pushed) is reported once and leaves the missing-PR recovery in charge.
  prs = [];
  createFails = true;
  await reviewer.sweep([worker("W3")] as any);
  transcripts.W3 = looped;
  await reviewer.sweep([worker("W3")] as any);
  await reviewer.sweep([worker("W3")] as any);
  assert.equal(
    steps("pr").filter((m) => /could not open a draft PR: HTTP 422/.test(m)).length,
    1,
    "the failed draft is reported once",
  );

  // A failed comment still hands the opened draft to review, and the failure is reported.
  createFails = false;
  commentFails = true;
  transcripts.W4 = looped;
  await reviewer.sweep([worker("W4")] as any);
  assert.ok(
    steps("pr").some((m) => /could not comment the guard error on draft PR #18: HTTP 502/.test(m)),
  );
  assert.ok(steps("review").filter((m) => /deferred/.test(m)).length >= 1);
  commentFails = false;
  prs = [];

  // Direct-push repos open no PR at all, so no draft either.
  const before = calls.length;
  createFails = false;
  await reviewer.sweep([
    worker("W1", { key: "o/agent-console#18", repo: "o/agent-console", effort: "deep" }),
  ] as any);
  assert.ok(
    !calls.slice(before).some((call) => call.method === "POST"),
    "direct pushes never get a draft",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("guard-draft: ok");

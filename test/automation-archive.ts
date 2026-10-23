import assert from "node:assert/strict";
import { createAutomationArchiver } from "../server/automation/archive.ts";

const thread = (id: string, extra: any = {}) => ({
  id,
  status: "idle",
  issueRun: {
    key: "stale-key",
    repo: "Owner/Repo",
    number: 42,
    role: "work",
    effort: "bau",
    branch: "auto/42",
    base: "main",
  },
  ...extra,
});
function fixture(items: any[], github: (method: string, endpoint: string) => Promise<any>) {
  const archived: string[] = [];
  const store = {
    list: () => items,
    get: (id: string) => items.find((t) => t.id === id),
    archive: (id: string) => {
      store.get(id).archived = 999;
      archived.push(id);
    },
    setIssueRun: (id: string, patch: any) => {
      Object.assign(store.get(id).issueRun, patch);
    },
  };
  return {
    archived,
    archiver: createAutomationArchiver({ threads: store, github, now: () => 1234 }),
  };
}

// Canonical identity groups workers and reviews despite legacy keys and repository casing.
{
  const a = thread("worker"),
    b = thread("review");
  b.issueRun = {
    ...b.issueRun,
    repo: " owner/repo/ ",
    key: "other",
    role: "review",
    finishedAt: 123,
  };
  let reads = 0;
  const { archiver, archived } = fixture([a, b], async (_method, endpoint) => {
    reads++;
    assert.equal(endpoint, "repos/owner/repo/issues/42");
    return { state: "closed" };
  });
  await archiver.sweep();
  assert.deepEqual(archived, ["worker", "review"]);
  assert.equal(reads, 1);
  assert.equal(a.issueRun.outcome, "issue_closed");
  assert.equal(a.issueRun.finishedAt, 1234);
  assert.equal(b.issueRun.finishedAt, 123);
  await archiver.sweep();
  assert.equal(reads, 1, "archived groups do not keep querying GitHub");
}

// An explicitly tracked merged PR resolves every sibling even while the issue remains open.
{
  const a = thread("worker"),
    b = thread("review");
  b.issueRun.pr = 7;
  const calls: string[] = [];
  const { archiver, archived } = fixture([a, b], async (_method, endpoint) => {
    calls.push(endpoint);
    return endpoint.endsWith("/issues/42") ? { state: "open" } : { merged: true };
  });
  await archiver.sweep();
  assert.deepEqual(archived, ["worker", "review"]);
  assert.equal(calls.length, 2);
  assert.equal(a.issueRun.pr, 7);
  assert.equal(a.issueRun.outcome, "merged");
}

// Legacy stalled workers have no PR marker: find merged PRs beyond the first page.
{
  const a = thread("legacy");
  a.issueRun.stalled = 1;
  const calls: string[] = [];
  const { archiver, archived } = fixture([a, thread("sibling")], async (_method, endpoint) => {
    calls.push(endpoint);
    if (endpoint.includes("/issues/")) return { state: "open" };
    assert.match(endpoint, /state=all&head=owner%3Aauto%2F42&base=main&per_page=100&page=/);
    return endpoint.endsWith("page=1")
      ? Array.from({ length: 100 }, (_, i) => ({ number: i + 1, state: "closed", merged_at: null }))
      : [{ number: 999, merged_at: "2026-01-01" }];
  });
  await archiver.sweep();
  assert.deepEqual(archived, ["legacy", "sibling"]);
  assert.equal(calls.length, 3, "branch reads are shared across siblings");
  assert.equal(a.issueRun.pr, 999);
}

// Closing a PR without merging does not complete an open issue.
{
  const a = thread("worker");
  a.issueRun.pr = 7;
  const { archiver, archived } = fixture([a], async (_method, endpoint) =>
    endpoint.includes("/issues/")
      ? { state: "open" }
      : endpoint.includes("?")
        ? [{ number: 7, state: "closed", merged_at: null }]
        : { state: "closed", merged: false },
  );
  await archiver.sweep();
  assert.deepEqual(archived, []);
  assert.equal(a.issueRun.finishedAt, undefined);
}

// GitHub errors leave uncertain groups alone and do not prevent later groups from completing.
{
  const a = thread("unavailable"),
    b = thread("completed");
  b.issueRun.number = 43;
  const { archiver, archived } = fixture([a, b], async (_method, endpoint) => {
    if (endpoint.endsWith("/issues/43")) return { state: "closed" };
    throw new Error("GitHub unavailable");
  });
  await archiver.sweep();
  assert.deepEqual(archived, ["completed"]);
  assert.equal(a.issueRun.finishedAt, undefined);
}

// Active threads stay visible; idle siblings archive now and active siblings on a later sweep.
{
  const a = thread("running", { status: "running" }),
    b = thread("background", { background: 1 }),
    c = thread("idle");
  const { archiver, archived } = fixture([a, b, c], async () => ({ state: "closed" }));
  await archiver.sweep();
  assert.deepEqual(archived, ["idle"]);
  a.status = "idle";
  b.background = 0;
  await archiver.sweep();
  assert.deepEqual(archived, ["idle", "running", "background"]);
}

// Recheck live activity after network reads and share concurrent sweeps.
{
  const a = thread("resumed");
  let release!: () => void,
    reads = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { archiver, archived } = fixture([a], async () => {
    reads++;
    await gate;
    a.status = "running";
    return { state: "closed" };
  });
  const first = archiver.sweep(),
    second = archiver.sweep();
  assert.equal(first, second);
  release();
  await first;
  assert.equal(reads, 1);
  assert.deepEqual(archived, []);
}

console.log("automation archive: passed");

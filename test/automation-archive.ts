import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createAutomationArchiver } from "../server/automation/archive.ts";
import { runtimeFinished, sweepAutoRuntime } from "../server/automation/runtime-cleanup.ts";

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

// Finished jobs: Auto runtime folders are reclaimed once archived, stalled, or judged.
const run = { role: "work" as const };

function runtimeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-runtime-cleanup-"));
  const dataDir = path.join(root, "data");
  const runtime = (id: string) => path.join(dataDir, "auto-runtime", id);
  const seed = (id: string) => {
    for (const dir of [
      "tmp/scratch",
      "cache/npm",
      "claude/plugins/marketplaces/m",
      "claude/projects/p",
      "codex/plugins/x",
      "codex/cache/y",
      "codex/sessions/2026",
    ])
      fs.mkdirSync(path.join(runtime(id), dir), { recursive: true });
    fs.writeFileSync(path.join(runtime(id), "claude/projects/p/s.jsonl"), "{}\n");
    fs.writeFileSync(path.join(runtime(id), "claude/.credentials.json"), "{}");
    fs.writeFileSync(path.join(runtime(id), "codex/sessions/2026/r.jsonl"), "{}\n");
    fs.writeFileSync(path.join(runtime(id), "cache/npm/blob"), "x".repeat(1000));
  };
  return { root, dataDir, runtime, seed };
}

const exists = (p: string) => fs.existsSync(p);

test("finished threads are reduced to transcripts and credentials", async () => {
  const { root, dataDir, runtime, seed } = runtimeFixture();
  try {
    seed("merged");
    seed("stalled");
    const result = await sweepAutoRuntime(dataDir, [
      { id: "merged", archived: 1, issueRun: { ...run, outcome: "merged" } },
      { id: "stalled", issueRun: { ...run, stalled: 1 } },
    ]);
    assert.deepEqual(result, { pruned: 2, removed: 0, failed: 0 });
    for (const id of ["merged", "stalled"]) {
      for (const gone of ["tmp", "cache", "claude/plugins", "codex/plugins", "codex/cache"])
        assert.equal(exists(path.join(runtime(id), gone)), false, `${id}/${gone}`);
      for (const kept of [
        "claude/projects/p/s.jsonl",
        "claude/.credentials.json",
        "codex/sessions/2026/r.jsonl",
      ])
        assert.equal(exists(path.join(runtime(id), kept)), true, `${id}/${kept}`);
    }
    // A second sweep finds nothing left to reclaim.
    const again = await sweepAutoRuntime(dataDir, [
      { id: "merged", archived: 1, issueRun: run },
      { id: "stalled", issueRun: { ...run, stalled: 1 } },
    ]);
    assert.deepEqual(again, { pruned: 0, removed: 0, failed: 0 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("running, background, and unfinished threads are untouched", async () => {
  const { root, dataDir, runtime, seed } = runtimeFixture();
  try {
    for (const id of ["running", "background", "idle", "other"]) seed(id);
    const before = fs.readdirSync(path.join(dataDir, "auto-runtime"), { recursive: true }).sort();
    const result = await sweepAutoRuntime(dataDir, [
      { id: "running", status: "running", archived: 1, issueRun: { ...run, outcome: "merged" } },
      { id: "background", background: 1, issueRun: { ...run, stalled: 1 } },
      { id: "idle", issueRun: run },
      { id: "other", status: "idle", issueRun: run },
    ]);
    assert.deepEqual(result, { pruned: 0, removed: 0, failed: 0 });
    assert.deepEqual(
      fs.readdirSync(path.join(dataDir, "auto-runtime"), { recursive: true }).sort(),
      before,
    );
    assert.equal(exists(path.join(runtime("running"), "claude/plugins/marketplaces/m")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("startup sweep removes folders of deleted threads and never follows links", async () => {
  const { root, dataDir, runtime, seed } = runtimeFixture();
  try {
    seed("deleted");
    seed("kept");
    const outside = path.join(root, "outside");
    fs.mkdirSync(path.join(outside, "plugins"), { recursive: true });
    fs.writeFileSync(path.join(outside, "plugins", "precious"), "x");
    // A sandboxed agent can replace its own claude folder with a link to shared state.
    fs.mkdirSync(runtime("linked"), { recursive: true });
    fs.symlinkSync(outside, path.join(runtime("linked"), "claude"));
    fs.symlinkSync(outside, runtime("dangling-link"));
    fs.mkdirSync(path.join(dataDir, "auto-runtime", "not an id"));
    const result = await sweepAutoRuntime(dataDir, [
      { id: "kept", issueRun: run },
      { id: "linked", archived: 1, issueRun: run },
    ]);
    assert.deepEqual(result, { pruned: 0, removed: 2, failed: 0 });
    assert.equal(exists(runtime("deleted")), false);
    assert.equal(fs.existsSync(runtime("dangling-link")), false);
    assert.equal(exists(path.join(outside, "plugins", "precious")), true);
    assert.equal(exists(path.join(runtime("kept"), "claude/plugins/marketplaces/m")), true);
    assert.equal(exists(path.join(dataDir, "auto-runtime", "not an id")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an empty thread list never deletes whole folders", async () => {
  const { root, dataDir, runtime, seed } = runtimeFixture();
  try {
    seed("unknown");
    assert.deepEqual(await sweepAutoRuntime(dataDir, []), { pruned: 0, removed: 0, failed: 0 });
    assert.equal(exists(path.join(runtime("unknown"), "claude/projects/p/s.jsonl")), true);
    assert.deepEqual(await sweepAutoRuntime(path.join(root, "missing"), [{ id: "x" }]), {
      pruned: 0,
      removed: 0,
      failed: 0,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an undeletable folder is counted and the sweep continues", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root ignores directory permissions");
  const { root, dataDir, runtime, seed } = runtimeFixture();
  try {
    seed("locked");
    seed("open");
    fs.chmodSync(path.join(runtime("locked"), "claude"), 0o500);
    const result = await sweepAutoRuntime(dataDir, [
      { id: "locked", archived: 1, issueRun: run },
      { id: "open", archived: 1, issueRun: run },
    ]);
    assert.deepEqual(result, { pruned: 1, removed: 0, failed: 1 });
    assert.equal(exists(path.join(runtime("open"), "claude/plugins")), false);
  } finally {
    fs.chmodSync(path.join(runtime("locked"), "claude"), 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("only final automation threads count as finished", () => {
  assert.equal(runtimeFinished({ id: "m" }), false);
  assert.equal(runtimeFinished({ id: "a", archived: 1, issueRun: run }), true);
  assert.equal(runtimeFinished({ id: "o", issueRun: { ...run, outcome: "changes" } }), true);
  assert.equal(
    runtimeFinished({ id: "w", issueRun: { ...run, finishedAt: 1, redoing: true } }),
    false,
  );
});

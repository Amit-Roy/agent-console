import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runtimeFinished, sweepAutoRuntime } from "../server/automation/runtime-cleanup.ts";

const run = { role: "work" as const };

function fixture() {
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
  const { root, dataDir, runtime, seed } = fixture();
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
  const { root, dataDir, runtime, seed } = fixture();
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
  const { root, dataDir, runtime, seed } = fixture();
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
  const { root, dataDir, runtime, seed } = fixture();
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
  const { root, dataDir, runtime, seed } = fixture();
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

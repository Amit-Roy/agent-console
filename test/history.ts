import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HistoryIndex } from "../server/history.ts";
import { codexModels, codexTranslator } from "../server/providers/codex.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-history-"));
try {
  const file = path.join(dir, "log.jsonl");
  const events = Array.from({ length: 10000 }, (_, i) => ({
    type: i % 10 === 0 ? "user_input" : "assistant",
    text: `${i} café 🧪`,
  }));
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e) + "\n").join(""));
  const idx = new HistoryIndex();
  const latest = idx.read(file, undefined, 80);
  assert.equal(latest.start, 9920);
  assert.deepEqual(latest.events, events.slice(9920));
  assert.ok(latest.bytes < fs.statSync(file).size / 10);
  const older = idx.read(file, latest.start, 80);
  assert.equal(older.end, latest.start);
  assert.deepEqual(older.events, events.slice(older.start, older.end));
  assert.equal(idx.count(file), 10000);
  assert.deepEqual(idx.after(file, 9995, 80)!.events, events.slice(9995));
  assert.equal(idx.after(file, 10000, 80)!.events.length, 0, "nothing new is an empty delta");
  assert.equal(idx.after(file, 9000, 80), null, "too wide a gap falls back to a page");
  assert.equal(
    idx.after(file, 10001, 80),
    null,
    "a log shorter than the cached view falls back to a page",
  );
  const extra = { type: "user_input", text: "new turn" };
  fs.appendFileSync(file, JSON.stringify(extra) + "\n");
  assert.equal(idx.read(file, undefined, 80).total, 10001);
  assert.deepEqual(idx.after(file, 10000, 80)!.events, [extra]);
  fs.writeFileSync(file, JSON.stringify(extra) + "\n");
  assert.deepEqual(idx.read(file, undefined, 80).events, [extra]);
  assert.equal(idx.read(file, 0, 80).events.length, 0);
  fs.rmSync(file);
  assert.equal(idx.read(file, undefined, 80).total, 0);
  const large = [{ type: "assistant", text: "x".repeat(2_000_000) }, ...events.slice(0, 60)];
  fs.writeFileSync(file, large.map((e) => JSON.stringify(e) + "\n").join(""));
  const bounded = idx.read(file, undefined, 10);
  assert.deepEqual(bounded.events, large.slice(51));
  assert.ok(
    bounded.bytes < 10_000,
    "discarded large tool/message bodies are not read or parsed while locating a page boundary",
  );
  fs.writeFileSync(
    file,
    JSON.stringify({ text: "alternate property order", type: "user_input" }) + "\n",
  );
  assert.equal(idx.read(file, undefined, 10).events[0].type, "user_input");
  const cached = { minSnapshotBytes: 0 };
  const cache = path.join(dir, "index-cache");
  const cachedFile = path.join(dir, "cached.jsonl");
  const encode = (entries: unknown[]) =>
    entries.map((entry) => JSON.stringify(entry) + "\n").join("");
  fs.writeFileSync(cachedFile, encode(events));
  const caching = new HistoryIndex(cache, cached);
  caching.count(cachedFile);
  assert.equal(fs.existsSync(cache), false, "live counts do not persist snapshots");
  const expected = caching.read(cachedFile, undefined, 80);
  const snapshotPath = path.join(cache, fs.readdirSync(cache)[0]);
  const snapshot = fs.readFileSync(snapshotPath, "utf8");
  assert.equal(fs.statSync(cache).mode & 0o777, 0o700);
  assert.equal(fs.statSync(snapshotPath).mode & 0o777, 0o600);
  function sourceBytes(action: () => unknown) {
    const original = fs.readSync;
    const inode = fs.statSync(cachedFile).ino;
    let bytes = 0;
    fs.readSync = ((...args: any[]) => {
      const count = (original as any)(...args);
      if (fs.fstatSync(args[0]).ino === inode) bytes += count;
      return count;
    }) as typeof fs.readSync;
    try {
      action();
    } finally {
      fs.readSync = original;
    }
    return bytes;
  }
  const reopening = new HistoryIndex(cache, cached);
  const reopenedBytes = sourceBytes(() =>
    assert.deepEqual(reopening.read(cachedFile, undefined, 80), expected),
  );
  assert.ok(
    reopenedBytes < fs.statSync(cachedFile).size / 10,
    "fresh instances skip the full source scan",
  );
  for (let position = 0; position < 65; position++) {
    const evictingFile = path.join(dir, `evict-${position}.jsonl`);
    fs.writeFileSync(evictingFile, encode([extra]));
    reopening.count(evictingFile);
  }
  assert.ok(
    sourceBytes(() => assert.deepEqual(reopening.read(cachedFile, undefined, 80), expected)) <
      fs.statSync(cachedFile).size / 10,
    "LRU eviction restores persisted offsets without scanning source",
  );
  const snapshotTime = fs.statSync(snapshotPath, { bigint: true }).mtimeNs;
  reopening.read(cachedFile, undefined, 80);
  assert.equal(
    fs.statSync(snapshotPath, { bigint: true }).mtimeNs,
    snapshotTime,
    "valid snapshots are not rewritten",
  );
  const fallbackCases = [
    "{broken",
    JSON.stringify({ ...JSON.parse(snapshot), version: 999 }),
    JSON.stringify({ ...JSON.parse(snapshot), fingerprint: "stale" }),
    ...[[1], [0, -1], [0, 1.5], [0, 2, 1], [0, 1, 1], [0, Number.MAX_SAFE_INTEGER]].map((offsets) =>
      JSON.stringify({ ...JSON.parse(snapshot), offsets }),
    ),
    " ".repeat(16 * 1024 * 1024 + 1),
  ];
  for (const corrupted of fallbackCases) {
    fs.writeFileSync(snapshotPath, corrupted);
    const bytes = sourceBytes(() =>
      assert.deepEqual(new HistoryIndex(cache, cached).read(cachedFile, undefined, 80), expected),
    );
    assert.ok(bytes >= fs.statSync(cachedFile).size, "invalid snapshots fall back to scanning");
  }
  const modifiedSnapshot = JSON.parse(snapshot);
  modifiedSnapshot.offsets[1]++;
  fs.writeFileSync(snapshotPath, JSON.stringify(modifiedSnapshot));
  assert.ok(
    sourceBytes(() =>
      assert.deepEqual(new HistoryIndex(cache, cached).read(cachedFile, undefined, 80), expected),
    ) >= fs.statSync(cachedFile).size,
    "checksum rejects ordered in-bounds corrupted offsets",
  );
  const originalCacheRead = fs.readSync;
  const snapshotInode = fs.statSync(snapshotPath).ino;
  let injectedRewrite = false;
  fs.readSync = ((...args: any[]) => {
    const count = (originalCacheRead as any)(...args);
    if (!injectedRewrite && fs.fstatSync(args[0]).ino === snapshotInode) {
      injectedRewrite = true;
      fs.writeFileSync(cachedFile, encode([extra]));
    }
    return count;
  }) as typeof fs.readSync;
  try {
    assert.deepEqual(
      new HistoryIndex(cache, cached).read(cachedFile, undefined, 80).events,
      [extra],
      "source changes during snapshot read discard snapshot and scan fresh file state",
    );
    assert.equal(injectedRewrite, true);
  } finally {
    fs.readSync = originalCacheRead;
  }
  fs.writeFileSync(cachedFile, encode(events));
  new HistoryIndex(cache, cached).read(cachedFile, undefined, 80);
  fs.appendFileSync(cachedFile, encode([extra]));
  assert.equal(
    new HistoryIndex(cache, cached).read(cachedFile, undefined, 80).total,
    events.length + 1,
    "append invalidates disk snapshot",
  );
  // Equal byte length, different newline locations: timestamps must invalidate in-memory and disk indexes.
  const firstShape = encode([
    { type: "user_input", text: "aa" },
    { type: "assistant", text: "b" },
  ]);
  const secondShape = encode([
    { type: "user_input", text: "a" },
    { type: "assistant", text: "bb" },
  ]);
  fs.writeFileSync(cachedFile, firstShape);
  const rewriting = new HistoryIndex(cache, cached);
  rewriting.read(cachedFile, undefined, 80);
  fs.writeFileSync(cachedFile, secondShape);
  fs.utimesSync(cachedFile, new Date(), new Date(Date.now() + 2000));
  assert.equal(firstShape.length, secondShape.length);
  assert.equal(
    new HistoryIndex(cache, cached).read(cachedFile, undefined, 80).events[1].text,
    "bb",
  );
  assert.equal(rewriting.read(cachedFile, undefined, 80).events[1].text, "bb");
  fs.writeFileSync(cachedFile + ".replacement", encode([extra]));
  fs.renameSync(cachedFile + ".replacement", cachedFile);
  assert.deepEqual(
    rewriting.read(cachedFile, undefined, 80).events,
    [extra],
    "replacement invalidates indexes",
  );
  fs.writeFileSync(cachedFile, "");
  assert.equal(rewriting.read(cachedFile, undefined, 80).total, 0, "truncation and empty files");
  fs.appendFileSync(cachedFile, encode([extra]) + '{"type":"assistant","text":"café 🧪');
  assert.deepEqual(
    rewriting.read(cachedFile, undefined, 80).events,
    [extra],
    "partial trailing line excluded",
  );
  const partial = new HistoryIndex(cache, cached);
  assert.deepEqual(partial.read(cachedFile, undefined, 80).events, [extra]);
  fs.appendFileSync(cachedFile, '"}\n');
  assert.equal(
    partial.read(cachedFile, undefined, 80).events[1].text,
    "café 🧪",
    "partial UTF-8 line survives reopen and append",
  );
  const blockedDirectory = path.join(dir, "not-a-directory");
  fs.writeFileSync(blockedDirectory, "blocked");
  assert.equal(
    new HistoryIndex(blockedDirectory, cached).read(cachedFile, undefined, 80).total,
    2,
    "cache errors never break reads",
  );
  const originalOpen = fs.openSync;
  fs.openSync = ((target: any, ...args: any[]) => {
    if (String(target).startsWith(cache))
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    return (originalOpen as any)(target, ...args);
  }) as typeof fs.openSync;
  try {
    assert.equal(new HistoryIndex(cache, cached).read(cachedFile, undefined, 80).total, 2);
  } finally {
    fs.openSync = originalOpen;
  }
  partial.forget(cachedFile);
  assert.equal(fs.existsSync(snapshotPath), false, "deletion removes derived snapshots");
  fs.rmSync(cachedFile);
  assert.equal(
    partial.read(cachedFile, undefined, 80).total,
    0,
    "missing source never uses snapshot",
  );
  const gateDir = path.join(dir, "gate-cache");
  const gateFile = path.join(dir, "gate.jsonl");
  const gateEvents = (count: number) =>
    Array.from({ length: count }, (_, position) => ({ type: "assistant", text: `g${position}` }));
  const gateRead = (index: HistoryIndex) => index.read(gateFile, undefined, 80);
  const gateBody = encode(gateEvents(50));
  const gateSize = Buffer.byteLength(gateBody);
  fs.writeFileSync(gateFile, gateBody);
  const gateExpected = gateRead(new HistoryIndex());
  assert.deepEqual(
    gateRead(new HistoryIndex(gateDir, { minSnapshotBytes: gateSize + 1 })),
    gateExpected,
  );
  assert.equal(fs.existsSync(gateDir), false, "log below threshold writes no snapshot");
  assert.deepEqual(
    gateRead(new HistoryIndex(gateDir, { minSnapshotBytes: gateSize })),
    gateExpected,
  );
  assert.equal(fs.readdirSync(gateDir).length, 1, "log exactly at threshold writes snapshot");
  fs.rmSync(gateDir, { recursive: true });
  const crossing = new HistoryIndex(gateDir, { minSnapshotBytes: 4096 });
  fs.writeFileSync(gateFile, encode(gateEvents(10)));
  gateRead(crossing);
  assert.equal(fs.existsSync(gateDir), false, "small log is not persisted");
  fs.appendFileSync(gateFile, encode(gateEvents(400).slice(10)));
  assert.ok(fs.statSync(gateFile).size >= 4096);
  assert.deepEqual(gateRead(crossing), gateRead(new HistoryIndex()));
  assert.equal(fs.readdirSync(gateDir).length, 1, "crossing the threshold writes snapshot");
  const staleSnapshot = path.join(gateDir, fs.readdirSync(gateDir)[0]);
  const staleBefore = fs.readFileSync(staleSnapshot, "utf8");
  fs.writeFileSync(gateFile, encode(gateEvents(10)));
  assert.deepEqual(
    gateRead(new HistoryIndex(gateDir, { minSnapshotBytes: 4096 })).events,
    gateEvents(10),
    "truncation below threshold ignores stale snapshot",
  );
  assert.equal(fs.readFileSync(staleSnapshot, "utf8"), staleBefore, "snapshot left untouched");
  fs.writeFileSync(
    path.join(dir, "models_cache.json"),
    JSON.stringify({
      models: [
        {
          slug: "visible",
          display_name: "Visible model",
          visibility: "list",
          default_reasoning_level: "low",
          supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
        },
        { slug: "hidden", visibility: "hide" },
      ],
    }),
  );
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
  try {
    assert.deepEqual(Object.keys(codexModels()), ["default", "visible"]);
    assert.deepEqual(codexModels().visible.efforts, ["low", "high"]);
    assert.deepEqual(codexModels().default.efforts, ["low", "high"]);
    assert.equal(codexModels().visible.defaultEffort, "low");
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
  const out: any[] = [];
  codexTranslator((e) => out.push(e))({
    type: "turn.completed",
    usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 20 },
  });
  assert.equal(out.find((e) => e.type === "token_usage").cached_input_tokens, 50);
  console.log(
    "PASS indexed history: bounded reads, deltas after a line, contiguous pages, UTF-8, appends, truncation, missing logs; Codex catalog and token telemetry",
  );
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

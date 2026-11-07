import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-view-cache-"));
process.env.AGENT_CONSOLE_DATA = dir;
process.env.AGENT_CONSOLE_PAGE = "40";
process.env.AGENT_CONSOLE_PAGE_BYTES = "96000";
const { HistoryIndex, VIEW_MIN_LINE_BYTES, VIEW_SIDECAR_VERSION } = await import("../server/history.ts");
const { Threads } = await import("../server/threads.ts");

const BIG = VIEW_MIN_LINE_BYTES + 4096;
const toolLine = (text: string, extra = "") => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: text }] },
  provider_diagnostics: extra,
});
const projectLine = (_line: number, parsed: any) =>
  parsed.type === "noise" ? null : { ...parsed, p: 1 };
const project = { key: "test-projection", project: projectLine };
const encode = (entries: any[]) => entries.map((entry) => JSON.stringify(entry) + "\n").join("");
function counted<T>(action: () => T) {
  const original = fs.readSync;
  let calls = 0;
  fs.readSync = ((...args: any[]) => {
    calls++;
    return (original as any)(...args);
  }) as typeof fs.readSync;
  try {
    return { result: action(), calls };
  } finally {
    fs.readSync = original;
  }
}
function turns(count: number, bigAt: number[]) {
  return Array.from({ length: count }, (_, position) =>
    position % 5 === 0
      ? { type: "user_input", text: `turn ${position}` }
      : bigAt.includes(position)
        ? toolLine("r".repeat(BIG), "d".repeat(BIG))
        : position % 7 === 0
          ? { type: "noise" }
          : toolLine(`small ${position}`),
  );
}

function bigReads<T>(action: () => T) {
  const original = fs.readSync;
  let big = 0;
  fs.readSync = ((...args: any[]) => {
    if (args[3] > 16 * 1024) big++;
    return (original as any)(...args);
  }) as typeof fs.readSync;
  try {
    return { result: action(), big };
  } finally {
    fs.readSync = original;
  }
}

function sidecarTests() {
  const cache = path.join(dir, "sidecar-cache");
  const options = { minSnapshotBytes: 1 };
  const log = path.join(dir, "sidecar.jsonl");
  const original = encode(turns(100, [91, 92, 93]));
  fs.writeFileSync(log, original);
  const sidecars = () => fs.readdirSync(cache).filter((name) => name.endsWith(".views.json"));
  const sidecarFile = () => path.join(cache, sidecars()[0]);
  const write = (reader: any) => {
    reader.read(log, undefined, 40, project);
    reader.flushViews();
  };
  const reopenWith = (key = project.key) => {
    const reopened = new HistoryIndex(cache, options);
    return reopened.read(log, undefined, 40, { key, project: projectLine });
  };
  const hits = (result: any) => result.items.length;
  const writer = new HistoryIndex(cache, options);
  write(writer);
  assert.equal(sidecars().length, 1, "sidecar written");
  assert.equal(fs.statSync(sidecarFile()).mode & 0o777, 0o600);
  const expected = new HistoryIndex().read(log, undefined, 40, project);

  // Reopen: byte-identical page, no large transcript reads.
  const warm = bigReads(() => new HistoryIndex(cache, options).read(log, undefined, 40, project));
  assert.equal(JSON.stringify(warm.result.items), JSON.stringify(expected.items));
  assert.equal(warm.big, 0, "reopen reads no large chunks");
  assert.ok(hits(warm.result) > 0);

  // Rejections: tamper with the sidecar and expect a transcript re-read (large reads again).
  const good = fs.readFileSync(sidecarFile(), "utf8");
  const rejected = (mutate: (sidecar: any) => void, rechecksum = false) => {
    const sidecar = JSON.parse(good);
    mutate(sidecar);
    if (rechecksum) {
      sidecar.checksum = sidecarChecksumOf(sidecar);
    }
    fs.writeFileSync(sidecarFile(), JSON.stringify(sidecar));
    const run = bigReads(() => new HistoryIndex(cache, options).read(log, undefined, 40, project));
    assert.ok(run.big > 0, "sidecar rejected: lines re-read");
    assert.equal(JSON.stringify(run.result.items), JSON.stringify(expected.items));
  };
  const sidecarChecksumOf = (sidecar: any) =>
    createHash("sha256")
      .update(
        JSON.stringify({
          version: VIEW_SIDECAR_VERSION,
          fingerprint: sidecar.fingerprint,
          projection: sidecar.projection,
          views: sidecar.views,
        }),
      )
      .digest("hex");
  rejected((sidecar) => (sidecar.fingerprint = "other"), true);
  rejected((sidecar) => (sidecar.projection = "other"), true);
  rejected((sidecar) => (sidecar.views[0].from += 1), true);
  rejected((sidecar) => (sidecar.views[0].value = { forged: true })); // checksum no longer matches
  rejected((sidecar) => (sidecar.version = VIEW_SIDECAR_VERSION + 1), true);
  fs.writeFileSync(sidecarFile(), good);
  assert.equal(bigReads(() => reopenWith()).big, 0, "restored good sidecar again");
  const changedKey = bigReads(() => reopenWith("another-key"));
  assert.ok(changedKey.big > 0, "projection key change rejects the sidecar");

  // Append: the snapshot rewrite drops the stale sidecar, the next page re-persists.
  const appender = new HistoryIndex(cache, options);
  appender.read(log, undefined, 40, project);
  fs.appendFileSync(log, encode(turns(10, [3, 4])));
  appender.read(log, undefined, 40, project);
  assert.equal(sidecars().length, 0, "stale sidecar removed on snapshot rewrite");
  appender.flushViews();
  assert.equal(sidecars().length, 1, "re-persisted after append");
  const afterAppend = bigReads(() => new HistoryIndex(cache, options).read(log, undefined, 40, project));
  assert.equal(afterAppend.big, 0);
  assert.equal(
    JSON.stringify(afterAppend.result.items),
    JSON.stringify(new HistoryIndex().read(log, undefined, 40, project).items),
  );

  // Pending write after invalidate is a no-op; invalidate and forget delete sidecars.
  const pending = new HistoryIndex(cache, options);
  pending.invalidateViews();
  assert.equal(sidecars().length, 0, "invalidateViews deletes sidecars");
  pending.read(log, undefined, 40, project);
  pending.invalidateViews();
  pending.flushViews();
  assert.equal(sidecars().length, 0, "pending write cancelled by invalidate");
  write(pending);
  assert.equal(sidecars().length, 1);
  pending.forget(log);
  assert.equal(sidecars().length, 0, "forget deletes the sidecar");
}

try {
  const file = path.join(dir, "log.jsonl");
  const entries = turns(100, [91, 92, 93]);
  fs.writeFileSync(file, encode(entries));
  const index = new HistoryIndex();
  const cold = index.read(file, undefined, 40, project);
  assert.equal(index.viewStats().entries, 3, "only the large lines are cached");
  const warm = counted(() => index.read(file, undefined, 40, project));
  const reference = new HistoryIndex().read(file, undefined, 40, project);
  assert.deepEqual(warm.result.items, reference.items);
  assert.deepEqual(warm.result.items, cold.items);
  assert.ok(warm.result.bytes < cold.bytes, "warm read skips the cached lines");
  // Zero reads touch cached lines: only the small turn-start line is probed and read.
  const coldCached = counted(() => new HistoryIndex().read(file, 94, 3, project));
  const cachedOnly = counted(() => index.read(file, 94, 3, project));
  assert.ok(coldCached.calls > cachedOnly.calls);
  assert.equal(cachedOnly.calls, 2, "warm: only the small turn-start line 90 is read");
  assert.equal(cachedOnly.result.items.length, 4);
  assert.ok(cachedOnly.result.bytes < 1024, "the three large lines are not read");
  assert.deepEqual(cachedOnly.result.items, coldCached.result.items);

  // Without a projection nothing changes and nothing is cached.
  const plain = new HistoryIndex();
  assert.deepEqual(plain.read(file, undefined, 40).events, entries.slice(60));
  assert.equal(plain.viewStats().entries, 0);

  // Appends: warm instance equals a fresh one.
  fs.appendFileSync(file, encode(turns(10, [3, 4])));
  assert.deepEqual(
    index.read(file, undefined, 40, project).items,
    new HistoryIndex().read(file, undefined, 40, project).items,
  );
  assert.deepEqual(
    index.after(file, 95, 40, project)!.items,
    new HistoryIndex().after(file, 95, 40, project)!.items,
  );

  // Same-size rewrite (different content, restored mtime) drops the cache.
  const rewriteFile = path.join(dir, "rewrite.jsonl");
  const original = encode([{ type: "user_input", text: "a" }, toolLine("x".repeat(BIG))]);
  fs.writeFileSync(rewriteFile, original);
  const rewriting = new HistoryIndex();
  const before = rewriting.read(rewriteFile, undefined, 10, project).items;
  assert.equal(rewriting.viewStats().entries, 1);
  fs.writeFileSync(rewriteFile, original.replace(/x/g, "y"));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(rewriteFile, later, later);
  const after = rewriting.read(rewriteFile, undefined, 10, project).items;
  assert.notDeepEqual(after, before);
  assert.equal(after[1].value.message.content[0].content[0], "y");

  // Truncation and file replacement.
  fs.writeFileSync(rewriteFile, encode([{ type: "user_input", text: "short" }]));
  assert.equal(rewriting.read(rewriteFile, undefined, 10, project).items.length, 1);
  assert.equal(rewriting.viewStats().entries, 0, "shrinking drops the cache");
  rewriting.forget(rewriteFile);
  fs.writeFileSync(
    rewriteFile,
    encode([{ type: "user_input", text: "a" }, toolLine("z".repeat(BIG))]),
  );
  rewriting.read(rewriteFile, undefined, 10, project);
  assert.equal(rewriting.viewStats().entries, 1);
  const replacement = `${rewriteFile}.new`;
  fs.writeFileSync(
    replacement,
    encode([{ type: "user_input", text: "b" }, toolLine("w".repeat(BIG))]),
  );
  fs.renameSync(replacement, rewriteFile);
  assert.equal(
    rewriting.read(rewriteFile, undefined, 10, project).items[1].value.message.content[0]
      .content[0],
    "w",
  );
  assert.equal(rewriting.viewStats().entries, 1, "only the replacement's view remains");

  // forget and invalidateViews clear.
  rewriting.forget(rewriteFile);
  assert.equal(rewriting.viewStats().entries, 0);
  index.invalidateViews();
  assert.deepEqual(index.viewStats(), { entries: 0, bytes: 0 });

  // Budget evicts least recently used.
  const budget = new HistoryIndex(undefined, { viewBudgetBytes: BIG * 2 + 1000 });
  budget.read(file, undefined, 40, project);
  const stats = budget.viewStats();
  assert.ok(stats.bytes <= BIG * 2 + 1000 && stats.entries < 3, "budget bounds the cache");

  // Small lines are never cached.
  const small = new HistoryIndex();
  small.read(file, undefined, 100, { key: "identity", project: (_line, parsed) => parsed });
  assert.equal(small.viewStats().entries, 3 + 2, "the five large lines only");
  const tiny = path.join(dir, "tiny.jsonl");
  fs.writeFileSync(tiny, encode(turns(30, [])));
  const tinyIndex = new HistoryIndex();
  tinyIndex.read(tiny, undefined, 40, project);
  assert.equal(tinyIndex.viewStats().entries, 0);

  // Threads.page: warm output equals a fresh instance for every page kind.
  const logs = path.join(dir, "logs");
  fs.mkdirSync(logs, { recursive: true });
  const threadFile = path.join(logs, "fixture.jsonl");
  fs.writeFileSync(threadFile, encode(turns(300, [271, 272, 273, 290, 291])));
  const instance = () => {
    const threads = Object.create(Threads.prototype);
    threads.historyIndex = new HistoryIndex();
    threads.questions = { list: () => [] };
    threads.workState = () => ({ state: "idle" });
    return threads;
  };
  const wire = (page: any) => {
    const { server_ms: _serverMs, bytes: _bytes, ...rest } = page; // bytes is a read diagnostic
    return JSON.stringify(rest);
  };
  const warming = instance();
  for (const small of [false, true]) {
    const kinds: [number | undefined, number | undefined][] = [
      [undefined, undefined],
      [250, undefined],
      [undefined, 295],
      [undefined, 100],
    ];
    for (const [beforeLine, since] of kinds) {
      warming.page("fixture", beforeLine, since, small);
      const warmPage = wire(warming.page("fixture", beforeLine, since, small));
      assert.equal(warmPage, wire(instance().page("fixture", beforeLine, since, small)));
    }
  }
  assert.ok(warming.historyIndex.viewStats().entries > 0);
  warming.invalidateHistoryViews();
  assert.equal(warming.historyIndex.viewStats().entries, 0);

  sidecarTests();
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

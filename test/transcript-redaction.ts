import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionSearch } from "../server/session-search.ts";
import { Threads } from "../server/threads.ts";
import { derivedToolToken, gateToolCall } from "../server/tool-token.ts";
import { TranscriptRedaction } from "../server/transcript-redaction.ts";

const fixture = "fixture-sensitive-value";
const clean = {
  matches: 0,
  candidates: 0,
  filesScanned: 2,
  filesChanged: 0,
  databasesScanned: 1,
  status: "complete",
  errors: [],
};
const caller = { mode: "bypassPermissions" };
const root = fs.mkdtempSync(path.join(os.tmpdir(), "redaction-manager-"));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function finished(manager: TranscriptRedaction, identifier: string) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const result = manager.tool({ action: "status", job: identifier });
    if (!["queued", "running"].includes(result.status)) return result;
    await tick();
  }
  throw new Error("Cleanup job timed out.");
}
function owners() {
  return {
    threads: { redactionCatalog: () => [], applyRedactionCatalog: () => true },
    search: { beginMaintenance: async () => {}, endMaintenance: async () => {} },
  };
}
try {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let running = 0,
    maximum = 0,
    started = 0;
  const manager = new TranscriptRedaction({
    dataDir: root,
    ...owners(),
    runner: async (_request, progress) => {
      running++;
      maximum = Math.max(maximum, running);
      started++;
      progress({ matches: 3, raw: fixture });
      await blocked;
      running--;
      return { ...clean, unexpected: fixture };
    },
  });
  const first = manager.tool({ scope: "native" });
  const second = manager.tool({ action: "scan", scope: "native" });
  assert.equal(first.status, "queued");
  await tick();
  assert.equal(started, 1);
  assert.equal(manager.tool({ action: "status", job: first.job }).matches, 3);
  assert(!JSON.stringify(manager.tool({ action: "status", job: first.job })).includes(fixture));
  release();
  assert.equal((await finished(manager, first.job)).status, "complete");
  assert.equal((await finished(manager, second.job)).status, "complete");
  assert.equal(maximum, 1);
  for (const context of [
    undefined,
    { mode: "plan" },
    { mode: "acceptEdits" },
    { mode: "bypassPermissions", issueRun: {} },
  ])
    assert.throws(
      () => manager.tool({ action: "apply" }, context),
      /current manual thread in Bypass/,
    );
  assert.throws(() => manager.tool({ executable: fixture }), /Unknown cleanup option/);
  await manager.close();

  for (const failure of [
    async () => {
      throw new Error(fixture);
    },
    async () => ({ status: "complete", errors: [] }),
  ]) {
    let released = 0;
    const options = owners();
    options.search.endMaintenance = async () => {
      released++;
    };
    const broken = new TranscriptRedaction({ dataDir: root, ...options, runner: failure });
    const job = broken.tool({ action: "apply", scope: "console" }, caller);
    const result = await finished(broken, job.job);
    assert.equal(result.status, "failed");
    assert.equal(released, 1);
    assert(!JSON.stringify(result).includes(fixture));
    await broken.close();
  }

  for (const [action, scope] of [
    ["scan", "console"],
    ["verify", "console"],
    ["apply", "native"],
  ]) {
    let acquired = 0;
    const options = owners();
    options.search.beginMaintenance = async () => {
      acquired++;
    };
    const readonly = new TranscriptRedaction({
      dataDir: root,
      ...options,
      runner: async (request) =>
        request.catalog ? { threads: [], matches: 0, candidates: 0, changed: 0 } : clean,
    });
    const job = readonly.tool({ action, scope }, caller);
    const result = await finished(readonly, job.job);
    assert.equal(result.status, "complete");
    assert.equal(result.filesScanned, clean.filesScanned + (scope === "native" ? 0 : 1));
    assert.equal(result.filesChanged, clean.filesChanged);
    assert.equal(acquired, 0);
    await readonly.close();
  }

  let attempts = 0,
    rebuilt = 0;
  const options = owners();
  options.threads.redactionCatalog = () =>
    [{ id: "one", title: "before", recent: ["before"] }] as any;
  options.threads.applyRedactionCatalog = () => ++attempts > 1;
  options.search.endMaintenance = async () => {
    rebuilt++;
  };
  const racing = new TranscriptRedaction({
    dataDir: root,
    ...options,
    runner: async (request) =>
      request.catalog
        ? {
            threads: request.catalog.map((entry: any) => ({ ...entry, title: "clean" })),
            matches: 1,
            candidates: 0,
            changed: 1,
          }
        : clean,
  });
  const race = racing.tool({ action: "apply" }, caller);
  const raceResult = await finished(racing, race.job);
  assert.equal(raceResult.status, "complete");
  assert.equal(raceResult.filesScanned, clean.filesScanned + 1);
  assert.equal(raceResult.filesChanged, clean.filesChanged + 1);
  assert.equal(attempts, 2);
  assert.equal(rebuilt, 1);
  await racing.close();

  const owner: any = Object.create(Threads.prototype);
  owner.threads = new Map([
    ["one", { id: "one", title: "before", recent: ["before"], status: "running" }],
  ]);
  owner.persist = () => {};
  owner.emit = () => {};
  const snapshot = owner.redactionCatalog();
  owner.threads.get("one").title = "new message";
  assert.equal(owner.applyRedactionCatalog(snapshot, [{ id: "one", title: "clean" }]), false);
  assert.equal(owner.threads.get("one").title, "new message");
  const current = owner.redactionCatalog();
  assert.equal(
    owner.applyRedactionCatalog(current, [{ id: "one", title: "clean", recent: ["clean"] }]),
    true,
  );
  assert.equal(owner.threads.get("one").status, "running");

  fs.writeFileSync(path.join(root, "threads.json"), "[]");
  const search = new SessionSearch(root);
  const warm = search.warm();
  await search.beginMaintenance();
  await warm;
  await assert.rejects(search.search({ query: "hello" }), /maintenance/);
  await assert.rejects(search.warm(), /maintenance/);
  await search.endMaintenance(true);
  assert.deepEqual((await search.search({ query: "hello" })).results, []);
  await search.beginMaintenance();
  fs.writeFileSync(path.join(root, "threads.json"), "malformed");
  await assert.rejects(search.endMaintenance(true));
  fs.writeFileSync(path.join(root, "threads.json"), "[]");
  await search.warm();
  search.close();

  const refreshDir = path.join(root, "pending-refresh");
  fs.mkdirSync(path.join(refreshDir, "logs"), { recursive: true });
  fs.writeFileSync(
    path.join(refreshDir, "threads.json"),
    JSON.stringify([{ id: "cached-one", title: "cached", provider: "test" }]),
  );
  fs.writeFileSync(
    path.join(refreshDir, "logs", "cached-one.jsonl"),
    `${JSON.stringify({ type: "user_input", text: "cached query" })}\n`,
  );
  let releaseRefresh!: () => void;
  let refreshStarted!: () => void;
  let gateRefresh = false;
  const refreshGate = new Promise<void>((resolve) => (releaseRefresh = resolve));
  const refreshReady = new Promise<void>((resolve) => (refreshStarted = resolve));
  const delayed = new SessionSearch(refreshDir, {
    beforeRefresh: async () => {
      if (!gateRefresh) return;
      refreshStarted();
      await refreshGate;
    },
  });
  await delayed.warm();
  gateRefresh = true;
  const staleRead = delayed.search({ query: "cached" });
  await refreshReady;
  let acquired = false;
  const acquisition = delayed.beginMaintenance();
  acquisition.then(() => (acquired = true));
  await assert.rejects(delayed.search({ query: "cached" }), /maintenance/);
  assert.equal(acquired, false, "maintenance waits for the pending refresh");
  releaseRefresh();
  await assert.rejects(staleRead, /maintenance/);
  await acquisition;
  await delayed.endMaintenance(false);
  delayed.close();

  const migrationDir = path.join(root, "paused-migration");
  fs.mkdirSync(path.join(migrationDir, "logs"), { recursive: true });
  fs.writeFileSync(path.join(migrationDir, "threads.json"), "[]");
  const migrationDb = new DatabaseSync(path.join(migrationDir, "session-search.sqlite"));
  migrationDb.exec("PRAGMA user_version=1;");
  migrationDb.close();
  const migration = new SessionSearch(migrationDir, { cleanupBatchLimit: 0 });
  const cleaned = migration.whenCleaned();
  await migration.beginMaintenance();
  const originalError = console.error;
  let logged = false;
  console.error = () => {
    logged = true;
  };
  try {
    assert.throws(() => (migration as any).start(), /maintenance/);
    (migration as any).cleanupStep();
    assert.equal((migration as any).echoPending, true);
    assert.equal((migration as any).cleanupTimer, undefined);
    assert.equal(logged, false);
    await migration.endMaintenance(true);
  } finally {
    console.error = originalError;
  }
  await cleaned;
  const migrationCheck = new DatabaseSync(path.join(migrationDir, "session-search.sqlite"));
  assert.equal(Number(migrationCheck.prepare("PRAGMA user_version").get()!.user_version), 2);
  assert.equal(
    Number(
      migrationCheck.prepare("SELECT count(*) AS n FROM meta WHERE key LIKE 'echo_%'").get()!.n,
    ),
    0,
  );
  migrationCheck.close();
  migration.close();

  const resumeDir = path.join(root, "resume-migration");
  fs.mkdirSync(path.join(resumeDir, "logs"), { recursive: true });
  fs.writeFileSync(path.join(resumeDir, "threads.json"), "[]");
  const resumeDb = new DatabaseSync(path.join(resumeDir, "session-search.sqlite"));
  resumeDb.exec("PRAGMA user_version=1;");
  resumeDb.close();
  const resumed = new SessionSearch(resumeDir, { cleanupBatchLimit: 0 });
  await resumed.beginMaintenance();
  (resumed as any).hooks.cleanupBatchLimit = undefined;
  await resumed.endMaintenance(false);
  await resumed.whenCleaned();
  assert.equal(Number((resumed as any).db.prepare("PRAGMA user_version").get()!.user_version), 2);
  assert.equal((resumed as any).cleanupTimer, undefined);
  resumed.close();

  const closeDir = path.join(root, "close-migration");
  fs.mkdirSync(path.join(closeDir, "logs"), { recursive: true });
  fs.writeFileSync(path.join(closeDir, "threads.json"), "[]");
  const closeDb = new DatabaseSync(path.join(closeDir, "session-search.sqlite"));
  closeDb.exec("PRAGMA user_version=1;");
  closeDb.close();
  const closed = new SessionSearch(closeDir, { cleanupBatchLimit: 0 });
  await closed.beginMaintenance();
  closed.close();
  await closed.endMaintenance(false);
  assert.equal((closed as any).cleanupTimer, undefined);

  for (const checkpoint of ["first", "second"]) {
    const directory = path.join(root, checkpoint);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "threads.json"), "[]");
    const search = new SessionSearch(directory);
    await search.warm();
    (search as any).db.exec("PRAGMA busy_timeout=0;");
    const reader = new DatabaseSync(path.join(directory, "session-search.sqlite"));
    const holdReader = () => reader.exec("BEGIN; SELECT * FROM sessions;");
    if (checkpoint === "first") holdReader();
    else {
      const original = (search as any).refresh.bind(search);
      (search as any).refresh = async () => {
        await original();
        (search as any).db.exec(
          "INSERT INTO sessions(thread,title,provider) VALUES('held','held','test')",
        );
        holdReader();
      };
    }
    const options = owners();
    const busy = new TranscriptRedaction({
      dataDir: directory,
      ...options,
      search,
      runner: async (request) =>
        request.catalog ? { threads: [], matches: 0, candidates: 0, changed: 0 } : clean,
    });
    try {
      const job = busy.tool({ action: "apply", scope: "console" }, caller);
      const result = await finished(busy, job.job);
      assert.equal(result.status, "failed", checkpoint);
      assert.equal(result.errors[0].code, "index_rebuild_failed", checkpoint);
      reader.exec("ROLLBACK");
      if (checkpoint === "second") delete (search as any).refresh;
      await search.warm();
    } finally {
      await busy.close();
      reader.close();
      search.close();
    }
  }

  const token = derivedToolToken("test-master", "auto");
  assert.equal(
    gateToolCall("test-master", token, "auto", "session_redact", () => false).status,
    400,
  );
  assert.equal(
    gateToolCall("test-master", "test-master", "auto", "session_redact", () => true).status,
    400,
  );
  console.log(
    "transcript-redaction: async jobs, serialization, sanitized failures, owner races, maintenance, and unattended gates pass",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ModelRateLimit, MODEL_REQUEST_INTERVAL_MS } from "../server/providers/model-rate-limit.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-model-rate-limit-"));
const database = path.join(dir, "gate.sqlite");
const gate = new ModelRateLimit({ path: database, intervalMs: 80 });
const peer = new ModelRateLimit({ path: database, intervalMs: 80 });
try {
  assert.equal(MODEL_REQUEST_INTERVAL_MS, 1100);
  assert.throws(() => new ModelRateLimit({ path: database, intervalMs: 0 }), /positive integer/);
  assert.equal(fs.statSync(database).mode & 0o777, 0o600);
  const { DatabaseSync } = await import("node:sqlite");
  const inspect = new DatabaseSync(database);
  inspect.exec(`CREATE TABLE observed_admissions (started INTEGER);
    CREATE TRIGGER observe_admission AFTER UPDATE OF next_at ON admission
    WHEN NEW.next_at > OLD.next_at
    BEGIN INSERT INTO observed_admissions VALUES (NEW.next_at - 80); END;`);

  // Each child owns an independent SQLite connection and Node event loop.
  const moduleUrl = pathToFileURL(path.resolve("server/providers/model-rate-limit.ts")).href;
  const childSource = `
    const { ModelRateLimit } = await import(${JSON.stringify(moduleUrl)});
    const gate = new ModelRateLimit({ path: process.argv[1], intervalMs: 80 });
    for (let i = 0; i < 3; i++) {
      await gate.acquire();
      console.log(Date.now());
    }
    gate.close();
  `;
  const child = () => new Promise<number[]>((resolve, reject) => {
    const processChild = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", childSource, database]);
    let output = "", errors = "";
    processChild.stdout.on("data", chunk => output += chunk);
    processChild.stderr.on("data", chunk => errors += chunk);
    processChild.on("error", reject);
    processChild.on("exit", code => code === 0
      ? resolve(output.trim().split("\n").map(Number))
      : reject(new Error(`Rate gate child exited ${code}: ${errors}`)));
  });
  const starts = (await Promise.all([child(), child(), child()])).flat().sort((a, b) => a - b);
  assert.equal(starts.length, 9);
  // Capture admission clocks atomically inside SQLite. A child can be paused
  // after admission, so timestamps printed after commit are not exact clocks.
  const admissions = inspect.prepare("SELECT started FROM observed_admissions ORDER BY started").all() as { started: number }[];
  assert.equal(admissions.length, 9);
  for (let index = 1; index < admissions.length; index++) {
    const spacing = admissions[index].started - admissions[index - 1].started;
    assert.ok(spacing >= 80, `Cross-process spacing ${spacing}ms`);
  }

  // An aborted waiter must leave the exact previously stored deadline untouched.
  await gate.acquire();
  const before = inspect.prepare("SELECT next_at FROM admission WHERE id = 1").get();
  const aborted = new AbortController();
  const pending = peer.acquire(aborted.signal);
  aborted.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(inspect.prepare("SELECT next_at FROM admission WHERE id = 1").get(), before);
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(peer.acquire(alreadyAborted.signal), { name: "AbortError" });
  assert.deepEqual(inspect.prepare("SELECT next_at FROM admission WHERE id = 1").get(), before);

  // The second connection sees another process's reported provider cooldown.
  const cooldown = gate.report429("0.24");
  await peer.acquire();
  assert.ok(Date.now() >= cooldown);
  const defaultCooldown = gate.report429("invalid");
  assert.ok(defaultCooldown >= Date.now() + 29_900);
  assert.ok(gate.report429("0") >= defaultCooldown, "a later response cannot shorten an active cooldown");
  const capped = gate.report429("999999999");
  assert.ok(capped <= Date.now() + 900_000);
  inspect.close();

  // HTTP-date Retry-After and response plumbing use a separate clock/database.
  const http = new ModelRateLimit({ path: path.join(dir, "http.sqlite"), intervalMs: 1 });
  try {
    const date = new Date(Date.now() + 10_000).toUTCString();
    assert.equal(http.report429(date), Date.parse(date));
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response("slow down", { status: 429, headers: { "retry-after": "0.01" } });
    // Clear only this test database's clock; the production API never clears it.
    const scratch = new DatabaseSync(path.join(dir, "http.sqlite"));
    scratch.exec("UPDATE admission SET cooldown_until = 0");
    try {
      const beforeFetch = Date.now();
      assert.equal((await http.fetch("https://example.invalid")).status, 429);
      const row = scratch.prepare("SELECT cooldown_until FROM admission WHERE id = 1").get() as { cooldown_until: number };
      assert.ok(row.cooldown_until >= beforeFetch + 10);
    } finally { globalThis.fetch = original; scratch.close(); }
  } finally { http.close(); }
  console.log("model-rate-limit: cross-process spacing, aborts, shared cooldown, and Retry-After passed");
} finally {
  gate.close();
  peer.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

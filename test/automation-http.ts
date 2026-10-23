import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The dashboard's entrypoint over HTTP: auth gate, snapshot shape, paged step log, versioned contract, redaction on disk.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-console-automation-http-"));
const data = path.join(directory, "data");
fs.mkdirSync(data, { recursive: true });
const now = Date.now();
const seed = [
  { seq: 1, ts: now - 5000, step: "review", kind: "ok", run: "a", msg: "approved", ref: "o/r#1" },
  { seq: 2, ts: now - 4000, step: "worktree", kind: "fail", msg: "no checkout", ref: "o/r#2" },
  { seq: 3, ts: now - 3000, step: "dispatcher", kind: "start", run: "b", ref: "o/r#3" }, // left open by a "previous process"
];
fs.writeFileSync(
  path.join(data, "automation-events.jsonl"),
  seed.map((e) => JSON.stringify(e)).join("\n") + "\n",
);
fs.writeFileSync(
  path.join(data, "window-dispatch.json"),
  JSON.stringify({ enabled: true, dryRun: true }),
);
// a local agent-console checkout for the Debug button to branch from
const g = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...a], {
    stdio: "ignore",
  });
const repos = path.join(directory, "repos"),
  worktrees = path.join(directory, "wt"),
  originRepo = path.join(directory, "origin.git"),
  local = path.join(repos, "agent-console");
fs.mkdirSync(originRepo);
g(originRepo, "init", "-q", "--bare", "-b", "main");
fs.mkdirSync(repos);
execFileSync("git", ["clone", "-q", originRepo, local], { stdio: "ignore" });
fs.writeFileSync(path.join(local, "a"), "1");
g(local, "add", "a");
g(local, "commit", "-qm", "init");
g(local, "push", "-q", "origin", "HEAD:main");
g(local, "remote", "set-head", "origin", "main");
const listener = net.createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = (listener.address() as net.AddressInfo).port;
await new Promise<void>((resolve, reject) =>
  listener.close((error) => (error ? reject(error) : resolve())),
);
const origin = `http://127.0.0.1:${port}`;
const password = randomBytes(24).toString("base64url");
const child = spawn(process.execPath, [process.env.TEST_SERVER_ENTRY || "server/index.ts"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    AGENT_CONSOLE_DATA: data,
    AGENT_CONSOLE_RUN: path.join(directory, "run"),
    AGENT_CONSOLE_MOCK: "1",
    AGENT_CONSOLE_REPOS: repos,
    AGENT_CONSOLE_WORKTREES: worktrees,
    AGENT_CONSOLE_AUTH: "password",
    AGENT_CONSOLE_PASSWORD: password,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stderr.resume();
try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Scratch server startup timed out.")), 20_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Scratch server exited: ${code}`));
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output = (output + chunk.toString()).slice(-2048);
      if (output.includes("agent-console listening on")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  assert.equal((await fetch(origin + "/api/automation")).status, 401);
  assert.equal((await fetch(origin + "/api/automation/job?repo=o/r&number=2")).status, 401);
  assert.equal((await fetch(origin + "/api/automation/log?step=review")).status, 401);
  const login = await fetch(origin + "/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const headers = { Cookie: login.headers.get("set-cookie")!.split(";")[0] };
  const get = (p: string) => fetch(origin + p, { headers });

  const jobResponse = await get("/api/automation/job?v=1&repo=O/R&number=2");
  assert.equal(jobResponse.status, 200);
  assert.equal(jobResponse.headers.get("cache-control"), "no-store");
  const job = await jobResponse.json();
  assert.equal(job.v, 1);
  assert.equal(job.repo, "o/r");
  assert.equal(job.state, "blocked");
  assert.equal(job.summary, "no checkout");
  assert.equal(job.events.length, 1);
  assert.equal(job.workflow.find((s: any) => s.id === "worktree").state, "failed");
  assert.equal((await get("/api/automation/job?v=2&repo=o/r&number=2")).status, 400);
  assert.equal((await get("/api/automation/job?repo=../r&number=2")).status, 400);
  assert.equal((await get("/api/automation/job?repo=o/r&number=999")).status, 400);

  const res = await get("/api/automation");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const snap = await res.json();
  assert.equal(snap.v, 1);
  assert.equal(snap.flow.nodes.length, snap.steps.length);
  const step = (id: string) => snap.steps.find((s: any) => s.id === id);
  assert.equal(step("review").state, "ok");
  assert.equal(step("worktree").state, "failed");
  assert.equal(
    step("dispatcher").state,
    "abandoned",
    "a run left open by a previous process is closed at start-up",
  );
  assert.equal(snap.failures[0].msg, "no checkout");
  assert.ok(snap.triggers.some((t: any) => t.kind === "webhook"));
  assert.equal(typeof snap.config.dispatch.enabled, "boolean");

  const log = await (await get("/api/automation/log?step=review&limit=1")).json();
  assert.equal(log.entries[0].msg, "approved");
  assert.equal((await get("/api/automation/log?step=nope")).status, 400);
  assert.equal((await get("/api/automation?v=2")).status, 400);
  // toggles: same-origin only, validated, persisted to window-dispatch.json
  const postToggle = (body: object, origin_ = origin) =>
    fetch(origin + "/api/automation/toggle", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", Origin: origin_ },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await postToggle({ target: "opener", enabled: true }, "https://example.invalid")).status,
    403,
  );
  assert.equal((await postToggle({ target: "nope", enabled: true })).status, 400);
  const on = await postToggle({ target: "opener", enabled: true });
  assert.equal(on.status, 200);
  assert.equal((await on.json()).config.opener.enabled, true);
  const off = await postToggle({ target: "dispatcher", enabled: false });
  assert.equal((await off.json()).config.dispatch.enabled, false);
  // the Debug button: same-origin only, validated, one worktree and thread
  const postDebug = (body: object, origin_ = origin) =>
    fetch(origin + "/api/automation/debug", {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        ...(origin_ ? { Origin: origin_ } : {}),
      },
      body: JSON.stringify(body),
    });
  assert.equal(
    (
      await fetch(origin + "/api/automation/debug", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).status,
    401,
  );
  assert.equal(
    (await postDebug({ v: 1 }, "https://example.invalid")).status,
    403,
    "cross-origin refused",
  );
  assert.equal((await postDebug({ v: 1, focus: "nope" })).status, 400);
  const dbg = await postDebug({ v: 1, focus: "worktree", note: "why" });
  assert.equal(dbg.status, 200);
  const made = await dbg.json();
  assert.equal(typeof made.thread, "string");
  assert.ok(fs.existsSync(path.join(made.cwd, "a")), "a worktree of the checkout");
  assert.match(made.branch, /^debug\/automation-/);
  const onDisk = fs.readFileSync(path.join(data, "automation-events.jsonl"), "utf8");
  assert.match(onDisk, /"kind":"abandoned"[^\n]*"run":"b"|"run":"b"[^\n]*"kind":"abandoned"/);
} finally {
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((r) => setTimeout(r, 3000))]);
  fs.rmSync(directory, { recursive: true, force: true });
}
console.log(
  "PASS automation HTTP: auth gate, snapshot, restart recovery of open runs, paged step log, version check",
);

// Checkpoint fork: log cut at the checkpoint line, source untouched, Claude --resume-session-at args, 404 and 401.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { claudeStartArgs } from "../server/providers/claude.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ac-ckhttp-")));
const repo = path.join(directory, "repo");
fs.mkdirSync(repo);
const listener = net.createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = (listener.address() as net.AddressInfo).port;
await new Promise<void>((resolve) => listener.close(() => resolve()));
const origin = `http://127.0.0.1:${port}`;
const password = randomBytes(24).toString("base64url");
const child = spawn(process.execPath, ["server/index.ts"], {
  cwd: root,
  env: {
    ...process.env,
    HOME: directory,
    PORT: String(port),
    AGENT_CONSOLE_DATA: path.join(directory, "data"),
    AGENT_CONSOLE_RUN: path.join(directory, "run"),
    AGENT_CONSOLE_ENV_FILES: path.join(directory, "no-env"),
    AGENT_CONSOLE_BRAIN: path.join(directory, "no-brain"),
    AGENT_CONSOLE_MOCK: "1",
    AGENT_CONSOLE_LABELS: "0",
    AGENT_CONSOLE_AUTH: "password",
    AGENT_CONSOLE_PASSWORD: password,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stderr.resume();
const inbox: any[] = [];
let socket: WebSocket | undefined;

const settle = async (predicate: () => boolean | Promise<boolean>, label: string) => {
  for (let tick = 0; tick < 200; tick++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`timed out: ${label}`);
};

try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Scratch server startup timed out.")), 20_000);
    child.once("exit", (code) => reject(new Error(`Scratch server exited: ${code}`)));
    let output = "";
    child.stdout.on("data", (chunk) => {
      output = (output + chunk.toString()).slice(-2048);
      if (output.includes("agent-console listening on")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  const login = await fetch(`${origin}/login`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const headers = { Cookie: cookie, "Content-Type": "application/json", Origin: origin };
  const api = (route: string, init: RequestInit = {}) =>
    fetch(origin + route, { ...init, headers: { ...headers, ...init.headers } });
  const post = (route: string, body: unknown) =>
    api(route, { method: "POST", body: JSON.stringify(body) });

  socket = new WebSocket(`${origin.replace("http", "ws")}/ws`, { headers: { origin, cookie } });
  socket.on("message", (data) => inbox.push(JSON.parse(String(data))));
  await settle(() => inbox.some((message) => message.t === "hello"), "ws hello");
  const status = new Map<string, string>();
  const created = new Map<string, string>();
  const track = () => {
    for (const message of inbox) {
      if (message.t === "thread") status.set(message.thread.id, message.thread.status);
      if (message.t === "created") created.set(message.thread.title, message.thread.id);
    }
  };
  const open = async (title: string) => {
    socket!.send(
      JSON.stringify({
        t: "create",
        provider: "mock",
        cwd: repo,
        mode: "bypassPermissions",
        title,
      }),
    );
    await settle(() => (track(), created.has(title)), `created ${title}`);
    return created.get(title)!;
  };
  const prompt = async (threadId: string, text: string) => {
    socket!.send(JSON.stringify({ t: "send", thread: threadId, text }));
    await settle(() => (track(), status.get(threadId) === "running"), "running");
  };
  const idle = (threadId: string) =>
    settle(() => (track(), status.get(threadId) === "idle"), "idle");

  const alpha = await open("A");
  const base = `/api/threads/${alpha}/checkpoints`;
  fs.writeFileSync(path.join(repo, "a.txt"), "v1\n");
  await prompt(alpha, "one");
  await idle(alpha);
  await settle(async () => ((await (await api(base)).json()) as any[]).length >= 1, "checkpoint 1");
  fs.writeFileSync(path.join(repo, "a.txt"), "v2\n");
  await prompt(alpha, "two");
  await idle(alpha);
  await settle(async () => ((await (await api(base)).json()) as any[]).length >= 2, "checkpoint 2");

  const logOf = (id: string) => path.join(directory, "data", "logs", `${id}.jsonl`);
  const sourceBefore = fs.readFileSync(logOf(alpha), "utf8");
  const isCheckpoint = (line: string, seq: number) => {
    const event = JSON.parse(line);
    return event.type === "checkpoint" && event.seq === seq;
  };
  const sourceLines = sourceBefore.split("\n").filter(Boolean);
  const cutAt = sourceLines.findIndex((line) => isCheckpoint(line, 1));
  assert.ok(cutAt >= 0 && cutAt < sourceLines.length - 1, "checkpoint 1 is mid-log");

  const forked = await post(`${base}/1/fork`, {});
  assert.equal(forked.status, 200);
  const forkId = ((await forked.json()) as { id: string }).id;
  assert.ok(forkId && forkId !== alpha);
  const forkLines = fs.readFileSync(logOf(forkId), "utf8").split("\n").filter(Boolean);
  assert.deepEqual(forkLines, sourceLines.slice(0, cutAt + 1));
  assert.ok(isCheckpoint(forkLines[forkLines.length - 1], 1), "fork ends at the checkpoint line");
  assert.equal(fs.readFileSync(logOf(alpha), "utf8"), sourceBefore, "source log unchanged");

  assert.equal((await post(`${base}/99/fork`, {})).status, 404);
  assert.equal((await post(`${base}/0/fork`, {})).status, 404);
  assert.equal(
    (
      await fetch(`${origin + base}/1/fork`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    401,
  );

  const spec = { id: "t1", cwd: "/tmp", mode: "bypassPermissions", model: "opus" } as any;
  const withAt = claudeStartArgs({ ...spec, forkFrom: "sid-1", forkAt: "uuid-9" });
  const flagIndex = withAt.indexOf("--resume-session-at");
  assert.ok(flagIndex > 0 && withAt[flagIndex + 1] === "uuid-9" && withAt.includes("--fork-session"));
  assert.equal(withAt[withAt.indexOf("--resume") + 1], "sid-1");
  const plain = claudeStartArgs({ ...spec, forkFrom: "sid-1" });
  assert.ok(plain.includes("--fork-session") && !plain.includes("--resume-session-at"));
  const fresh = claudeStartArgs(spec);
  assert.ok(!fresh.includes("--fork-session") && !fresh.includes("--resume-session-at"));
  console.log("PASS checkpoint fork: cut log, source intact, claude args, 404, 401");
} finally {
  socket?.terminate();
  const exited = once(child, "exit");
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await exited;
  }
  fs.rmSync(directory, { recursive: true, force: true });
}

// Time-travel HTTP routes: list, diff, file, dry-run, rewind, undo, busy and stale refusals, one-shot note.
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
const read = (name: string) => fs.readFileSync(path.join(repo, name), "utf8");

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
  // snapshots finish in the background: the next edit waits for the previous one to be recorded
  const checkpointCount = (count: number) =>
    settle(async () => ((await (await api(base)).json()) as any[]).length >= count, "checkpoints");
  fs.writeFileSync(path.join(repo, "a.txt"), "v1\n");
  await prompt(alpha, "one");
  await idle(alpha);
  await checkpointCount(1);
  fs.writeFileSync(path.join(repo, "a.txt"), "v2\n");
  fs.writeFileSync(path.join(repo, "b.txt"), "bee\n");
  await prompt(alpha, "two");
  await idle(alpha);

  // unauthenticated requests are rejected
  assert.equal((await fetch(origin + base)).status, 401);
  assert.equal(
    (
      await fetch(`${origin + base}/1/rewind`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    401,
  );

  // list returns the checkpoint events
  let listed: any[] = [];
  await settle(
    async () => ((listed = await (await api(base)).json()), listed.length >= 2),
    "two checkpoints",
  );
  const events = inbox.filter(
    (message) =>
      message.t === "event" && message.event?.type === "checkpoint" && message.thread === alpha,
  );
  assert.deepEqual(
    listed.map((item) => item.commit),
    events.map((message) => message.event.commit),
  );
  assert.equal(listed[0].seq, 1);

  // diff returns name-status plus unified text
  const diff = await (await api(`${base}/2/diff?base=prev`)).json();
  assert.deepEqual(diff.files.map((entry: any) => `${entry.s}:${entry.p}`).sort(), [
    "A:b.txt",
    "M:a.txt",
  ]);
  assert.match(diff.patch, /\+v2/);
  const fromFirst = await (await api(`${base}/2/diff?base=0&path=a.txt`)).json();
  assert.deepEqual(
    fromFirst.files.map((entry: any) => entry.p),
    ["a.txt"],
  );
  assert.equal((await api(`${base}/2/diff?base=nope`)).status, 400);
  assert.equal(await (await api(`${base}/1/file?path=a.txt`)).text(), "v1\n");
  assert.equal((await api(`${base}/1/file?path=b.txt`)).status, 404);
  assert.equal((await api(`${base}/1/file?path=.env`)).status, 403);

  // dry run leaves files unchanged and reports outside edits
  fs.writeFileSync(path.join(repo, "a.txt"), "v3\n");
  const dry = await (await post(`${base}/1/rewind`, { dryRun: true })).json();
  assert.deepEqual(dry.files.map((entry: any) => `${entry.s}:${entry.p}`).sort(), [
    "D:b.txt",
    "M:a.txt",
  ]);
  assert.deepEqual(dry.outside, ["a.txt"]);
  assert.equal(read("a.txt"), "v3\n");
  assert.ok(fs.existsSync(path.join(repo, "b.txt")));

  // stale
  const stale = await post(`${base}/1/rewind`, { expectCommit: "0".repeat(40) });
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { error: "stale" });
  assert.equal(read("a.txt"), "v3\n");

  // rewind restores the file; undo brings the edit back
  const latest = listed[listed.length - 1].commit;
  const done = await post(`${base}/1/rewind`, { expectCommit: latest });
  assert.equal(done.status, 200);
  const { preRewindSeq } = await done.json();
  assert.ok(preRewindSeq > 1);
  assert.equal(read("a.txt"), "v1\n");
  assert.equal(fs.existsSync(path.join(repo, "b.txt")), false);
  await settle(
    () =>
      inbox.some(
        (message) =>
          message.t === "rewound" &&
          message.thread === alpha &&
          message.seq === 1 &&
          message.preRewindSeq === preRewindSeq,
      ),
    "rewound ws message",
  );
  assert.ok(
    inbox.some(
      (message) =>
        message.t === "event" &&
        message.event?.type === "rewound" &&
        message.event.preRewindSeq === preRewindSeq,
    ),
  );
  assert.equal((await post(`${base}/${preRewindSeq}/rewind`, {})).status, 200);
  assert.equal(read("a.txt"), "v3\n");
  assert.equal(read("b.txt"), "bee\n");

  // the next prompt carries the note exactly once
  const note = `[Files rewound to checkpoint ${preRewindSeq}; re-read files before editing.]`;
  const mark = inbox.length;
  await prompt(alpha, "echo");
  await idle(alpha);
  const since = (from: number) =>
    JSON.stringify(inbox.slice(from).filter((message) => message.t === "event"));
  assert.ok(since(mark).includes(note), "first prompt carries the note");
  const mark2 = inbox.length;
  await prompt(alpha, "echo again");
  await idle(alpha);
  assert.ok(!since(mark2).includes("Files rewound"), "note is one-shot");

  // busy while a same-folder thread runs
  const other = await open("B");
  await prompt(other, "slow");
  const busy = await post(`${base}/1/rewind`, {});
  assert.equal(busy.status, 409);
  assert.deepEqual(await busy.json(), { error: "busy", threads: [other] });
  assert.equal(read("a.txt"), "v3\n");
  console.log(
    "PASS checkpoint HTTP routes: list, diff, file, dry run, rewind, undo, busy, stale, note, auth",
  );
} finally {
  socket?.terminate();
  const exited = once(child, "exit");
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await exited;
  }
  fs.rmSync(directory, { recursive: true, force: true });
}

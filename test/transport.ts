// Isolated transport regression: no model calls or live thread mutations.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-transport-"));
const base = "http://127.0.0.1:17778",
  a = "11111111-1111-4111-8111-111111111111",
  b = "22222222-2222-4222-8222-222222222222";
const threads = [a, b].map((id, i) => ({
  id,
  title: `Transport ${i}`,
  provider: "mock",
  model: "echo",
  mode: "plan",
  cwd: process.cwd(),
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  cost: 0,
}));
fs.writeFileSync(path.join(data, "threads.json"), JSON.stringify(threads));
fs.mkdirSync(path.join(data, "logs"));
const history = [
  { type: "user_input", text: "Transport fixture" },
  ...Array.from({ length: 80 }, (_, i) => ({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: `Step ${i}: ` + "Repeatable history and tool output. ".repeat(45) },
      ],
    },
  })),
];
fs.writeFileSync(
  path.join(data, "logs", a + ".jsonl"),
  history.map((e) => JSON.stringify(e) + "\n").join(""),
);
process.env.AGENT_CONSOLE_DATA = data;
const { makeToken } = await import("../server/auth.ts");
const server = spawn(process.execPath, ["server/index.ts"], {
  env: {
    ...process.env,
    PORT: "17778",
    AGENT_CONSOLE_MOCK: "1",
    AGENT_CONSOLE_BRAIN: path.join(data, "no-brain"),
  },
  stdio: "ignore",
});
const clients: WebSocket[] = [];
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function connect(compress: boolean) {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws", {
    perMessageDeflate: compress,
    headers: { origin: base, cookie: `__Host-ac_session=${makeToken()}` },
  });
  clients.push(ws);
  const messages: any[] = [];
  ws.on("message", (raw) => messages.push(JSON.parse(String(raw))));
  const wait = async (pred: (m: any) => boolean) => {
    for (let i = 0; i < 250; i++) {
      const at = messages.findIndex(pred);
      if (at >= 0) return messages.splice(at, 1)[0];
      await pause(20);
    }
    throw Error("Transport reply timed out");
  };
  const hello = await wait((m) => m.t === "hello");
  return {
    ws,
    messages,
    wait,
    hello,
    send: (m: any) => ws.send(JSON.stringify(m)),
    read: () => Number((ws as any)._socket.bytesRead),
  };
}
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base)).status < 500) break;
    } catch {}
    await pause(100);
  }
  const plain = await connect(false),
    compressed = await connect(true);
  assert.equal(plain.ws.extensions, "");
  assert.match(compressed.ws.extensions, /permessage-deflate/);
  assert.equal(compressed.hello.features.selectiveEvents, true);
  const sample = async (c: typeof plain) => {
    const at = c.read();
    c.send({ t: "open", thread: a, request: 1, foregroundOnly: true });
    const page = await c.wait((m) => m.t === "history" && m.request === 1);
    return { page, bytes: c.read() - at };
  };
  const raw = await sample(plain),
    zipped = await sample(compressed);
  assert.deepEqual(zipped.page.events, raw.page.events);
  assert.ok(
    zipped.bytes < raw.bytes * 0.55,
    JSON.stringify({ raw: raw.bytes, zipped: zipped.bytes }),
  );
  console.log(
    `PASS compressed history: ${raw.bytes} → ${zipped.bytes} socket bytes, same ${raw.page.events.length} events; uncompressed clients supported`,
  );
  const observer = await connect(false);
  observer.send({ t: "send", thread: b, text: "Background private transport marker" });
  await observer.wait((m) => m.t === "event" && m.thread === b && m.event.type === "result");
  await pause(50);
  assert.ok(compressed.messages.some((m) => m.t === "invalidate" && m.thread === b));
  assert.ok(!compressed.messages.some((m) => m.t === "event" && m.thread === b));
  assert.ok(!JSON.stringify(compressed.messages).includes("Background private transport marker"));
  // Cached switches subscribe without requesting history again.
  compressed.messages.length = 0;
  compressed.send({ t: "subscribe", thread: b });
  compressed.send({ t: "send", thread: b, text: "Foreground marker" });
  await compressed.wait((m) => m.t === "event" && m.thread === b && m.event.type === "result");
  assert.ok(
    compressed.messages.some(
      (m) => m.t === "event" && JSON.stringify(m).includes("Foreground marker"),
    ),
  );
  assert.ok(!compressed.messages.some((m) => m.t === "history"));
  observer.send({ t: "send", thread: a, text: "Other background marker" });
  await observer.wait((m) => m.t === "event" && m.thread === a && m.event.type === "result");
  await pause(50);
  assert.ok(compressed.messages.some((m) => m.t === "invalidate" && m.thread === a));
  assert.ok(!compressed.messages.some((m) => m.t === "event" && m.thread === a));
  console.log(
    "PASS selective stream: background content omitted, cache invalidation retained, cached switches resubscribe, legacy observers retain full events",
  );
} finally {
  for (const ws of clients) ws.terminate();
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise<void>((r) => server.once("exit", () => r()));
  }
  fs.rmSync(data, { recursive: true, force: true });
}

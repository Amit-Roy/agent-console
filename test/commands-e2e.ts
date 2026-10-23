import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { makeToken } from "../server/auth.ts";
const base = process.env.BASE || "http://127.0.0.1:7071";
const inbox: any[] = [];
const ws = new WebSocket(base.replace("http", "ws") + "/ws", {
  headers: { origin: base, cookie: `ac_session=${makeToken()}` },
});
ws.on("message", (d) => inbox.push(JSON.parse(String(d))));
async function wait(pred: (m: any) => boolean, timeout = 6000) {
  const at = Date.now();
  while (Date.now() - at < timeout) {
    const m = inbox.find(pred);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error("Timed out waiting for command reply");
}
const send = (m: any) => ws.send(JSON.stringify(m));
const hello = await wait((m) => m.t === "hello");
assert.ok(hello.commands.codex.some((c: any) => c.name === "compact"));
assert.ok(hello.commands.mock.some((c: any) => c.name === "compact"));
let id: string | undefined;
try {
  send({ t: "create", provider: "mock", cwd: hello.dirs[0], title: "Command integration fixture" });
  id = (await wait((m) => m.t === "created")).thread.id;
  const post = (text: string) => send({ t: "send", thread: id, text });
  const event = (type: string) => (m: any) =>
    m.t === "event" && m.thread === id && m.event.type === type;
  post("/compact");
  assert.match((await wait((m) => m.t === "error")).message, /before compacting/);
  assert.ok(!inbox.some(event("user_input")));
  inbox.length = 0;
  post("remember the fixture fact");
  await wait(event("result"));
  inbox.length = 0;
  post("/help");
  assert.match((await wait(event("command_status"))).event.text, /\/compact/);
  assert.ok(!inbox.some(event("user_input")));
  inbox.length = 0;
  post("/not-a-command");
  assert.match((await wait((m) => m.t === "error")).message, /not available/);
  assert.ok(!inbox.some(event("user_input")));
  inbox.length = 0;
  post("/compact");
  await wait((m) => event("command_status")(m) && m.event.status === "running");
  post("message after compaction");
  await wait(
    (m) =>
      m.t === "queue" &&
      m.thread === id &&
      m.items.some((x: any) => x.text === "message after compaction"),
  );
  await wait((m) => event("command_status")(m) && m.event.status === "completed");
  assert.ok(
    inbox.some(
      (m) =>
        m.t === "thread" &&
        m.thread.id === id &&
        m.thread.context?.used === 6000 &&
        m.thread.lastCompactedAt,
    ),
  );
  await wait(
    (m) => event("assistant")(m) && JSON.stringify(m.event).includes("message after compaction"),
  );
  await wait(
    (m) =>
      m.t === "thread" && m.thread.id === id && m.thread.status === "idle" && !m.thread.operation,
  );
  inbox.length = 0;
  send({ t: "open", thread: id });
  const h = await wait((m) => m.t === "history" && m.thread === id);
  assert.ok(
    h.events.some(
      (e: any) => e.type === "assistant" && JSON.stringify(e).includes("remember the fixture fact"),
    ),
  );
  assert.ok(
    !h.events.some(
      (e: any) =>
        e.type === "assistant" &&
        JSON.stringify(e).includes("mock reply (acceptEdits, echo): /compact"),
    ),
  );
  inbox.length = 0;
  post("agent fixture");
  await wait(event("user_input"));
  post("/compact");
  await wait(
    (m) => m.t === "queue" && m.thread === id && m.items.some((x: any) => x.text === "/compact"),
  );
  post("/compact");
  assert.match((await wait((m) => m.t === "error")).message, /already running or queued/);
  await wait((m) => event("command_status")(m) && m.event.status === "completed");
  inbox.length = 0;
  post("fail fixture");
  post("/compact");
  await wait((m) => event("command_status")(m) && m.event.status === "completed");
  inbox.length = 0;
  send({ t: "compact", thread: id });
  await wait((m) => event("command_status")(m) && m.event.status === "running");
  post("/stop");
  await wait(
    (m) =>
      m.t === "thread" && m.thread.id === id && m.thread.status === "idle" && !m.thread.operation,
  );
  assert.ok(!inbox.some((m) => event("command_status")(m) && m.event.status === "completed"));
  console.log(
    "PASS command discovery before first turn, empty/unknown errors, no model prompts, native compaction, queued compaction/input, retained transcript and Stop",
  );
} finally {
  if (id) send({ t: "delete", thread: id });
  ws.close();
}

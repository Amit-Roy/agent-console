import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-thread-messages-"));
Object.assign(process.env, {
  AGENT_CONSOLE_DATA: data,
  AGENT_CONSOLE_ENV_FILES: path.join(data, "no-env"),
  AGENT_CONSOLE_BRAIN: path.join(data, "no-brain"),
  AGENT_CONSOLE_MOCK: "1",
  AGENT_CONSOLE_LABELS: "0",
});
const { Threads } = await import("../server/threads.ts");
const { PROVIDERS } = await import("../server/providers/index.ts");
const { gateToolCall } = await import("../server/tool-token.ts");
const contexts = new Map<string, any>();
const prompts = new Map<string, string[]>();
const events: any[] = [];
const nextPrompts = new Map<string, () => void>();
PROVIDERS.set("message-fixture", {
  id: "message-fixture",
  label: "Message fixture",
  modes: ["plan"],
  defaultMode: "plan",
  models: () => ["fixture"],
  defaultModel: () => "fixture",
  status: () => ({ ok: true }),
  start(spec: any, ctx: any) {
    contexts.set(spec.id, ctx);
    return {
      alive: true,
      send(text: string) {
        prompts.set(spec.id, [...(prompts.get(spec.id) ?? []), text]);
        nextPrompts.get(spec.id)?.();
        nextPrompts.delete(spec.id);
      },
      abort() {},
      kill() {},
    };
  },
});
const threads = new Threads((event) => events.push(event));
const source = threads.create({ provider: "message-fixture", cwd: data, title: "Sender" });
const target = threads.create({ provider: "message-fixture", cwd: data, title: "Recipient" });
const other = threads.create({ provider: "message-fixture", cwd: data, title: "Other" });
threads.send(source.id, "Start");
threads.send(other.id, "Start");
const token = "thread-messaging-fixture-token";
const server = createServer(async (req, res) => {
  const name = req.url!.split("/").at(-1)!;
  const gate = gateToolCall(
    token,
    String(req.headers["x-agent-console-tool"] ?? ""),
    req.headers["x-agent-console-thread"] as string | undefined,
    name,
    () => false,
  );
  try {
    if (gate.error) throw new Error(gate.error);
    let body = "";
    for await (const part of req) body += part;
    const result = await threads.threadTool(name, gate.threadId, JSON.parse(body));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result));
  } catch (error: any) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: error.message }));
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address() as { port: number };
const url = `http://127.0.0.1:${address.port}/api/agent-tools`;
const child = spawn(process.execPath, ["server/providers/console-mcp.mjs"], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    AGENT_CONSOLE_TOOL_URL: url,
    AGENT_CONSOLE_TOOL_TOKEN: token,
    AGENT_CONSOLE_THREAD: source.id,
  },
});
const replies = new Map<number, (value: any) => void>();
const lines = createInterface({ input: child.stdout! });
lines.on("line", (line) => {
  const reply = JSON.parse(line);
  replies.get(reply.id)?.(reply);
  replies.delete(reply.id);
});
let nextId = 0;
const request = (method: string, params?: any): Promise<any> =>
  new Promise((resolve) => {
    const requestId = ++nextId;
    replies.set(requestId, resolve);
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
  });
const observe = (input: any, parent?: string) =>
  contexts.get(source.id).event({
    type: "assistant",
    ...(parent ? { parent_tool_use_id: parent } : {}),
    message: {
      content: [
        {
          type: "tool_use",
          id: `call-${++nextId}`,
          name: "mcp__agent_console__thread_send",
          input,
        },
      ],
    },
  });
const call = (input: any) => request("tools/call", { name: "thread_send", arguments: input });
const raw = async (thread: string | undefined, input: any) => {
  const response = await fetch(`${url}/thread_send`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agent-console-tool": token,
      ...(thread ? { "x-agent-console-thread": thread } : {}),
    },
    body: JSON.stringify(input),
  });
  return { status: response.status, body: await response.json() };
};
try {
  const list = await request("tools/list");
  assert(
    list.result.tools.some(
      (tool: any) => tool.name === "thread_send" && !tool.annotations.readOnlyHint,
    ),
  );
  const listed = await request("tools/call", { name: "thread_list", arguments: {} });
  assert(
    JSON.parse(listed.result.content[0].text).threads.some(
      (thread: any) => thread.id === target.id,
    ),
  );
  const input = { thread: target.id, message: "/compact must remain message text" };
  const initialActivity = target.lastUserActivityAt;
  observe(input);
  const sent = await call(input);
  assert.equal(
    target.lastUserActivityAt,
    initialActivity,
    "agent messages do not count as user activity",
  );
  assert.deepEqual(JSON.parse(sent.result.content[0].text), {
    thread: target.id,
    delivery: "started",
  });
  assert(prompts.get(target.id)![0].includes(`[Message from thread ${source.id}`));
  const attributed = events.find(
    (event) => event.thread === target.id && event.event?.sourceThread,
  );
  assert.equal(attributed.event.sourceThread.id, source.id);
  console.log("PASS: MCP root call starts recipient with visible sender attribution.");
  observe(input, "native-child");
  assert((await call(input)).result.isError);
  assert((await call(input)).result.isError, "one-use authorization cannot replay");
  assert.equal((await raw(undefined, input)).status, 400);
  observe(input);
  assert.equal((await raw(other.id, input)).status, 400, "spoofed header has no grant");
  const busy = await call(input);
  assert.equal(JSON.parse(busy.result.content[0].text).delivery, "queued");
  assert.equal(threads.getQueues()[target.id].length, 1);
  console.log(
    "PASS: inherited master token, native child, unbound caller, spoofed sender and replay rejected.",
  );
  threads.send(target.id, "User message", { mode: "queue" });
  const drained = new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("Queue did not drain")), 2000);
    nextPrompts.set(target.id, () => {
      clearTimeout(deadline);
      resolve();
    });
  });
  contexts.get(target.id).event({ type: "result", subtype: "success" });
  await drained;
  assert.equal(
    threads.getQueues()[target.id].length,
    1,
    "user message stays queued behind agent message",
  );
  assert(
    events.filter((event) => event.thread === target.id && event.event?.sourceThread).length === 2,
  );
  const live = (threads as any).live.get(other.id);
  const steered: string[] = [];
  live.agent.steer = (text: string) => {
    steered.push(text);
  };
  const steerInput = { thread: other.id, message: "Steer a busy thread" };
  observe(steerInput);
  assert.equal(JSON.parse((await call(steerInput)).result.content[0].text).delivery, "steered");
  assert(steered[0].includes(source.id));
  let acceptSteer: (() => void) | undefined;
  live.agent.steer = () =>
    new Promise<void>((resolve) => {
      acceptSteer = resolve;
    });
  observe(steerInput);
  assert.equal(JSON.parse((await call(steerInput)).result.content[0].text).delivery, "steering");
  acceptSteer?.();
  await new Promise((resolve) => setImmediate(resolve));
  const badInputs = [
    { thread: source.id, message: "self" },
    { thread: "missing", message: "hi" },
    { thread: target.id, message: "" },
    { thread: target.id, message: "x".repeat(20_001) },
    { thread: target.id, message: "hi", sender: other.id },
  ];
  for (const invalid of badInputs) {
    observe(invalid);
    assert((await call(invalid)).result.isError);
  }
  threads.get(target.id)!.archived = Date.now();
  observe(input);
  assert((await call(input)).result.isError);
  console.log(
    "PASS: queued attribution, preserved user queue, invalid input and archived/missing/self targets.",
  );
} finally {
  child.kill();
  await once(child, "exit");
  lines.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  threads.shutdown();
  fs.rmSync(data, { recursive: true, force: true });
}

// Answering a question from a push notification (#421): nonce rules on Threads, then the HTTP route on a scratch server.
// Run: node test/questions-http.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket } from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ac-questions-http-"));

// --- Threads: the notice carries the question, the nonce gates the answer
const data = path.join(scratch, "inproc");
fs.mkdirSync(data);
Object.assign(process.env, {
  AGENT_CONSOLE_DATA: data,
  AGENT_CONSOLE_ENV_FILES: path.join(data, "no-env"),
  AGENT_CONSOLE_BRAIN: path.join(data, "no-brain"),
  AGENT_CONSOLE_MOCK: "1",
  AGENT_CONSOLE_LABELS: "0",
});
const { Threads } = await import(pathToFileURL(path.join(root, "server/threads.ts")).href);
const { PROVIDERS } = await import(
  pathToFileURL(path.join(root, "server/providers/index.ts")).href
);
const contexts = new Map<string, any>();
const answers: any[] = [];
PROVIDERS.set("ask-fixture", {
  id: "ask-fixture",
  label: "Ask fixture",
  modes: ["plan"],
  defaultMode: "plan",
  models: () => ["fixture"],
  defaultModel: () => "fixture",
  status: () => ({ ok: true }),
  start(target: any, ctx: any) {
    contexts.set(target.id, ctx);
    return {
      alive: true,
      send() {},
      steer() {},
      answer(requestId: string, reply: any) {
        answers.push({ id: requestId, reply });
        return true;
      },
      abort() {},
      kill() {},
    };
  },
});
const notices: any[] = [];
const threads = new Threads(
  () => {},
  (notice: any) => notices.push(notice),
);
const ask = (requestId: string, questions: any[]) => {
  const thread = threads.create({ provider: "ask-fixture", cwd: data, title: "Ask" });
  threads.send(thread.id, "go");
  contexts.get(thread.id).event({ type: "question", id: requestId, questions });
  return thread;
};
const one = {
  id: "scope",
  question: "How much?",
  options: [{ label: "Quick" }, { label: "Full" }],
};
try {
  const thread = ask("q1", [one]);
  const notice = notices.find(
    (entry) => entry.kind === "needs_input" && entry.thread === thread.id,
  );
  assert.equal(notice.question.id, "q1");
  assert.equal(notice.question.key, "scope");
  assert.equal(notice.question.text, "How much?");
  assert.deepEqual(notice.question.options, ["Quick", "Full"]);
  assert.ok(notice.question.nonce.length >= 16);
  const status = (action: () => void) => {
    try {
      action();
    } catch (error: any) {
      return error.status;
    }
    return 200;
  };
  const reply = (nonce: unknown, requestId = "q1") =>
    status(() => threads.answerFromPush(thread.id, requestId, { scope: ["Full"] }, false, nonce));
  assert.equal(reply("wrong"), 409);
  assert.equal(reply(undefined), 409);
  assert.equal(reply("x", "missing"), 404);
  assert.equal(reply(notice.question.nonce), 200);
  assert.deepEqual({ ...answers.at(-1).reply.answers }, { scope: ["Full"] });
  assert.equal(reply(notice.question.nonce), 404, "A used nonce cannot answer twice");

  const many = ask("q2", [
    { ...one, id: "a", options: [{ label: "1" }, { label: "2" }, { label: "3" }] },
  ]);
  const wide = notices.findLast(
    (entry) => entry.thread === many.id && entry.kind === "needs_input",
  );
  assert.deepEqual(
    [wide.question.options, wide.question.nonce],
    [[], undefined],
    "Over two options: no buttons",
  );
  const multi = ask("q3", [{ ...one, multiSelect: true }]);
  assert.equal(
    notices.findLast((entry) => entry.thread === multi.id).question.nonce,
    undefined,
    "Multi-select: no buttons",
  );
  const pair = ask("q4", [one, { ...one, id: "second" }]);
  assert.equal(
    notices.findLast((entry) => entry.thread === pair.id).question.nonce,
    undefined,
    "Several questions: no buttons",
  );
  const skipped = ask("q5", [one]);
  const skipNotice = notices.findLast((entry) => entry.thread === skipped.id);
  threads.answerFromPush(skipped.id, "q5", undefined, true, skipNotice.question.nonce);
  assert.equal(answers.at(-1).reply.skip, true);
} finally {
  threads.shutdown();
}

// --- HTTP: auth, same-origin, and the nonce check on a real server
const listener = net.createServer().listen(0, "127.0.0.1");
await once(listener, "listening");
const port = (listener.address() as net.AddressInfo).port;
await new Promise((resolve) => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const password = randomBytes(24).toString("base64url");
const child = spawn(process.execPath, ["server/index.ts"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    AGENT_CONSOLE_DATA: path.join(scratch, "server"),
    AGENT_CONSOLE_RUN: path.join(scratch, "run"),
    AGENT_CONSOLE_MOCK: "1",
    AGENT_CONSOLE_AUTH: "password",
    AGENT_CONSOLE_PASSWORD: password,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stderr.resume();
let socket: WebSocket | undefined;
try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Scratch server startup timed out.")), 30_000);
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
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  socket = new WebSocket(`${origin.replace("http", "ws")}/ws`, {
    headers: { Cookie: cookie, Origin: origin },
  });
  const inbox: any[] = [];
  socket.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
  await once(socket, "open");
  const until = async (match: (message: any) => any) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const found = inbox.find(match);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
      `Timed out waiting for the server: ${JSON.stringify(inbox.map((message) => message.t + (message.message ? ":" + message.message : "")))}`,
    );
  };
  socket.send(JSON.stringify({ t: "create", cwd: root, title: "ask" }));
  const created = await until((message) => message.t === "created");
  const thread = created.thread?.id ?? created.id;
  socket.send(JSON.stringify({ t: "send", thread, text: "question please" }));
  const asked = await until(
    (message) =>
      message.t === "event" && message.thread === thread && message.event?.type === "question",
  );
  const questionId = asked.event.id;
  const route = (threadId: string, questionKey: string) =>
    `${origin}/api/questions/${encodeURIComponent(threadId)}/${encodeURIComponent(questionKey)}/answer`;
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url, {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const body = { answers: { scope: ["Quick pass"] }, nonce: "not-the-nonce" };
  assert.equal(
    (await fetch(route(thread, questionId), { method: "POST", body: "{}" })).status,
    401,
  );
  assert.equal(
    (await post(route(thread, questionId), body, { Origin: "https://evil.example" })).status,
    403,
  );
  assert.equal((await post(route(thread, questionId), body)).status, 409, "Wrong nonce");
  assert.equal((await post(route(thread, "gone"), body)).status, 404, "Unknown question");
  assert.equal((await post(route("nothread", questionId), body)).status, 404, "Unknown thread");
  assert.equal(
    inbox.some((message) => message.t === "event" && message.event?.type === "question_answer"),
    false,
    "A refused answer changes nothing",
  );
} finally {
  socket?.close();
  child.removeAllListeners("exit");
  child.kill();
  await once(child, "exit");
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
}
console.log("Question answer-from-push checks passed.");

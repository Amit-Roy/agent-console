// A turn that ends by announcing its next step gets exactly one auto "continue" send, and only when nothing else is going on.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-auto-continue-"));
Object.assign(process.env, {
  AGENT_CONSOLE_DATA: data,
  AGENT_CONSOLE_ENV_FILES: path.join(data, "no-env"),
  AGENT_CONSOLE_BRAIN: path.join(data, "no-brain"),
  AGENT_CONSOLE_MOCK: "1",
  AGENT_CONSOLE_LABELS: "0",
});
delete process.env.AGENT_CONSOLE_AUTO_CONTINUE;
const { Threads } = await import(pathToFileURL(path.join(root, "server/threads.ts")).href);
const { PROVIDERS } = await import(
  pathToFileURL(path.join(root, "server/providers/index.ts")).href
);
const { AUTO_CONTINUE_PROMPT } = await import(
  pathToFileURL(path.join(root, "server/auto-continue.ts")).href
);
const contexts = new Map<string, any>();
const sent: string[] = [];
PROVIDERS.set("continue-fixture", {
  id: "continue-fixture",
  label: "Continue fixture",
  modes: ["plan"],
  defaultMode: "plan",
  models: () => ["fixture"],
  defaultModel: () => "fixture",
  status: () => ({ ok: true }),
  start(thread: any, ctx: any) {
    contexts.set(thread.id, ctx);
    return {
      alive: true,
      send(text: string) {
        sent.push(text);
      },
      interrupt() {},
      abort() {},
      kill() {},
    };
  },
});
mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
const threads = new Threads(() => {});
const ANNOUNCE = "Tests pass.\nNext I'll wire the route handler.";
const nudges = () => sent.filter((text) => text === AUTO_CONTINUE_PROMPT).length;
const emit = (threadId: string, event: any) => contexts.get(threadId).event(event);
const say = (threadId: string, text: string) =>
  emit(threadId, { type: "assistant", message: { content: [{ type: "text", text }] } });
const endTurn = (threadId: string, extra: any = {}) => {
  emit(threadId, { type: "result", subtype: "success", ...extra });
  mock.timers.tick(300);
};
function start(title: string) {
  const thread = threads.create({ provider: "continue-fixture", cwd: data, title });
  threads.send(thread.id, "go");
  return thread;
}
function expectNone(title: string, setup: (threadId: string) => void, extra: any = {}) {
  const before = nudges();
  const thread = start(title);
  setup(thread.id);
  say(thread.id, ANNOUNCE);
  endTurn(thread.id, extra);
  assert.equal(nudges(), before, `${title}: no auto continue`);
}

try {
  const first = start("announced");
  say(first.id, ANNOUNCE);
  endTurn(first.id);
  assert.equal(nudges(), 1, "announced step sends exactly one continue");
  assert.equal(threads.get(first.id).status, "running", "the continue turn is running");
  say(first.id, ANNOUNCE);
  endTurn(first.id);
  assert.equal(nudges(), 1, "the continuation turn announcing again sends nothing");

  threads.send(first.id, "next please");
  say(first.id, ANNOUNCE);
  endTurn(first.id);
  assert.equal(nudges(), 2, "a new user message re-arms");

  const noAnnounce = start("no announcement");
  say(noAnnounce.id, "All done.");
  endTurn(noAnnounce.id);
  assert.equal(nudges(), 2, "a finished turn gets no continue");

  const toolLast = start("tool last");
  say(toolLast.id, ANNOUNCE);
  emit(toolLast.id, {
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "tu1", name: "Read", input: {} }] },
  });
  endTurn(toolLast.id);
  assert.equal(nudges(), 2, "text followed by a tool call is not what the turn ended on");

  expectNone("background task", (threadId) =>
    emit(threadId, {
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "a" }],
    }),
  );
  expectNone("open question", (threadId) =>
    emit(threadId, {
      type: "question",
      id: "q",
      questions: [{ id: "a", question: "Which?", options: [{ label: "A" }] }],
    }),
  );
  expectNone("is_error", () => {}, { is_error: true, subtype: "error" });
  expectNone("issue run", (threadId) => {
    threads.get(threadId).issueRun = { repo: "o/r", number: 1 };
  });
  expectNone("pending background bash", (threadId) =>
    emit(threadId, {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "bg1", name: "Bash", input: { run_in_background: true } },
        ],
      },
    }),
  );

  const finishedBg = start("finished background bash");
  const beforeBg = nudges();
  emit(finishedBg.id, {
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: "bg2", name: "Bash", input: { run_in_background: true } }],
    },
  });
  emit(finishedBg.id, {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "bg2", content: "ok" }] },
  });
  say(finishedBg.id, ANNOUNCE);
  endTurn(finishedBg.id);
  assert.equal(nudges(), beforeBg + 1, "a returned background call no longer blocks");

  const queued = start("queued");
  const beforeQueue = nudges();
  say(queued.id, ANNOUNCE);
  threads.send(queued.id, "also this", { mode: "queue" });
  endTurn(queued.id);
  assert.equal(nudges(), beforeQueue, "a queued message wins over the continue");

  process.env.AGENT_CONSOLE_AUTO_CONTINUE = "0";
  expectNone("disabled", () => {});
  delete process.env.AGENT_CONSOLE_AUTO_CONTINUE;
  console.log("PASS auto continue sends once per user turn and respects every gate");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  fs.rmSync(data, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 50);
}

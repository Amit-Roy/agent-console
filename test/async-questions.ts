import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = process.env.AGENT_CONSOLE_TEST_ROOT || fileURLToPath(new URL("../", import.meta.url));
const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-async-questions-"));
process.env.AGENT_CONSOLE_DATA = data;
process.env.AGENT_CONSOLE_ENV_FILES = path.join(data, "no-env");
process.env.AGENT_CONSOLE_BRAIN = path.join(data, "no-brain");
process.env.AGENT_CONSOLE_MOCK = "1";
process.env.AGENT_CONSOLE_LABELS = "0";
const { Threads } = await import(pathToFileURL(path.join(root, "server/threads.ts")).href);
const { PROVIDERS } = await import(
  pathToFileURL(path.join(root, "server/providers/index.ts")).href
);
const { turnsOf } = await import(pathToFileURL(path.join(root, "server/export.ts")).href);
const contexts = new Map<string, any>();
const delivered: { thread: string; method: string; text: string }[] = [];
let nativeAnswers = 0;
PROVIDERS.set("async-fixture", {
  id: "async-fixture",
  label: "Async fixture",
  modes: ["plan"],
  defaultMode: "plan",
  models: () => ["fixture"],
  defaultModel: () => "fixture",
  status: () => ({ ok: true }),
  start(t: any, ctx: any) {
    let alive = true;
    contexts.set(t.id, {
      event: ctx.event,
      exit() {
        alive = false;
        ctx.exited({ code: 0, signal: null, stderr: "", aborted: false });
      },
    });
    return {
      get alive() {
        return alive;
      },
      send(text: string) {
        delivered.push({ thread: t.id, method: "send", text });
      },
      steer(text: string) {
        delivered.push({ thread: t.id, method: "steer", text });
      },
      answer() {
        nativeAnswers++;
        throw Error("Async metadata is not a blocking native request");
      },
      abort() {
        alive = false;
        ctx.exited({ code: null, signal: "SIGINT", stderr: "", aborted: true });
      },
      kill() {
        alive = false;
        ctx.exited({ code: null, signal: "SIGTERM", stderr: "", aborted: true });
      },
    };
  },
});
const published: any[] = [];
let threads = new Threads((m: any) => published.push(structuredClone(m)));
const create = () => {
  const t = threads.create({
    provider: "async-fixture",
    cwd: data,
    title: "Async question fixture",
  });
  threads.send(t.id, "original task");
  return t;
};
const questions = [
  { id: "scope", question: "Which scope?", options: [{ label: "Quick" }, { label: "Full" }] },
];
const ask = (t: any, id: string, async = true) =>
  contexts.get(t.id).event({ type: "question", id, questions, ...(async ? { async: true } : {}) });
const finish = (t: any) => contexts.get(t.id).event({ type: "result", subtype: "success" });
const events = (id: string) => threads.history(id) as any[];
const durable = () => JSON.parse(fs.readFileSync(path.join(data, "questions.json"), "utf8"));
const sentTo = (id: string) => delivered.filter((d) => d.thread === id);
try {
  const t = create();
  ask(t, "async-persist");
  ask(t, "blocking", false);
  assert.deepEqual(
    durable()[t.id].map((q: any) => q.id),
    ["async-persist"],
    "only async requests are durable",
  );
  assert.equal(fs.statSync(path.join(data, "questions.json")).mode & 0o777, 0o600);
  finish(t);
  assert.equal(t.status, "idle");
  assert.deepEqual(
    threads.getQuestions(t.id).map((q: any) => q.id),
    ["async-persist"],
    "turn results close blocking input while preserving async input",
  );
  assert.equal(t.waiting, 1);
  contexts.get(t.id).exit();
  assert.equal(
    threads.getQuestions(t.id).length,
    1,
    "a subprocess exit does not cancel an async question",
  );
  threads.shutdown();
  threads = new Threads((m: any) => published.push(structuredClone(m)));
  assert.equal(threads.get(t.id)?.waiting, 1);
  assert.equal(
    threads.page(t.id).questions[0].id,
    "async-persist",
    "restart restores the live picker independently of history pagination",
  );
  assert.throws(() => threads.answer(t.id, "async-persist", { scope: ["Unknown"] }));
  assert.equal(sentTo(t.id).length, 1, "invalid async answers never start inference");
  threads.answer(t.id, "async-persist", { scope: ["Full"] });
  assert.equal(sentTo(t.id).length, 2);
  assert.deepEqual(sentTo(t.id).at(-1), {
    thread: t.id,
    method: "send",
    text: "Which scope?\nFull",
  });
  assert.deepEqual(threads.getQuestions(t.id), []);
  assert.equal(threads.get(t.id)?.waiting, undefined);
  assert.equal(durable()[t.id], undefined);
  assert.throws(() => threads.answer(t.id, "async-persist", { scope: ["Full"] }));
  assert.equal(sentTo(t.id).length, 2, "another tab cannot submit the same async answer twice");
  assert.equal(events(t.id).filter((e) => e.type === "user_input" && e.questionAnswer).length, 1);
  assert.deepEqual(
    turnsOf(events(t.id), { tools: false })
      .filter((r: any) => r.role === "user")
      .map((r: any) => r.text),
    ["original task", "Full"],
    "export does not duplicate the generated answer turn",
  );

  const skip = create();
  ask(skip, "skip");
  finish(skip);
  contexts.get(skip.id).exit();
  threads.answer(skip.id, "skip", undefined, true);
  assert.deepEqual(threads.getQuestions(skip.id), []);
  assert.equal(
    sentTo(skip.id).length,
    1,
    "Skip closes idle async input without starting a paid turn",
  );
  assert.equal(events(skip.id).findLast((e) => e.type === "question_answer").skip, true);

  for (const running of [false, true]) {
    const chat = create();
    ask(chat, `chat-${running}`);
    if (!running) {
      finish(chat);
      contexts.get(chat.id).exit();
    }
    threads.send(chat.id, "Use your best judgment", { mode: "steer" });
    assert.deepEqual(threads.getQuestions(chat.id), []);
    assert.equal(sentTo(chat.id).length, 2, "ordinary chat replies are delivered once");
    assert.equal(sentTo(chat.id).at(-1)?.method, running ? "steer" : "send");
    assert.equal(
      events(chat.id).findLast((e) => e.type === "question_answer").note,
      "Use your best judgment",
    );
    assert.equal(threads.getQueues()[chat.id], undefined);
  }

  const queue = create();
  ask(queue, "keep-while-queued");
  threads.send(queue.id, "For the next turn", { mode: "queue" });
  assert.equal(
    threads.getQuestions(queue.id).length,
    1,
    "explicit queue does not silently answer async input",
  );
  assert.equal(threads.getQueues()[queue.id].length, 1);
  threads.abort(queue.id);
  assert.deepEqual(threads.getQuestions(queue.id), []);
  assert.equal(threads.getQueues()[queue.id], undefined);
  assert.equal(durable()[queue.id], undefined);

  for (const action of ["abort", "remove"] as const) {
    const closed = create();
    ask(closed, action);
    finish(closed);
    contexts.get(closed.id).exit();
    threads[action](closed.id);
    assert.deepEqual(
      threads.getQuestions(closed.id),
      [],
      `${action} clears async questions even without a native process`,
    );
    assert.equal(durable()[closed.id], undefined);
    assert.throws(() => threads.answer(closed.id, action, { scope: ["Full"] }));
    if (action === "abort")
      assert.ok(events(closed.id).some((e) => e.type === "question_answer" && e.cancelled));
  }
  assert.equal(
    nativeAnswers,
    0,
    "async answers never call Agent.answer or fabricate a native RPC reply",
  );
  console.log(
    "PASS async question lifecycle: result/exit/restart persistence, validation, one native send, skip without inference, ordinary chat idle/running, explicit queue, abort/delete and export deduplication",
  );
} finally {
  threads.shutdown();
  PROVIDERS.delete("async-fixture");
  fs.rmSync(data, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-questions-"));
process.env.AGENT_CONSOLE_DATA = data;
process.env.AGENT_CONSOLE_BRAIN = path.join(data, "no-brain");
process.env.AGENT_CONSOLE_LABELS = "0";
const { Threads } = await import("../server/threads.ts");
const { PROVIDERS } = await import("../server/providers/index.ts");
const { turnsOf, replayPreamble } = await import("../server/export.ts");
const contexts = new Map<string, any>();
const calls: { id: string; reply: any }[] = [];
const sent: string[] = [];
const steered: string[] = [];
let accept = true,
  consumed = true,
  finishInAnswer = false;
PROVIDERS.set("question-fixture", {
  id: "question-fixture",
  label: "Question fixture",
  modes: ["plan"],
  defaultMode: "plan",
  models: () => ["fixture"],
  defaultModel: () => "fixture",
  status: () => ({ ok: true }),
  start(t, ctx) {
    contexts.set(t.id, ctx);
    return {
      alive: true,
      send(text) {
        sent.push(text);
      },
      steer(text) {
        steered.push(text);
      },
      answer(id, reply) {
        if (!accept) throw new Error("Native request is temporarily unavailable");
        calls.push({ id, reply: structuredClone(reply) });
        if (finishInAnswer) ctx.event({ type: "result", subtype: "success" });
        return consumed;
      },
      abort() {
        ctx.exited({ code: null, signal: "SIGINT", stderr: "", aborted: true });
      },
      kill() {
        ctx.exited({ code: null, signal: "SIGTERM", stderr: "", aborted: true });
      },
    };
  },
});
const events: any[] = [];
const threads = new Threads((m) => events.push(structuredClone(m)));
const create = () => {
  const t = threads.create({ provider: "question-fixture", cwd: data, title: "Question fixture" });
  threads.send(t.id, "begin");
  return t;
};
const questions = [
  {
    id: "scope",
    question: "How much should I review?",
    options: [{ label: "Quick pass" }, { label: "Full review" }],
    allowOther: true,
  },
  {
    id: "checks",
    question: "Which checks should I run?",
    options: [{ label: "Tests" }, { label: "Screenshots" }],
    multiSelect: true,
  },
];
const ask = (t: any, id = "request", list = questions) =>
  contexts.get(t.id).event({ type: "question", id, questions: structuredClone(list) });
const answerEvents = (id: string) =>
  events
    .filter((m) => m.t === "event" && m.thread === id && m.event.type === "question_answer")
    .map((m) => m.event);
const rejected = (t: any, id: string, answers: unknown) => {
  const before = calls.length;
  assert.throws(
    () => threads.answer(t.id, id, answers),
    `reject malformed answer ${JSON.stringify(answers)}`,
  );
  assert.equal(calls.length, before, "invalid answers never reach the native process");
  assert.equal(threads.getQuestions(t.id).length, 1, "validation keeps the question answerable");
};
try {
  const t = create();
  ask(t);
  assert.equal(t.waiting, 1);
  assert.equal(t.status, "running", "a question pauses the existing native turn");
  assert.deepEqual(threads.getQuestions()[t.id], threads.getQuestions(t.id));
  assert.equal(
    threads.page(t.id).questions[0].id,
    "request",
    "reopening a thread includes pending questions",
  );
  const reconnect = structuredClone(threads.getQuestions());
  assert.deepEqual(
    reconnect[t.id][0].questions,
    questions,
    "hello/reconnect payload retains every question and choice",
  );
  rejected(t, "request", null);
  rejected(t, "request", { scope: ["Quick pass"] });
  rejected(t, "request", { scope: ["Quick pass", "Full review"], checks: ["Tests"] });
  rejected(t, "request", { scope: ["Quick pass"], checks: ["Unknown choice"] });
  rejected(t, "request", { scope: ["Quick pass"], checks: ["Tests", "Tests"] });
  rejected(t, "request", { scope: ["   "], checks: ["Tests"] });
  rejected(t, "request", { scope: ["Quick pass"], checks: ["Tests"], injected: ["unexpected"] });
  assert.throws(() => threads.answer(t.id, "stale", { scope: ["Quick pass"], checks: ["Tests"] }));
  assert.equal(calls.length, 0);
  const chosen = { scope: ["Review just the changed lines"], checks: ["Tests", "Screenshots"] };
  finishInAnswer = true;
  threads.answer(t.id, "request", chosen);
  assert.deepEqual(
    calls,
    [{ id: "request", reply: { answers: chosen } }],
    "custom and multiple choices continue the native process once",
  );
  assert.deepEqual(threads.getQuestions(t.id), []);
  assert.equal(t.waiting, undefined);
  assert.equal(t.status, "idle", "synchronous native completion cannot strand waiting state");
  assert.equal(answerEvents(t.id).filter((e) => e.id === "request" && !e.cancelled).length, 1);
  assert.throws(
    () => threads.answer(t.id, "request", chosen),
    "another tab cannot answer a completed request",
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(
    sent,
    ["begin"],
    "answers resume a native request instead of sending another user turn",
  );
  assert.equal(threads.history(t.id).filter((e: any) => e.type === "user_input").length, 1);
  const replayed = turnsOf(threads.history(t.id), { tools: false });
  assert.deepEqual(
    replayed.filter((turn) => turn.role === "agent").map((turn) => turn.text),
    questions.map((q) => q.question),
  );
  assert.deepEqual(
    replayed.filter((turn) => turn.role === "user").map((turn) => turn.text),
    ["begin", "Review just the changed lines\nTests, Screenshots"],
  );
  assert.match(
    replayPreamble(threads.history(t.id)),
    /How much should I review\?[\s\S]*Review just the changed lines/,
  );

  finishInAnswer = false;
  const chat = create();
  ask(chat, "chat");
  const beforeChatCalls = calls.length;
  const beforeChatSend = sent.length;
  threads.send(chat.id, "Choose whatever keeps the review focused");
  assert.equal(
    calls.length,
    beforeChatCalls + 1,
    "a composer message releases the native waiting request once",
  );
  assert.equal(calls.at(-1)?.reply.note, "Choose whatever keeps the review focused");
  assert.equal(calls.at(-1)?.reply.skip, undefined);
  assert.equal(steered.length, 0, "consumed chat notes are not also delivered through steering");
  assert.equal(sent.length, beforeChatSend, "consumed chat notes are not sent as new turns");
  assert.deepEqual(threads.getQuestions(chat.id), []);
  assert.equal(answerEvents(chat.id).at(-1).note, "Choose whatever keeps the review focused");

  finishInAnswer = false;
  const skip = create();
  ask(skip, "skip");
  threads.answer(skip.id, "skip", undefined, true);
  assert.equal(calls.at(-1)?.reply.skip, true);
  assert.equal(answerEvents(skip.id).at(-1).skip, true);
  assert.deepEqual(threads.getQuestions(skip.id), []);

  const secret = create();
  ask(secret, "secret", [
    {
      id: "password",
      question: "Enter the fixture password",
      options: [],
      allowOther: true,
      secret: true,
    },
  ] as any);
  const fixtureSecret = "test-only-sensitive-answer";
  threads.answer(secret.id, "secret", { password: [fixtureSecret] });
  assert.deepEqual(
    calls.at(-1)?.reply.answers,
    { password: [fixtureSecret] },
    "native continuation receives the actual secret",
  );
  assert.equal(
    JSON.stringify(threads.history(secret.id)).includes(fixtureSecret),
    false,
    "secret answers never enter the durable transcript",
  );
  assert.equal(
    JSON.stringify(events.filter((m) => m.thread === secret.id)).includes(fixtureSecret),
    false,
    "secret answers are not broadcast to connected clients",
  );

  const unavailable = create();
  ask(unavailable, "unavailable");
  accept = false;
  assert.throws(() =>
    threads.answer(unavailable.id, "unavailable", { scope: ["Quick pass"], checks: ["Tests"] }),
  );
  assert.equal(
    calls.length,
    4,
    "a failed native continuation is never reported as successfully answered",
  );
  assert.equal(
    threads.getQuestions(unavailable.id).length,
    1,
    "native errors preserve the request for a retry",
  );
  assert.equal(answerEvents(unavailable.id).length, 0);
  accept = true;
  consumed = false; // false means no ordinary chat note was consumed; structured replies still succeed.
  threads.answer(unavailable.id, "unavailable", { scope: ["Quick pass"], checks: ["Tests"] });
  assert.equal(answerEvents(unavailable.id).length, 1);
  assert.deepEqual(threads.getQuestions(unavailable.id), []);
  consumed = true;

  for (const exit of ["abort", "result", "process"] as const) {
    const t = create();
    ask(t, exit);
    if (exit === "abort") threads.abort(t.id);
    if (exit === "result") contexts.get(t.id).event({ type: "result", subtype: "success" });
    if (exit === "process")
      contexts.get(t.id).exited({ code: 1, signal: null, stderr: "fixture exit", aborted: false });
    assert.deepEqual(threads.getQuestions(t.id), [], `${exit} clears pending requests`);
    assert.equal(t.waiting, undefined);
    assert.equal(t.status, "idle");
    assert.ok(
      answerEvents(t.id).some((e) => e.id === exit && e.cancelled),
      `${exit} leaves a closed transcript card`,
    );
    assert.throws(() => threads.answer(t.id, exit, { scope: ["Quick pass"], checks: ["Tests"] }));
    if (exit === "abort") {
      const before = events.length;
      ask(t, "late-after-abort");
      assert.deepEqual(
        threads.getQuestions(t.id),
        [],
        "a stale process cannot resurrect a request after abort",
      );
      assert.equal(events.length, before, "events from an aborted process are ignored");
    }
  }
  console.log(
    "PASS questions: full validation, custom/multiple choices, native continuation exactly once, skip, reopen/reconnect state and terminal cleanup",
  );
} finally {
  threads.shutdown();
  PROVIDERS.delete("question-fixture");
  fs.rmSync(data, { recursive: true, force: true });
}

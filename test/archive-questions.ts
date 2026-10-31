import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = process.env.AGENT_CONSOLE_TEST_ROOT || fileURLToPath(new URL("../", import.meta.url));
const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-archive-questions-"));
process.env.AGENT_CONSOLE_DATA = data;
process.env.AGENT_CONSOLE_ENV_FILES = path.join(data, "no-env");
process.env.AGENT_CONSOLE_BRAIN = path.join(data, "no-brain");
process.env.AGENT_CONSOLE_MOCK = "1";
process.env.AGENT_CONSOLE_TURN_STALE_MS = "100";
process.env.AGENT_CONSOLE_QUESTION_STALE_MS = "100";
process.env.AGENT_CONSOLE_LABELS = "0";
const { Threads } = await import(pathToFileURL(path.join(root, "server/threads.ts")).href);
const { PROVIDERS } = await import(
  pathToFileURL(path.join(root, "server/providers/index.ts")).href
);
const { turnsOf } = await import(pathToFileURL(path.join(root, "server/export.ts")).href);
const contexts = new Map<string, any>();
const aborted: string[] = [];
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
        
      },
      steer(text: string) {
        
      },
      answer() {
        throw Error("Async metadata is not a blocking native request");
      },
      abort() {
        aborted.push(t.id);
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
const threads = new Threads(() => {});
const create = () => {
  const t = threads.create({ provider: "async-fixture", cwd: data, title: "Archive fixture" });
  threads.send(t.id, "original task");
  return t;
};
const questions = [{ id: "scope", question: "Which scope?", options: [{ label: "Quick" }, { label: "Full" }] }];
const ask = (t: any, id: string, async = true) =>
  contexts.get(t.id).event({ type: "question", id, questions, ...(async ? { async: true } : {}) });
const durable = () => JSON.parse(fs.readFileSync(path.join(data, "questions.json"), "utf8"));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const blocking = create();
  ask(blocking, "b1", false);
  ask(blocking, "a1");
  assert.equal(blocking.status, "running");
  threads.archive(blocking.id, true);
  assert.equal(blocking.status, "idle");
  assert.equal(blocking.waiting, undefined);
  assert.ok(blocking.archived);
  assert.equal(threads.getQuestions(blocking.id).length, 0);
  assert.ok(aborted.includes(blocking.id), "agent saw the abort");
  assert.equal(durable()[blocking.id], undefined);

  const asyncOnly = create();
  ask(asyncOnly, "a2");
  assert.equal(durable()[asyncOnly.id].length, 1);
  threads.archive(asyncOnly.id, true);
  assert.equal(durable()[asyncOnly.id], undefined, "async question leaves questions.json");
  assert.equal(asyncOnly.waiting, undefined);

  const plain = create();
  threads.archive(plain.id, true);
  assert.equal(plain.status, "running", "a turn without questions keeps running");
  assert.ok(!aborted.includes(plain.id));

  ask(plain, "late", false);
  assert.equal(plain.archived, undefined, "a new question unarchives");
  assert.equal(plain.waiting, 1);

  const hung = create();
  ask(hung, "h1", false);
  hung.archived = Date.now();
  const aged = create();
  ask(aged, "g1", false);
  const fresh = create();
  await pause(150);
  threads.sweep(1);
  assert.equal(hung.status, "idle", "archived thread no longer exempt");
  assert.equal(aged.status, "idle", "over-age question loses the exemption");
  assert.equal(fresh.status, "idle", "silent turn expires too");
  assert.ok(
    (threads.history(aged.id) as any[]).some((e) => e.type === "console_error"),
    "expiry leaves a console_error",
  );
  console.log("archive-questions ok");
} finally {
  threads.shutdown();
  fs.rmSync(data, { recursive: true, force: true });
}

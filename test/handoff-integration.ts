import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-handoff-"));
process.env.AGENT_CONSOLE_DATA = data;
process.env.AGENT_CONSOLE_MOCK = "1";
process.env.AGENT_CONSOLE_BRAIN = path.join(data, "missing-brain");
const { Threads } = await import("../server/threads.ts");
const emitted: any[] = [];
const threads = new Threads(e => emitted.push(e));
try {
  const source = threads.create({ provider: "mock", cwd: data, title: "handoff fixture" });
  const log = path.join(data, "logs", `${source.id}.jsonl`);
  fs.writeFileSync(log, JSON.stringify({ type: "user_input", text: "Original request: stay local." }) + "\n");
  const fork = threads.fork(source.id, undefined, true);
  assert.equal(fork.replayLimit, 6000);
  assert.equal(fork.forkFrom, undefined);
  assert.deepEqual(threads.history(fork.id), threads.history(source.id));
  threads.send(fork.id, "ok");
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("mock handoff did not finish")), 2000);
    const poll = setInterval(() => {
      if (threads.get(fork.id)?.status !== "idle") return;
      clearInterval(poll); clearTimeout(timeout); resolve();
    }, 10);
  });
  const reply = threads.history(fork.id).findLast(e => e.type === "assistant")?.message?.content?.find((b: any) => b.type === "text")?.text;
  assert.match(reply, /fresh session with a short handoff/);
  assert.match(reply, /Original request: stay local/);
  assert.equal(threads.get(fork.id)?.replayLimit, undefined);
  source.provider = "claude";
  source.sessionId = "existing-native-session";
  const nativeFork = threads.fork(source.id);
  assert.equal(nativeFork.forkFrom, source.sessionId);
  const shortFork = threads.fork(source.id, undefined, true);
  assert.equal(shortFork.forkFrom, undefined);
  assert.equal(shortFork.sessionId, undefined);
  assert.equal(shortFork.replayLimit, 6000);
  console.log("PASS short fork first-turn delivery, full transcript retention and native-session isolation");
} finally {
  threads.shutdown();
  fs.rmSync(data, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-queue-edit-"));
process.env.AGENT_CONSOLE_DATA = dir;
process.env.AGENT_CONSOLE_BRAIN = path.join(dir, "no-brain");
process.env.AGENT_CONSOLE_LABELS = "0";
const { Threads } = await import("../server/threads.ts");
const { PROVIDERS } = await import("../server/providers/index.ts");
const { saveUpload } = await import("../server/uploads.ts");
let ctx: any;
const sent: string[] = [];
const sleep = () => new Promise((r) => setTimeout(r, 350));
PROVIDERS.set("fixture", {
  id: "fixture",
  label: "Fixture",
  modes: ["plan"],
  defaultMode: "plan",
  models: () => ["fixture"],
  defaultModel: () => "fixture",
  status: () => ({ ok: true }),
  start(_t, c) {
    ctx = c;
    return {
      alive: true,
      send(text) {
        sent.push(text);
      },
      abort() {},
      kill() {},
    };
  },
});
let threads = new Threads(() => {});
try {
  const t = threads.create({ provider: "fixture", cwd: dir, title: "Fixture" });
  const upload = saveUpload(t.id, "notes.txt", "text/plain", Buffer.from("fixture"));
  threads.send(t.id, "active");
  const original = "original ".repeat(60);
  threads.send(t.id, original, { mode: "queue", attachments: [{ id: upload.id }] });
  threads.send(t.id, "second", { mode: "queue" });
  const [head] = threads.getQueues()[t.id];
  assert.equal(head.text.length, 200);
  const editing = threads.editQueued(t.id, head.id);
  assert.equal(editing.text, original);
  assert.equal(editing.attachments, 1);
  ctx.event({ type: "result", subtype: "success" });
  await sleep();
  assert.equal(sent.length, 1, "held head blocks the whole queue");
  assert.throws(() => threads.saveQueued(t.id, head.id, 0, "x".repeat(100001)), /100,000/);
  threads.saveQueued(t.id, head.id, 0, "updated");
  assert.throws(() => threads.saveQueued(t.id, head.id, 0, "stale"), /changed/);
  await sleep();
  assert.ok(
    sent[1].includes("updated") && sent[1].includes("notes.txt"),
    "text changes retain attachments",
  );
  assert.ok(sent[1].includes("second"), "everything queued goes out together as one prompt");
  assert.equal(threads.getQueues()[t.id], undefined);
  threads.send(t.id, "second", { mode: "queue" });
  const following = threads.getQueues()[t.id][0];
  threads.editQueued(t.id, following.id);
  ctx.event({ type: "result", subtype: "success" });
  await sleep();
  assert.equal(sent.length, 2);
  threads.cancelQueuedEdit(t.id, following.id, 0);
  await sleep();
  assert.equal(sent[2], "second", "Cancel sends the unchanged original");
  threads.send(t.id, "attachment only", { mode: "queue", attachments: [{ id: upload.id }] });
  const attachmentOnly = threads.getQueues()[t.id][0];
  threads.editQueued(t.id, attachmentOnly.id);
  threads.saveQueued(t.id, attachmentOnly.id, 0, "");
  ctx.event({ type: "result", subtype: "success" });
  await sleep();
  assert.ok(sent.at(-1)!.includes("notes.txt"));
  const beforeRestart = sent.length;
  threads.send(t.id, "persist across restart", { mode: "queue" });
  const held = threads.getQueues()[t.id][0];
  threads.editQueued(t.id, held.id);
  threads.shutdown();
  threads = new Threads(() => {});
  await sleep();
  assert.equal(threads.getQueues()[t.id][0].editing, true);
  assert.equal(sent.length, beforeRestart);
  threads.saveQueued(t.id, held.id, 0, "resumed edit");
  await sleep();
  assert.equal(sent.at(-1), "resumed edit");
  threads.send(t.id, "removed", { mode: "queue" });
  const gone = threads.getQueues()[t.id][0];
  threads.editQueued(t.id, gone.id);
  threads.unqueue(t.id, gone.id);
  assert.throws(() => threads.saveQueued(t.id, gone.id, 0, "late"), /no longer queued/);
  assert.equal(fs.statSync(path.join(dir, "queues.json")).mode & 0o777, 0o600);
  threads.send(t.id, "one", { mode: "queue", attachments: [{ id: upload.id }] });
  threads.send(t.id, "two [Image #1]", { mode: "queue" });
  threads.send(t.id, "/compact", { mode: "queue" });
  threads.send(t.id, "three", { mode: "queue" });
  const n = sent.length;
  ctx.event({ type: "result", subtype: "success" });
  await sleep();
  assert.equal(sent.length, n + 1);
  assert.ok(
    sent.at(-1)!.startsWith("one\n\ntwo [Image #1]"),
    "queued messages are joined in order, a command stops the batch",
  );
  assert.equal(threads.getQueues()[t.id].length, 2);
  // a message sent in the gap between turn end and the queue draining joins behind the queue, never ahead of it
  const r = threads.create({ provider: "fixture", cwd: dir, title: "Race" });
  threads.send(r.id, "busy");
  threads.send(r.id, "older", { mode: "queue" });
  const m = sent.length;
  ctx.event({ type: "result", subtype: "success" });
  threads.send(r.id, "newer");
  assert.equal(sent.length, m, "newer waits for the queue");
  await sleep();
  assert.equal(sent.length, m + 1);
  assert.equal(sent.at(-1), "older\n\nnewer", "queued first, then the late message, as one prompt");
  console.log(
    "PASS queue edits: full text, delivery hold/order, attachment preservation, validation, stale writes, cancel, restart persistence, removed-message race and late-message ordering",
  );
} finally {
  threads.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
}

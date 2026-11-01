// Per-thread todo list: CRUD, caps, persistence, cleanup and agent tool text.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-todos-"));
Object.assign(process.env, {
  AGENT_CONSOLE_DATA: data,
  AGENT_CONSOLE_ENV_FILES: path.join(data, "no-env"),
  AGENT_CONSOLE_BRAIN: path.join(data, "no-brain"),
  AGENT_CONSOLE_MOCK: "1",
  AGENT_CONSOLE_LABELS: "0",
});
const { Threads } = await import("../server/threads.ts");
const { Todos } = await import("../server/todos.ts");
const events: any[] = [];
const threads = new Threads((event) => events.push(event));
const thread = threads.create({ provider: "mock", cwd: data, title: "Todos" });
const file = path.join(data, "todos.json");

try {
  assert.deepEqual(threads.todo("get", thread.id), []);
  let list = threads.todo("add", thread.id, { items: "  write tests  " });
  assert.equal(list[0].text, "write tests");
  assert.equal(list[0].by, "user");
  assert.match(list[0].id, /^[A-Za-z0-9_-]{8}$/);
  assert.equal(threads.get(thread.id)?.todoOpen, 1);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(events.some((e) => e.t === "todos" && e.thread === thread.id && e.todos.length === 1));

  const text = threads.todoTool("todo_add", thread.id, { items: ["one", "two"] });
  assert.match(text, /\[ \] \S{8} one/);
  assert.equal(threads.get(thread.id)?.todoOpen, 3);
  list = threads.getTodos(thread.id);
  assert.equal(list[1].by, "agent");

  threads.todoTool("todo_complete", thread.id, { id: list[0].id });
  assert.equal(threads.get(thread.id)?.todoOpen, 2);
  assert.match(threads.todoTool("todo_list", thread.id, {}), /\[x\] /);
  threads.todo("set", thread.id, { id: list[0].id, done: false });
  assert.equal(threads.get(thread.id)?.todoOpen, 3);
  threads.todo("remove", thread.id, { id: list[2].id });
  assert.equal(threads.getTodos(thread.id).length, 2);

  assert.throws(() => threads.todo("add", thread.id, { items: "   " }), /empty/);
  assert.throws(() => threads.todo("add", thread.id, { items: "x".repeat(501) }), /over 500/);
  assert.throws(() => threads.todo("set", thread.id, { id: "nope" }), /No such todo/);
  assert.throws(() => threads.todo("get", "missing-thread"), /No such thread/);
  assert.throws(() => threads.todoTool("todo_list", undefined, {}), /require/);
  assert.throws(() => threads.todoTool("todo_list", "missing-thread", {}), /require/);

  threads.todo("add", thread.id, { items: Array.from({ length: 98 }, (_, i) => `item ${i}`) });
  assert.equal(threads.getTodos(thread.id).length, 100);
  assert.throws(() => threads.todo("add", thread.id, { items: "one more" }), /at most 100/);
  assert.equal(threads.getTodos(thread.id).length, 100);

  const reloaded = new Todos(file);
  assert.equal(reloaded.list(thread.id).length, 100);
  assert.equal(reloaded.list(thread.id)[1].by, "agent");

  threads.remove(thread.id);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {});
  console.log("PASS todos: CRUD, cap, persistence, cleanup, errors");
} finally {
  fs.rmSync(data, { recursive: true, force: true });
  process.exit(0);
}

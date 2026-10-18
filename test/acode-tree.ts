import assert from "node:assert/strict";
import express from "express";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAcodeBridge } from "../server/acode.ts";
const dir = await mkdtemp(path.join(os.tmpdir(), "acode-tree-"));
let now = Date.now();
const bridge = createAcodeBridge(() => ({ cwd: dir }), () => now);
const app = express(); app.use(express.json());
app.post("/create", bridge.create); app.post("/exchange", bridge.exchange);
app.get("/tree", bridge.tree); app.post("/open", bridge.openFile);
app.get("/file", bridge.read); app.put("/file", bridge.save);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
async function request(route: string, method = "GET", body?: unknown, token?: string) {
  const response = await fetch(base + route, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json() as any };
}
async function exchange(file = "repo/src/note.txt") {
  const ticket = await request(`/create?thread=test&path=${encodeURIComponent(file)}`, "POST", {});
  assert.equal(ticket.status, 200);
  const result = await request("/exchange", "POST", { ticket: ticket.body.ticket });
  assert.equal(result.status, 200); return result.body;
}
try {
  await mkdir(path.join(dir, "repo/src"), { recursive: true });
  await mkdir(path.join(dir, "repo/.git"));
  await mkdir(path.join(dir, "other"));
  await writeFile(path.join(dir, "repo/src/note.txt"), "hello");
  await writeFile(path.join(dir, "other/secret.txt"), "unrelated");
  await writeFile(path.join(dir, "repo/.env"), "PASSWORD=no");
  await mkdir(path.join(dir, "repo/.env.hidden"));
  await writeFile(path.join(dir, "repo/.env.hidden/value"), "private");
  await writeFile(path.join(dir, "repo/.agent-console-edit-test"), "temporary");
  await writeFile(path.join(dir, "repo/image.bin"), Buffer.from([255, 254]));
  await symlink(path.join(dir, "other"), path.join(dir, "repo/external"));
  await symlink("src", path.join(dir, "repo/internal"));
  const grant = await exchange(); const token = grant.project.token;
  assert.equal(grant.project.root, path.join(dir, "repo"));
  assert.equal((await request("/tree", "GET", undefined, grant.token)).status, 401);
  assert.equal((await request("/file", "GET", undefined, token)).status, 401);
  const root = await request("/tree", "GET", undefined, token);
  assert.equal(root.status, 200);
  assert.deepEqual(root.body.entries.map((e: any) => e.name).sort(), ["image.bin", "src"]);
  const tree = await request("/tree?path=src", "GET", undefined, token);
  assert.equal(tree.body.entries[0].path, "src/note.txt");
  const opened = await request("/open", "POST", { path: "src/note.txt" }, token);
  assert.equal(opened.status, 200); assert.equal(opened.body.content, "hello");
  const saved = await request("/file", "PUT", { content: "saved", revision: opened.body.revision }, opened.body.token);
  assert.equal(saved.status, 200); assert.equal(await readFile(path.join(dir, "repo/src/note.txt"), "utf8"), "saved");
  for (const target of ["../other/secret.txt", "/etc/passwd", "external/secret.txt", "internal/note.txt", ".env", ".env.hidden/value", ".git/config", ".agent-console-edit-test"]) {
    assert.ok((await request("/open", "POST", { path: target }, token)).status >= 400, target);
  }
  assert.equal((await request("/open", "POST", { path: "image.bin" }, token)).status, 415);
  assert.equal((await request("/tree?cursor=-1", "GET", undefined, token)).status, 400);
  await mkdir(path.join(dir, "repo/many"));
  await Promise.all(Array.from({ length: 205 }, (_, i) => writeFile(path.join(dir, `repo/many/file${i}`), "x")));
  const first = await request("/tree?path=many", "GET", undefined, token);
  assert.equal(first.body.entries.length, 200); assert.equal(first.body.next, 200);
  const second = await request("/tree?path=many&cursor=200", "GET", undefined, token);
  assert.equal(second.body.entries.length, 5); assert.equal(second.body.next, null);
  assert.equal(new Set([...first.body.entries, ...second.body.entries].map((e: any) => e.path)).size, 205);
  await mkdir(path.join(dir, "repo/nested/.git"), { recursive: true });
  await writeFile(path.join(dir, "repo/nested/note.txt"), "nested");
  assert.equal((await exchange("repo/nested/note.txt")).project.root, path.join(dir, "repo/nested"));
  await writeFile(path.join(dir, "root.txt"), "root");
  assert.equal((await exchange("root.txt")).project.root, dir);
  const outside = await mkdtemp(path.join(os.tmpdir(), "acode-outside-"));
  try {
    await writeFile(path.join(outside, "note.txt"), "outside");
    assert.equal((await exchange(path.join(outside, "note.txt"))).project.root, outside);
  } finally { await rm(outside, { recursive: true, force: true }); }
  now += 8 * 60 * 60_000;
  assert.equal((await request("/tree", "GET", undefined, token)).status, 401);
  const fresh = await exchange();
  await rename(path.join(dir, "repo"), path.join(dir, "old-repo"));
  await mkdir(path.join(dir, "repo"));
  assert.equal((await request("/tree", "GET", undefined, fresh.project.token)).status, 409);
  console.log("Acode project tree: scoped root, listing, open/save, credential hiding, symlinks, pagination, expiry and inode replacement passed.");
} finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }

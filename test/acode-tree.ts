import assert from "node:assert/strict";
import express from "express";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rename, rm, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAcodeBridge } from "../server/acode.ts";
const dir = await mkdtemp(path.join(os.tmpdir(), "acode-tree-"));
let now = Date.now();
const bridge = createAcodeBridge(
  () => ({ cwd: dir }),
  () => now,
);
const app = express();
app.use(express.json());
app.post("/create", bridge.create);
app.post("/exchange", bridge.exchange);
app.get("/tree", bridge.tree);
app.post("/open", bridge.openFile);
app.get("/file", bridge.read);
app.put("/file", bridge.save);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
async function request(route: string, method = "GET", body?: unknown, token?: string) {
  const response = await fetch(base + route, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: (await response.json()) as any };
}
async function exchange(file = "repo/src/note.txt") {
  const ticket = await request(`/create?thread=test&path=${encodeURIComponent(file)}`, "POST", {});
  assert.equal(ticket.status, 200);
  const result = await request("/exchange", "POST", { ticket: ticket.body.ticket });
  assert.equal(result.status, 200);
  return result.body;
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
  await symlink("src/note.txt", path.join(dir, "repo/AGENTS.md"));
  await symlink(".env", path.join(dir, "repo/hidden.txt"));
  await symlink("missing.txt", path.join(dir, "repo/dangling.txt"));
  await symlink("/etc/hostname", path.join(dir, "repo/outside.txt"));
  const grant = await exchange();
  const token = grant.project.token;
  assert.equal(
    grant.project.root,
    dir,
    "a nested Git repository must not narrow the thread workspace",
  );
  assert.equal((await request("/tree", "GET", undefined, grant.token)).status, 401);
  assert.equal((await request("/file", "GET", undefined, token)).status, 401);
  const root = await request("/tree", "GET", undefined, token);
  assert.equal(root.status, 200);
  assert.deepEqual(root.body.entries.map((e: any) => e.name).sort(), ["other", "repo"]);
  const repoTree = await request("/tree?path=repo", "GET", undefined, token);
  assert.deepEqual(repoTree.body.entries.map((e: any) => e.name).sort(), [
    "AGENTS.md",
    "image.bin",
    "src",
  ]);
  const tree = await request("/tree?path=repo/src", "GET", undefined, token);
  assert.equal(tree.body.entries[0].path, "repo/src/note.txt");
  const sibling = await request("/open", "POST", { path: "other/secret.txt" }, token);
  assert.equal(sibling.status, 200, "sibling repositories remain reachable within the workspace");
  const opened = await request("/open", "POST", { path: "repo/src/note.txt" }, token);
  assert.equal(opened.status, 200);
  assert.equal(opened.body.content, "hello");
  const saved = await request(
    "/file",
    "PUT",
    { content: "saved", revision: opened.body.revision },
    opened.body.token,
  );
  assert.equal(saved.status, 200);
  assert.equal(await readFile(path.join(dir, "repo/src/note.txt"), "utf8"), "saved");
  const linked = await request("/open", "POST", { path: "repo/AGENTS.md" }, token);
  assert.equal(linked.status, 200);
  assert.equal(linked.body.path, path.join(dir, "repo/AGENTS.md"));
  assert.equal(linked.body.name, "AGENTS.md");
  assert.equal(
    (
      await request(
        "/file",
        "PUT",
        { content: "linked save", revision: linked.body.revision },
        linked.body.token,
      )
    ).status,
    200,
  );
  assert.equal(await readFile(path.join(dir, "repo/src/note.txt"), "utf8"), "linked save");
  assert.equal((await lstat(path.join(dir, "repo/AGENTS.md"))).isSymbolicLink(), true);
  const aliasLaunch = await exchange("repo/AGENTS.md");
  assert.equal(aliasLaunch.path, path.join(dir, "repo/AGENTS.md"));
  const aliasSaved = await request(
    "/file",
    "PUT",
    { content: "launch save", revision: aliasLaunch.revision },
    aliasLaunch.token,
  );
  assert.equal(aliasSaved.status, 200);
  assert.equal(await readFile(path.join(dir, "repo/src/note.txt"), "utf8"), "launch save");
  assert.equal((await lstat(path.join(dir, "repo/AGENTS.md"))).isSymbolicLink(), true);
  await rm(path.join(dir, "repo/AGENTS.md"));
  await symlink("../other/secret.txt", path.join(dir, "repo/AGENTS.md"));
  assert.equal((await request("/file", "GET", undefined, linked.body.token)).status, 409);
  assert.equal(
    (
      await request(
        "/file",
        "PUT",
        { content: "wrong", revision: aliasLaunch.revision },
        aliasLaunch.token,
      )
    ).status,
    409,
  );
  assert.equal(await readFile(path.join(dir, "other/secret.txt"), "utf8"), "unrelated");
  for (const alias of ["repo/hidden.txt", "repo/dangling.txt", "repo/outside.txt"]) {
    assert.ok((await request("/open", "POST", { path: alias }, token)).status >= 400, alias);
    assert.ok(
      (await request(`/create?thread=test&path=${encodeURIComponent(alias)}`, "POST", {})).status >=
        400,
      alias,
    );
  }
  for (const target of [
    "../other/secret.txt",
    "/etc/passwd",
    "repo/external/secret.txt",
    "repo/internal/note.txt",
    "repo/.env",
    "repo/.env.hidden/value",
    "repo/.git/config",
    "repo/.agent-console-edit-test",
  ]) {
    assert.ok((await request("/open", "POST", { path: target }, token)).status >= 400, target);
  }
  assert.equal((await request("/open", "POST", { path: "repo/image.bin" }, token)).status, 415);
  assert.equal((await request("/open", "POST", { path: "repo/tsconfig.json" }, token)).status, 404);
  assert.equal(
    (await request("/open", "POST", { path: "repo/src/note.txt/child" }, token)).status,
    404,
  );
  assert.equal((await request("/tree?cursor=-1", "GET", undefined, token)).status, 400);
  await mkdir(path.join(dir, "repo/many"));
  await Promise.all(
    Array.from({ length: 205 }, (_, i) => writeFile(path.join(dir, `repo/many/file${i}`), "x")),
  );
  const first = await request("/tree?path=repo/many", "GET", undefined, token);
  assert.equal(first.body.entries.length, 200);
  assert.equal(first.body.next, 200);
  const second = await request("/tree?path=repo/many&cursor=200", "GET", undefined, token);
  assert.equal(second.body.entries.length, 5);
  assert.equal(second.body.next, null);
  assert.equal(
    new Set([...first.body.entries, ...second.body.entries].map((e: any) => e.path)).size,
    205,
  );
  await mkdir(path.join(dir, "repo/nested/.git"), { recursive: true });
  await writeFile(path.join(dir, "repo/nested/note.txt"), "nested");
  assert.equal((await exchange("repo/nested/note.txt")).project.root, dir);
  await writeFile(path.join(dir, "root.txt"), "root");
  assert.equal((await exchange("root.txt")).project.root, dir);
  const outside = await mkdtemp(path.join(os.tmpdir(), "acode-outside-"));
  try {
    await writeFile(path.join(outside, "note.txt"), "outside");
    assert.equal((await exchange(path.join(outside, "note.txt"))).project.root, outside);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
  now += 100 * 365 * 24 * 60 * 60_000;
  assert.equal((await request("/tree", "GET", undefined, token)).status, 200);
  const fresh = await exchange();
  await rename(dir, dir + "-old");
  await mkdir(dir);
  assert.equal((await request("/tree", "GET", undefined, fresh.project.token)).status, 409);
  console.log(
    "Acode project tree: scoped root, listing, open/save, credential hiding, symlinks, pagination, expiry and inode replacement passed.",
  );
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
  await rm(dir + "-old", { recursive: true, force: true });
}

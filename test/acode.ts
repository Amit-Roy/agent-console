import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import {
  chmod,
  link,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { createAcodeBridge } from "../server/acode.ts";

const dir = await mkdtemp(path.join(os.tmpdir(), "acode-test-"));
let now = Date.now();
const bridge = createAcodeBridge(
  (id) => (id === "test" ? { cwd: dir, id } : undefined),
  () => now,
);
const app = express();
app.use(express.json({ limit: "2mb" }));
app.post(
  "/create",
  (req, res, next) => (req.get("Authorization") === "owner" ? next() : res.sendStatus(401)),
  bridge.create,
);
app.use((req, res, next) => {
  const origin = req.get("Origin");
  if (
    origin &&
    !["null", "file://", "https://localhost", "http://localhost", "http://localhost:8080"].includes(
      origin,
    )
  ) {
    res.sendStatus(403);
    return;
  }
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  next();
});
app.post("/exchange", bridge.exchange);
app.get("/file", bridge.read);
app.put("/file", bridge.save);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
async function request(
  route: string,
  method = "GET",
  body?: unknown,
  auth?: string,
  origin?: string,
) {
  const response = await fetch(base + route, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(auth ? { Authorization: auth } : {}),
      ...(origin ? { Origin: origin } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (() => {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    })(),
    response,
  };
}
async function ticket(file = "note.txt") {
  return request(`/create?thread=test&path=${encodeURIComponent(file)}`, "POST", {}, "owner");
}
async function grant() {
  const created = await ticket();
  assert.equal(created.status, 200);
  const exchanged = await request("/exchange", "POST", { ticket: created.body.ticket });
  assert.equal(exchanged.status, 200);
  return { created, exchanged, auth: `Bearer ${exchanged.body.token}` };
}
try {
  await writeFile(path.join(dir, "note.txt"), "hello\n");
  await chmod(path.join(dir, "note.txt"), 0o640);
  assert.equal((await request("/create?thread=test&path=note.txt", "POST", {})).status, 401);
  assert.equal((await request("/file")).status, 401);
  const { created, exchanged, auth } = await grant();
  assert.equal(exchanged.body.content, "hello\n");
  assert.equal((await request("/exchange", "POST", { ticket: created.body.ticket })).status, 401);
  assert.equal(
    (await request("/file", "GET", undefined, auth, "https://evil.example")).status,
    403,
  );
  assert.equal(
    (await request("/file", "GET", undefined, auth, "null")).response.headers.get(
      "Access-Control-Allow-Origin",
    ),
    "null",
  );
  const saved = await request(
    "/file",
    "PUT",
    { content: "edited\n", revision: exchanged.body.revision },
    auth,
  );
  assert.equal(saved.status, 200);
  assert.equal(await readFile(path.join(dir, "note.txt"), "utf8"), "edited\n");
  assert.equal((await stat(path.join(dir, "note.txt"))).mode & 0o777, 0o640);
  assert.equal(
    (await request("/file", "PUT", { content: "stale", revision: exchanged.body.revision }, auth))
      .status,
    409,
  );
  const snap = await request("/file", "GET", undefined, auth);
  const both = await Promise.all(
    ["first", "second"].map((content) =>
      request("/file", "PUT", { content, revision: snap.body.revision }, auth),
    ),
  );
  assert.deepEqual(both.map((x) => x.status).sort(), [200, 409]);
  assert.equal(
    (await request("/file", "PUT", { content: "\0", revision: saved.body.revision }, auth)).status,
    403,
  );
  assert.equal(
    (
      await request(
        "/file",
        "PUT",
        { content: "x".repeat((1 << 20) + 1), revision: saved.body.revision },
        auth,
      )
    ).status,
    413,
  );
  for (const [name, content] of [
    [".env", "secret"],
    ["binary.txt", Buffer.from([0xff])],
    ["private.txt", "-----BEGIN RSA PRIVATE KEY-----\n"],
  ] as const) {
    await writeFile(path.join(dir, name), content);
    assert.ok((await ticket(name)).status >= 400);
  }
  await writeFile(path.join(dir, "huge.txt"), "x".repeat((1 << 20) + 1));
  assert.equal((await ticket("huge.txt")).status, 413);
  const latest = await request("/file", "GET", undefined, auth);
  const peer = await grant();
  const again = await request(
    "/file",
    "PUT",
    { content: "again", revision: latest.body.revision },
    auth,
  );
  assert.equal(again.status, 200);
  assert.equal(
    (
      await request(
        "/file",
        "PUT",
        { content: "stale peer", revision: peer.exchanged.body.revision },
        peer.auth,
      )
    ).status,
    409,
  );
  const peerLatest = await request("/file", "GET", undefined, peer.auth);
  assert.equal(
    (
      await request(
        "/file",
        "PUT",
        { content: "peer save", revision: peerLatest.body.revision },
        peer.auth,
      )
    ).status,
    200,
  );
  await link(path.join(dir, "note.txt"), path.join(dir, "hardlink.txt"));
  const linked = await request("/file", "GET", undefined, auth);
  assert.equal(
    (await request("/file", "PUT", { content: "blocked", revision: linked.body.revision }, auth))
      .status,
    403,
  );
  await rm(path.join(dir, "hardlink.txt"));
  // Inject filesystem failures on temporary handles, without changing production APIs.
  const probe = await open(path.join(dir, "probe.txt"), "w");
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalWrite = prototype.writeFile;
  prototype.writeFile = async function (...args: any[]) {
    if (realpathSync(`/proc/self/fd/${this.fd}`).includes(".agent-console-edit-"))
      throw new Error("Injected disk failure");
    return originalWrite.apply(this, args);
  };
  const beforeFailure = await request("/file", "GET", undefined, auth);
  try {
    assert.equal(
      (
        await request(
          "/file",
          "PUT",
          { content: "never written", revision: beforeFailure.body.revision },
          auth,
        )
      ).status,
      403,
    );
  } finally {
    prototype.writeFile = originalWrite;
  }
  assert.equal(await readFile(path.join(dir, "note.txt"), "utf8"), beforeFailure.body.content);
  assert.equal((await readdir(dir)).filter((x) => x.startsWith(".agent-console-edit-")).length, 0);
  const originalSync = prototype.sync;
  prototype.sync = async function (...args: any[]) {
    if (realpathSync(`/proc/self/fd/${this.fd}`).includes(".agent-console-edit-")) {
      await writeFile(path.join(dir, "replacement.txt"), "external replacement");
      await rename(path.join(dir, "replacement.txt"), path.join(dir, "note.txt"));
    }
    return originalSync.apply(this, args);
  };
  try {
    assert.equal(
      (
        await request(
          "/file",
          "PUT",
          { content: "must conflict", revision: beforeFailure.body.revision },
          auth,
        )
      ).status,
      409,
    );
  } finally {
    prototype.sync = originalSync;
  }
  assert.equal(await readFile(path.join(dir, "note.txt"), "utf8"), "external replacement");
  assert.equal((await readdir(dir)).filter((x) => x.startsWith(".agent-console-edit-")).length, 0);
  const expiring = await ticket();
  now += 60_001;
  assert.equal((await request("/exchange", "POST", { ticket: expiring.body.ticket })).status, 401);
  const withinTtl = await grant();
  now += 11 * 60 * 60_000;
  assert.equal((await request("/file", "GET", undefined, withinTtl.auth)).status, 200);
  const pastTtl = await grant();
  now += 12 * 60 * 60_000 + 1;
  assert.equal((await request("/file", "GET", undefined, pastTtl.auth)).status, 401);
  const swapped = await grant();
  await rename(path.join(dir, "note.txt"), path.join(dir, "old.txt"));
  await symlink(path.join(dir, "old.txt"), path.join(dir, "note.txt"));
  assert.equal((await request("/file", "GET", undefined, swapped.auth)).status, 409);
  assert.equal(
    (
      await request(
        "/file",
        "PUT",
        { content: "bad", revision: swapped.exchanged.body.revision },
        swapped.auth,
      )
    ).status,
    409,
  );
  assert.notEqual(await readFile(path.join(dir, "old.txt"), "utf8"), "bad");
  console.log(
    "Acode bridge: authentication, replay, expiry, save, conflict, concurrent saves, mode, CORS, symlink, secrets, binary and size checks passed.",
  );
} finally {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  await rm(dir, { recursive: true, force: true });
}

// Isolated real HTTP API: no model calls, live threads or production credentials.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { MAX_VIEW_BYTES, MAX_PREVIEW_IMAGE_BYTES, TREE_PAGE_SIZE } from "../server/files.ts";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ac-files-"));
const data = path.join(temp, "data"), cwd = path.join(temp, "project");
fs.mkdirSync(data); fs.mkdirSync(cwd);
const id = "11111111-1111-4111-8111-111111111111";
const alias = path.join(temp, "project-alias"), aliasId = "22222222-2222-4222-8222-222222222222";
fs.symlinkSync(cwd, alias);
fs.writeFileSync(path.join(data, "threads.json"), JSON.stringify([{ id, cwd }, { id: aliasId, cwd: alias }].map(thread => ({ ...thread, provider: "mock", model: "echo", mode: "plan", title: "File fixture", status: "idle", createdAt: 1, updatedAt: 1, cost: 0 }))));
const port = process.env.FILE_API_TEST_PORT || "7073";
assert.match(port, /^707[1-5]$/, "use an isolated scratch port, 7071–7075");
const repos = path.join(os.homedir(), "repos");
const workspace = fs.mkdtempSync(path.join(repos, "ac-files-scope-"));
fs.writeFileSync(path.join(workspace, "workspace.ts"), "export const workspace = true;");
const base = `http://127.0.0.1:${port}`;
const password = "isolated-file-preview-fixture";
const server = spawn(process.execPath, ["server/index.ts"], {
  cwd: path.resolve(import.meta.dirname, ".."), stdio: "ignore",
  env: { ...process.env, PORT: String(port), AGENT_CONSOLE_DATA: data, AGENT_CONSOLE_RUN: data, AGENT_CONSOLE_PID_FILE: "", AGENT_CONSOLE_AUTH: "password", AGENT_CONSOLE_PASSWORD: password, AGENT_CONSOLE_MOCK: "1", AGENT_CONSOLE_HEADROOM: "0" },
});
let cookie = "";
const file = (requested: string, thread = id) => fetch(`${base}/api/file?${new URLSearchParams({ thread, path: requested })}`, { headers: { cookie }, signal: AbortSignal.timeout(3000) });
const tree = (requested = ".", cursor?: string, thread = id) => fetch(`${base}/api/files?${new URLSearchParams({ thread, path: requested, ...(cursor ? { cursor } : {}) })}`, { headers: { cookie }, signal: AbortSignal.timeout(3000) });
const put = (name: string, content: string | Buffer) => fs.writeFileSync(path.join(cwd, name), content);
try {
  for (let attempt = 0; ; attempt++) {
    try { await fetch(`${base}/api/file`, { signal: AbortSignal.timeout(500) }); break; }
    catch { if (attempt === 199 || server.exitCode !== null) throw Error("Isolated file API did not start."); }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  put("hello.ts", "const greeting = 'héllo';\n");
  assert.equal((await file("hello.ts")).status, 401, "API requires authentication");
  assert.equal((await tree()).status, 401, "tree requires authentication");
  assert.equal((await fetch(`${base}/api/file-image?thread=${id}&path=hello.ts`)).status, 401, "image requires authentication");
  const login = await fetch(`${base}/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200); cookie = login.headers.get("set-cookie")!.split(";")[0];
  const scoped = (endpoint: string, params: Record<string, string> = {}, authenticated = true) => fetch(`${base}/api/${endpoint}?${new URLSearchParams({ scope: "repos", ...params })}`, { headers: authenticated ? { cookie } : {}, signal: AbortSignal.timeout(3000) });
  for (const endpoint of ["files", "file", "file-image"]) assert.equal((await scoped(endpoint, {}, false)).status, 401, "workspace scope requires authentication");
  const rootListing = await (await scoped("files")).json();
  assert.equal(rootListing.root, repos); assert.equal(rootListing.path, repos);
  assert.equal((await scoped("files", { path: workspace })).status, 200);
  assert.equal((await scoped("file", { path: path.join(workspace, "workspace.ts") })).status, 200, "workspace needs no thread");
  assert.equal((await file(path.join(workspace, "workspace.ts"))).status, 200, "thread scope reaches the rest of home");
  assert.equal((await scoped("file", { path: "/etc/hostname" })).status, 403, "system files stay closed");
  fs.writeFileSync(path.join(workspace, ".env"), "private workspace fixture");
  fs.symlinkSync("/etc", path.join(workspace, "outside"));
  assert.equal((await scoped("file", { path: path.join(workspace, ".env") })).status, 403);
  assert.equal((await scoped("file", { path: path.join(workspace, "outside", "hostname") })).status, 403);
  for (const endpoint of ["files", "file", "file-image"]) {
    assert.equal((await scoped(endpoint, { scope: "home", path: workspace })).status, 400);
    assert.equal((await scoped(endpoint, { thread: id, path: workspace })).status, 400, "reject ambiguous scope");
  }
  const response = await file("hello.ts");
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type")!, /application\/json/);
  const initial = await response.json();
  assert.deepEqual({ kind: initial.kind, root: initial.root, path: initial.path, name: initial.name, content: initial.content, bytes: initial.bytes }, { kind: "text", root: cwd, path: path.join(cwd, "hello.ts"), name: "hello.ts", content: "const greeting = 'héllo';\n", bytes: Buffer.byteLength("const greeting = 'héllo';\n") });
  assert.ok(initial.read_ms >= 0);
  assert.match(response.headers.get("server-timing")!, /^file;dur=\d/);
  assert.equal((await file(path.join(cwd, "hello.ts"))).status, 200, "absolute source link");
  assert.equal((await file(path.join(alias, "hello.ts"), aliasId)).status, 200, "absolute link using a symlink cwd");
  assert.equal((await file("hello.ts", aliasId)).status, 200, "relative link using a symlink cwd");
  assert.equal((await file(path.join(cwd, "hello.ts"), aliasId)).status, 200, "absolute real path using a symlink cwd");
  put("markup.html", "<script>window.pwned=true</script>");
  assert.equal((await (await file("markup.html")).json()).content, "<script>window.pwned=true</script>", "HTML is JSON text");
  put("empty", ""); assert.equal((await (await file("empty")).json()).content, "");
  assert.equal((await file("hello.ts", "missing")).status, 404);
  assert.equal((await file("missing.ts")).status, 404);
  assert.equal((await file("")).status, 400);
  assert.equal((await file("bad\0path")).status, 400);
  assert.equal((await file(".")).status, 415);
  fs.writeFileSync(path.join(temp, "outside.txt"), "outside");
  assert.equal((await file("../outside.txt")).status, 200, "temp outside cwd is viewable");
  assert.equal((await file(path.join(temp, "outside.txt"))).status, 200);
  assert.equal((await file("/proc/self/environ")).status, 403, "server environment stays closed");
  assert.equal((await file(path.join(os.homedir(), ".claude", ".credentials.json"))).status, 403);
  fs.symlinkSync("/etc/hostname", path.join(cwd, "escape"));
  assert.equal((await file("escape")).status, 403, "symlink cannot escape home");
  fs.symlinkSync(path.join(cwd, "hello.ts"), path.join(cwd, "inside"));
  assert.equal((await file("inside")).status, 200, "in-project symlink is safe");
  fs.mkdirSync(path.join(cwd, "projx", "pub"), { recursive: true }); fs.writeFileSync(path.join(cwd, "projx", "pub", "uniq.js"), "1");
  assert.equal((await file("pub/uniq.js")).status, 200, "relative path found in the single subfolder holding it");
  fs.mkdirSync(path.join(cwd, "projy", "pub"), { recursive: true }); fs.writeFileSync(path.join(cwd, "projy", "pub", "uniq.js"), "2");
  assert.equal((await file("pub/uniq.js")).status, 404, "ambiguous relative path stays missing");
  fs.mkdirSync(path.join(temp, "home"));
  fs.symlinkSync(path.join(cwd, "hello.ts"), path.join(temp, "home", "link.ts"));
  assert.equal((await file(path.join(temp, "home", "link.ts"))).status, 200, "outside-path link resolving inside cwd is viewable");
  for (const name of [".env", ".env.local", "credentials.json", ".credentials.json", ".bash_history", "auth.json", "id_ed25519", "secret", "private.pem"]) {
    put(name, "private fixture"); assert.equal((await file(name)).status, 403, `refuse ${name}`);
  }
  fs.symlinkSync(path.join(cwd, ".env"), path.join(cwd, "friendly.txt"));
  assert.equal((await file("friendly.txt")).status, 403, "credential symlink is refused");
  fs.mkdirSync(path.join(cwd, ".git")); put(".git/config", "private remote");
  assert.equal((await file(".git/config")).status, 403);
  put("innocent.txt", "-----BEGIN OPENSSH PRIVATE KEY-----\nfixture");
  assert.equal((await file("innocent.txt")).status, 403, "private-key bytes are refused");
  put("binary", Buffer.from([65, 0, 66])); assert.equal((await file("binary")).status, 415);
  put("invalid-utf8", Buffer.from([0xff, 0xfe])); assert.equal((await file("invalid-utf8")).status, 415);
  put("limit.txt", Buffer.alloc(MAX_VIEW_BYTES, 65)); assert.equal((await file("limit.txt")).status, 200);
  put("large.txt", Buffer.alloc(MAX_VIEW_BYTES + 1, 65)); assert.equal((await file("large.txt")).status, 413);
  if (process.platform !== "win32") {
    execFileSync("mkfifo", [path.join(cwd, "pipe")]);
    assert.equal((await file("pipe")).status, 415, "named pipe cannot block a request");
  }
  // Image previews use sniffed bytes, independent of extension, and an authenticated
  // binary route. The JSON metadata never carries base64/image payloads.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6koAAAAAASUVORK5CYII=", "base64");
  for (const [name, bytes, media_type] of [
    ["picture.dat", png, "image/png"],
    ["picture.jpg", Buffer.from([255, 216, 255, 224, 0, 16]), "image/jpeg"],
    ["picture.gif", Buffer.from("GIF89a"), "image/gif"],
    ["picture.webp", Buffer.from("RIFF0000WEBP"), "image/webp"],
  ] as const) {
    put(name, bytes);
    const meta = await (await file(name)).json();
    assert.equal(meta.kind, "image"); assert.equal(meta.media_type, media_type);
    assert.equal(meta.bytes, bytes.length); assert.equal(meta.content, undefined); assert.equal(meta.data, undefined);
    const raw = await fetch(base + meta.url, { headers: { cookie } });
    assert.equal(raw.status, 200); assert.equal(raw.headers.get("content-type"), media_type);
    assert.equal(raw.headers.get("cache-control"), "no-store");
    assert.equal(raw.headers.get("x-content-type-options"), "nosniff");
    assert.equal(raw.headers.get("content-disposition"), "inline");
    assert.match(raw.headers.get("server-timing")!, /^file;dur=\d/);
    assert.deepEqual(Buffer.from(await raw.arrayBuffer()), bytes);
    assert.equal((await fetch(base + meta.url)).status, 401);
  }
  fs.writeFileSync(path.join(workspace, "workspace.png"), png);
  const workspaceImage = await (await scoped("file", { path: path.join(workspace, "workspace.png") })).json();
  assert.equal(new URL(workspaceImage.url, base).searchParams.get("scope"), "repos");
  assert.equal(new URL(workspaceImage.url, base).searchParams.has("thread"), false);
  assert.deepEqual(Buffer.from(await (await fetch(base + workspaceImage.url, { headers: { cookie } })).arrayBuffer()), png);
  put("fake.png", "<svg onload='alert(1)'></svg>");
  const rawFile = (requested: string) => fetch(`${base}/api/file-image?${new URLSearchParams({ thread: id, path: requested })}`, { headers: { cookie } });
  assert.equal((await rawFile("fake.png")).status, 415);
  assert.equal((await rawFile(".env")).status, 403);
  assert.equal((await rawFile("escape")).status, 403);
  put("large.png", Buffer.concat([png.subarray(0, 16), Buffer.alloc(MAX_PREVIEW_IMAGE_BYTES)]));
  assert.equal((await file("large.png")).status, 413); assert.equal((await rawFile("large.png")).status, 413);
  put("limit.png", Buffer.concat([png.subarray(0, 16), Buffer.alloc(MAX_PREVIEW_IMAGE_BYTES - 16)]));
  assert.equal((await file("limit.png")).status, 200); assert.equal((await rawFile("limit.png")).status, 200);

  fs.mkdirSync(path.join(cwd, "src")); put("src/nested.ts", "export {};");
  let listingResponse = await tree();
  assert.equal(listingResponse.status, 200); assert.match(listingResponse.headers.get("server-timing")!, /^tree;dur=\d/);
  const listing = await listingResponse.json();
  assert.equal(listing.root, cwd); assert.equal(listing.path, cwd); assert.equal(listing.parent, null);
  assert.ok(listing.bytes > 0); assert.ok(listing.read_ms >= 0);
  assert.deepEqual(listing.entries.find((e: any) => e.name === "src"), { name: "src", path: path.join(cwd, "src"), kind: "directory" });
  assert.ok(listing.entries.some((e: any) => e.name === "hello.ts" && e.kind === "file"));
  for (const excluded of [".git", ".env", ".env.local", "credentials.json", "escape", "friendly.txt", "pipe"]) assert.ok(!listing.entries.some((e: any) => e.name === excluded), `omit sensitive/symlink/special entry ${excluded}`);
  assert.ok(listing.entries.some((e: any) => e.name === "inside" && e.kind === "file"), "in-root symlink listed");
  const nested = await (await tree("src")).json(); assert.equal(nested.parent, cwd); assert.equal(nested.entries.length, 1);
  assert.equal((await tree("../")).status, 200); assert.equal((await tree("/etc")).status, 403); assert.equal((await tree(".git")).status, 403);
  assert.equal((await tree(".", "-1")).status, 400); assert.equal((await tree(".", "100001")).status, 400);
  assert.equal((await tree(".", "broken")).status, 400); assert.equal((await tree(".", undefined, "missing")).status, 404);
  assert.equal((await tree("hello.ts")).status, 404);
  assert.equal((await tree(".", undefined, aliasId)).status, 200, "tree accepts a symlink thread cwd");
  fs.mkdirSync(path.join(cwd, "many"));
  for (let n = 0; n < TREE_PAGE_SIZE * 2 + 3; n++) put(`many/item-${n}.txt`, "x");
  const seen = new Set<string>(); let cursor: string | undefined, pages = 0;
  do {
    const page = await (await tree("many", cursor)).json(); pages++;
    assert.ok(page.entries.length <= TREE_PAGE_SIZE); assert.ok(pages < 6);
    for (const entry of page.entries) { assert.ok(!seen.has(entry.path)); seen.add(entry.path); }
    cursor = page.cursor ?? undefined; assert.equal(page.truncated, !!cursor);
  } while (cursor);
  assert.equal(seen.size, TREE_PAGE_SIZE * 2 + 3); assert.equal(pages, 3);
  fs.mkdirSync(path.join(cwd, "filtered"));
  for (let n = 0; n < 1002; n++) put(`filtered/credentials.${n}`, "private");
  const filtered = await (await tree("filtered")).json();
  assert.equal(filtered.entries.length, 0); assert.equal(filtered.cursor, "1000"); assert.equal(filtered.truncated, true, "bounded scan still advances cursor through hidden entries");
  const filteredRest = await (await tree("filtered", filtered.cursor)).json();
  assert.equal(filteredRest.cursor, null); assert.equal(filteredRest.entries.length, 0);
  console.log("PASS file API: authentication, absolute/relative UTF-8 text and HTML-as-JSON, scope/symlinks, secrets/private keys, binary/special files, text/image byte boundaries, authenticated image sniffing/headers, scoped nonrecursive paginated tree and timing metrics");
} finally {
  if (server.exitCode === null) { server.kill("SIGTERM"); await new Promise<void>(resolve => server.once("exit", () => resolve())); }
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(temp, { recursive: true, force: true });
}

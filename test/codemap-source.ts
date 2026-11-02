// Codemap source resolution + store tests. Run: node test/codemap-source.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codemap-source-"));
process.env.AGENT_CONSOLE_DATA = path.join(tmp, "data");
const src = await import("../server/codemap/source.ts");
const store = await import("../server/codemap/store.ts");

// parseSource rejects
for (const bad of [
  "ssh://git@github.com/a/b",
  "file:///tmp/x",
  "git@github.com:a/b.git",
  "https://gitlab.com/a/b",
  "https://evil.com/a/b",
  "a/b/c",
  "-x/y",
  "own er/repo",
  "a/..",
  "../x",
]) {
  assert.throws(() => src.parseSource(bad), undefined, `rejects ${bad}`);
}
// parseSource github forms
const want = { kind: "github", owner: "nefr0", repo: "agent-console" };
for (const validInput of [
  "nefr0/agent-console",
  "https://github.com/nefr0/agent-console",
  "https://github.com/nefr0/agent-console.git",
  "github.com/nefr0/agent-console",
]) {
  assert.deepEqual(src.parseSource(validInput), want, validInput);
}
assert.equal(src.slugFor(want), "gh-nefr0-agent-console");
assert.deepEqual(src.parseSource("/etc"), { kind: "local", path: "/etc" });

// local resolution
const root = path.join(tmp, "repos");
fs.mkdirSync(path.join(root, "good", ".git"), { recursive: true });
fs.mkdirSync(path.join(root, "plain"), { recursive: true });
fs.symlinkSync("/etc", path.join(root, "link"));
const local = (p: string) => src.resolveLocal(src.parseSource(p), root);
assert.equal(local(path.join(root, "good")), fs.realpathSync(path.join(root, "good")));
assert.throws(() => local("/etc"), /inside/);
assert.throws(() => local(path.join(root, "plain")), /not a git repo/);
assert.throws(() => local(path.join(root, "link")), /inside/);
assert.throws(() => local(path.join(root, "good", "..", "..", "etc")), /inside|not found/);
assert.equal(src.slugFor({ kind: "local", path: "/x/My_Repo.v2" }), "my-repo-v2");

// clone fixture from a local bare repo
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  });
const work = path.join(tmp, "work");
fs.mkdirSync(work);
git(work, "init", "-q", "-b", "main");
for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(work, `f${i}.txt`), "x".repeat(100));
git(work, "add", ".");
git(work, "commit", "-q", "-m", "init");
const bases = path.join(tmp, "bases");
fs.mkdirSync(path.join(bases, "acme"), { recursive: true });
git(tmp, "clone", "-q", "--bare", work, path.join(bases, "acme", "fixture.git"));
const fixture = { kind: "github" as const, owner: "acme", repo: "fixture" };

const dest = path.join(tmp, "clone-ok");
await src.cloneGithub(fixture, dest, { urlBase: bases });
assert.equal(git(dest, "config", "core.symlinks").trim(), "false");
assert.match(await src.headSha(dest), /^[0-9a-f]{40}$/);
await src.refreshGithub(fixture, dest, { urlBase: bases });

const big = path.join(tmp, "clone-big");
await assert.rejects(src.cloneGithub(fixture, big, { urlBase: bases, maxFiles: 2 }), /limits/);
assert.equal(fs.existsSync(big), false, "oversized clone removed");
const bigBytes = path.join(tmp, "clone-bytes");
await assert.rejects(
  src.cloneGithub(fixture, bigBytes, { urlBase: bases, maxBytes: 10 }),
  /limits/,
);
assert.equal(fs.existsSync(bigBytes), false);

// store
const data = process.env.AGENT_CONSOLE_DATA;
assert.equal(store.mapsDir(), path.join(data, "maps"));
const meta = (slug: string, updatedAt = 1) => ({
  slug,
  label: slug,
  source: { kind: "local" as const, ref: slug },
  status: "queued" as const,
  createdAt: 1,
  updatedAt,
});
assert.deepEqual(store.listMaps(), []);
store.writeMeta(meta("alpha"));
store.writeMeta({ ...meta("alpha"), status: "ready", updatedAt: 2 });
assert.equal(store.readMeta("alpha")?.status, "ready");
assert.deepEqual(fs.readdirSync(store.mapDir("alpha")), ["meta.json"], "no tmp leftovers");
fs.mkdirSync(path.join(store.mapDir("alpha"), "clone"));
assert.equal(store.listMaps().length, 1);
assert.throws(() => store.deleteMap("../x"), /invalid map slug/);
store.deleteMap("alpha");
assert.equal(fs.existsSync(store.mapDir("alpha")), false);
for (let i = 0; i < store.MAX_MAPS; i++) store.writeMeta(meta(`m${i}`));
assert.throws(() => store.assertCapacity("new"), /limit/);
store.assertCapacity("m3");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("codemap-source ok");

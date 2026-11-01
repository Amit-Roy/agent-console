// Shadow-git checkpoints on a git repo and a plain folder. Run: node test/checkpoints.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { list, prune, restore, snapshot } from "../server/checkpoints.ts";

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoints-"));
const dataDir = path.join(workRoot, "data");
const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const put = (root: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const take = async (cwd: string, kind = "tool") => {
  const made = await snapshot({ cwd, threadId: "t1", kind: kind as "tool", dataDir });
  assert.ok(made && "seq" in made, "snapshot created");
  return made;
};

// Git repo with tracked, ignored, large and secret files.
const repo = path.join(workRoot, "repo");
fs.mkdirSync(repo);
run(repo, "init", "-q");
run(repo, "config", "user.email", "t@t");
run(repo, "config", "user.name", "t");
put(repo, "a.txt", "one\n");
put(repo, "gone.txt", "delete me\n");
put(repo, ".gitignore", "ignored.log\n");
run(repo, "add", "-A");
run(repo, "commit", "-qm", "init");
put(repo, "untracked.txt", "new\n");
put(repo, "ignored.log", "noise\n");
put(repo, ".env", "TOKEN=x\n");
fs.writeFileSync(path.join(repo, "huge.bin"), Buffer.alloc(10 * 1024 * 1024 + 1));
put(repo, "node_modules/pkg/index.js", "x\n");

const gitFiles = [".git/HEAD", ".git/index"].map((rel) => fs.readFileSync(path.join(repo, rel)));
const porcelain = run(repo, "status", "--porcelain");

const first = await take(repo, "turn_start");
const names = first.files.map((file) => file.p).sort();
assert.deepEqual(names, [".gitignore", "a.txt", "gone.txt", "untracked.txt"]);
assert.deepEqual(first.skipped, ["huge.bin"]);
assert.equal(first.head, run(repo, "rev-parse", "HEAD"));
assert.equal(first.seq, 1);
assert.ok(first.files.every((file) => file.s === "A"));

assert.equal(await snapshot({ cwd: repo, threadId: "t1", kind: "tool", dataDir }), null);

put(repo, "a.txt", "two\n");
fs.rmSync(path.join(repo, "gone.txt"));
put(repo, "created.txt", "made\n");
const second = await take(repo);
assert.equal(second.seq, 2);
const status = Object.fromEntries(second.files.map((file) => [file.p, file.s]));
assert.deepEqual(status, { "a.txt": "M", "gone.txt": "D", "created.txt": "A" });

await restore(repo, "t1", first.commit, dataDir);
assert.equal(read(repo, "a.txt"), "one\n");
assert.equal(read(repo, "gone.txt"), "delete me\n");
assert.ok(!fs.existsSync(path.join(repo, "created.txt")), "created file removed");
assert.equal(read(repo, "ignored.log"), "noise\n");
assert.equal(read(repo, ".env"), "TOKEN=x\n");
assert.ok(fs.existsSync(path.join(repo, "huge.bin")), "skipped file untouched");

const after = [".git/HEAD", ".git/index"].map((rel) => fs.readFileSync(path.join(repo, rel)));
assert.deepEqual(after, gitFiles, "user .git HEAD and index unchanged");
assert.equal(run(repo, "status", "--porcelain"), porcelain, "git status unchanged by restore");

const rows = await list("t1", repo, dataDir);
assert.deepEqual(
  rows.map((row) => [row.seq, row.kind]),
  [
    [1, "turn_start"],
    [2, "tool"],
  ],
);

// Plain folder, no git at all.
const plain = path.join(workRoot, "plain");
put(plain, "x.txt", "x1\n");
put(plain, "sub/y.txt", "y1\n");
const plainFirst = await take(plain);
assert.equal(plainFirst.head, null);
assert.deepEqual(plainFirst.files.map((file) => file.p).sort(), ["sub/y.txt", "x.txt"]);
put(plain, "x.txt", "x2\n");
await take(plain);
await restore(plain, "t1", plainFirst.commit, dataDir);
assert.equal(read(plain, "x.txt"), "x1\n");
assert.ok(!fs.existsSync(path.join(plain, ".git")), "no .git created in plain folder");

// Prune drops refs older than 30 days.
const shadow = path.join(dataDir, "checkpoints");
const repos = fs.readdirSync(shadow).filter((name) => name.endsWith(".git"));
assert.equal(repos.length, 2);
const gitDir = path.join(shadow, repos[0]);
const old = new Date(Date.now() - 40 * 86400_000).toISOString();
const stamp = { ...process.env, GIT_COMMITTER_DATE: old, GIT_AUTHOR_DATE: old };
const tree = execFileSync(
  "git",
  [`--git-dir=${gitDir}`, "hash-object", "-t", "tree", "/dev/null"],
  {
    encoding: "utf8",
  },
).trim();
const commit = execFileSync("git", [`--git-dir=${gitDir}`, "commit-tree", tree, "-m", "tool - -"], {
  encoding: "utf8",
  env: {
    ...stamp,
    GIT_AUTHOR_NAME: "a",
    GIT_AUTHOR_EMAIL: "a@a",
    GIT_COMMITTER_NAME: "a",
    GIT_COMMITTER_EMAIL: "a@a",
  },
}).trim();
execFileSync("git", [`--git-dir=${gitDir}`, "update-ref", "refs/ac/oldthread/1", commit]);
const refs = () =>
  execFileSync("git", [`--git-dir=${gitDir}`, "for-each-ref", "--format=%(refname)"], {
    encoding: "utf8",
  });
assert.match(refs(), /oldthread/);
await prune(30, dataDir);
assert.doesNotMatch(refs(), /oldthread/);
assert.match(
  execFileSync("git", [`--git-dir=${path.join(shadow, repos[1])}`, "for-each-ref"], {
    encoding: "utf8",
  }) + refs(),
  /refs\/ac\/t1/,
  "recent refs survive",
);

fs.rmSync(workRoot, { recursive: true, force: true });
console.log("checkpoints ok");

// Release builder: idempotent, hardlinked deps shared across releases, a server that cannot boot never becomes ready.
// Builds real releases of this repo's HEAD (cloned, so uncommitted work is ignored) into a temp AGENT_CONSOLE_HOME.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ac-release-test-"));
const app = path.join(tmp, "app");
const clone = path.join(tmp, "repo");
const env: NodeJS.ProcessEnv = { ...process.env, AGENT_CONSOLE_HOME: app };
for (const key of Object.keys(env))
  if (key.startsWith("AGENT_CONSOLE_") && key !== "AGENT_CONSOLE_HOME") delete env[key];
const git = (...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "-C", clone, ...args],
    { encoding: "utf8" },
  ).trim();

function release(ref: string) {
  const began = Date.now();
  try {
    const stdout = execFileSync(
      "node",
      [path.join(root, "scripts", "release.mjs"), "--repo", clone, ref],
      {
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 300_000,
      },
    );
    return {
      code: 0,
      dir: stdout.trim().split("\n").pop() as string,
      ms: Date.now() - began,
      stderr: "",
    };
  } catch (failure: any) {
    return {
      code: failure.status ?? 1,
      dir: "",
      ms: Date.now() - began,
      stderr: String(failure.stderr),
    };
  }
}

const inode = (file: string) => fs.statSync(file).ino;

try {
  execFileSync("git", ["clone", "--quiet", "--no-hardlinks", root, clone]);

  const cold = release("HEAD");
  assert.equal(cold.code, 0, cold.stderr);
  const sha = git("rev-parse", "HEAD");
  assert.equal(cold.dir, path.join(app, "releases", sha.slice(0, 12)));
  assert.ok(fs.existsSync(path.join(cold.dir, ".ready")));
  assert.ok(
    fs.existsSync(path.join(cold.dir, ".bundle", "server", "index.ts.mjs")),
    "bundle is built in place",
  );
  const info = JSON.parse(fs.readFileSync(path.join(cold.dir, "RELEASE.json"), "utf8"));
  assert.equal(info.sha, sha);
  assert.match(info.lockhash, /^[0-9a-f]{16}$/);
  assert.throws(
    () => fs.accessSync(path.join(cold.dir, "RELEASE.json"), fs.constants.W_OK),
    "release is read-only",
  );

  const warm = release("HEAD");
  assert.equal(warm.code, 0, warm.stderr);
  assert.equal(warm.dir, cold.dir);
  assert.ok(warm.ms < 2000, `second build is a no-op (took ${warm.ms} ms)`);

  const store = path.join(app, "deps", info.lockhash, "node_modules", "express", "package.json");
  assert.equal(
    inode(path.join(cold.dir, "node_modules", "express", "package.json")),
    inode(store),
    "deps are hardlinked",
  );

  // Same lockfile: a new release reuses the store instead of reinstalling.
  fs.appendFileSync(path.join(clone, "README.md"), "\nrelease test\n");
  git("commit", "-q", "-am", "doc change");
  const second = release("HEAD");
  assert.equal(second.code, 0, second.stderr);
  assert.notEqual(second.dir, cold.dir);
  assert.deepEqual(fs.readdirSync(path.join(app, "deps")), [info.lockhash]);
  assert.equal(
    inode(path.join(second.dir, "node_modules", "express", "package.json")),
    inode(store),
  );

  // A commit that bundles fine but throws at boot fails the smoke boot and never becomes ready.
  const entry = path.join(clone, "server", "index.ts");
  fs.writeFileSync(
    entry,
    `const missing = "./missing-" + process.pid;\nawait import(missing);\n${fs.readFileSync(entry, "utf8")}`,
  );
  git("commit", "-q", "-am", "broken import");
  const broken = release("HEAD");
  assert.notEqual(broken.code, 0, "broken commit must fail");
  assert.match(broken.stderr, /scratch server exited during boot|did not answer/);
  const brokenDir = path.join(app, "releases", git("rev-parse", "HEAD").slice(0, 12));
  assert.ok(!fs.existsSync(path.join(brokenDir, ".ready")));
  console.log(`release: cold ${cold.ms} ms, warm ${warm.ms} ms; all checks passed`);
} finally {
  if (fs.existsSync(tmp)) {
    execFileSync("find", [tmp, "-type", "d", "-exec", "chmod", "u+w", "{}", "+"]);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

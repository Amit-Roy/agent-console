import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = process.env.REPOS_LINT_SCRIPT || path.join(root, "tooling/repos/lint");
// Keep fixtures outside test/tmp, which production lint intentionally excludes.
const scratch = fs.mkdtempSync(path.join(root, "repos-lint-fixture-"));
const worktree = path.join(scratch, "private checkout $literal");
fs.mkdirSync(worktree);
const run = (args: string[], env = process.env) =>
  spawnSync("sh", [runner, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
const write = (name: string, content: string) => {
  const file = path.join(worktree, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

try {
  write("good.js", "console.log(1);\n");
  write("good.py", "print(1)\n");
  let result = run([worktree]);
  assert.equal(result.status, 0, "explicit clean worktree must pass without scanning ~/repos");

  write("bad.js", "debugger;\n");
  result = run([worktree]);
  assert.notEqual(result.status, 0, "Biome failure must survive successful Ruff commands");
  fs.unlinkSync(path.join(worktree, "bad.js"));

  write("bad.py", "print(undefined_name)\n");
  result = run([worktree]);
  assert.notEqual(result.status, 0, "Ruff lint failure must survive successful format check");
  fs.unlinkSync(path.join(worktree, "bad.py"));

  const excluded = [
    "vendor/broken.js",
    "public/vendor/broken.py",
    "app.min.js",
    "package-lock.json",
    "docs/generated.json",
    "arch-evidence/output/after.json",
  ];
  for (const name of excluded) write(name, "not valid source {{{\n");
  write("good.js", "console.log( 1 )\n");
  write("good.py", "print( 1 )\n");
  result = run(["--fix", worktree]);
  assert.equal(
    result.status,
    0,
    "--fix must format first-party source and exclude generated files",
  );
  assert.equal(fs.readFileSync(path.join(worktree, "good.js"), "utf8"), "console.log(1);\n");
  assert.equal(fs.readFileSync(path.join(worktree, "good.py"), "utf8"), "print(1)\n");
  for (const name of excluded) {
    assert.equal(fs.readFileSync(path.join(worktree, name), "utf8"), "not valid source {{{\n");
  }
  assert.equal(run([worktree]).status, 0, "formatted source must pass a subsequent check");

  const home = path.join(scratch, "home");
  for (const name of ["agent-console", "brain", "portfolio-lab", "quant-harness", "dotfiles"]) {
    const dir = path.join(home, "repos", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "clean.js"), "console.log(1);\n");
  }
  for (const name of ["agent-console-other-worktree", "OpenBB", "camofox-browser"]) {
    const dir = path.join(home, "repos", name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "invalid.js"), "not valid source {{{\n");
  }
  result = run([], { ...process.env, HOME: home });
  assert.equal(result.status, 0, "default sweep must select only the five named repositories");
  assert.notEqual(run(["--unknown"]).status, 0, "unknown options must fail before scanning");
  assert.notEqual(run([path.join(scratch, "missing")]).status, 0, "missing targets must fail");
  console.log("PASS repos-lint: worktree isolation, aggregate failures, fixes, exclusions, scope");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

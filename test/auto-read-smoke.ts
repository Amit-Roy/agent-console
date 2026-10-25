// Manual smoke test, not part of CI: run with `node test/auto-read-smoke.ts`.
// Runs real toolchain commands inside the Auto launcher with the real read policy and scratch state.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch } from "../server/automation/sandbox.ts";

const home = os.homedir();
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-read-smoke-"));
const clone = path.join(root, "clone");
const data = path.join(root, "data");
// Empty provider homes: the smoke test must never copy real logins.
const scratchHomes = ["claude", "codex", "pi"].map((name) => path.join(root, `${name}-home`));
for (const dir of [clone, data, ...scratchHomes]) fs.mkdirSync(dir);
execFileSync("git", ["init", "-q", clone], { stdio: "ignore" });
fs.writeFileSync(path.join(clone, ".git", "agent-console-auto"), "private-checkout-v1\n");
const secret = path.join(home, ".config", "agent-console", "secret");

const commands: [string, string, boolean][] = [
  ["claude --version", "claude --version >/dev/null", true],
  ["codex --version", "codex --version >/dev/null", true],
  ["pi --version", "pi --version >/dev/null 2>&1", true],
  ["gh auth status", "gh auth status >/dev/null 2>&1", true],
  ["git status", `git -C ${clone} status >/dev/null`, true],
  ["node -e 1", "node -e 1", true],
  ["python3 -c 1", "python3 -c 1", true],
  // The PATH shim (pmg) needs a writable ~/.config/safedep with or without the read list, so test the real binary.
  ["uv --version", `${path.join(home, ".local", "bin", "uv")} --version >/dev/null`, true],
  ["rtk --version", "rtk --version >/dev/null", true],
  ["codegraph --version", "codegraph --version >/dev/null", true],
  ["cat console secret (must fail)", `cat ${secret} >/dev/null 2>&1`, false],
];

let failures = 0;
try {
  if (!fs.existsSync(secret))
    console.log("note: console secret file absent; denial check is vacuous");
  for (const [index, provider] of ["claude", "codex", "pi"].entries()) {
    const env = {
      ...process.env,
      XDG_STATE_HOME: path.join(root, "state"),
      CLAUDE_CONFIG_DIR: scratchHomes[0],
      CODEX_HOME: scratchHomes[1],
      CODEX_HELPER_PACKAGE_ROOT: path.join(home, ".codex", "packages"),
      PI_CODING_AGENT_DIR: scratchHomes[2],
    };
    const thread = {
      id: `smoke-${index}`,
      cwd: clone,
      provider,
      issueRun: { role: "work", repo: "owner/scratch-repo", number: 1 },
    };
    for (const [label, script, mustPass] of commands) {
      const run = launch(thread, "sh", ["-c", script], env);
      const result = spawnSync(run.command, run.args, { env: run.env, encoding: "utf8" });
      const expected = (result.status === 0) === mustPass;
      if (!expected) failures++;
      const why = expected
        ? ""
        : ` (exit ${result.status}: ${(result.stderr || "").split("\n")[0].slice(0, 160)})`;
      console.log(`${expected ? "PASS" : "FAIL"} [${provider}] ${label}${why}`);
    }
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(failures ? `${failures} command(s) failed` : "all commands behaved as expected");
process.exit(failures ? 1 : 0);

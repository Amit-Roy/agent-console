// Main threads launch with a role persona; a missing persona file launches as before; Pi children never see it.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-persona-launch-"));
process.env.AGENT_CONSOLE_PERSONA_DIR = dir;
const { claudeStartArgs } = await import("../server/providers/claude.ts");
const { piMainPrompt } = await import("../server/providers/pi.ts");
const base = { id: "t1", cwd: "/tmp", mode: "bypassPermissions", model: "opus" } as any;
const agent = (spec: any) => {
  const args = claudeStartArgs({ ...base, ...spec });
  return args.includes("--agent") ? args[args.indexOf("--agent") + 1] : undefined;
};
try {
  assert.equal(agent({}), undefined, "missing file: no --agent");
  for (const name of ["orchestrator", "reviewer", "dream"])
    fs.writeFileSync(path.join(dir, `${name}.md`), `---\nname: ${name}\n---\nPERSONA-${name}\n`);
  assert.equal(agent({}), "orchestrator");
  assert.equal(agent({ issueRun: { role: "work" } }), "orchestrator");
  assert.equal(agent({ issueRun: { role: "review" } }), "reviewer");
  assert.equal(agent({ schedule: { task: "dream" } }), "dream");
  const main = piMainPrompt(base, "BRAIN");
  assert.ok(main.includes("PERSONA-orchestrator") && main.endsWith("BRAIN"));
  assert.equal(
    piMainPrompt({ ...base, issueRun: { role: "review" } }, undefined),
    "PERSONA-reviewer",
  );
  console.log("PASS  persona-launch: --agent per thread kind, none when missing, Pi main-only");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

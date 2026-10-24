// brain context: async (never blocks the event loop), cached until wiki/index.md changes or 5 minutes pass, concurrent calls share one run.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-brain-"));
fs.mkdirSync(path.join(root, "bin"));
fs.mkdirSync(path.join(root, "wiki"));
const index = path.join(root, "wiki", "index.md"),
  count = path.join(root, "runs");
fs.writeFileSync(index, "# Brain index\nv1\n");
// a slow stand-in for `brain context`: records each run, then prints the index
fs.writeFileSync(
  path.join(root, "bin", "brain"),
  `#!/bin/sh\necho x >> "${count}"\nsleep 0.3\ncat "${index}"\n`,
  { mode: 0o755 },
);
process.env.AGENT_CONSOLE_BRAIN = path.join(root, "bin", "brain");
const { brainContext, brainInstructions, harnessInstructions } = await import(
  "../server/providers/brain.ts"
);
const runs = () =>
  fs.existsSync(count) ? fs.readFileSync(count, "utf8").split("\n").filter(Boolean).length : 0;

try {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  const [a, b] = await Promise.all([brainContext(), brainContext()]);
  clearInterval(timer);
  assert.equal(a, "# Brain index\nv1");
  assert.equal(b, a);
  assert.equal(runs(), 1, "concurrent calls share one run");
  assert.ok(ticks >= 10, `event loop kept running during the 300 ms run (${ticks} ticks)`);
  console.log(
    `PASS  brain: async run, event loop free (${ticks} ticks), one run for concurrent callers`,
  );

  const t0 = performance.now();
  assert.equal(await brainContext(), a);
  assert.equal(runs(), 1);
  assert.ok(performance.now() - t0 < 50);
  const instructions = await harnessInstructions();
  assert.ok(instructions.includes("v1"));
  assert.ok(
    instructions.includes(brainInstructions()),
    "the harness receives the save contract alongside the index",
  );
  assert.ok(
    instructions.includes(path.join(root, "CLAUDE.md")),
    "the schema path follows the configured brain repository",
  );
  assert.ok(
    instructions.includes(`${process.env.AGENT_CONSOLE_BRAIN} lint`),
    "the full CLI path works without a brain PATH entry",
  );
  assert.ok(instructions.includes("wiki/index.md"));
  assert.ok(instructions.includes("required frontmatter"));
  assert.ok(instructions.includes("ops/ layer"), "the save text names the ops layer");
  assert.ok(
    instructions.includes(`${process.env.AGENT_CONSOLE_BRAIN} tags suggest`),
    "the save text points to tag suggestions with the full CLI path",
  );
  assert.ok(
    instructions.includes("reuse existing tags") && instructions.includes("1-8 atomic tags"),
  );
  assert.ok(instructions.includes("Never edit wiki/log.md by hand or run git"));
  console.log("PASS  brain: cached while the index is unchanged");

  fs.writeFileSync(index, "# Brain index\nv2 longer\n");
  assert.equal(await brainContext(), "# Brain index\nv2 longer");
  assert.equal(runs(), 2);
  console.log("PASS  brain: index change invalidates the cache");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

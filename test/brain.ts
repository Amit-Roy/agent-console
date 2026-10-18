// brain context: async (never blocks the event loop), cached until wiki/index.md changes or 5 minutes pass, concurrent calls share one run.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-brain-"));
fs.mkdirSync(path.join(root, "bin")); fs.mkdirSync(path.join(root, "wiki"));
const index = path.join(root, "wiki", "index.md"), count = path.join(root, "runs");
fs.writeFileSync(index, "# Brain index\nv1\n");
// a slow stand-in for `brain context`: records each run, then prints the index
fs.writeFileSync(path.join(root, "bin", "brain"), `#!/bin/sh\necho x >> "${count}"\nsleep 0.3\ncat "${index}"\n`, { mode: 0o755 });
process.env.AGENT_CONSOLE_BRAIN = path.join(root, "bin", "brain");
const { brainContext, harnessInstructions } = await import("../server/providers/brain.ts");
const runs = () => (fs.existsSync(count) ? fs.readFileSync(count, "utf8").split("\n").filter(Boolean).length : 0);

try {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  const [a, b] = await Promise.all([brainContext(), brainContext()]);
  clearInterval(timer);
  assert.equal(a, "# Brain index\nv1"); assert.equal(b, a);
  assert.equal(runs(), 1, "concurrent calls share one run");
  assert.ok(ticks >= 10, `event loop kept running during the 300 ms run (${ticks} ticks)`);
  console.log(`PASS  brain: async run, event loop free (${ticks} ticks), one run for concurrent callers`);

  const t0 = performance.now();
  assert.equal(await brainContext(), a);
  assert.equal(runs(), 1); assert.ok(performance.now() - t0 < 50);
  assert.ok((await harnessInstructions()).includes("v1"));
  console.log("PASS  brain: cached while the index is unchanged");

  fs.writeFileSync(index, "# Brain index\nv2 longer\n");
  assert.equal(await brainContext(), "# Brain index\nv2 longer");
  assert.equal(runs(), 2);
  console.log("PASS  brain: index change invalidates the cache");
} finally { fs.rmSync(root, { recursive: true, force: true }); }

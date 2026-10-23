// Boot telemetry: phase deltas, the slow-boot flag, bounded file, and wiring into the server (issue #18).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-boot-timing-"));
const { createBootTiming, KEEP, SLOW_BOOT_MS } = await import("../server/boot-timing.ts");
try {
  assert.equal(SLOW_BOOT_MS, 5000);
  let t = 0;
  const slow: unknown[] = [];
  const bt = createBootTiming({
    file: path.join(dir, "boot.jsonl"),
    uptime: () => t,
    now: () => 42,
    onSlow: (r) => slow.push(r),
  });
  t = 300;
  bt.mark("modules");
  t = 450;
  bt.mark("threads");
  t = 900;
  bt.mark("listening");
  const fast = bt.flush("listen");
  assert.deepEqual(fast.phases, [
    { name: "modules", at: 300, ms: 300 },
    { name: "threads", at: 450, ms: 150 },
    { name: "listening", at: 900, ms: 450 },
  ]);
  assert.equal(fast.totalMs, 900);
  assert.equal(fast.slow, false);
  assert.equal(slow.length, 0);

  // later phases form their own record and are never judged slow
  t = 9000;
  bt.mark("deferred");
  assert.equal(bt.flush("deferred").slow, false);
  assert.equal(bt.recent().length, 2);

  // a first listen over 5 s is flagged and reported once
  const bt2 = createBootTiming({
    file: path.join(dir, "slow.jsonl"),
    uptime: () => t,
    onSlow: (r) => slow.push(r),
  });
  t = 15_000;
  bt2.mark("listening");
  assert.equal(bt2.flush("listen").slow, true);
  assert.equal(slow.length, 1);

  // bounded, and a corrupt line never breaks reading
  const file = path.join(dir, "bounded.jsonl");
  fs.writeFileSync(file, "not json\n");
  const bt3 = createBootTiming({ file, uptime: () => 1 });
  for (let i = 0; i < KEEP + 5; i++) {
    bt3.mark("x");
    bt3.flush("listen");
  }
  assert.equal(fs.readFileSync(file, "utf8").trim().split("\n").length, KEEP);
  assert.equal(bt3.recent(3).length, 3);

  // wired into the server at the real boot phases
  const src = fs.readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
  for (const p of [
    'boot.mark("modules")',
    'boot.mark("listening")',
    'boot.flush("listen")',
    "/api/boot-timing",
  ])
    assert.ok(src.includes(p), `server/index.ts missing ${p}`);
  console.log("boot-timing ok");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

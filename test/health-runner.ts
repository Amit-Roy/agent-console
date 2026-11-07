import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { HealthCheck } from "../server/health/checks.ts";
import { createHealthRunner, needsBootRun, worstStatus } from "../server/health/runner.ts";

const okCheck = (checkId: string, status: HealthCheck["status"] = "ok"): HealthCheck => ({
  id: checkId,
  label: checkId,
  status,
  detail: "d",
});

function setup(clock = { t: 1_000_000 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "health-runner-"));
  const calls = { camofox: 0, report: 0 };
  let release: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  const runner = createHealthRunner({
    threads: {},
    dataDir: dir,
    deps: {
      now: () => (clock.t += 10),
      camofox: async () => {
        calls.camofox++;
        await gate;
        return okCheck("camofox");
      },
      report: async () => {
        calls.report++;
        return [okCheck("disk", "warning")];
      },
    },
  });
  return {
    dir,
    calls,
    runner,
    hold() {
      gate = new Promise((resolve) => {
        release = resolve;
      });
    },
    free: () => release?.(),
  };
}

test("run is recorded and returned first by latest", async () => {
  const ctx = setup();
  const run = await ctx.runner.run("manual");
  assert.equal(run.checks.length, 2);
  assert.equal(ctx.runner.latest()?.at, run.at);
  assert.deepEqual(ctx.runner.history(14)[0], { at: run.at, trigger: "manual", worst: "warning" });
});

test("file capped at 60 after 70 runs", async () => {
  const ctx = setup();
  for (let idx = 0; idx < 70; idx++) await ctx.runner.run("hourly");
  const lines = fs
    .readFileSync(path.join(ctx.dir, "health", "runs.jsonl"), "utf8")
    .trim()
    .split("\n");
  assert.equal(lines.length, 60);
  assert.equal(ctx.runner.history(14).length, 14);
});

test("concurrent calls share one run", async () => {
  const ctx = setup();
  ctx.hold();
  const first = ctx.runner.run("manual");
  const second = ctx.runner.run("nightly");
  assert.equal(ctx.runner.running(), true);
  ctx.free();
  assert.equal(await first, await second);
  assert.equal(ctx.calls.camofox, 1);
  assert.equal(ctx.runner.running(), false);
});

test("hourly runs only camofox", async () => {
  const ctx = setup();
  const run = await ctx.runner.run("hourly");
  assert.equal(ctx.calls.report, 0);
  assert.deepEqual(
    run.checks.map((item) => item.id),
    ["camofox"],
  );
});

test("boot catch-up decision with fake clock", () => {
  const now = Date.parse("2026-01-02T12:00:00Z");
  assert.equal(needsBootRun(undefined, now), true);
  assert.equal(needsBootRun("garbage", now), true);
  assert.equal(needsBootRun(new Date(now - 25 * 3_600_000).toISOString(), now), false);
  assert.equal(needsBootRun(new Date(now - 27 * 3_600_000).toISOString(), now), true);
});

test("hourly runs do not count as full runs", async () => {
  const ctx = setup();
  await ctx.runner.run("hourly");
  assert.equal(ctx.runner.lastFullAt(), undefined);
  await ctx.runner.run("manual");
  assert.ok(ctx.runner.lastFullAt());
  assert.equal(worstStatus([okCheck("a"), okCheck("b", "error")]), "error");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createBenchmarkSubscriptions,
  subscriptionView,
  validateSubscriptionFees,
} from "../server/benchmark-subscriptions.ts";

const fees = { claude: 20, "claude:nefro": 20, codex: 20 };
const now = 1_800_000_000_000;
const sample = (used: number, resetsAt = now + 300_000, updatedAt = now) => ({
  updatedAt,
  windows: [{ label: "5-hour", used, limit: 100, unit: "%", resetsAt }],
});

test("three subscription fees are fixed monthly costs, separate from API usage", () => {
  const result = subscriptionView(
    fees,
    { claude: sample(10), "claude:nefro": sample(20), codex: sample(30) },
    now,
  );
  assert.equal(result.totalMonthly, 60);
  assert.equal(result.configured, true);
  assert.equal(result.capacityStatus, "unknown");
  assert.deepEqual(
    result.plans.map((p) => p.windows[0].remainingPercent),
    [90, 80, 70],
  );
  assert.deepEqual(
    result.plans.map((p) => p.monthly),
    [20, 20, 20],
  );
});

test("unconfigured fees and absent quota remain unknown", () => {
  const result = subscriptionView(null, {}, now);
  assert.equal(result.totalMonthly, null);
  assert.equal(result.configured, false);
  assert.ok(
    result.plans.every((p) => p.monthly === null && p.updatedAt === null && p.windows.length === 0),
  );
  assert.equal(result.capacityStatus, "unknown");
  assert.equal(
    subscriptionView({ claude: 0, "claude:nefro": 0, codex: 0 }, {}, now).totalMonthly,
    0,
  );
});

test("expired and old quota snapshots retain observed percentages without restoring allowances", () => {
  const result = subscriptionView(
    fees,
    {
      claude: sample(90, now - 1),
      "claude:nefro": sample(80, now + 300_000, now - 31 * 60_000),
      codex: sample(100),
    },
    now,
  );
  assert.deepEqual(
    result.plans.map((p) => p.windows[0].remainingPercent),
    [10, 20, 0],
  );
  assert.deepEqual(
    result.plans.map((p) => p.windows[0].stale),
    [true, true, false],
  );
});

test("malformed quotas cannot invent usable allowance", () => {
  const result = subscriptionView(
    fees,
    {
      claude: {
        updatedAt: now,
        windows: [
          { label: "5-hour", used: NaN, limit: 100 },
          { label: "7-day", used: 20, limit: 0 },
        ],
      },
      codex: { updatedAt: now, windows: [{ label: "5-hour", used: 5, limit: 100 }] },
    },
    now,
  );
  assert.deepEqual(result.plans[0].windows, []);
  assert.equal(result.plans[2].windows[0].stale, true);
  assert.equal(result.plans[2].windows[0].resetsAt, null);
});

test("fee validation rejects missing, extra, nonnumeric, negative and excessive inputs", () => {
  for (const invalid of [
    null,
    [],
    { claude: 20 },
    { ...fees, extra: 1 },
    { ...fees, codex: "20" },
    { ...fees, codex: -1 },
    { ...fees, codex: Infinity },
    { ...fees, codex: 100001 },
  ]) {
    assert.throws(() => validateSubscriptionFees(invalid));
  }
  assert.deepEqual(validateSubscriptionFees(fees), fees);
});

test("fees persist outside source with private permissions and fail closed if damaged", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-plans-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const service = createBenchmarkSubscriptions(dir);
  service.save(fees);
  assert.equal(createBenchmarkSubscriptions(dir).view({}, now).totalMonthly, 60);
  const file = path.join(dir, "benchmark-subscriptions.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, "invalid");
  assert.equal(service.view({}, now).configured, false);
});

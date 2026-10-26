import assert from "node:assert/strict";
import test from "node:test";
import { planShards } from "./shard-plan.mjs";

const weights: Record<string, number> = {
  "a.ts": 9,
  "b.ts": 7,
  "c.ts": 5,
  "d.ts": 4,
  "e.ts": 3,
  "f.ts": 1,
};
const files = [...Object.keys(weights), "new1.ts", "new2.ts"];
const load = (shard: string[]) => shard.reduce((sum, file) => sum + (weights[file] ?? 4), 0);

test("every file appears exactly once, unknown files included", () => {
  for (const total of [1, 2, 3, 4]) {
    const plan = planShards(files, weights, total);
    assert.equal(plan.length, total);
    assert.deepEqual(plan.flat().sort(), [...files].sort());
  }
});

test("output is deterministic regardless of input order", () => {
  const first = planShards(files, weights, 3);
  assert.deepEqual(planShards([...files].reverse(), weights, 3), first);
  assert.deepEqual(planShards(files, weights, 3), first);
});

test("shards list files longest first", () => {
  for (const shard of planShards(files, weights, 2))
    for (let i = 1; i < shard.length; i++)
      assert.ok((weights[shard[i - 1]] ?? 4) >= (weights[shard[i]] ?? 4));
});

test("shard loads differ by at most the largest weight", () => {
  for (const total of [2, 3, 4]) {
    const loads = planShards(files, weights, total).map(load);
    assert.ok(Math.max(...loads) - Math.min(...loads) <= 9);
  }
});

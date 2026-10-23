import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const directory = process.argv[2];
const logs = fs
  .readdirSync(directory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map(({ name }) => fs.readFileSync(path.join(directory, name, "test.log"), "utf8"));
assert.equal(logs.length, 2, "Both CI shard logs are required.");
const manifests = logs.map((log) =>
  JSON.parse(log.match(/^Test suite files: (.+)$/m)?.[1] || "null"),
);
assert.ok(Array.isArray(manifests[0]), "The full suite manifest is required.");
assert.deepEqual(manifests[0], manifests[1], "Both shards must select from the same full suite.");
const timings = logs.flatMap((log) => [...log.matchAll(/^[✔✖] (test\/\S+) \(([\d.]+)ms\)/gm)]);
assert.deepEqual(
  timings.map((match) => match[1]).sort(),
  [...manifests[0]].sort(),
  "Every test file must run exactly once across the shards.",
);
const starts = logs.map((log) => Number(log.match(/^Test run started: ([\d.]+)$/m)?.[1]));
const durations = logs.map((log) => Number(log.match(/^ℹ duration_ms ([\d.]+)$/m)?.[1]));
assert.ok([...starts, ...durations].every((value) => Number.isFinite(value) && value > 0));
// Include the start skew between runners in the whole-suite wall time.
const wall =
  Math.max(...starts.map((start, index) => start + durations[index])) - Math.min(...starts);
const combined = path.join(directory, "combined.log");
fs.writeFileSync(
  combined,
  `${timings.map((match) => match[0]).join("\n")}\nℹ duration_ms ${wall}\n`,
);
const result = spawnSync(process.execPath, ["scripts/ci-resources.mjs", "budget", combined], {
  stdio: "inherit",
});
process.exitCode = result.status ?? 1;

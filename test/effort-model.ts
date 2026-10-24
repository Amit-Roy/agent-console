import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin/effort-model");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ac-effort-model-"));
const BYTE_BUDGET = 300;

function fixture(name: string) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(path.join(dir, "run"), { recursive: true });
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  return {
    model: path.join(dir, "data/triage-effort-model.json"),
    challenger: path.join(dir, "data/triage-effort-model.challenger.json"),
    state: path.join(dir, "run/calibration-state.json"),
    toggles: path.join(dir, "data/effort-model.json"),
    env: {
      AGENT_CONSOLE_TRIAGE_EFFORT_MODEL: path.join(dir, "data/triage-effort-model.json"),
      AGENT_CONSOLE_TRIAGE_RUN: path.join(dir, "run"),
      AGENT_CONSOLE_DATA: path.join(dir, "data"),
      HOME: path.join(dir, "home"),
    },
  };
}

const artifact = (asOf: string, train: number, held: number, nodes: number, pinball: number) => ({
  training: { asOf, sampleCount: train },
  validation: {
    sampleCount: held,
    quantileModel: {
      quantiles: {
        p50: { pinball, coverage: 0.5 },
        p80: { pinball, coverage: 0.84 },
        p95: { pinball, coverage: 0.97 },
      },
    },
  },
  quantileModel: { nodeCount: nodes },
});

function run(args: string[], env: Record<string, string>) {
  const result = spawnSync(cli, args, { env: { ...process.env, ...env }, encoding: "utf8" });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

const write = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value));

{
  const present = fixture("present");
  write(present.model, artifact("2026-10-24T01:00:00Z", 410, 101, 5282, 0.479));
  write(present.challenger, artifact("2026-10-24T02:00:00Z", 420, 104, 2500, 0.461));
  write(present.state, {
    lastCompletedAt: Date.parse("2026-10-24T03:00:00Z"),
    lastOutcome: "rejected",
    reasons: ["p80 coverage 0.93 is above 0.92.", "second"],
  });
  write(present.toggles, { enabled: true, steps: { gate: false } });
  const result = run(["status"], present.env);
  assert.equal(result.code, 0);
  const lines = result.out.trimEnd().split("\n");
  assert.equal(lines[0], "live 2026-10-24 pinball 0.479 p80 0.84 p95 0.97 rows 410/101 nodes 5282");
  assert.equal(lines[1], "chal 2026-10-24 pinball 0.461 p80 0.84 p95 0.97 rows 420/104 nodes 2500");
  assert.equal(lines[2], "last 2026-10-24 rejected: p80 coverage 0.93 is above 0.92.");
  assert.equal(lines[3], "next 2026-10-31 | toggles off: gate");
  assert.ok(Buffer.byteLength(result.out) <= BYTE_BUDGET);
  const json = JSON.parse(run(["status", "--json"], present.env).out);
  assert.equal(json.live.nodes, 5282);
  assert.equal(json.last.outcome, "rejected");
}

{
  const missing = fixture("missing");
  const result = run(["status"], missing.env);
  assert.equal(result.code, 0);
  assert.equal(result.err, "");
  assert.equal(result.out, "live none\nlast none\nnext none | toggles all on\n");
}

{
  const crowded = fixture("crowded");
  write(crowded.model, artifact("2026-10-24T01:00:00Z", 4100, 1010, 52820, 0.479));
  write(crowded.challenger, artifact("2026-10-24T02:00:00Z", 4200, 1040, 25000, 0.461));
  write(crowded.state, {
    lastCompletedAt: Date.parse("2026-10-24T03:00:00Z"),
    lastOutcome: "rejected",
    reasons: ["x".repeat(500)],
  });
  write(crowded.toggles, {
    enabled: true,
    steps: Object.fromEntries(
      ["sessions", "features", "fit", "gate", "promote", "reprice"].map((step) => [step, false]),
    ),
  });
  const result = run(["status"], crowded.env);
  assert.ok(Buffer.byteLength(result.out) <= BYTE_BUDGET, result.out);
  assert.match(result.out, /^live /);
  assert.match(result.out, /toggles off: sessions,features,fit,gate,promote,reprice/);
}

{
  const broken = fixture("broken");
  fs.writeFileSync(broken.model, "{not json");
  fs.writeFileSync(broken.state, "[]");
  const result = run(["status"], broken.env);
  assert.equal(result.code, 0);
  assert.match(result.out, /^live none\nlast none\n/);
}

{
  const usage = fixture("usage");
  for (const args of [
    [],
    ["nope"],
    ["status", "--bogus"],
    ["bench", "--external", "other"],
    ["data"],
    ["data", "get"],
  ]) {
    const result = run(args, usage.env);
    assert.equal(result.code, 2, args.join(" "));
    assert.match(result.err, /^usage: effort-model /);
    assert.equal(result.err.trimEnd().split("\n").length, 1);
  }
  const noDataset = run(["bench"], usage.env);
  assert.equal(noDataset.code, 1);
  assert.match(noDataset.err, /^effort-model: dataset: not found: /);
}

fs.rmSync(scratch, { recursive: true, force: true });
console.log("effort-model: ok");

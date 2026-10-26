#!/usr/bin/env node
// Regenerate test/weights.json: median seconds per test file over recent successful main CI runs.
//   node scripts/test-weights.mjs [--runs N] [log ...]
// With log paths, uses those logs (each one a CI test.log). Without, downloads the test-log-*
// artifacts of the last N (default 5) successful main runs, falling back to job logs.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LINE = /^[✔✖] (test\/\S+) \(([\d.]+)ms\)/gm;
const gh = (...args) =>
  execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

export function parseLog(text) {
  return [...text.matchAll(LINE)].map((match) => [match[1], Number(match[2]) / 1000]);
}

export function medianWeights(samples) {
  const byFile = new Map();
  for (const [file, seconds] of samples) byFile.set(file, [...(byFile.get(file) ?? []), seconds]);
  const weights = {};
  for (const file of [...byFile.keys()].sort()) {
    const sorted = byFile.get(file).sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    weights[file] = Math.round(median * 10) / 10;
  }
  return weights;
}

function logsFromArtifacts(runId, directory) {
  gh("run", "download", String(runId), "-p", "test-log-*", "-D", directory);
  return fs
    .readdirSync(directory, { recursive: true })
    .filter((entry) => entry.endsWith("test.log"))
    .map((entry) => fs.readFileSync(path.join(directory, entry), "utf8"));
}

function logsFromJobs(runId) {
  const run = JSON.parse(gh("run", "view", String(runId), "--json", "jobs"));
  return run.jobs
    .filter((job) => /test-shard/.test(job.name))
    .map((job) => gh("run", "view", "--job", String(job.databaseId), "--log"));
}

function runLogs(runId, scratch) {
  try {
    const logs = logsFromArtifacts(runId, path.join(scratch, String(runId)));
    if (logs.length) return logs;
  } catch {
    // Artifacts expired or missing: fall back to job logs.
  }
  return logsFromJobs(runId);
}

function collectLogs(args, count) {
  if (args.length) return args.map((file) => [fs.readFileSync(file, "utf8")]);
  const runs = JSON.parse(
    gh(
      "run",
      "list",
      "--branch",
      "main",
      "--workflow",
      "ci.yml",
      "--status",
      "success",
      "--limit",
      String(count),
      "--json",
      "databaseId",
    ),
  );
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "test-weights-"));
  return runs.map((run) => runLogs(run.databaseId, scratch));
}

function main() {
  const args = process.argv.slice(2);
  const flag = args.indexOf("--runs");
  const count = flag < 0 ? 5 : Number(args.splice(flag, 2)[1]);
  const logs = collectLogs(args, count).flat();
  const samples = logs.flatMap(parseLog);
  if (!samples.length) throw new Error("No per-file timing lines found in the logs.");
  const target = path.join(import.meta.dirname, "..", "test", "weights.json");
  fs.writeFileSync(target, `${JSON.stringify(medianWeights(samples), null, 2)}\n`);
  console.log(`Wrote ${target} from ${logs.length} shard logs.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

#!/usr/bin/env node
// Agent-facing CLI for the effort-pricing model: status, bench, data fetch.
// Success is one short line (plus summary.json for bench); failures are
// `effort-model: <stage>: <msg>` on stderr with exit 1, bad arguments print usage with exit 2.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { effortModelPath } from "../server/providers/triage-effort.ts";
import { EFFORT_STEPS, readEffortConfig } from "../server/triage-promotion.ts";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const USAGE =
  "usage: effort-model status [--json] | bench [--dataset PATH] [--external swe-chat] [--external-rows PATH] [--out DIR] [--json] | data fetch [ARGS]";
const STATUS_BYTES = 300;
const REASON_CHARS = 60;
const WEEK_MS = 7 * 24 * 60 * 60_000;
const CACHE = path.join(os.homedir(), ".cache/agent-console");

type Json = Record<string, any>;

class CliError extends Error {
  stage: string;
  code: number;
  constructor(stage: string, message: string, code = 1) {
    super(message);
    this.stage = stage;
    this.code = code;
  }
}

const usageError = () => new CliError("usage", USAGE, 2);

function readJson(file: string): Json | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

const isoDate = (epochMs: number) => new Date(epochMs).toISOString().slice(0, 10);
const fixed = (value: unknown, digits = 3) =>
  typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "?";

function artifactDate(file: string, artifact: Json): string {
  const asOf = Date.parse(artifact.training?.asOf ?? "");
  return isoDate(Number.isFinite(asOf) ? asOf : fs.statSync(file).mtimeMs);
}

/** Facts one artifact line carries: date, mean pinball, p80/p95 coverage, rows, nodes. */
function artifactFacts(file: string): Json | null {
  const artifact = readJson(file);
  if (!artifact) return null;
  const quantiles: Json = artifact.validation?.quantileModel?.quantiles ?? {};
  const pinballs = Object.values(quantiles)
    .map((entry: any) => entry?.pinball)
    .filter((value) => typeof value === "number");
  const mean = pinballs.length
    ? pinballs.reduce((sum, value) => sum + value, 0) / pinballs.length
    : null;
  return {
    date: artifactDate(file, artifact),
    pinball: mean,
    p80: quantiles.p80?.coverage ?? null,
    p95: quantiles.p95?.coverage ?? null,
    train: artifact.training?.sampleCount ?? null,
    held: artifact.validation?.sampleCount ?? null,
    nodes: artifact.quantileModel?.nodeCount ?? null,
  };
}

function artifactLine(label: string, facts: Json | null): string {
  if (!facts) return `${label} none`;
  return (
    `${label} ${facts.date} pinball ${fixed(facts.pinball)} p80 ${fixed(facts.p80, 2)} ` +
    `p95 ${fixed(facts.p95, 2)} rows ${facts.train ?? "?"}/${facts.held ?? "?"} nodes ${facts.nodes ?? "?"}`
  );
}

function calibrationRunDir(): string {
  return process.env.AGENT_CONSOLE_TRIAGE_RUN || path.join(CACHE, "github-triage");
}

function lastRun(state: Json | null): Json | null {
  const completed = state?.lastCompletedAt;
  if (typeof completed !== "number" || !Number.isFinite(completed)) return null;
  const reason = Array.isArray(state?.reasons) ? String(state.reasons[0] ?? "") : "";
  return {
    date: isoDate(completed),
    outcome: String(state?.lastOutcome ?? "?"),
    reason: reason.replace(/\s+/g, " ").slice(0, REASON_CHARS),
    next: isoDate(completed + WEEK_MS),
  };
}

function lastLine(run: Json | null): string {
  if (!run) return "last none";
  return `last ${run.date} ${run.outcome}${run.reason ? `: ${run.reason}` : ""}`;
}

function togglesText(): string {
  const config = readEffortConfig();
  if (!config.enabled) return "toggles off";
  const off = EFFORT_STEPS.filter((step) => !config.steps[step]);
  return off.length ? `toggles off: ${off.join(",")}` : "toggles all on";
}

function statusLines(): { lines: string[]; data: Json } {
  const live = effortModelPath();
  const challengerFile = path.join(path.dirname(live), "triage-effort-model.challenger.json");
  const liveFacts = artifactFacts(live);
  const challengerFacts = artifactFacts(challengerFile);
  const run = lastRun(readJson(path.join(calibrationRunDir(), "calibration-state.json")));
  const toggles = togglesText();
  const lines = [
    artifactLine("live", liveFacts),
    ...(challengerFacts ? [artifactLine("chal", challengerFacts)] : []),
    lastLine(run),
    `next ${run?.next ?? "none"} | ${toggles}`,
  ];
  return { lines, data: { live: liveFacts, challenger: challengerFacts, last: run, toggles } };
}

/** Keep the status within its byte budget by dropping the optional challenger line first. */
function withinBudget(lines: string[]): string[] {
  const text = (rows: string[]) => rows.join("\n");
  if (Buffer.byteLength(text(lines)) <= STATUS_BYTES) return lines;
  return lines.filter((line) => !line.startsWith("chal "));
}

function statusCommand(args: string[]) {
  const { values } = parseArgs({ args, options: { json: { type: "boolean" } }, strict: true });
  const { lines, data } = statusLines();
  console.log(values.json ? JSON.stringify(data) : withinBudget(lines).join("\n"));
}

function triagePython(): string {
  return (
    process.env.AGENT_CONSOLE_TRIAGE_PYTHON ||
    path.join(os.homedir(), ".local/share/agent-console/triage-venv/bin/python")
  );
}

function runChild(stage: string, command: string, args: string[]): number {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, OMP_NUM_THREADS: "1" },
  });
  if (result.error) throw new CliError(stage, result.error.message);
  return result.status ?? 1;
}

/** The fetch is the only command needing pyarrow; say so in one line instead of a traceback. */
function dataCommand(args: string[]): number {
  if (args[0] !== "fetch") throw usageError();
  const python = triagePython();
  const result = spawnSync(python, [path.join(SCRIPTS, "effort-data.py"), ...args.slice(1)], {
    stdio: ["inherit", "inherit", "pipe"],
    encoding: "utf8",
  });
  if (result.error) throw new CliError("data", result.error.message);
  if (/ModuleNotFoundError: No module named 'pyarrow'/.test(result.stderr))
    throw new CliError(
      "data",
      `pyarrow missing in ${python}; uv pip install --python ${python} pyarrow`,
    );
  process.stderr.write(result.stderr);
  return result.status ?? 1;
}

function externalRowsFile(location: string | undefined): string {
  const target = location ?? path.join(CACHE, "effort-data/swe-chat");
  const rows =
    fs.existsSync(target) && fs.statSync(target).isDirectory()
      ? path.join(target, "rows.jsonl")
      : target;
  if (!fs.existsSync(rows))
    throw new CliError("external", `no rows at ${rows}; run effort-model data fetch`);
  return rows;
}

/** Feature rows live beside the raw rows and are rebuilt whenever the raw rows are newer. */
function externalFeatures(location: string | undefined): string {
  const rows = externalRowsFile(location);
  const features = path.join(path.dirname(rows), "features.jsonl");
  const fresh =
    fs.existsSync(features) && fs.statSync(features).mtimeMs >= fs.statSync(rows).mtimeMs;
  if (fresh) return features;
  const script = path.join(SCRIPTS, "effort-data-features.ts");
  const status = spawnSync(process.execPath, [script, rows, features], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (status.status !== 0) throw new CliError("external", "feature build failed");
  return features;
}

function benchOptions(args: string[]) {
  try {
    return parseArgs({
      args,
      options: {
        dataset: { type: "string" },
        external: { type: "string" },
        "external-rows": { type: "string" },
        out: { type: "string" },
        json: { type: "boolean" },
      },
      strict: true,
    }).values;
  } catch {
    throw usageError();
  }
}

function benchCommand(args: string[]): number {
  const options = benchOptions(args);
  if (options.external !== undefined && options.external !== "swe-chat") throw usageError();
  const live = effortModelPath();
  const dataset = options.dataset ?? path.join(path.dirname(live), "triage-effort-training.json");
  if (!fs.existsSync(dataset)) throw new CliError("dataset", `not found: ${dataset}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = options.out ?? path.join(CACHE, "effort-bench", stamp);
  const command = [
    path.join(SCRIPTS, "triage-effort-bench.py"),
    "--dataset",
    dataset,
    "--artifact",
    live,
    "--out",
    out,
  ];
  if (options.external || options["external-rows"])
    command.push("--external-rows", externalFeatures(options["external-rows"]));
  if (options.json) command.push("--json");
  return runChild("bench", triagePython(), command);
}

function dispatch(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command === "status") {
    try {
      statusCommand(rest);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw usageError();
    }
    return 0;
  }
  if (command === "bench") return benchCommand(rest);
  if (command === "data") return dataCommand(rest);
  throw usageError();
}

function main() {
  try {
    process.exitCode = dispatch(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    if (error.stage === "usage") console.error(error.message);
    else console.error(`effort-model: ${error.stage}: ${error.message}`);
    process.exitCode = error.code;
  }
}

main();

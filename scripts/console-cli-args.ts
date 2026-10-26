import fs from "node:fs";
import { parseArgs } from "node:util";
import { configPatch, positiveInteger } from "../server/console-cli-input.ts";

export const IDEAS_USAGE =
  "app-ideas list | read <slug> (JSON output; requires an Agent Console session)";
export function parseIdeasArgs(args: string[]) {
  const { positionals, values } = parseArgs({
    args,
    options: { help: { type: "boolean", short: "h" } },
    allowPositionals: true,
  });
  if (values.help || args.length === 0) return;
  const [command, slug] = positionals;
  if (command === "list" && positionals.length === 1) return { operation: "idea_list", input: {} };
  if (command === "read" && positionals.length === 2 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
    return { operation: "idea_read", input: { slug } };
  throw new Error(IDEAS_USAGE);
}

export const TASKS_USAGE =
  "scheduled-tasks list | get|runs <id-or-title> | report|transcript <id-or-title> [run-id] [--start N --limit N] | update <id-or-title> --json '<patch>' (or --file PATH; '-' reads stdin)";
const OPERATIONS: Record<string, string> = {
  list: "schedule_config_list",
  get: "schedule_get",
  runs: "schedule_runs",
  report: "schedule_report",
  transcript: "schedule_transcript",
  update: "schedule_config_update",
};

export function parseTasksArgs(args: string[]) {
  const { positionals, values } = parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "string" },
      file: { type: "string" },
      start: { type: "string" },
      limit: { type: "string" },
    },
    allowPositionals: true,
  });
  if (values.help || args.length === 0) return;
  const [command, identifier, run] = positionals;
  if (!Object.hasOwn(OPERATIONS, command)) throw new Error(TASKS_USAGE);
  const count = positionals.length;
  const maximum = ["report", "transcript"].includes(command) ? 3 : command === "list" ? 1 : 2;
  if (
    count < (command === "list" ? 1 : 2) ||
    count > maximum ||
    identifier?.trim() === "" ||
    run?.trim() === ""
  )
    throw new Error(TASKS_USAGE);
  const input: Record<string, unknown> = command === "list" ? {} : { id: identifier };
  if (run) input.run = run;
  applyOptions(command, values, input);
  return { operation: OPERATIONS[command], input };
}

function applyOptions(
  command: string,
  values: Record<string, unknown>,
  input: Record<string, unknown>,
) {
  if (command !== "transcript" && (values.start !== undefined || values.limit !== undefined))
    throw new Error("--start/--limit apply only to transcript.");
  if (command !== "update" && (values.json !== undefined || values.file !== undefined))
    throw new Error("--json/--file apply only to update.");
  if (values.start !== undefined)
    input.start = positiveInteger(values.start, "start", Number.MAX_SAFE_INTEGER);
  if (values.limit !== undefined) input.limit = positiveInteger(values.limit, "limit", 100);
  if (command === "update") input.patch = readPatch(values);
}

function readPatch(values: Record<string, unknown>) {
  if ((values.json !== undefined) === (values.file !== undefined))
    throw new Error("update requires exactly one of --json or --file.");
  const source =
    typeof values.file === "string"
      ? fs.readFileSync(values.file === "-" ? 0 : values.file, "utf8")
      : String(values.json);
  let patch: unknown;
  try {
    patch = JSON.parse(source);
  } catch {
    throw new Error("Config patch must be valid JSON.");
  }
  return configPatch(patch);
}

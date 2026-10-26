import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { configPatch, positiveInteger } from "./console-cli-input.ts";
import type { Ideas } from "./ideas.ts";
import { PROVIDERS } from "./providers/index.ts";
import type { Run, Schedules, Task, TaskInput } from "./schedules.ts";
import type { SessionSearch } from "./session-search.ts";

const OPERATIONS = new Set([
  "idea_list",
  "idea_read",
  "schedule_config_list",
  "schedule_get",
  "schedule_runs",
  "schedule_report",
  "schedule_transcript",
  "schedule_config_update",
]);
export const isConsoleCliTool = (name: string): boolean => OPERATIONS.has(name);
type Services = {
  ideas: Pick<Ideas, "list" | "read">;
  schedules: Pick<Schedules, "list" | "get" | "update" | "outputs">;
  sessionSearch: Pick<SessionSearch, "read">;
};

function pickTask(schedules: Services["schedules"], identifier: unknown): Task {
  if (typeof identifier !== "string" || !identifier.trim())
    throw new Error("Give a task id or exact title.");
  const exact = schedules.get(identifier);
  if (exact) return exact;
  const matches = schedules
    .list()
    .filter((task) => task.title.toLowerCase() === identifier.toLowerCase());
  if (matches.length > 1)
    throw new Error("Ambiguous task title. Use its id from scheduled-tasks list.");
  if (!matches.length) throw new Error("Unknown scheduled task. Use scheduled-tasks list.");
  return matches[0];
}

function taskConfig(task: Task) {
  const { runs: _runs, ...configuration } = task;
  return configuration;
}

function pickRun(task: Task, identifier: unknown, report: boolean): Run {
  if (identifier !== undefined && typeof identifier !== "string")
    throw new Error("run must be a run id.");
  const run =
    identifier === undefined
      ? task.runs.findLast((candidate) => (report ? !!candidate.output : !!candidate.thread))
      : task.runs.find((candidate) => candidate.id === identifier);
  if (!run)
    throw new Error(identifier ? "Unknown run for this task." : "No matching run for this task.");
  return run;
}

function readReport(outputs: string, run: Run): string {
  if (!run.output) throw new Error("This run has no saved report.");
  const relative = path.relative(outputs, run.output.path);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Report path is outside the outputs repository.");
  if (run.output.commit) {
    if (!/^[a-f0-9]{7,40}$/.test(run.output.commit))
      throw new Error("Invalid saved report commit.");
    try {
      return execFileSync(
        "git",
        ["-C", outputs, "show", `${run.output.commit}:${relative.split(path.sep).join("/")}`],
        {
          encoding: "utf8",
          maxBuffer: 600_000,
          timeout: 10_000,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch {
      throw new Error("Saved report commit is unavailable.");
    }
  }
  if (fs.statSync(run.output.path).size > 600_000) throw new Error("Saved report is too large.");
  return fs.readFileSync(run.output.path, "utf8");
}

function validateAgentPatch(patch: TaskInput, task: Task): void {
  const provider = PROVIDERS.get(patch.provider ?? task.provider);
  if (!provider) throw new Error("Unknown agent.");
  if (patch.model !== undefined && !provider.models().includes(patch.model))
    throw new Error("Unknown model for this agent.");
  if (patch.mode !== undefined && !provider.modes.includes(patch.mode))
    throw new Error("Unknown mode for this agent.");
  const model =
    patch.model ??
    (patch.provider && patch.provider !== task.provider ? provider.defaultModel() : task.model);
  if (
    patch.effort !== undefined &&
    patch.effort !== "default" &&
    !provider.modelDetails?.()[model]?.efforts.includes(patch.effort)
  )
    throw new Error("Unknown effort for this model.");
}

export async function consoleCliTool(
  name: string,
  input: Record<string, unknown>,
  services: Services,
): Promise<unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Input must be an object.");
  if (name === "idea_list") return services.ideas.list();
  if (name === "idea_read") {
    if (typeof input.slug !== "string") throw new Error("Give an idea slug.");
    return services.ideas.read(input.slug);
  }
  if (name === "schedule_config_list") return { tasks: services.schedules.list().map(taskConfig) };
  const task = pickTask(services.schedules, input.id);
  return taskOperation(name, input, task, services);
}

async function taskOperation(
  name: string,
  input: Record<string, unknown>,
  task: Task,
  services: Services,
): Promise<unknown> {
  switch (name) {
    case "schedule_get":
      return { task: taskConfig(task) };
    case "schedule_runs":
      return { task: task.id, runs: task.runs };
    case "schedule_config_update": {
      const patch = configPatch(input.patch);
      validateAgentPatch(patch, task);
      return { updated: taskConfig(services.schedules.update(task.id, patch)) };
    }
    case "schedule_report": {
      const run = pickRun(task, input.run, true);
      return {
        task: task.id,
        run: run.id,
        output: run.output,
        markdown: readReport(services.schedules.outputs, run),
      };
    }
    case "schedule_transcript": {
      const run = pickRun(task, input.run, false);
      if (!run.thread) throw new Error("This run has no transcript.");
      const start =
        input.start === undefined
          ? 1
          : positiveInteger(input.start, "start", Number.MAX_SAFE_INTEGER);
      const limit = input.limit === undefined ? 30 : positiveInteger(input.limit, "limit", 100);
      return {
        task: task.id,
        run: run.id,
        ...(await services.sessionSearch.read({ thread: run.thread, start, limit })),
      };
    }
    default:
      throw new Error(`Unknown CLI operation ${name}.`);
  }
}

import path from "node:path";
import { completeLabel } from "./small-model.ts";

// Tool cards show what the agent is *doing*, not just the raw command. Claude usually supplies a `description` for Bash itself
// and the UI derives labels for file/search tools from their input. What is left is shell commands, Read/Edit calls and MCP tool
// calls with no description (Codex, Pi, terse Claude calls): batch them through Nemotron on NVIDIA.

const FLUSH_MS = 700;
const MAX_BATCH = 8;
const MAX_CMD = 100; // only an excerpt of each command leaves the machine
const MAX_LABEL = 72;

export interface LabelJob {
  thread: string;
  id: string; // tool_use id
  name: string; // tool name: Bash or mcp__server__tool
  command: string; // shell command, or a short plain-English sketch of the MCP call
  cwd: string;
}

/** Which tool calls need a model-written label: shell commands, Read calls and MCP calls without a description. */
export function needsLabel(name: string, input: any): boolean {
  if (typeof input?.description === "string" && input.description.trim()) return false;
  if (name === "Bash") return typeof input?.command === "string" && input.command.trim() !== "";
  if (name === "Read") return typeof input?.file_path === "string" && input.file_path.trim() !== "";
  if (name === "Edit") return typeof input?.file_path === "string" && input.file_path.trim() !== "";
  if (name.startsWith("mcp__")) return true;
  return false;
}

export const excerpt = (c: string) => {
  const one = c.replace(/\s+/g, " ").trim();
  return one.length > MAX_CMD ? one.slice(0, MAX_CMD) + "..." : one;
};

/** Prettify an MCP tool name `mcp__server__tool` -> `server/tool`; pass other names through. */
export function mcpName(name: string): string {
  if (!name.startsWith("mcp__")) return name;
  const parts = name.slice(5).split("__");
  return parts.length > 1 ? `${parts[0]}/${parts.slice(1).join("__")}` : name;
}

/** A short sketch of an MCP tool call's input: prettified name plus the most descriptive param. */
export function mcpSketch(name: string, input: any): string {
  const label = mcpName(name);
  if (!input || typeof input !== "object") return label;
  const keys = Object.keys(input);
  const hint = keys.find((k) => /query|pattern|path|file|url|issue|symbol|topic/.test(k));
  if (hint && typeof input[hint] === "string") return `${label}: ${excerpt(String(input[hint]))}`;
  return `${label}: ${excerpt(JSON.stringify(input))}`;
}

/** A short sketch of a Read call: the verb plus a shortened, readable path. */
export function readSketch(input: any): string {
  if (!input || typeof input !== "object") return "Read";
  const p = String(input.file_path ?? "");
  if (!p) return "Read";
  const segs = p.split(/[/\\]/).filter(Boolean);
  const i = segs.lastIndexOf("repos");
  const short = i !== -1 && segs[i + 1] ? segs.slice(i + 1).join("/") : segs.slice(-2).join("/");
  return `Read: ${excerpt(short)}`;
}

/** A short sketch of an Edit call: the verb plus the edited file's shortened path. */
export function editSketch(input: any): string {
  if (!input || typeof input !== "object") return "Edit";
  const p = String(input.file_path ?? "");
  if (!p) return "Edit";
  const segs = p.split(/[/\\]/).filter(Boolean);
  const i = segs.lastIndexOf("repos");
  const short = i !== -1 && segs[i + 1] ? segs.slice(i + 1).join("/") : segs.slice(-2).join("/");
  const oldLines = Array.isArray(input.old_string)
    ? input.old_string.length
    : String(input.old_string ?? "").split("\n").length;
  return `Edit: ${excerpt(short)} (${oldLines} line${oldLines === 1 ? "" : "s"})`;
}

const PROMPT = (cwd: string, jobs: LabelJob[]) =>
  `For each numbered tool call, write a plain-English label of 3 to 8 words saying what it does. Start with an -ing verb, e.g. "Running the test suite", "Searching the repo for TODOs", "Listing files in the project". No quotes, no trailing period. Reply with ONLY a JSON array of ${jobs.length} string(s), in order.\n\nWorking folder: ${cwd}\n\n${jobs.map((j, i) => `${i + 1}. ${j.command}`).join("\n")}`;

/** Model reply -> exactly n tidy labels, or undefined if the reply is not a clean array of that length. */
export function parseLabels(raw: string | undefined, n: number): string[] | undefined {
  const m = raw?.match(/\[[\s\S]*\]/);
  if (!m) return undefined;
  let arr: unknown;
  try {
    arr = JSON.parse(m[0]);
  } catch {
    return undefined;
  }
  if (!Array.isArray(arr) || arr.length !== n || !arr.every((x) => typeof x === "string"))
    return undefined;
  const out = arr.map((x) =>
    String(x ?? "")
      .replace(/\s+/g, " ")
      .replace(/^["'`\s]+|["'`\s.]+$/g, "")
      .slice(0, MAX_LABEL)
      .trim(),
  );
  return out.every(Boolean) ? out : undefined;
}

/** Deterministic stand-in for tests (AGENT_CONSOLE_MOCK=1). */
const fake = (job: LabelJob) =>
  job.name === "Bash"
    ? `Running ${job.command.trim().split(/\s+/)[0]}`
    : job.name === "Read"
      ? job.command
      : job.name === "Edit"
        ? job.command
        : `Using ${mcpName(job.name)}`;

export interface Labeler {
  request(job: LabelJob): void;
}

interface LabelerState {
  queue: LabelJob[];
  timer: NodeJS.Timeout | undefined;
  busy: boolean;
  onLabel: (job: LabelJob, label: string) => void;
}

async function labelBatch(batch: LabelJob[]): Promise<string[] | undefined> {
  // jobs from different folders are rare; the first job's folder is context enough
  return await completeLabel(
    PROMPT(path.basename(batch[0].cwd) || batch[0].cwd, batch),
    "You write short, plain-English labels.",
    (raw) => parseLabels(raw, batch.length),
  );
}

async function runLabeler(state: LabelerState) {
  if (state.busy || !state.queue.length) return;
  state.busy = true;
  try {
    while (state.queue.length) {
      const batch = state.queue.splice(0, MAX_BATCH);
      const labels =
        process.env.AGENT_CONSOLE_MOCK === "1"
          ? batch.map((job) => fake(job))
          : await labelBatch(batch);
      if (labels)
        batch.forEach((job, idx) => {
          state.onLabel(job, labels[idx]);
        });
    }
  } finally {
    state.busy = false;
  }
}

function requestLabel(state: LabelerState, job: LabelJob) {
  if (process.env.AGENT_CONSOLE_LABELS === "0") return;
  state.queue.push(job);
  if (state.queue.length >= MAX_BATCH) {
    clearTimeout(state.timer);
    state.timer = undefined;
    void runLabeler(state);
  } else if (!state.timer) {
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void runLabeler(state);
    }, FLUSH_MS);
    state.timer.unref();
  }
}

export function createLabeler(onLabel: (job: LabelJob, label: string) => void): Labeler {
  const state: LabelerState = { queue: [], timer: undefined, busy: false, onLabel };
  return {
    request(job) {
      requestLabel(state, job);
    },
  };
}

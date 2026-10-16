import path from "node:path";
import { completeLabel } from "./small-model.ts";

// Tool cards show what the agent is *doing*, not just the raw command. Claude usually supplies a `description` for Bash itself
// and the UI derives labels for file/search tools from their input. What is left is shell commands with no description
// (Codex, Pi, terse Claude calls): batch them through OpenRouter, then Luna, then Haiku.

const FLUSH_MS = 700;
const MAX_BATCH = 8;
const MAX_CMD = 100; // only an excerpt of each command leaves the machine
const MAX_LABEL = 72;

export interface LabelJob {
  thread: string;
  id: string; // tool_use id
  command: string;
  cwd: string;
}

/** Which tool calls need a model-written label: shell commands that did not come with a description. */
export function needsLabel(name: string, input: any): input is { command: string } {
  return name === "Bash" && typeof input?.command === "string" && input.command.trim() !== "" && !(typeof input.description === "string" && input.description.trim());
}

export const excerpt = (c: string) => { const one = c.replace(/\s+/g, " ").trim(); return one.length > MAX_CMD ? one.slice(0, MAX_CMD) + "..." : one; };

const PROMPT = (cwd: string, commands: string[]) =>
  `For each numbered shell command, write a plain-English label of 3 to 8 words saying what it does. Start with an -ing verb, e.g. "Running the test suite", "Searching the repo for TODOs", "Listing files in the project". No quotes, no trailing period. Reply with ONLY a JSON array of ${commands.length} string(s), in order.\n\nWorking folder: ${cwd}\n\n${commands.map((c, i) => `${i + 1}. ${excerpt(c)}`).join("\n")}`;

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
  if (!Array.isArray(arr) || arr.length !== n || !arr.every(x => typeof x === "string")) return undefined;
  const out = arr.map((x) => String(x ?? "").replace(/\s+/g, " ").replace(/^["'`\s]+|["'`\s.]+$/g, "").slice(0, MAX_LABEL).trim());
  return out.every(Boolean) ? out : undefined;
}

/** Deterministic stand-in for tests (AGENT_CONSOLE_MOCK=1). */
const fake = (command: string) => `Running ${command.trim().split(/\s+/)[0]}`;

export interface Labeler {
  request(job: LabelJob): void;
}

export function createLabeler(onLabel: (job: LabelJob, label: string) => void): Labeler {
  let queue: LabelJob[] = [];
  let timer: NodeJS.Timeout | undefined;
  let busy = false;

  const run = async () => {
    if (busy || !queue.length) return;
    busy = true;
    try {
      while (queue.length) {
        const batch = queue.splice(0, MAX_BATCH);
        let labels: string[] | undefined;
        if (process.env.AGENT_CONSOLE_MOCK === "1") labels = batch.map((j) => fake(j.command));
        else {
          // jobs from different folders are rare; the first job's folder is context enough
          labels = await completeLabel(PROMPT(path.basename(batch[0].cwd) || batch[0].cwd, batch.map((j) => j.command)), "You write short, plain-English labels.", raw => parseLabels(raw, batch.length));
        }
        if (labels) batch.forEach((j, i) => onLabel(j, labels![i]));
      }
    } finally {
      busy = false;
    }
  };

  return {
    request(job) {
      if (process.env.AGENT_CONSOLE_LABELS === "0") return;
      queue.push(job);
      if (queue.length >= MAX_BATCH) {
        clearTimeout(timer);
        timer = undefined;
        void run();
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = undefined;
          void run();
        }, FLUSH_MS);
        timer.unref();
      }
    },
  };
}

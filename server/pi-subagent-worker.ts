import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./auth.ts";
import { childEnv } from "./providers/env.ts";
import { piTranslator } from "./providers/pi.ts";
import { piRateEnv } from "./providers/pi-rate-env.ts";
import { parseJson, spawnLines } from "./providers/proc.ts";

// Claude and Codex hand research (gathering, notes, indexing) to Pi so a cheaper model spends the tokens. The caller gets the
// report back as a tool result; notes.md and index.json are kept under DATA_DIR/pi-research/<id>/ and each run's usage is
// appended to pi-research-usage.jsonl so premium and Pi tokens can be compared. Pi runs read-only and gets no console tools.

export interface ResearchRequest {
  version?: 1;
  task: string;
  cwd: string; // folder Pi may read; never written to
  model?: string;
  timeoutMs?: number;
  caller?: { thread?: string; provider?: string };
}

export interface ResearchUsage {
  input: number;
  cacheRead: number;
  output: number;
  cost?: number;
}

export interface ResearchResponse {
  version: 1;
  id: string;
  provider: "pi";
  model: string;
  phase: "completed" | "failed";
  notesPath: string;
  indexPath: string;
  finalText?: string;
  usage: ResearchUsage;
  error?: string;
}

const DEFAULT_MODEL = "nvidia/nvidia/nemotron-3-super-120b-a12b";
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const READ_ONLY_TOOLS = "read,grep,find,ls";
const ROOT = path.join(DATA_DIR, "pi-research");
const LEDGER = path.join(DATA_DIR, "pi-research-usage.jsonl");

const PROMPT = (task: string) =>
  `You are a research subagent. You have read-only tools. Gather the information, then answer with one self-contained markdown report: findings first, sources (file paths or URLs) after. Do not ask questions.\n\nTask: ${task}`;

function validate(req: ResearchRequest) {
  const task = typeof req?.task === "string" ? req.task.trim() : "";
  if (!task) throw new Error("research task must not be empty");
  const cwd = typeof req.cwd === "string" ? path.resolve(req.cwd) : "";
  try {
    if (!cwd || !fs.statSync(cwd).isDirectory()) throw new Error();
    fs.accessSync(cwd, fs.constants.R_OK);
  } catch {
    throw new Error(`cwd not accessible: ${req.cwd}`);
  }
  return {
    task,
    cwd,
    model: req.model || DEFAULT_MODEL,
    timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

interface ResearchRun {
  usage: ResearchUsage;
  text: string;
  error: string | undefined;
  settled: (() => void) | undefined;
}

function recordResearchResult(run: ResearchRun, event: any) {
  for (const entry of event.usageModels ?? []) {
    run.usage.input += (entry.fresh ?? 0) + (entry.cacheWrite ?? 0) + (entry.cacheRead ?? 0);
    run.usage.cacheRead += entry.cacheRead ?? 0;
    run.usage.output += entry.output ?? 0;
    if (typeof entry.cost === "number") run.usage.cost = (run.usage.cost ?? 0) + entry.cost;
  }
  if (event.is_error) run.error ||= "pi reported an error";
  run.settled?.();
}

function handleResearchEvent(run: ResearchRun, event: any) {
  if (event.type === "console_error") run.error ||= String(event.text);
  if (event.type === "result") recordResearchResult(run, event);
}

function captureResearchText(run: ResearchRun, reply: any) {
  if (reply.type !== "message_end" || reply.message?.role !== "assistant") return;
  const joined = (reply.message.content ?? [])
    .filter((block: any) => block?.type === "text")
    .map((block: any) => block.text)
    .join("\n");
  if (joined) run.text = joined;
}

function writeResearchNotes(
  req: ResearchRequest,
  paths: { notesPath: string; indexPath: string },
  details: {
    id: string;
    task: string;
    cwd: string;
    model: string;
    text: string;
    usage: ResearchUsage;
  },
) {
  const { id: runId, task, cwd, model, text, usage } = details;
  fs.writeFileSync(paths.notesPath, text, { mode: 0o600 });
  fs.writeFileSync(
    paths.indexPath,
    JSON.stringify(
      {
        version: 1,
        id: runId,
        task,
        cwd,
        provider: "pi",
        model,
        caller: req.caller ?? {},
        createdAt: new Date().toISOString(),
        notes: path.basename(paths.notesPath),
        usage,
      },
      null,
      1,
    ),
    { mode: 0o600 },
  );
}

function appendResearchLedger(
  req: ResearchRequest,
  runId: string,
  phase: string,
  model: string,
  usage: ResearchUsage,
) {
  try {
    fs.appendFileSync(
      LEDGER,
      JSON.stringify({
        ts: Date.now(),
        id: runId,
        phase,
        caller: req.caller ?? {},
        pi: { model, ...usage },
      }) + "\n",
      { mode: 0o600 },
    );
  } catch (error: any) {
    console.error(`pi-research ledger write failed: ${error?.message || error}`);
  }
}

export async function runPiResearch(req: ResearchRequest): Promise<ResearchResponse> {
  const { task, cwd, model, timeoutMs } = validate(req);
  const runId = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  const dir = path.join(ROOT, runId);
  fs.mkdirSync(path.join(dir, "session"), { recursive: true, mode: 0o700 });
  const notesPath = path.join(dir, "research-notes.md");
  const indexPath = path.join(dir, "index.json");

  const run: ResearchRun = {
    usage: { input: 0, cacheRead: 0, output: 0 },
    text: "",
    error: undefined,
    settled: undefined,
  };
  const done = new Promise<void>((resolve) => (run.settled = resolve));
  const translate = piTranslator((event) => handleResearchEvent(run, event));

  const args = [
    "--mode",
    "rpc",
    "--model",
    model,
    "--session-dir",
    path.join(dir, "session"),
    "--tools",
    READ_ONLY_TOOLS,
  ];
  const env = piRateEnv({ ...childEnv(), AGENT_CONSOLE_THREAD: runId }, "interactive");
  const proc = spawnLines(
    "pi",
    "pi",
    args,
    { cwd, env },
    {
      event: (event) => {
        if (event.type === "console_error") run.error ||= String(event.text);
      },
      commands() {},
      exited(info) {
        if (!info.aborted) run.error ||= info.stderr.trim() || `pi exited with code ${info.code}`;
        run.settled?.();
      },
    },
    (line) => {
      const reply = parseJson(line);
      if (!reply) return;
      captureResearchText(run, reply);
      translate(reply);
    },
  );

  proc.write(JSON.stringify({ id: "p1", type: "prompt", message: PROMPT(task) }));
  const timer = setTimeout(() => {
    run.error ||= `timed out after ${Math.round(timeoutMs / 1000)}s`;
    run.settled?.();
  }, timeoutMs);
  await done;
  clearTimeout(timer);
  if (proc.alive()) proc.kill();

  const { text, usage } = run;
  const phase = run.error || !text ? "failed" : "completed";
  if (phase === "failed") run.error ||= "pi returned no report";
  const res: ResearchResponse = {
    version: 1,
    id: runId,
    provider: "pi",
    model,
    phase,
    notesPath,
    indexPath,
    usage,
    ...(phase === "completed" ? { finalText: text } : { error: run.error }),
  };
  if (phase === "completed")
    writeResearchNotes(req, { notesPath, indexPath }, { id: runId, task, cwd, model, text, usage });
  appendResearchLedger(req, runId, phase, model, usage);
  return res;
}

/** What the calling model sees: the report plus where it is kept, or why the run failed. */
export function researchToolText(res: ResearchResponse): string {
  if (res.phase === "failed") return `Error: Pi research failed: ${res.error}`;
  return `${res.finalText}\n\n---\nPi (${res.model}) used ${res.usage.input} input / ${res.usage.output} output tokens.\nNotes: ${res.notesPath}\nIndex: ${res.indexPath}`;
}

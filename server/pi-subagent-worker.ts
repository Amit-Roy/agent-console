import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "./auth.ts";
import { childEnv } from "./providers/env.ts";
import { piRateEnv } from "./providers/pi-rate-env.ts";
import { parseJson, spawnLines } from "./providers/proc.ts";
import { piTranslator } from "./providers/pi.ts";

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

export async function runPiResearch(req: ResearchRequest): Promise<ResearchResponse> {
  const { task, cwd, model, timeoutMs } = validate(req);
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  const dir = path.join(ROOT, id);
  fs.mkdirSync(path.join(dir, "session"), { recursive: true, mode: 0o700 });
  const notesPath = path.join(dir, "research-notes.md");
  const indexPath = path.join(dir, "index.json");

  const usage: ResearchUsage = { input: 0, cacheRead: 0, output: 0 };
  let text = "";
  let error: string | undefined;
  let settled: (() => void) | undefined;
  const done = new Promise<void>((resolve) => (settled = resolve));

  const translate = piTranslator((ev) => {
    if (ev.type === "console_error") error ||= String(ev.text);
    if (ev.type === "result") {
      for (const m of ev.usageModels ?? []) {
        usage.input += (m.fresh ?? 0) + (m.cacheWrite ?? 0) + (m.cacheRead ?? 0);
        usage.cacheRead += m.cacheRead ?? 0;
        usage.output += m.output ?? 0;
        if (typeof m.cost === "number") usage.cost = (usage.cost ?? 0) + m.cost;
      }
      if (ev.is_error) error ||= "pi reported an error";
      settled?.();
    }
  });

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
  const env = piRateEnv({ ...childEnv(), AGENT_CONSOLE_THREAD: id }, "interactive");
  const proc = spawnLines(
    "pi",
    "pi",
    args,
    { cwd, env },
    {
      event: (ev) => {
        if (ev.type === "console_error") error ||= String(ev.text);
      },
      commands() {},
      exited(info) {
        if (!info.aborted) error ||= info.stderr.trim() || `pi exited with code ${info.code}`;
        settled?.();
      },
    },
    (line) => {
      const r = parseJson(line);
      if (!r) return;
      if (r.type === "message_end" && r.message?.role === "assistant") {
        const t = (r.message.content ?? [])
          .filter((b: any) => b?.type === "text")
          .map((b: any) => b.text)
          .join("\n");
        if (t) text = t;
      }
      translate(r);
    },
  );

  proc.write(JSON.stringify({ id: "p1", type: "prompt", message: PROMPT(task) }));
  const timer = setTimeout(() => {
    error ||= `timed out after ${Math.round(timeoutMs / 1000)}s`;
    settled?.();
  }, timeoutMs);
  await done;
  clearTimeout(timer);
  if (proc.alive()) proc.kill();

  const phase = error || !text ? "failed" : "completed";
  if (phase === "failed") error ||= "pi returned no report";
  const res: ResearchResponse = {
    version: 1,
    id,
    provider: "pi",
    model,
    phase,
    notesPath,
    indexPath,
    usage,
    ...(phase === "completed" ? { finalText: text } : { error }),
  };
  if (phase === "completed") {
    fs.writeFileSync(notesPath, text, { mode: 0o600 });
    fs.writeFileSync(
      indexPath,
      JSON.stringify(
        {
          version: 1,
          id,
          task,
          cwd,
          provider: "pi",
          model,
          caller: req.caller ?? {},
          createdAt: new Date().toISOString(),
          notes: path.basename(notesPath),
          usage,
        },
        null,
        1,
      ),
      { mode: 0o600 },
    );
  }
  try {
    fs.appendFileSync(
      LEDGER,
      JSON.stringify({
        ts: Date.now(),
        id,
        phase,
        caller: req.caller ?? {},
        pi: { model, ...usage },
      }) + "\n",
      { mode: 0o600 },
    );
  } catch (e: any) {
    console.error(`pi-research ledger write failed: ${e?.message || e}`);
  }
  return res;
}

/** What the calling model sees: the report plus where it is kept, or why the run failed. */
export function researchToolText(res: ResearchResponse): string {
  if (res.phase === "failed") return `Error: Pi research failed: ${res.error}`;
  return `${res.finalText}\n\n---\nPi (${res.model}) used ${res.usage.input} input / ${res.usage.output} output tokens.\nNotes: ${res.notesPath}\nIndex: ${res.indexPath}`;
}

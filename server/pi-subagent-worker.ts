import { join } from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { launch as sandboxLaunch } from "./automation/sandbox.ts";
import { childEnv } from "./providers/env.ts";
import { piRateEnv } from "./providers/pi-rate-env.ts";
import { parseJson, spawnLines, type Proc } from "./providers/proc.ts";
import { piQuestions } from "./providers/pi-questions.ts";
import { piTranslator } from "./providers/pi.ts";
import { harnessInstructions } from "./providers/brain.ts";
import { retryEvent } from "./turn-timing.ts";
import { acquireModelRequest } from "./providers/model-rate-client.ts";
import { IMAGE_ONLY_PROMPT, type AgentCtx, type Attachment } from "./providers/types.ts";
import { DATA_DIR } from "./auth.ts";

export interface ResearchTaskRequest {
  task: string;
  cwd: string;
  model?: string;
  mode?: "plan" | "bypassPermissions";
}

export interface ResearchTaskResult {
  notesPath: string;
  indexPath: string;
  provider: string;
  model: string;
  phase: "delegated" | "completed" | "failed";
}

const QUESTIONS_EXTENSION = fileURLToPath(new URL("./pi-questions-extension.mjs", import.meta.url));
const TOOLS_EXTENSION = fileURLToPath(new URL("./console-tools.mjs", import.meta.url));

const DEFAULT_MODEL = "nvidia/nvidia/nemotron-3-super-120b-a12b";

const DEFAULT_REQUEST: ResearchTaskRequest = { task: "", cwd: process.cwd() };

function validateRequest(req: Partial<ResearchTaskRequest>): ResearchTaskRequest {
  const task = typeof req.task === "string" ? req.task : DEFAULT_REQUEST.task;
  const cwd = typeof req.cwd === "string" ? req.cwd : DEFAULT_REQUEST.cwd;
  if (!fs.existsSync(cwd)) fs.mkdirSync(cwd, { recursive: true });
  return { task, cwd, model: req.model ?? DEFAULT_MODEL, mode: req.mode ?? "bypassPermissions" };
}

/**
 * Processes a research task by delegating it to a PI subagent.
 * Spawns a PI agent, sends the research task, and returns structured results.
 * @param req The research task request with task description and working directory.
 * @returns A promise that resolves to the structured result with notes and index paths.
 */
export async function processResearchTask(req: ResearchTaskRequest): Promise<ResearchTaskResult> {
  const { task, cwd, model = DEFAULT_MODEL, mode = "bypassPermissions" } = validateRequest(req);

  const sessionId = `pi-subagent-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
  const sessionDir = join(cwd, "pi-sessions", sessionId);
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

  const args = ["--mode", "rpc", "--model", model, "--session-dir", sessionDir, "--extension", QUESTIONS_EXTENSION, "--extension", TOOLS_EXTENSION];
  if (mode === "plan") args.push("--tools", "read,grep,find,ls,ask_user,schedule_list,save_output");

  const notesPath = join(cwd, "research-notes.md");
  const indexPath = join(cwd, "index.json");

  let resolved = false;
  let result: ResearchTaskResult | undefined;
  let notesContent = "";

  const ctx: AgentCtx = {
    event(ev: any) {
      if (ev.type === "result") {
        resolved = true;
        result = {
          notesPath,
          indexPath,
          provider: "pi",
          model,
          phase: ev.subtype === "error" ? "failed" : "completed",
        };
      }
    },
    commands() {},
    exited(info: any) {
      if (!resolved) {
        result = {
          notesPath,
          indexPath,
          provider: "pi",
          model,
          phase: "failed",
        };
      }
    },
  };

  let proc: Proc | undefined;
  const questions = piQuestions(msg => proc?.write(JSON.stringify(msg)), ctx.event);

  const translate = piTranslator(
    (ev) => ctx.event(ev),
    (list) => ctx.commands(list),
    () => undefined
  );

  const launch = sandboxLaunch({ id: sessionId, cwd, mode, model }, "pi", args, piRateEnv({ ...childEnv(), AGENT_CONSOLE_THREAD: sessionId }, "interactive"));
  proc = spawnLines("pi", launch.command, launch.args, { cwd: launch.cwd, env: launch.env }, {
    ...ctx,
    exited(info: any) { questions.cancelAll(); ctx.exited(info); },
  }, (line) => {
    const r = parseJson(line);
    if (!r || questions.handle(r)) return;
    
    if (r.type === "message_end" && r.message?.role === "assistant") {
      const text = r.message.content?.[0]?.text;
      if (text) notesContent = text;
    }
    
    translate(r);
  });

  // Send the research task
  const prompt = `Research: ${task}

Write your findings to 'research-notes.md' in the current directory.
Create an index 'index.json' in the current directory.
When done, exit.`;
  proc.write(JSON.stringify({ type: "prompt", prompt: prompt }) + "\n");

  // Wait for result
  const timeout = setTimeout(() => {
    if (!resolved && proc) proc.abort();
  }, 60_000);

  while (!resolved && proc?.alive()) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  clearTimeout(timeout);

  if (!result) {
    result = { notesPath, indexPath, provider: "pi", model, phase: "failed" };
  }

  // Ensure files exist even if PI didn't produce them (fallback)
  if (!fs.existsSync(notesPath)) {
    fs.writeFileSync(notesPath, notesContent || `# Research: ${task}\n\nPI subagent result.`);
  }
  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath, JSON.stringify([{ id: "1", title: task, description: task, status: result.phase, provider: "pi", model }]));
  }

  return result;
}
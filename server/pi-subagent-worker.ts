import { join } from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { launch as sandboxLaunch } from "./automation/sandbox.ts";
import { childEnv } from "./providers/env.ts";
import { piRateEnv } from "./providers/pi-rate-env.ts";
import { parseJson, spawnLines, type Proc } from "./providers/proc.ts";
import { piQuestions } from "./providers/pi-questions.ts";
import { piTranslator } from "./providers/pi.ts";
import { type AgentCtx } from "./providers/types.ts";
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
  finalText?: string;
}

const QUESTIONS_EXTENSION = fileURLToPath(new URL("./pi-questions-extension.mjs", import.meta.url));
const TOOLS_EXTENSION = fileURLToPath(new URL("./console-tools.mjs", import.meta.url));

const DEFAULT_MODEL = "nvidia/nvidia/nemotron-3-super-120b-a12b";

function validateRequest(req: Partial<ResearchTaskRequest>): ResearchTaskRequest {
  const task = typeof req.task === "string" && req.task.trim().length > 0 ? req.task.trim() : "";
  if (!task) throw new Error("research task must not be empty");

  const cwd = typeof req.cwd === "string" ? req.cwd : process.cwd();
  try {
    fs.accessSync(cwd, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    throw new Error(`cwd not accessible: ${cwd}`);
  }

  return { task, cwd, model: req.model ?? DEFAULT_MODEL, mode: req.mode ?? "bypassPermissions" };
}

/**
 * Processes a research task by delegating it to a PI subagent.
 * Spawns a PI agent, sends the research task, and returns structured results including
 * the PI's final text output.
 * @param req The research task request with task description and working directory.
 * @returns A promise that resolves to the structured result with notes, index paths,
 *   provider, model, phase, and PI final text.
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
  let failureReason = "";

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
          finalText: notesContent,
        };
      }
    },
    commands() {},
    exited(info: any) {
      if (!resolved) {
        const reason = failureReason || info.stderr || `exit code ${info.code}`;
        result = {
          notesPath,
          indexPath,
          provider: "pi",
          model,
          phase: "failed",
          finalText: undefined,
        };
        failureReason = reason;
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

    if (r.type === "auto_retry_end" && r.success === false) {
      failureReason = String(r.finalError ?? "auto retry failed");
    }

    translate(r);
  });

  // Send the research task using the proper prompt envelope from pi.ts
  const n = 0;
  const id = `p${n + 1}`;
  proc.write(JSON.stringify({ id, type: "prompt", message: task }) + "\n");

  // Wait for result with timeout
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    if (proc) {
      failureReason = "timeout after 60s waiting for PI subagent result";
      proc.abort();
    }
  }, 60_000);

  while (!resolved && !timedOut && proc?.alive()) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  clearTimeout(timeout);

  if (!result) {
    result = {
      notesPath,
      indexPath,
      provider: "pi",
      model,
      phase: timedOut ? "failed" : "failed",
      finalText: undefined,
    };
  }

  // Copy files from sessionDir to cwd if they exist (only on success)
  if (result.phase === "completed") {
    const sessionNotesPath = join(sessionDir, "research-notes.md");
    const sessionIndexPath = join(sessionDir, "index.json");
    if (fs.existsSync(sessionNotesPath)) {
      fs.copyFileSync(sessionNotesPath, notesPath);
    }
    if (fs.existsSync(sessionIndexPath)) {
      fs.copyFileSync(sessionIndexPath, indexPath);
    }
  }

  return result;
}
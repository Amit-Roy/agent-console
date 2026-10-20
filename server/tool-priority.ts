import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "./auth.ts";

/* Agents' tool work (tests, builds, browsers, scratch servers) runs at a lower CPU priority than the agents themselves and this
   server, so a busy box delays background work instead of the next model step or a chat stream. Two layers:
   - Claude sources CLAUDE_ENV_FILE before every Bash command, so each command starts at TOOL_NICE (verified on CLI 2.1).
   - A sweep renices every process two or more levels below this server: tool shells and MCP servers of every harness.
     The harness processes (direct children) keep normal priority. Lowering priority needs no privilege; raising it does,
     so nothing here can make a process faster than default. AGENT_CONSOLE_TOOL_NICE=0 turns it off. */
const PROC = "/proc";
export const TOOL_NICE = Math.max(0, Math.min(19, Number(process.env.AGENT_CONSOLE_TOOL_NICE ?? 10)));
const SWEEP_MS = 2000;

let envFile: string | null = null;
export function toolEnvFile(): string | null {
  if (!TOOL_NICE) return null;
  if (envFile) return envFile;
  const file = path.join(DATA_DIR, "tool-env.sh");
  try {
    fs.writeFileSync(file, `# Written by agent-console: Bash tool commands run below the agent's own priority.\nrenice -n ${TOOL_NICE} -p $$ >/dev/null 2>&1\n`, { mode: 0o644 });
    envFile = file;
  } catch {}
  return envFile;
}

function children(pid: number): number[] {
  const out: number[] = [];
  let tasks: string[] = [];
  try { tasks = fs.readdirSync(path.join(PROC, String(pid), "task")); } catch { return out; }
  for (const tid of tasks) {
    try {
      for (const c of fs.readFileSync(path.join(PROC, String(pid), "task", tid, "children"), "utf8").split(" ")) if (c.trim()) out.push(Number(c));
    } catch {}
  }
  return out;
}

/* Renice descendants below the direct children of `root`. Returns how many processes were lowered. */
export function lowerToolPriority(root = process.pid, nice = TOOL_NICE): number {
  let lowered = 0;
  const seen = new Set<number>();
  let level = children(root);
  for (let depth = 1; level.length && depth < 32; depth++) {
    const next: number[] = [];
    for (const pid of level) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      if (depth >= 2) {
        try { if (os.getPriority(pid) < nice) { os.setPriority(pid, nice); lowered++; } } catch {}
      }
      next.push(...children(pid));
    }
    level = next;
  }
  return lowered;
}

let started = false;
export function startToolPriority() {
  if (started || !TOOL_NICE) return;
  started = true;
  toolEnvFile();
  setInterval(() => lowerToolPriority(), SWEEP_MS).unref();
}

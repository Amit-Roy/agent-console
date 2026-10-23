import { spawn, type ChildProcess } from "node:child_process";
import type { AgentCtx } from "./types.ts";

export interface Proc {
  proc: ChildProcess;
  aborted: boolean;
  alive(): boolean;
  write(line: string): void;
  abort(): void;
  kill(): void;
}

// Spawn a harness and deliver its stdout one LF-terminated record at a time. Splitting only on "\n" (not readline) keeps
// U+2028/2029 inside JSON strings intact. Reports start failures and exits through ctx.
export function spawnLines(
  name: string,
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
  ctx: AgentCtx,
  onLine: (line: string) => void,
): Proc {
  const proc = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
  const p: Proc = {
    proc,
    aborted: false,
    alive: () => proc.exitCode === null && proc.signalCode === null,
    write: (line) => void proc.stdin!.write(line + "\n"),
    abort() {
      p.aborted = true;
      proc.kill("SIGINT");
      setTimeout(() => p.alive() && proc.kill("SIGKILL"), 2000).unref();
    },
    kill() {
      p.aborted = true;
      proc.kill("SIGTERM");
      setTimeout(() => p.alive() && proc.kill("SIGKILL"), 5000).unref();
    },
  };
  let buf = "";
  let stderr = "";
  proc.stdout!.setEncoding("utf8");
  proc.stdout!.on("data", (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (line.trim()) onLine(line);
    }
  });
  proc.stderr!.setEncoding("utf8");
  proc.stderr!.on("data", (c: string) => (stderr = (stderr + c).slice(-2000)));
  proc.stdin!.on("error", () => {}); // EPIPE when the child exits first; the exit handler reports it
  proc.on("error", (err) =>
    ctx.event({ type: "console_error", text: `Could not start ${name}: ${err.message}` }),
  );
  proc.on("exit", (code, signal) => ctx.exited({ code, signal, stderr, aborted: p.aborted }));
  return p;
}

export const parseJson = (line: string): any => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

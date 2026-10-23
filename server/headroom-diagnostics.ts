import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LIMIT = 256 * 1024;
type Event = "start" | "exit" | "spawn-error" | "stop" | "resource" | "breaker" | "output";
const EVENTS = new Set(["start", "exit", "spawn-error", "stop", "resource", "breaker", "output"]);
// Deliberately accept only fixed categories and numeric metadata. Child output, error
// messages, environment variables and HTTP bodies must never reach this log.
export function diagnostic(event: Event, fields: Record<string, number> = {}) {
  if (!EVENTS.has(event)) return;
  try {
    const dir = process.env.AGENT_CONSOLE_RUN || path.join(os.homedir(), ".cache", "agent-console");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, "headroom-diagnostics.jsonl");
    const previous = `${file}.1`;
    if (fs.existsSync(previous)) {
      const old = fs.lstatSync(previous);
      if (old.isSymbolicLink() || old.size > LIMIT) fs.rmSync(previous, { force: true });
      else fs.chmodSync(previous, 0o600);
    }
    const values = Object.fromEntries(
      Object.entries(fields).filter(
        ([key, value]) =>
          /^(pid|code|signal|attempt|rssBytes|cpuPercent|stdoutBytes|stderrBytes|reason)$/.test(
            key,
          ) && Number.isFinite(value),
      ),
    );
    const line = JSON.stringify({ time: Date.now(), event, ...values }) + "\n";
    if (Buffer.byteLength(line) > LIMIT) return;
    if (fs.existsSync(file) && fs.lstatSync(file).size + Buffer.byteLength(line) > LIMIT) {
      // Never follow a preexisting symlink, including during rotation.
      fs.rmSync(previous, { force: true });
      const old = fs.lstatSync(file);
      if (old.isSymbolicLink() || old.size > LIMIT) fs.rmSync(file, { force: true });
      else {
        fs.renameSync(file, previous);
        fs.chmodSync(previous, 0o600);
      }
    }
    const fd = fs.openSync(
      file,
      fs.constants.O_WRONLY |
        fs.constants.O_APPEND |
        fs.constants.O_CREAT |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fs.fchmodSync(fd, 0o600);
      fs.writeSync(fd, line);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* Diagnostics cannot break routing or shutdown. */
  }
}

export type Resource = { rssBytes: number; ticks: number; time: number };
export async function resource(pid: number): Promise<Resource | undefined> {
  if (process.platform !== "linux") return;
  try {
    const [stat, status] = await Promise.all([
      fs.promises.readFile(`/proc/${pid}/stat`, "utf8"),
      fs.promises.readFile(`/proc/${pid}/status`, "utf8"),
    ]);
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    const rssKB = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]);
    const ticks = Number(fields[11]) + Number(fields[12]);
    if (Number.isFinite(rssKB) && Number.isFinite(ticks))
      return { rssBytes: rssKB * 1024, ticks, time: Date.now() };
  } catch {
    /* A process may exit between the two reads. */
  }
}

export class ResourceGuard {
  private previous: Resource | undefined;
  private busySince: number | undefined;
  sample(current: Resource) {
    // Linux /proc process accounting uses USER_HZ (100 ticks per second).
    const elapsed = this.previous ? current.time - this.previous.time : 0;
    const cpuPercent =
      elapsed > 0 ? Math.max(0, ((current.ticks - this.previous!.ticks) * 1000) / elapsed) : 0;
    if (cpuPercent > 80) this.busySince ??= this.previous!.time;
    else this.busySince = undefined;
    this.previous = current;
    return {
      cpuPercent,
      reason:
        current.rssBytes > 1024 * 1024 * 1024
          ? 1
          : this.busySince !== undefined && current.time - this.busySince >= 30_000
            ? 2
            : 0,
    };
  }
}

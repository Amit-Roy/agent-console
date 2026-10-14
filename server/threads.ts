import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./auth.ts";

export type Mode = "plan" | "acceptEdits" | "bypassPermissions";
export const MODES: Mode[] = ["plan", "acceptEdits", "bypassPermissions"];
export const MODELS = ["sonnet", "opus", "haiku"];

export interface Thread {
  id: string;
  title: string;
  cwd: string;
  mode: Mode;
  model: string;
  sessionId?: string;
  status: "idle" | "running";
  cost: number;
  createdAt: number;
  updatedAt: number;
}

type Emit = (msg: unknown) => void;

const THREADS_FILE = path.join(DATA_DIR, "threads.json");
const LOG_DIR = path.join(DATA_DIR, "logs");
fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });

const IDLE_KILL_MS = 30 * 60 * 1000;
const MAX_RESULT_CHARS = 20_000;
// never let the subscription login be silently replaced by metered API billing
const SCRUBBED_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDECODE"];

export interface Command {
  name: string;
  description: string;
  argumentHint?: string;
}
const COMMANDS_FILE = path.join(DATA_DIR, "commands.json");

interface Live {
  proc: ChildProcess;
  buf: string;
  stderr: string;
  aborted: boolean;
  idleTimer?: NodeJS.Timeout;
}

export class Threads {
  private threads = new Map<string, Thread>();
  private live = new Map<string, Live>();
  private emit: Emit;
  private commands: Command[] = [];
  constructor(emit: Emit) {
    this.emit = emit;
    try {
      this.commands = JSON.parse(fs.readFileSync(COMMANDS_FILE, "utf8"));
    } catch {}
    try {
      for (const t of JSON.parse(fs.readFileSync(THREADS_FILE, "utf8")) as Thread[]) {
        t.status = "idle"; // nothing survives a server restart
        this.threads.set(t.id, t);
      }
    } catch {}
  }

  getCommands(): Command[] {
    return this.commands;
  }

  list(): Thread[] {
    return [...this.threads.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  get(id: string) {
    return this.threads.get(id);
  }

  private persist() {
    fs.writeFileSync(THREADS_FILE, JSON.stringify([...this.threads.values()], null, 1), { mode: 0o600 });
  }
  private touch(t: Thread) {
    t.updatedAt = Date.now();
    this.persist();
    this.emit({ t: "thread", thread: t });
  }

  create(opts: { cwd: string; mode: Mode; model: string; title?: string }): Thread {
    const now = Date.now();
    const t: Thread = {
      id: crypto.randomUUID(),
      title: opts.title?.trim() || path.basename(opts.cwd) || "thread",
      cwd: opts.cwd,
      mode: opts.mode,
      model: opts.model,
      status: "idle",
      cost: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.threads.set(t.id, t);
    this.persist();
    this.emit({ t: "thread", thread: t });
    return t;
  }

  update(id: string, patch: { mode?: Mode; model?: string; title?: string }) {
    const t = this.threads.get(id);
    if (!t) return;
    if (t.status === "running" && (patch.mode || patch.model)) throw new Error("Stop the running turn before changing mode or model.");
    if (patch.mode) t.mode = patch.mode;
    if (patch.model) t.model = patch.model;
    if (patch.title) t.title = patch.title.slice(0, 80);
    if (patch.mode || patch.model) this.kill(id); // respawn with new flags on next send (history kept via --resume)
    this.touch(t);
  }

  remove(id: string) {
    this.kill(id);
    this.threads.delete(id);
    this.persist();
    fs.rmSync(path.join(LOG_DIR, `${id}.jsonl`), { force: true });
    this.emit({ t: "removed", thread: id });
  }

  history(id: string): unknown[] {
    try {
      return fs
        .readFileSync(path.join(LOG_DIR, `${id}.jsonl`), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  private log(id: string, ev: unknown) {
    fs.appendFileSync(path.join(LOG_DIR, `${id}.jsonl`), JSON.stringify(ev) + "\n", { mode: 0o600 });
  }

  private publish(id: string, ev: any, persistIt = true) {
    if (persistIt) this.log(id, ev);
    this.emit({ t: "event", thread: id, event: ev });
  }

  private spawnProc(t: Thread): Live {
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode", t.mode,
      "--model", t.model,
    ];
    if (t.sessionId) args.push("--resume", t.sessionId);
    const env = { ...process.env };
    for (const k of SCRUBBED_ENV) delete env[k];
    const proc = spawn("claude", args, { cwd: t.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const live: Live = { proc, buf: "", stderr: "", aborted: false };
    this.live.set(t.id, live);

    proc.stdout!.setEncoding("utf8");
    proc.stdout!.on("data", (chunk: string) => {
      live.buf += chunk;
      let i: number;
      while ((i = live.buf.indexOf("\n")) >= 0) {
        const line = live.buf.slice(0, i);
        live.buf = live.buf.slice(i + 1);
        if (line.trim()) this.onLine(t, line);
      }
    });
    proc.stderr!.setEncoding("utf8");
    proc.stderr!.on("data", (c: string) => (live.stderr = (live.stderr + c).slice(-2000)));
    proc.on("error", (err) => {
      this.publish(t.id, { type: "console_error", text: `Could not start claude: ${err.message}` });
    });
    proc.on("exit", (code, signal) => {
      if (live.idleTimer) clearTimeout(live.idleTimer);
      if (this.live.get(t.id) === live) this.live.delete(t.id);
      if (t.status === "running") {
        t.status = "idle";
        if (!live.aborted) {
          this.publish(t.id, {
            type: "console_error",
            text: `claude exited (${signal ?? code}). ${live.stderr.trim().slice(-500)}`,
          });
        }
        this.touch(t);
      }
    });
    return live;
  }

  private onLine(t: Thread, line: string) {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type === "system" && ev.subtype === "init" && ev.session_id) {
      if (t.sessionId !== ev.session_id) {
        t.sessionId = ev.session_id;
        this.persist();
      }
    }
    if (ev.type === "user") {
      delete ev.tool_use_result; // duplicate of message.content, can be huge
      for (const c of ev.message?.content ?? []) {
        if (c?.type === "tool_result" && typeof c.content === "string" && c.content.length > MAX_RESULT_CHARS) {
          c.content = c.content.slice(0, MAX_RESULT_CHARS) + `\n… (${c.content.length - MAX_RESULT_CHARS} more characters truncated)`;
        }
      }
    }
    if (ev.type === "system" && ev.subtype === "commands_changed") {
      // slash commands + skills available to headless runs; cached so the "/" menu works before the first message
      const list: Command[] = (ev.commands ?? [])
        .filter((c: any) => typeof c?.name === "string")
        .map((c: any) => ({ name: c.name, description: String(c.description ?? "").slice(0, 200), argumentHint: c.argumentHint || undefined }))
        .sort((a: Command, b: Command) => a.name.localeCompare(b.name));
      if (JSON.stringify(list) !== JSON.stringify(this.commands)) {
        this.commands = list;
        fs.writeFileSync(COMMANDS_FILE, JSON.stringify(list), { mode: 0o600 });
        this.emit({ t: "commands", commands: list });
      }
      return;
    }
    if (ev.type === "result") {
      t.status = "idle";
      if (typeof ev.total_cost_usd === "number") t.cost += ev.total_cost_usd;
      this.touch(t);
    }
    this.publish(t.id, ev, ev.type !== "stream_event");
  }

  send(id: string, text: string) {
    const t = this.threads.get(id);
    if (!t) throw new Error("Unknown thread");
    if (t.status === "running") throw new Error("A turn is already running.");
    let live = this.live.get(id);
    if (!live || live.proc.exitCode !== null) live = this.spawnProc(t);
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.aborted = false;
    t.status = "running";
    this.publish(id, { type: "user_input", text, ts: Date.now() });
    live.proc.stdin!.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
    this.touch(t);
    live.idleTimer = undefined;
  }

  abort(id: string) {
    const t = this.threads.get(id);
    const live = this.live.get(id);
    if (!t || !live) return;
    live.aborted = true;
    this.live.delete(id); // next send spawns a fresh process and resumes the session
    live.proc.kill("SIGINT");
    setTimeout(() => live.proc.exitCode === null && live.proc.kill("SIGKILL"), 2000);
    t.status = "idle";
    this.publish(id, { type: "aborted", ts: Date.now() });
    this.touch(t);
  }

  private kill(id: string) {
    const live = this.live.get(id);
    if (live) {
      live.aborted = true;
      live.proc.kill("SIGTERM");
      this.live.delete(id);
    }
  }

  // free memory from idle claude processes; sessions resume on the next message
  sweep() {
    for (const [id, live] of this.live) {
      const t = this.threads.get(id);
      if (t && t.status === "idle" && Date.now() - t.updatedAt > IDLE_KILL_MS) this.kill(id);
    }
  }

  shutdown() {
    for (const id of [...this.live.keys()]) this.kill(id);
  }
}

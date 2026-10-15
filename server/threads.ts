import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./auth.ts";
import { DEFAULT_PROVIDER, PROVIDERS, type Agent, type AgentCtx, type Command, type Mode } from "./providers/index.ts";

export type { Command, Mode };

export interface Thread {
  id: string;
  provider: string;
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
const COMMANDS_FILE = path.join(DATA_DIR, "commands.json");
const LOG_DIR = path.join(DATA_DIR, "logs");
fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });

const IDLE_KILL_MS = 30 * 60 * 1000;

interface Live {
  agent: Agent;
  aborted: boolean;
}

export class Threads {
  private threads = new Map<string, Thread>();
  private live = new Map<string, Live>();
  private emit: Emit;
  private commands: Record<string, Command[]> = {}; // per provider: each harness has its own slash commands and skills
  constructor(emit: Emit) {
    this.emit = emit;
    try {
      const c = JSON.parse(fs.readFileSync(COMMANDS_FILE, "utf8"));
      this.commands = Array.isArray(c) ? { claude: c } : c; // older versions cached a bare Claude list
    } catch {}
    try {
      for (const t of JSON.parse(fs.readFileSync(THREADS_FILE, "utf8")) as Thread[]) {
        t.status = "idle"; // nothing survives a server restart
        t.provider ||= DEFAULT_PROVIDER;
        this.threads.set(t.id, t);
      }
    } catch {}
  }

  getCommands(): Record<string, Command[]> {
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

  create(opts: { provider?: string; cwd: string; mode?: Mode; model?: string; title?: string }): Thread {
    const prov = PROVIDERS.get(opts.provider || DEFAULT_PROVIDER);
    if (!prov) throw new Error("Unknown provider.");
    const st = prov.status();
    if (!st.ok) throw new Error(`${prov.label} is not ready. ${st.hint ?? ""}`.trim());
    const mode = opts.mode && prov.modes.includes(opts.mode) ? opts.mode : prov.defaultMode;
    const model = opts.model && prov.models().includes(opts.model) ? opts.model : prov.defaultModel();
    if (!model) throw new Error(`${prov.label} has no models available.`);
    const now = Date.now();
    const t: Thread = {
      id: crypto.randomUUID(),
      provider: prov.id,
      title: opts.title?.trim() || path.basename(opts.cwd) || "thread",
      cwd: opts.cwd,
      mode,
      model,
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
    const prov = PROVIDERS.get(t.provider);
    if (patch.mode && !prov?.modes.includes(patch.mode)) patch.mode = undefined;
    if (patch.model && !prov?.models().includes(patch.model)) patch.model = undefined;
    if (t.status === "running" && (patch.mode || patch.model)) throw new Error("Stop the running turn before changing mode or model.");
    if (patch.mode) t.mode = patch.mode;
    if (patch.model) t.model = patch.model;
    if (patch.title) t.title = patch.title.slice(0, 80);
    if (patch.mode || patch.model) this.kill(id); // respawn with new flags on next send (history kept via the harness's session)
    this.touch(t);
  }

  remove(id: string) {
    this.kill(id);
    this.threads.delete(id);
    this.persist();
    fs.rmSync(path.join(LOG_DIR, `${id}.jsonl`), { force: true });
    fs.rmSync(path.join(DATA_DIR, "pi-sessions", id), { recursive: true, force: true });
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

  private setCommands(provider: string, list: Command[]) {
    if (JSON.stringify(list) === JSON.stringify(this.commands[provider])) return;
    this.commands[provider] = list;
    fs.writeFileSync(COMMANDS_FILE, JSON.stringify(this.commands), { mode: 0o600 });
    this.emit({ t: "commands", provider, commands: list });
  }

  private start(t: Thread): Live {
    const prov = PROVIDERS.get(t.provider);
    if (!prov) throw new Error(`Unknown provider "${t.provider}".`);
    const live: Live = { agent: undefined as unknown as Agent, aborted: false };
    const ctx: AgentCtx = {
      event: (ev) => this.onEvent(t, ev),
      commands: (list) => this.setCommands(t.provider, list),
      exited: (info) => {
        const current = this.live.get(t.id) === live;
        if (current) this.live.delete(t.id);
        if (!current || t.status !== "running") return; // a replaced or aborted agent's exit says nothing about the new turn
        t.status = "idle";
        if (!info.aborted && !live.aborted) {
          this.publish(t.id, { type: "console_error", text: `${prov.label} exited (${info.signal ?? info.code}). ${info.stderr.trim().slice(-500)}` });
        }
        this.touch(t);
      },
    };
    live.agent = prov.start({ id: t.id, cwd: t.cwd, mode: t.mode, model: t.model, sessionId: t.sessionId }, ctx);
    this.live.set(t.id, live);
    return live;
  }

  // Canonical events from any harness. We only interpret the two that change thread state.
  private onEvent(t: Thread, ev: any) {
    if (ev.type === "system" && ev.subtype === "init" && ev.session_id && t.sessionId !== ev.session_id) {
      t.sessionId = ev.session_id;
      this.persist();
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
    if (!live || !live.agent.alive) live = this.start(t);
    live.aborted = false;
    t.status = "running";
    this.publish(id, { type: "user_input", text, ts: Date.now() });
    this.touch(t);
    live.agent.send(text);
  }

  abort(id: string) {
    const t = this.threads.get(id);
    const live = this.live.get(id);
    if (!t || !live) return;
    live.aborted = true;
    this.live.delete(id); // next send starts a fresh agent and resumes the session
    live.agent.abort();
    t.status = "idle";
    this.publish(id, { type: "aborted", ts: Date.now() });
    this.touch(t);
  }

  private kill(id: string) {
    const live = this.live.get(id);
    if (live) {
      live.aborted = true;
      this.live.delete(id);
      live.agent.kill();
    }
  }

  // free memory from idle agent processes; sessions resume on the next message
  sweep() {
    for (const [id] of this.live) {
      const t = this.threads.get(id);
      if (t && t.status === "idle" && Date.now() - t.updatedAt > IDLE_KILL_MS) this.kill(id);
    }
  }

  shutdown() {
    for (const id of [...this.live.keys()]) this.kill(id);
  }
}

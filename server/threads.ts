import { IdleCompactionTimers, idleCompactionPolicy, idleCompactionDeadline } from "./idle-compaction.ts";
import { HistoryIndex } from "./history.ts";
import { historyWireEvent } from "./history-wire.ts";
import { commandList, CONSOLE_COMMANDS, parseCommand } from "./commands.ts";
import { usage, claudeWindows, codexWindows } from "./usage.ts";
import { CodexTelemetry } from "./providers/codex-telemetry.ts";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./auth.ts";
import { Questions, type PendingQuestion } from "./questions.ts";
import { brainCommit } from "./providers/brain.ts";
import { createLabeler, needsLabel, type Labeler } from "./providers/label.ts";
import { suggestTitle } from "./providers/title.ts";
import { recentPreamble, replayPreamble } from "./export.ts";
import { backfill, restoreAccounting, recordTurn, readTurns, type Turn } from "./analytics.ts";
import { repairAccounting } from "./accounting-repair.ts";
import { SessionAccounting, codexAccounting, piAccounting, type ModelUsage } from "./accounting.ts";
import { MAX_ATTACHMENTS, removeUploads, resolveAttachments, threadDir, withFileList } from "./uploads.ts";
import { clip, DEFAULT_PROVIDER, PROVIDERS, type Agent, type AgentCtx, type Command, type Mode } from "./providers/index.ts";

export type { Command, Mode };

export interface Thread {
  id: string;
  provider: string;
  title: string;
  autoTitle?: boolean; // still carries the folder-name default: the first message renames it (cleared by a manual rename)
  cwd: string;
  mode: Mode;
  model: string;
  effort?: string;
  advisor?: string;
  idleCompaction?: boolean;
  idleCompactionTtlMs?: number;
  idleCompactionDueAt?: number;
  lastUserActivityAt?: number;
  lastProviderActivityAt?: number;
  idleCompactionConsumedAt?: number;
  lastRun?: { model?: string; effort?: string; source?: string; duration_ms?: number; input_tokens?: number; output_tokens?: number; cached_input_tokens?: number };
  sessionId?: string;
  forkFrom?: string; // forked from a Claude session: the first run continues a copy of it (cleared once the fork has its own session id)
  context?: { used?: number; max?: number; source?: string }; // tokens in the agent's context now, and the model's window when the harness reports it
  replay?: boolean; // forked from an agent with no native fork: the first message carries the earlier conversation as text
  replayLimit?: number; // explicit short handoff instead of native session or full text replay
  status: "idle" | "running";
  waiting?: number; // unanswered blocking requests or persistent async questions
  operation?: "compact";
  lastCompactedAt?: number;
  archived?: number; // when it was archived: it leaves the working list until unarchived or sent to again
  cost: number;
  costMeasured?: boolean;
  createdAt: number;
  updatedAt: number;
}

type Emit = (msg: unknown) => void;

const THREADS_FILE = path.join(DATA_DIR, "threads.json");
const COMMANDS_FILE = path.join(DATA_DIR, "commands.json");
const QUEUES_FILE = path.join(DATA_DIR, "queues.json");
const QUESTIONS_FILE = path.join(DATA_DIR, "questions.json");
const LOG_DIR = path.join(DATA_DIR, "logs");
fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });

const IDLE_KILL_MS = 30 * 60 * 1000;

// Chatter the UI never shows. Dropped before it is logged or sent (and filtered from older logs): a long Claude thread was 15% of it.
const NOISE = new Set(["system/thinking_tokens", "system/status", "system/hook_started", "system/hook_response", "system/task_updated", "system/background_tasks_changed", "tool_progress"]);
const kindOf = (e: any) => `${e?.type}${e?.subtype ? "/" + e.subtype : ""}`;
const PAGE = Number(process.env.AGENT_CONSOLE_PAGE) || 40; // events the UI gets when it opens a thread; older ones load on request
const PAGE_BYTES = Number(process.env.AGENT_CONSOLE_PAGE_BYTES) || 96_000; // sent JSON per page: a page widened back to its turn's start can exceed 150 events
const RESULT_CLIP = 4000; // tool output in replayed history (the card shows at most 8000 anyway, and live output is already clipped at 20000)
const MAX_QUEUE = 20;

interface Queued {
  id: string;
  text: string;
  attachments: unknown; // [{id,n}] as sent by the browser; resolved when the message is actually sent
  revision: number;
  editing?: boolean;
  questionAnswer?: true;
}
const attachList = (q: Queued): any[] => (Array.isArray(q.attachments) ? q.attachments : []);
// One prompt from several queued messages. "[Image #n]" is numbered per message, so renumber to keep the references unambiguous.
function mergeQueued(items: Queued[]): { text: string; attachments: unknown; questionAnswer?: true } {
  if (items.length === 1) return { text: items[0].text, attachments: items[0].attachments, ...(items[0].questionAnswer ? { questionAnswer: true } : {}) };
  let next = 0;
  const attachments: any[] = [];
  const parts = items.map((item) => {
    const renumber = new Map<number, number>();
    for (const a of attachList(item)) {
      if (Number.isInteger(a?.n)) renumber.set(a.n, ++next);
      attachments.push(Number.isInteger(a?.n) ? { ...a, n: renumber.get(a.n) } : a);
    }
    return renumber.size ? item.text.replace(/\[Image #(\d+)\]/g, (m, k) => (renumber.has(+k) ? `[Image #${renumber.get(+k)}]` : m)) : item.text;
  });
  return { text: parts.filter((x) => x.trim()).join("\n\n"), attachments, ...(items.every(item => item.questionAnswer) ? { questionAnswer: true } : {}) };
}
const queuePreview = ({ id, text, revision, editing }: Queued) => ({ id, text: text.slice(0, 200), revision, editing: !!editing });

// what the usage dashboard needs to know about the turn in flight
interface TurnState { start: number; tools: Record<string, number>; usage?: any; models?: ModelUsage[] }

interface Live {
  agent: Agent;
  aborted: boolean;
  compactConfirmed?: boolean;
  compactWait?: NodeJS.Timeout;
}

export class Threads {
  private questions = new Questions();
  private idleCompactionTimers = new IdleCompactionTimers();
  private closed = false;
  private historyIndex = new HistoryIndex();
  private threads = new Map<string, Thread>();
  private live = new Map<string, Live>();
  private turns = new Map<string, TurnState>(); // the turn in flight, per thread
  private accounting = new SessionAccounting();
  private queues = new Map<string, Queued[]>(); // messages to send, in order, once the running turn ends
  private emit: Emit;
  private labeler: Labeler; // plain-English labels for shell commands that arrive without a description
  private commands: Record<string, Command[]> = {}; // per provider: each harness has its own slash commands and skills
  constructor(emit: Emit) {
    this.emit = emit;
    this.labeler = createLabeler((job, label) => {
      if (this.threads.has(job.thread)) this.publish(job.thread, { type: "tool_label", tool_use_id: job.id, label });
    });
    try {
      const c = JSON.parse(fs.readFileSync(COMMANDS_FILE, "utf8"));
      this.commands = Array.isArray(c) ? { claude: c } : c; // older versions cached a bare Claude list
    } catch {}
    try {
      for (const t of JSON.parse(fs.readFileSync(THREADS_FILE, "utf8")) as Thread[]) {
        t.status = "idle"; // nothing survives a server restart
        delete t.waiting;
        delete t.operation;
        t.provider ||= DEFAULT_PROVIDER;
        if (t.provider === "codex" && t.context?.source !== "codex/last_request") delete t.context;
        try {
          if (t.provider === "claude") {
            const last = this.historyIndex.read(path.join(LOG_DIR, `${t.id}.jsonl`), undefined, 100).events.findLast(e => claudeWindows(e).length);
            if (last) usage.record("claude", { windows: claudeWindows(last) }, t.updatedAt);
          }
          if (t.provider === "codex") {
            const samples = t.sessionId ? new CodexTelemetry(t.sessionId).read() : [];
            for (const s of samples) if (s.context) {
              const c = s.context;
              if ("reset" in c) { t.context = { max: t.context?.max, source: c.source }; t.lastCompactedAt = s.observedAt || t.lastCompactedAt; }
              else t.context = { ...t.context, ...c };
            }
            const quota = samples.findLast(s => s.rateLimits);
            if (quota) usage.record("codex", { windows: codexWindows(quota.rateLimits) }, quota.observedAt);
          }
        } catch {} // unavailable telemetry must never hide the thread
        this.threads.set(t.id, t);
      }
    } catch {}
    try {
      const saved = JSON.parse(fs.readFileSync(QUESTIONS_FILE, "utf8"));
      for (const [id, requests] of Object.entries(saved)) {
        if (!this.threads.has(id) || !Array.isArray(requests)) continue;
        for (const request of requests) {
          if (request?.async !== true) continue;
          try { this.questions.add(id, request); } catch {}
        }
        const count = this.questions.list(id).length;
        if (count) this.threads.get(id)!.waiting = count;
      }
    } catch {}
    this.accounting = restoreAccounting([...this.threads.values()]);
    try { backfill([...this.threads.values()]); } catch {} // usage history from logs written before the dashboard existed
    try {
      repairAccounting(DATA_DIR, true); // startup precedes new turns; preserves an exclusive original backup
      const rows = readTurns(0, Date.now(), Number.MAX_SAFE_INTEGER).filter(r => r.accounting === 2);
      for (const t of this.threads.values()) {
        const known = rows.filter(r => r.thread === t.id && r.cost != null);
        t.cost = known.reduce((sum, r) => sum + r.cost!, 0);
        t.costMeasured = known.length > 0;
      }
    } catch { /* malformed/incomplete legacy history must not stop the console */ }
    try {
      for (const [id, items] of Object.entries(JSON.parse(fs.readFileSync(QUEUES_FILE, "utf8"))) as [string, Queued[]][]) {
        if (!this.threads.has(id) || !Array.isArray(items)) continue;
        this.queues.set(id, items.filter(q => typeof q.id === "string" && typeof q.text === "string" && q.text.length <= 100_000).slice(0, MAX_QUEUE).map(q => ({ ...q, revision: Number.isSafeInteger(q.revision) ? q.revision : 0, editing: q.editing === true })));
      }
      setImmediate(() => { for (const id of this.queues.keys()) this.drain(id); });
    } catch {}
    for (const thread of this.threads.values()) this.refreshIdleCompaction(thread);
  }

  private refreshIdleCompaction(t: Thread) {
    this.idleCompactionTimers.cancel(t.id);
    const policy = idleCompactionPolicy(t);
    t.idleCompactionTtlMs = policy.ttlMs;
    delete t.idleCompactionDueAt;
    const deadline = idleCompactionDeadline(t, policy, !!this.queues.get(t.id)?.length);
    if (this.closed || deadline == null || deadline <= Date.now()) return;
    t.idleCompactionDueAt = deadline;
    const cycle = t.lastUserActivityAt;
    this.idleCompactionTimers.schedule(t.id, deadline, () => {
      const current = this.threads.get(t.id);
      if (this.closed || current !== t || t.lastUserActivityAt !== cycle) return;
      const currentPolicy = idleCompactionPolicy(t);
      if (idleCompactionDeadline(t, currentPolicy, !!this.queues.get(t.id)?.length) !== deadline) { this.refreshIdleCompaction(t); return; }
      // A stalled event loop must not buy compaction after the estimated cache expiry.
      t.idleCompactionConsumedAt = cycle;
      delete t.idleCompactionDueAt;
      this.persist();
      if (Date.now() >= t.lastProviderActivityAt! + currentPolicy.ttlMs!) { this.touch(t); return; }
      try { this.compact(t.id); }
      catch { this.touch(t); } // consume failed attempts; never create a paid retry loop
    });
  }

  getCommands(): Record<string, Command[]> {
    return Object.fromEntries([...PROVIDERS.keys()].map(id => [id, commandList(this.commands[id])]));
  }

  list(): Thread[] {
    return [...this.threads.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  get(id: string) {
    return this.threads.get(id);
  }
  getQuestions(): Record<string, PendingQuestion[]>;
  getQuestions(id: string): PendingQuestion[];
  getQuestions(id?: string) { return id === undefined ? this.questions.all() : this.questions.list(id); }

  answer(thread: string, id: string, answers: unknown, skip = false) {
    const request = this.questions.list(thread).find(q => q.id === id);
    const result = this.questions.answer(thread, id, answers, this.live.get(thread)?.agent, skip, undefined,
      request?.async ? reply => {
        if (!reply.skip) {
          const text = request.questions.map(q => `${q.question}\n${reply.answers[q.id].join(", ")}`).join("\n\n");
          this.send(thread, text, { mode: "steer", questionAnswer: true });
        }
        return true;
      } : undefined);
    this.publish(thread, result.event);
    this.updateWaiting(thread);
  }

  private updateWaiting(id: string) {
    const t = this.threads.get(id);
    if (!t) return;
    const count = this.questions.list(id).length;
    if (count) t.waiting = count;
    else delete t.waiting;
    const durable: Record<string, PendingQuestion[]> = {};
    for (const [key, requests] of Object.entries(this.questions.all())) {
      const asyncRequests = requests.filter(q => q.async);
      if (asyncRequests.length) durable[key] = asyncRequests;
    }
    fs.writeFileSync(QUESTIONS_FILE + ".tmp", JSON.stringify(durable), { mode: 0o600 });
    fs.renameSync(QUESTIONS_FILE + ".tmp", QUESTIONS_FILE);
    this.refreshIdleCompaction(t);
    this.persist();
    this.emit({ t: "thread", thread: t });
  }

  private cancelQuestions(id: string, includeAsync = false) {
    const pending = this.questions.list(id).filter(q => includeAsync || !q.async);
    for (const request of pending) {
      this.questions.remove(id, request.id);
      this.publish(id, { type: "question_answer", id: request.id, cancelled: true, ts: Date.now() });
    }
    if (pending.length) this.updateWaiting(id);
  }
  private persist() {
    fs.writeFileSync(THREADS_FILE, JSON.stringify([...this.threads.values()], null, 1), { mode: 0o600 });
  }
  private touch(t: Thread) {
    t.updatedAt = Date.now();
    this.refreshIdleCompaction(t);
    this.persist();
    this.emit({ t: "thread", thread: t });
  }

  create(opts: { provider?: string; cwd: string; mode?: Mode; model?: string; effort?: string; title?: string }): Thread {
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
      autoTitle: !opts.title?.trim(),
      cwd: opts.cwd,
      mode,
      model,
      effort: this.validEffort(prov, model, opts.effort),
      status: "idle",
      cost: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.threads.set(t.id, t);
    this.refreshIdleCompaction(t);
    this.persist();
    this.emit({ t: "thread", thread: t });
    return t;
  }

  private validEffort(prov: any, model: string, effort?: string): string {
    if (!effort || effort === "default") return "default";
    if (!prov?.modelDetails?.()[model]?.efforts.includes(effort)) throw new Error("Unsupported effort for this model.");
    return effort;
  }

  // Filing a thread away is not activity: updatedAt stays, so it keeps its place in either list
  archive(id: string, archived: boolean) {
    const t = this.threads.get(id);
    if (!t || !!t.archived === archived) return;
    if (archived) t.archived = Date.now();
    else delete t.archived;
    this.refreshIdleCompaction(t);
    this.persist();
    this.emit({ t: "thread", thread: t });
  }

  update(id: string, patch: { mode?: Mode; model?: string; effort?: string; advisor?: string; title?: string; idleCompaction?: boolean }) {
    const t = this.threads.get(id);
    if (!t) return;
    const prov = PROVIDERS.get(t.provider);
    if (patch.mode && !prov?.modes.includes(patch.mode)) patch.mode = undefined;
    if (patch.model && !prov?.models().includes(patch.model)) patch.model = undefined;
    if (patch.advisor && patch.advisor !== "default" && !prov?.advisors?.includes(patch.advisor)) patch.advisor = undefined;
    const effort = patch.model || patch.effort ? this.validEffort(prov, patch.model || t.model, patch.effort || "default") : t.effort;
    if (t.status === "running" && (patch.mode || patch.model || patch.effort || patch.advisor)) throw new Error("Stop the running turn before changing mode, model or effort.");
    if (patch.mode) t.mode = patch.mode;
    if (patch.model && patch.model !== t.model) delete t.context; // the old model's window is no longer authoritative
    if (patch.model) t.model = patch.model;
    t.effort = effort;
    if (patch.advisor) t.advisor = patch.advisor;
    if (typeof patch.idleCompaction === "boolean") t.idleCompaction = patch.idleCompaction;
    if (patch.title) {
      t.title = patch.title.slice(0, 80);
      t.autoTitle = false;
    }
    if (patch.mode || patch.model || patch.effort || patch.advisor) this.kill(id); // respawn with new flags on next send (history kept via the harness's session)
    this.touch(t);
  }

  // A new thread that carries on from this one. Claude forks its session, Pi gets a copy of its session directory, and agents with
  // no fork (Codex) replay the earlier conversation as text in the first message. The history and uploads are copied so the fork reads whole.
  // With `provider` set to another agent the fork switches harness: its native session cannot carry over, so it always replays text.
  fork(id: string, provider?: string, recent = false): Thread {
    const src = this.threads.get(id);
    if (!src) throw new Error("Unknown thread");
    const target = provider && provider !== src.provider ? PROVIDERS.get(provider) : undefined;
    if (provider && provider !== src.provider && !target) throw new Error("Unknown provider.");
    if (target) {
      const st = target.status();
      if (!st.ok) throw new Error(`${target.label} is not ready. ${st.hint ?? ""}`.trim());
      if (!target.defaultModel()) throw new Error(`${target.label} has no models available.`);
    }
    if (src.status === "running") throw new Error("Wait for the current turn to finish before forking.");
    const now = Date.now();
    const t: Thread = {
      id: crypto.randomUUID(),
      provider: target?.id ?? src.provider,
      title: `${src.title.replace(/\s*\(fork\)$/, "").slice(0, 70)} (fork)`,
      cwd: src.cwd,
      mode: target ? (target.modes.includes(src.mode) ? src.mode : target.defaultMode) : src.mode,
      model: target ? target.defaultModel() : src.model,
      effort: target ? "default" : src.effort,
      advisor: target ? undefined : src.advisor,
      context: target || recent ? undefined : src.context,
      status: "idle",
      cost: 0,
      createdAt: now,
      updatedAt: now,
    };
    const log = (x: string) => path.join(LOG_DIR, `${x}.jsonl`);
    const hasHistory = fs.existsSync(log(src.id));
    if (hasHistory) fs.copyFileSync(log(src.id), log(t.id));
    if (fs.existsSync(threadDir(src.id))) fs.cpSync(threadDir(src.id), threadDir(t.id), { recursive: true });
    if (recent) {
      if (hasHistory) { t.replay = true; t.replayLimit = 6000; }
    } else if (target) {
      if (hasHistory) t.replay = true;
    } else if (src.provider === "claude") {
      if (src.sessionId) t.forkFrom = src.sessionId;
    } else if (src.provider === "pi") {
      const dir = path.join(DATA_DIR, "pi-sessions", src.id);
      if (fs.existsSync(dir)) fs.cpSync(dir, path.join(DATA_DIR, "pi-sessions", t.id), { recursive: true });
    } else if (hasHistory) t.replay = true;
    this.threads.set(t.id, t);
    this.persist();
    this.emit({ t: "thread", thread: t });
    return t;
  }

  remove(id: string) {
    this.cancelQuestions(id, true);
    this.kill(id);
    this.queues.delete(id);
    this.emitQueue(id);
    this.idleCompactionTimers.cancel(id);
    this.threads.delete(id);
    this.persist();
    fs.rmSync(path.join(LOG_DIR, `${id}.jsonl`), { force: true });
    fs.rmSync(path.join(DATA_DIR, "pi-sessions", id), { recursive: true, force: true });
    removeUploads(id);
    this.emit({ t: "removed", thread: id });
  }

  history(id: string): unknown[] {
    try {
      return fs
        .readFileSync(path.join(LOG_DIR, `${id}.jsonl`), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((e) => !NOISE.has(kindOf(e)));
    } catch {
      return [];
    }
  }

  // What the UI gets when it opens a thread: the newest PAGE events (or the PAGE before `before`), starting on a user message so a
  // page never opens mid-turn, with long tool output clipped. `start > 0` means there is older history to ask for.
  // With `since` (the last line a cached view holds) it is only the lines after that, or a full page when too many arrived meanwhile.
  // `small` (phones) gets 60% of the events and half the bytes: less to download and draw on every open and older page.
  page(id: string, before?: number, since?: number, small = false) {
    const limit = small ? Math.ceil(PAGE * 0.6) : PAGE, maxBytes = small ? PAGE_BYTES / 2 : PAGE_BYTES;
    const at = performance.now();
    const file = path.join(LOG_DIR, `${id}.jsonl`);
    const delta = since != null && before == null ? this.historyIndex.after(file, since, PAGE) : null;
    const page = delta || this.historyIndex.read(file, before, limit);
    let items = page.events.map((e, i) => ({ line: page.start + i, e })).filter(({ e }) => !NOISE.has(kindOf(e))).map(({ line, e }) => {
      if (e?.type === "user" && Array.isArray(e.message?.content)) e = { ...e, message: { ...e.message, content: e.message.content.map((c: any) => (c?.type === "tool_result" && typeof c.content === "string" && c.content.length > RESULT_CLIP ? { ...c, content: clip(c.content, RESULT_CLIP) } : c)) } };
      e = historyWireEvent(e);
      return { line, e, size: JSON.stringify(e).length };
    });
    let start = page.start;
    let rest = items.reduce((n, x) => n + x.size, 0);
    if (!delta && rest > maxBytes && items.length > 1) {
      // Too big: begin at the earliest later user message that fits, else just the newest PAGE events (mid-turn, like an unaligned page).
      let cut = items.findIndex((x) => (rest -= x.size) + x.size <= maxBytes && x.e?.type === "user_input");
      if (cut < 0) cut = Math.max(0, items.length - limit);
      if (cut > 0) { start = items[cut].line; items = items.slice(cut); }
    }
    return { ...page, start, events: items.map((x) => x.e), questions: this.questions.list(id), ...(delta ? { delta: true } : {}), server_ms: Math.round((performance.now() - at) * 10) / 10 };
  }

  private log(id: string, ev: unknown) {
    fs.appendFileSync(path.join(LOG_DIR, `${id}.jsonl`), JSON.stringify(ev) + "\n", { mode: 0o600 });
  }

  private publish(id: string, ev: any, persistIt = true) {
    if (!persistIt) return void this.emit({ t: "event", thread: id, event: ev });
    this.log(id, ev);
    this.emit({ t: "event", thread: id, event: ev, seq: this.historyIndex.count(path.join(LOG_DIR, `${id}.jsonl`)) });
  }

  private setCommands(provider: string, list: Command[]) {
    if (JSON.stringify(list) === JSON.stringify(this.commands[provider])) return;
    this.commands[provider] = list;
    fs.writeFileSync(COMMANDS_FILE, JSON.stringify(this.commands), { mode: 0o600 });
    this.emit({ t: "commands", provider, commands: commandList(list) });
  }

  private start(t: Thread): Live {
    const prov = PROVIDERS.get(t.provider);
    if (!prov) throw new Error(`Unknown provider "${t.provider}".`);
    const live: Live = { agent: undefined as unknown as Agent, aborted: false };
    let starting = true;
    const earlyEvents: any[] = [];
    const ctx: AgentCtx = {
      event: (ev) => {
        if (live.aborted) return;
        if (starting) earlyEvents.push(ev);
        else if (this.live.get(t.id) === live) this.onEvent(t, ev);
      },
      commands: (list) => this.setCommands(t.provider, list),
      exited: (info) => {
        const current = this.live.get(t.id) === live;
        if (current) this.live.delete(t.id);
        if (!current || t.status !== "running") return; // a replaced or aborted agent's exit says nothing about the new turn
        this.cancelQuestions(t.id);
        t.status = "idle";
        delete t.operation;
        if (!info.aborted && !live.aborted) {
          this.publish(t.id, { type: "console_error", text: `${prov.label} exited (${info.signal ?? info.code}). ${info.stderr.trim().slice(-500)}` });
        }
        this.touch(t);
        if (parseCommand(this.queues.get(t.id)?.[0]?.text || "")?.name === "compact") this.drain(t.id);
      },
    };
    live.agent = prov.start({ id: t.id, cwd: t.cwd, mode: t.mode, model: t.model, effort: t.effort, advisor: t.advisor, sessionId: t.sessionId, forkFrom: t.sessionId ? undefined : t.forkFrom }, ctx);
    this.live.set(t.id, live);
    starting = false;
    for (const event of earlyEvents) if (!live.aborted && this.live.get(t.id) === live) this.onEvent(t, event);
    return live;
  }

  // Canonical events from any harness. We only interpret the two that change thread state.
  private onEvent(t: Thread, ev: any) {
    const compacting = t.operation === "compact";
    if (NOISE.has(kindOf(ev))) return;
    if (ev.type === "question") {
      try { ev = this.questions.add(t.id, ev); }
      catch { this.publish(t.id, { type: "console_error", text: "The agent sent an invalid question request." }); return; }
      this.updateWaiting(t.id);
    }
    if (ev.type === "question_answer") {
      if (!this.questions.remove(t.id, ev.id)) return;
      this.updateWaiting(t.id);
    }
    if (ev.type === "provider_usage") {
      const windows = codexWindows(ev.rateLimits);
      if (windows.length) {
        const merged = new Map((usage.get(t.provider)?.windows || []).map(w => [w.label, w]));
        for (const w of windows) merged.set(w.label, w); // app-server quota notifications can be sparse
        usage.record(t.provider, { windows: [...merged.values()] });
      }
      return;
    }
    if (ev.type === "rate_limit_event") {
      const windows = claudeWindows(ev);
      if (windows.length) usage.record(t.provider, { windows });
    }
    if (ev.type === "token_usage") { const turn = this.turns.get(t.id); if (turn) turn.usage = ev; }
    if (ev.type === "run_settings" || ev.type === "token_usage") {
      t.lastRun = { ...(ev.type === "run_settings" ? {} : t.lastRun), ...Object.fromEntries(Object.entries(ev).filter(([k]) => k !== "type")) };
      this.touch(t);
      return;
    }
    if (ev.type === "context_usage") {
      // not part of the conversation: remember it on the thread so the context meter survives reloads
      t.context = { used: ev.reset ? undefined : ev.used ?? t.context?.used, max: ev.max ?? t.context?.max, ...(ev.source ? { source: ev.source } : {}) };
      this.emit({ t: "thread", thread: t });
      return;
    }
    if (ev.type === "system" && ev.subtype === "init" && ev.session_id && t.sessionId !== ev.session_id) {
      if (t.forkFrom) this.accounting.seedFork(ev.session_id, t.forkFrom);
      t.sessionId = ev.session_id;
      delete t.forkFrom; // the fork now has its own session
      this.persist();
    }
    if (ev.type === "system" && ev.subtype === "compact_boundary") {
      const live = this.live.get(t.id);
      if (live) live.compactConfirmed = true;
      t.lastCompactedAt = Date.now();
      t.idleCompactionConsumedAt = t.lastUserActivityAt;
      t.context = { max: t.context?.max, source: t.context?.source };
      this.emit({ t: "thread", thread: t });
    }
    if (ev.type === "assistant") {
      const turn = this.turns.get(t.id);
      if (turn) for (const b of ev.message?.content ?? []) if (b?.type === "tool_use") turn.tools[b.name] = (turn.tools[b.name] ?? 0) + 1;
    }
    if (ev.type === "result") {
      this.cancelQuestions(t.id);
      const live = this.live.get(t.id);
      // Claude answers /compact with an empty result straight away, then compacts and sends compact_boundary and the real result
      if (t.operation === "compact" && t.provider === "claude" && live && !live.compactConfirmed && !live.compactWait && !ev.is_error && !ev.num_turns) {
        live.compactWait = setTimeout(() => { live.compactWait = undefined; if (t.operation === "compact" && !live.compactConfirmed) this.onEvent(t, { ...ev, is_error: true, subtype: "error" }); }, 10 * 60_000);
        return;
      }
      if (live?.compactWait) { clearTimeout(live.compactWait); live.compactWait = undefined; }
      this.finishTurn(t, ev);
      if (!compacting) {
        t.lastProviderActivityAt = Math.max(Date.now(), t.lastUserActivityAt ?? 0);
        if (ev.is_error) t.idleCompactionConsumedAt = t.lastUserActivityAt;
      }
      if (t.operation === "compact") {
        if (!ev.is_error && !this.live.get(t.id)?.compactConfirmed) {
          ev = { ...ev, is_error: true, subtype: "error" };
          this.publish(t.id, { type: "console_error", text: "The agent did not confirm compaction. Context has not been marked as compacted." });
        }
        this.publish(t.id, { type: "command_status", command: "compact", status: ev.is_error ? "failed" : "completed", text: ev.is_error ? "Context compaction failed." : "Context compacted. The conversation transcript is kept." });
        delete t.operation;
      }
      t.lastRun = { ...t.lastRun, duration_ms: ev.duration_ms };
      // a message that arrived just as the turn ended starts the next one straight away: Claude says so in queued_turn_count
      t.status = Number(ev.queued_turn_count) > 0 ? "running" : "idle";
      this.touch(t);
      brainCommit(); // agents may have written wiki pages this turn; keep the shared brain's git history current
      if (t.status === "idle" && (!ev.is_error || parseCommand(this.queues.get(t.id)?.[0]?.text || "")?.name === "compact")) this.drain(t.id);
    }
    this.publish(t.id, ev, ev.type !== "stream_event");
    if (ev.type === "assistant") {
      for (const b of ev.message?.content ?? []) {
        if (b?.type === "tool_use" && needsLabel(b.name, b.input)) this.labeler.request({ thread: t.id, id: b.id, command: b.input.command, cwd: t.cwd });
      }
    }
  }

  private finishTurn(t: Thread, ev: any) {
    const measured = ev.modelUsage ? this.accounting.consume(ev.session_id || t.sessionId || t.id, ev) : undefined;
    if (measured?.duplicate) return;
    const turn = this.turns.get(t.id);
    if (!turn) return;
    this.turns.delete(t.id);
    const row: Turn = { ts: turn.start, thread: t.id, provider: t.provider, model: t.lastRun?.model || t.model, effort: t.effort, ms: ev.duration_ms, accounting: 2 };
    if (Object.keys(turn.tools).length) row.tools = turn.tools;
    if (ev.is_error) row.err = 1;
    if (measured) Object.assign(row, measured);
    else if (t.provider === "codex") Object.assign(row, codexAccounting(turn.usage, row.model!));
    else if (ev.usageModels) Object.assign(row, piAccounting(ev.usageModels));
    if (row.cost != null) { t.cost += row.cost; t.costMeasured = true; }
    try { recordTurn(row); } catch {}
  }

  private command(t: Thread, text: string, attachments?: unknown): boolean {
    const command = /^\/\s*$/.test(text.trim()) ? { name: "help", args: "" } : parseCommand(text);
    if (!command) return false;
    const { name, args } = command;
    const host = CONSOLE_COMMANDS.some(c => c.name === name);
    if (!host) {
      if (t.provider === "claude" || t.provider === "pi") return false; // their native command/skill registries are authoritative, including commands in the first prompt
      throw new Error(`/${name} is not available for this agent. Type /help for supported commands.`);
    }
    if (Array.isArray(attachments) && attachments.length) throw new Error("Run commands without attachments.");
    if (name === "stop") { this.abort(t.id); return true; }
    if (name === "compact") { this.compact(t.id, args); return true; }
    if (name === "model" && args) {
      if (!PROVIDERS.get(t.provider)?.models().includes(args)) throw new Error("Unknown model. Choose one from the model menu.");
      this.update(t.id, { model: args });
    } else if (name === "effort" && args) this.update(t.id, { effort: args });
    const message = name === "help" ? this.getCommands()[t.provider].map(c => `/${c.name}${c.argumentHint ? " " + c.argumentHint : ""} — ${c.description}`).join("\n")
      : `${PROVIDERS.get(t.provider)?.label}: ${t.model} · effort ${t.effort || "default"} · ${t.operation === "compact" ? "compacting" : t.status}${t.context?.used != null ? ` · ${t.context.used.toLocaleString()} context tokens` : ""}`;
    this.publish(t.id, { type: "command_status", command: name, status: "completed", text: message });
    return true;
  }

  compact(id: string, instructions = "") {
    const t = this.threads.get(id);
    if (!t) throw new Error("Unknown thread");
    if (t.provider === "codex" && instructions) throw new Error("Codex /compact does not accept extra instructions.");
    if (t.operation === "compact" || this.queues.get(id)?.some(q => parseCommand(q.text)?.name === "compact")) throw new Error("Context compaction is already running or queued.");
    if (t.status === "running") return this.whileRunning(t, `/compact${instructions ? " " + instructions : ""}`, { mode: "queue" });
    if (!fs.existsSync(path.join(LOG_DIR, `${id}.jsonl`)) || (t.provider === "codex" && !t.sessionId)) throw new Error("Send a message before compacting this thread.");
    t.idleCompactionConsumedAt = t.lastUserActivityAt;
    this.idleCompactionTimers.cancel(id);
    delete t.idleCompactionDueAt;
    this.kill(id); // native sessions resume from disk; never share a mutable session with an idle subprocess
    const live = this.start(t);
    if (!live.agent.compact) { this.kill(id); throw new Error("This agent does not support context compaction."); }
    live.compactConfirmed = false;
    t.operation = "compact";
    t.status = "running";
    this.publish(id, { type: "user_input", text: `/compact${instructions ? " " + instructions : ""}`, command: true, ts: Date.now() });
    this.publish(id, { type: "command_status", command: "compact", status: "running", text: "Compacting context…" });
    this.turns.set(id, { start: Date.now(), tools: {} });
    this.touch(t);
    try { live.agent.compact(instructions); }
    catch (error) { this.kill(id); delete t.operation; t.status = "idle"; this.touch(t); throw error; }
  }

  // `attachments` is untrusted browser input: [{id}] naming files already uploaded to this thread
  // While a turn is running a message either steers it (delivered to the agent now, picked up after its current tool call) or waits in
  // a queue for the turn to end. `mode: "queue"` forces the queue; so does an agent that cannot take input mid-turn.
  send(id: string, text: string, opts: { auto?: "brain"; attachments?: unknown; mode?: "steer" | "queue"; delivery?: "queued"; questionAnswer?: true } = {}) {
    const t = this.threads.get(id);
    if (!t) throw new Error("Unknown thread");
    if (!opts.auto && !opts.questionAnswer && this.command(t, text, opts.attachments)) return;
    const incomingAttachments = resolveAttachments(id, opts.attachments);
    if (!opts.auto && !opts.delivery && !opts.questionAnswer && text.trim() &&
        !incomingAttachments.length && (t.status !== "running" || opts.mode !== "queue")) {
      for (const question of this.questions.list(id).filter(q => q.async)) {
        const result = this.questions.answer(id, question.id, {}, undefined, false, text, () => false);
        this.publish(id, result.event);
        this.updateWaiting(id);
      }
    }
    if (!opts.auto) {
      t.lastUserActivityAt = Math.max(Date.now(), (t.lastUserActivityAt ?? 0) + 1);
      this.idleCompactionTimers.cancel(id);
      delete t.idleCompactionDueAt;
    }
    if (t.status === "running") {
      if (opts.auto) throw new Error("A turn is already running.");
      return this.whileRunning(t, text, opts);
    }
    const attachments = incomingAttachments;
    let prompt = withFileList(text, attachments);
    if (t.replay && !opts.auto) {
      prompt = (t.replayLimit === 6000 ? recentPreamble(this.history(id)) : replayPreamble(this.history(id))) + prompt; // exclude this new message
      t.replay = false;
      delete t.replayLimit;
    }
    if (!opts.auto) delete t.archived; // writing to an archived thread puts it back to work (touch below persists it)
    let live = this.live.get(id);
    if (!live || !live.agent.alive) live = this.start(t);
    live.aborted = false;
    t.status = "running";
    this.turns.set(id, { start: Date.now(), tools: {} });
    this.publish(id, {
      type: "user_input",
      text,
      ts: Date.now(),
      ...(opts.auto ? { auto: opts.auto } : {}),
      ...(opts.delivery ? { delivery: opts.delivery } : {}),
      ...(opts.questionAnswer ? { questionAnswer: true } : {}),
      ...(attachments.length ? { attachments: attachments.map(({ id, name, kind, media_type, size, n }) => ({ id, name, kind, media_type, size, ...(n ? { n } : {}) })) } : {}),
    });
    this.touch(t);
    live.agent.send(prompt, attachments.filter((a) => a.kind === "image"));
    // "ok" / "hi" say nothing about the topic: wait for a first message with substance
    if (t.autoTitle && !opts.auto && (attachments.length || text.trim().split(/\s+/).length >= 3)) {
      t.autoTitle = false; // one attempt per thread, whatever the outcome
      void this.retitle(t, text.trim() || attachments.map((a) => a.name).join(" "));
    }
  }

  private whileRunning(t: Thread, text: string, opts: { attachments?: unknown; mode?: "steer" | "queue"; questionAnswer?: true }) {
    const attachments = resolveAttachments(t.id, opts.attachments); // reject bad ids now, not when the queue drains
    const agent = this.live.get(t.id)?.agent;
    // A normal chat reply also releases a waiting tool; otherwise steering can sit behind that tool forever.
    if (opts.mode !== "queue" && !attachments.length && text.trim()) {
      for (const question of this.questions.list(t.id).filter(q => !q.async)) {
        const result = this.questions.answer(t.id, question.id, {}, agent, false, text);
        this.publish(t.id, result.event);
        this.updateWaiting(t.id);
        if (result.consumed) return;
      }
    }
    if (t.operation !== "compact" && opts.mode !== "queue" && agent?.steer) {
      const accepted = () => this.publish(t.id, {
        type: "user_input",
        text,
        ts: Date.now(),
        delivery: "steer",
        ...(opts.questionAnswer ? { questionAnswer: true } : {}),
        ...(attachments.length ? { attachments: attachments.map(({ id, name, kind, media_type, size, n }) => ({ id, name, kind, media_type, size, ...(n ? { n } : {}) })) } : {}),
      });
      const delivery = agent.steer(withFileList(text, attachments), attachments.filter((a) => a.kind === "image"));
      if (delivery instanceof Promise) {
        void delivery.then(accepted).catch((error) => {
          if (!this.threads.has(t.id) || this.live.get(t.id)?.agent !== agent) return;
          this.publish(t.id, { type: "console_error", text: `Steering was not accepted: ${error.message}. Sending as the next message.` });
          try { this.send(t.id, text, { ...opts, mode: "queue" }); }
          catch (e: any) { this.publish(t.id, { type: "console_error", text: `Message could not be sent: ${e.message}` }); }
        });
      } else accepted();
      return;
    }
    const q = this.queues.get(t.id) ?? [];
    if (q.length >= MAX_QUEUE) throw new Error("Too many queued messages.");
    q.push({ id: crypto.randomUUID(), text, attachments: opts.attachments, revision: 0, ...(opts.questionAnswer ? { questionAnswer: true } : {}) });
    this.queues.set(t.id, q);
    this.emitQueue(t.id);
  }

  private emitQueue(id: string) {
    fs.writeFileSync(QUEUES_FILE + ".tmp", JSON.stringify(Object.fromEntries(this.queues)), { mode: 0o600 });
    fs.renameSync(QUEUES_FILE + ".tmp", QUEUES_FILE);
    this.emit({ t: "queue", thread: id, items: (this.queues.get(id) ?? []).map(queuePreview) });
  }
  getQueues(): Record<string, ReturnType<typeof queuePreview>[]> {
    const out: Record<string, ReturnType<typeof queuePreview>[]> = {};
    for (const [id, q] of this.queues) if (q.length) out[id] = q.map(queuePreview);
    return out;
  }
  editQueued(id: string, qid: string) {
    const item = this.queues.get(id)?.find(q => q.id === qid);
    if (!item) throw new Error("This message is no longer queued. It may already have been sent.");
    item.editing = true;
    this.emitQueue(id);
    return { id: item.id, text: item.text, revision: item.revision, attachments: Array.isArray(item.attachments) ? item.attachments.length : 0 };
  }
  saveQueued(id: string, qid: string, revision: number, text: unknown) {
    const item = this.queues.get(id)?.find(q => q.id === qid);
    if (!item) throw new Error("This message is no longer queued. Your draft has been kept in the editor.");
    if (!item.editing || item.revision !== revision) throw new Error("This queued message changed in another window. Reopen it to edit the latest version.");
    if (typeof text !== "string" || text.length > 100_000 || (!text.trim() && !(Array.isArray(item.attachments) && item.attachments.length))) throw new Error("Enter a message of up to 100,000 characters, or keep an attachment.");
    item.text = text;
    item.revision++;
    item.editing = false;
    this.emitQueue(id);
    this.drain(id);
  }
  cancelQueuedEdit(id: string, qid: string, revision: number) {
    const item = this.queues.get(id)?.find(q => q.id === qid);
    if (item && item.revision === revision) {
      item.editing = false;
      this.emitQueue(id);
      this.drain(id);
    }
  }
  // "Steer" on a queued card: hand that one message to the running turn now instead of waiting for it to end
  steerQueued(id: string, qid: string) {
    const t = this.threads.get(id);
    const q = this.queues.get(id);
    const item = q?.find((x) => x.id === qid);
    if (!t || !item) throw new Error("This message is no longer queued. It may already have been sent.");
    if (item.editing) throw new Error("Finish editing this message first.");
    if (t.status !== "running") return this.drain(id);
    if (t.operation || !this.live.get(id)?.agent.steer) throw new Error("This agent cannot take a message mid-turn. It will be sent when the turn ends.");
    this.queues.set(id, q!.filter((x) => x !== item));
    this.emitQueue(id);
    this.whileRunning(t, item.text, { attachments: item.attachments, mode: "steer", ...(item.questionAnswer ? { questionAnswer: true } : {}) });
  }
  unqueue(id: string, qid: string) {
    const q = this.queues.get(id);
    if (!q) return;
    this.queues.set(id, q.filter((x) => x.id !== qid));
    this.emitQueue(id);
    this.drain(id);
  }
  // When a turn ends leaving the thread idle, everything queued behind it goes out together as ONE prompt. A command such as
  // /compact always goes alone, and a message being edited holds back the ones after it.
  private drain(id: string) {
    if (!this.queues.get(id)?.length) return;
    setTimeout(() => {
      const t = this.threads.get(id);
      const q = this.queues.get(id);
      if (!t || t.status !== "idle" || !q?.length || q[0].editing) return;
      let n = 1;
      let files = attachList(q[0]).length;
      if (!parseCommand(q[0].text)) {
        while (n < q.length && !q[n].editing && !parseCommand(q[n].text) && files + attachList(q[n]).length <= MAX_ATTACHMENTS) files += attachList(q[n++]).length;
      }
      const { text, attachments, questionAnswer } = mergeQueued(q.splice(0, n));
      this.emitQueue(id);
      try {
        this.send(id, text, { attachments, delivery: "queued", ...(questionAnswer ? { questionAnswer: true } : {}) });
      } catch (e: any) {
        this.publish(id, { type: "console_error", text: `A queued message could not be sent: ${e?.message ?? e}` });
      }
    }, 250).unref();
  }

  // Name the thread after what the first message is about. Never blocks the turn; on any failure the folder name stays.
  private async retitle(t: Thread, message: string) {
    const original = t.title;
    const title = await suggestTitle(message).catch(() => undefined);
    if (!title || !this.threads.has(t.id) || t.title !== original) return; // deleted, or the user renamed it meanwhile
    t.title = title;
    this.touch(t);
  }

  abort(id: string) {
    const t = this.threads.get(id);
    const live = this.live.get(id);
    if (!t) return;
    this.cancelQuestions(id, true);
    t.idleCompactionConsumedAt = t.lastUserActivityAt;
    this.idleCompactionTimers.cancel(id);
    delete t.idleCompactionDueAt;
    this.persist();
    if (this.queues.delete(id)) this.emitQueue(id); // Stop means stop: nothing queued behind it runs
    if (!live) { this.touch(t); return; }
    live.aborted = true;
    this.live.delete(id); // next send starts a fresh agent and resumes the session
    live.agent.abort();
    t.status = "idle";
    delete t.operation;
    this.publish(id, { type: "aborted", ts: Date.now() });
    this.touch(t);
  }

  private kill(id: string) {
    this.cancelQuestions(id);
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
    this.closed = true;
    this.idleCompactionTimers.shutdown();
    for (const id of [...this.live.keys()]) this.kill(id);
  }
}

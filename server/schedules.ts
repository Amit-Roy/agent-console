import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { Cron } from "croner";
import { DATA_DIR } from "./auth.ts";
import { PROVIDERS } from "./providers/index.ts";
import type { Mode, Thread, Threads } from "./threads.ts";

// Scheduled tasks: a saved prompt that runs on a timer. Every run is an ordinary thread (reply in it to follow up, fork it like any
// other), tagged with its task so the sidebar files it under the task instead of the thread list. A run's report is committed to a
// local git repo of outputs, so research builds up a history. Weak models get this for free: if the agent never calls save_output,
// its final message is saved as the report.

export type Repeat = "manual" | "hourly" | "daily" | "weekdays" | "weekly";
export const REPEATS: Repeat[] = ["manual", "hourly", "daily", "weekdays", "weekly"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export interface Run {
  id: string;
  thread?: string; // absent for a skipped run
  at: number;
  trigger: "schedule" | "manual" | "catch-up";
  status: "running" | "done" | "failed" | "skipped";
  reason?: string; // why it was skipped or failed
  ms?: number;
  cost?: number;
  output?: { path: string; commit?: string };
}

export interface Task {
  id: string;
  title: string;
  prompt: string;
  provider: string;
  model: string;
  effort?: string;
  mode: Mode;
  cwd: string;
  repeat: Repeat;
  time: string; // HH:MM in `tz`; hourly uses only the minutes
  day: number; // 0 (Sunday) to 6, weekly only
  tz: string;
  enabled: boolean;
  saveOutput: boolean;
  createdAt: number;
  updatedAt: number;
  nextRunAt?: number;
  runs: Run[];
}

export type TaskInput = Partial<
  Pick<
    Task,
    | "title"
    | "prompt"
    | "provider"
    | "model"
    | "effort"
    | "mode"
    | "cwd"
    | "repeat"
    | "time"
    | "tz"
    | "enabled"
    | "saveOutput"
  >
> & { day?: number | string };

const CATCH_UP_MS = 7 * 86_400_000;
const MAX_SKIPPED = 20;
const RUN_LIMIT_MS = 45 * 60_000; // a run that has not ended its turn by then is hung (e.g. a tool call that never returns)

export function cronPattern(t: Pick<Task, "repeat" | "time" | "day">): string | null {
  const [h, m] = t.time.split(":").map(Number);
  switch (t.repeat) {
    case "hourly":
      return `${m} * * * *`;
    case "daily":
      return `${m} ${h} * * *`;
    case "weekdays":
      return `${m} ${h} * * 1-5`;
    case "weekly":
      return `${m} ${h} * * ${t.day}`;
    default:
      return null;
  }
}

// "Daily 09:00", "Weekdays 18:30", "Mondays 09:00", "Hourly at :15", "Manual"
export function describe(t: Pick<Task, "repeat" | "time" | "day">): string {
  if (t.repeat === "manual") return "Manual";
  if (t.repeat === "hourly") return `Hourly at :${t.time.slice(3)}`;
  if (t.repeat === "weekly")
    return `${["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"][t.day]} ${t.time}`;
  return `${t.repeat === "daily" ? "Daily" : "Weekdays"} ${t.time}`;
}

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "task";

function validZone(tz: unknown): string | undefined {
  if (typeof tz !== "string" || !tz) return undefined;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

// Local date and time of `ts` in `tz`: "2026-10-19", "09:00"
function localParts(ts: number, tz: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(ts)
      .map((x) => [x.type, x.value]),
  );
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
    short: new Intl.DateTimeFormat("en", { timeZone: tz, month: "short", day: "numeric" }).format(
      ts,
    ),
  };
}

// The agent's last words in a thread: the text blocks of its final assistant message(s) after the last user input
export function finalText(events: any[]): string {
  const out: string[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === "user_input") break;
    if (e?.type !== "assistant") continue;
    const text = (e.message?.content ?? [])
      .filter((b: any) => b?.type === "text" && b.text?.trim())
      .map((b: any) => b.text)
      .join("\n\n");
    if (text) {
      out.unshift(text);
      if (out.join("").length > 200) break;
    }
  }
  return out.join("\n\n").trim();
}

type Emit = (msg: unknown) => void;

export class Schedules {
  private tasks = new Map<string, Task>();
  private crons = new Map<string, Cron>();
  private tz: string; // the zone the user last scheduled in: the default for tasks agents create
  private file: string;
  readonly outputs: string;
  private threads: Threads;
  private emit: Emit;
  private limit: number;
  private watchdogs = new Map<string, NodeJS.Timeout>(); // run id -> timer

  constructor(
    threads: Threads,
    emit: Emit,
    opts: { file?: string; outputs?: string; catchUp?: boolean; runLimitMs?: number } = {},
  ) {
    this.threads = threads;
    this.limit = opts.runLimitMs ?? RUN_LIMIT_MS;
    this.emit = emit;
    this.file = opts.file ?? path.join(DATA_DIR, "schedules.json");
    this.outputs =
      opts.outputs ??
      process.env.AGENT_CONSOLE_OUTPUTS ??
      path.join(os.homedir(), "repos", "agent-outputs");
    this.tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.tz = validZone(saved.tz) ?? this.tz;
      for (const t of saved.tasks ?? []) {
        // nothing survives a restart: a run still marked running lost its turn with the old process
        for (const r of t.runs ?? [])
          if (
            r.status === "running" &&
            !(r.thread && threads.get(r.thread)?.status === "running")
          ) {
            r.status = "failed";
            r.reason = "The server restarted during this run.";
          }
        this.tasks.set(t.id, t);
      }
    } catch {}
    threads.onTurnEnd = (t, ev) => this.turnEnded(t, ev);
    for (const t of this.tasks.values()) this.arm(t);
    if (opts.catchUp !== false) setImmediate(() => this.catchUp());
  }

  list(): Task[] {
    return [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt);
  }
  get(id: string) {
    return this.tasks.get(id);
  }

  private persist() {
    fs.writeFileSync(this.file, JSON.stringify({ tz: this.tz, tasks: this.list() }, null, 1), {
      mode: 0o600,
    });
  }
  private changed() {
    this.persist();
    this.emit({ t: "tasks", tasks: this.list() });
  }

  private arm(t: Task) {
    this.crons.get(t.id)?.stop();
    this.crons.delete(t.id);
    delete t.nextRunAt;
    const pattern = t.enabled ? cronPattern(t) : null;
    if (!pattern) return;
    const cron = new Cron(pattern, { timezone: t.tz }, () => {
      t.nextRunAt = cron.nextRun()?.getTime();
      this.run(t.id, "schedule");
    });
    this.crons.set(t.id, cron);
    t.nextRunAt = cron.nextRun()?.getTime();
  }

  // One run for the latest occurrence missed while the server was down, if it is under a week old. Older misses are not replayed.
  private catchUp() {
    const now = Date.now();
    for (const t of this.tasks.values()) {
      const pattern = t.enabled ? cronPattern(t) : null;
      if (!pattern) continue;
      const prev = new Cron(pattern, { timezone: t.tz, paused: true })
        .previousRuns(1, new Date(now))[0]
        ?.getTime();
      const last = Math.max(t.createdAt, t.updatedAt, t.runs.at(-1)?.at ?? 0);
      if (prev && prev > last && now - prev < CATCH_UP_MS) this.run(t.id, "catch-up");
    }
  }

  private validate(
    input: TaskInput,
    base?: Task,
  ): Omit<Task, "id" | "createdAt" | "updatedAt" | "runs" | "nextRunAt"> {
    const title = String(input.title ?? base?.title ?? "")
      .trim()
      .slice(0, 80);
    const prompt = String(input.prompt ?? base?.prompt ?? "")
      .trim()
      .slice(0, 20_000);
    if (!title) throw new Error("Give the task a name.");
    if (!prompt) throw new Error("Write what the agent should do.");
    const providerId =
      input.provider ?? base?.provider ?? (PROVIDERS.get("pi")?.status().ok ? "pi" : "claude");
    const prov = PROVIDERS.get(providerId);
    if (!prov) throw new Error("Unknown agent.");
    const model =
      input.model && prov.models().includes(input.model)
        ? input.model
        : providerId === base?.provider && !input.model
          ? base.model
          : prov.defaultModel();
    if (!model) throw new Error(`${prov.label} has no models available.`);
    const mode =
      input.mode && prov.modes.includes(input.mode)
        ? input.mode
        : providerId === base?.provider && !input.mode
          ? base.mode
          : prov.defaultMode;
    const effortIn =
      input.effort ??
      (providerId === base?.provider && model === base?.model ? base.effort : undefined);
    const effort =
      effortIn && effortIn !== "default" && prov.modelDetails?.()[model]?.efforts.includes(effortIn)
        ? effortIn
        : "default";
    const cwd = path.resolve(String(input.cwd ?? base?.cwd ?? path.join(os.homedir(), "repos")));
    const home = os.homedir();
    if (cwd !== home && !cwd.startsWith(home + path.sep))
      throw new Error("Folder must be inside your home folder.");
    if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory())
      throw new Error("Folder does not exist.");
    const repeat = (input.repeat ?? base?.repeat ?? "daily") as Repeat;
    if (!REPEATS.includes(repeat)) throw new Error(`Repeat must be one of: ${REPEATS.join(", ")}.`);
    const time = String(input.time ?? base?.time ?? "09:00");
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
      throw new Error("Time must be HH:MM, 24-hour (for example 09:00).");
    const dayIn = input.day ?? base?.day ?? 1;
    const day =
      typeof dayIn === "string" && !/^\d$/.test(dayIn)
        ? DAYS.indexOf(dayIn.slice(0, 3).toLowerCase())
        : Number(dayIn);
    if (!(day >= 0 && day <= 6))
      throw new Error("Day must be a weekday name (mon, tue, …) or 0–6 with 0 = Sunday.");
    const tz = validZone(input.tz) ?? base?.tz ?? this.tz;
    return {
      title,
      prompt,
      provider: prov.id,
      model,
      effort,
      mode,
      cwd,
      repeat,
      time,
      day,
      tz,
      enabled: input.enabled ?? base?.enabled ?? true,
      saveOutput: input.saveOutput ?? base?.saveOutput ?? true,
    };
  }

  create(input: TaskInput): Task {
    const now = Date.now();
    const t: Task = {
      id: crypto.randomUUID(),
      ...this.validate(input),
      createdAt: now,
      updatedAt: now,
      runs: [],
    };
    if (validZone(input.tz)) this.tz = t.tz;
    this.tasks.set(t.id, t);
    this.arm(t);
    this.changed();
    return t;
  }

  update(id: string, input: TaskInput): Task {
    const t = this.tasks.get(id);
    if (!t) throw new Error("Unknown scheduled task.");
    Object.assign(t, this.validate(input, t), { updatedAt: Date.now() });
    if (validZone(input.tz)) this.tz = t.tz;
    this.arm(t);
    this.changed();
    return t;
  }

  // Deleting a task deletes its run threads too. Committed reports stay in the outputs repo.
  remove(id: string) {
    const t = this.tasks.get(id);
    if (!t) return;
    this.crons.get(id)?.stop();
    this.crons.delete(id);
    this.tasks.delete(id);
    for (const r of t.runs)
      if (r.thread && this.threads.get(r.thread)) {
        try {
          if (this.threads.get(r.thread)!.status === "running") this.threads.abort(r.thread);
          this.threads.remove(r.thread);
        } catch {}
      }
    this.changed();
  }

  run(id: string, trigger: Run["trigger"] = "manual"): Run {
    const t = this.tasks.get(id);
    if (!t) throw new Error("Unknown scheduled task.");
    const now = Date.now();
    const busy = t.runs.find(
      (r) => r.status === "running" && r.thread && this.threads.get(r.thread)?.status === "running",
    );
    if (busy) {
      const run: Run = {
        id: crypto.randomUUID(),
        at: now,
        trigger,
        status: "skipped",
        reason: "The previous run was still working.",
      };
      t.runs.push(run);
      const skipped = t.runs.filter((r) => r.status === "skipped");
      if (skipped.length > MAX_SKIPPED) t.runs.splice(t.runs.indexOf(skipped[0]), 1);
      this.changed();
      return run;
    }
    const when = localParts(now, t.tz);
    const run: Run = { id: crypto.randomUUID(), at: now, trigger, status: "running" };
    t.runs.push(run);
    try {
      const thread = this.threads.create({
        provider: t.provider,
        cwd: t.cwd,
        mode: t.mode,
        model: t.model,
        effort: t.effort,
        title: `${t.title} · ${when.short} ${when.time}`,
        schedule: { task: t.id, run: run.id },
      });
      run.thread = thread.id;
      this.changed();
      this.watch(t, run);
      this.threads.send(thread.id, t.prompt, {
        instructions: this.instructions(t, trigger, when),
        scheduled: trigger,
      });
    } catch (e: any) {
      run.status = "failed";
      run.reason = e?.message || "The run could not start.";
      this.changed();
    }
    return run;
  }

  // Weaker models need the playbook spelled out: where the last report is, how to research, where output goes.
  private instructions(t: Task, trigger: Run["trigger"], when: { date: string; time: string }) {
    const prev = t.runs.findLast((r) => r.output?.path && fs.existsSync(r.output.path))?.output!
      .path;
    return (
      `Scheduled task "${t.title}", ${trigger === "catch-up" ? "catch-up run for a missed time" : "run"} at ${when.date} ${when.time} (${t.tz}). ` +
      "Nobody is watching this run, so do not ask questions: make sensible assumptions and state them. " +
      (prev
        ? `The previous run's report is ${prev}: read it first and build on it. `
        : "This is the first run with a saved report, so there is no previous report. ") +
      "For anything current (news, releases, prices, docs) use your web search and fetch tools" +
      (t.provider === "pi" ? " (web_search_exa, then web_fetch_exa on the best URLs)" : "") +
      "; never scrape search engines with curl. Give every finding its source URL and date, and leave out what you could not verify. " +
      "In shell commands, wrap anything slow in `timeout 60`, and never put a leading `.{0,N}` regex on a large or single-line file such as flattened HTML: it can run for many minutes. Find the text with `grep -boF 'anchor' file`, then cut context with `cut -c` or `head -c`. " +
      "End with a markdown report: a one-line summary, then the findings." +
      (t.saveOutput
        ? ` Your final message is saved to git as the report${t.provider === "pi" ? " (or call save_output with the full report)" : ""}, so do not write report files anywhere else.`
        : "")
    );
  }

  private findRun(thread: string): { task: Task; run: Run } | undefined {
    const tag = this.threads.get(thread)?.schedule;
    const task = tag && this.tasks.get(tag.task);
    const run = task?.runs.find((r) => r.id === tag!.run);
    return task && run ? { task, run } : undefined;
  }

  // A hung tool call never yields a result, so turnEnded never fires. Past the limit, stop the thread and fail the run.
  private watch(task: Task, run: Run) {
    const timer = setTimeout(() => {
      this.watchdogs.delete(run.id);
      if (run.status !== "running" || !run.thread) return;
      try {
        this.threads.abort(run.thread);
      } catch {}
      run.status = "failed";
      run.reason = `The run was stopped after ${Math.round(this.limit / 60_000)} minutes without finishing.`;
      run.ms = Date.now() - run.at;
      this.changed();
      this.threads.note(run.thread, {
        type: "schedule_report",
        task: task.id,
        title: task.title,
        run: { ...run },
        ts: Date.now(),
      });
    }, this.limit);
    timer.unref();
    this.watchdogs.set(run.id, timer);
  }

  private turnEnded(t: Thread, ev: any) {
    const found = this.findRun(t.id);
    if (!found || found.run.status !== "running") return; // follow-up turns in a finished run change nothing
    const { task, run } = found;
    clearTimeout(this.watchdogs.get(run.id));
    this.watchdogs.delete(run.id);
    run.status = ev.is_error ? "failed" : "done";
    if (ev.is_error) run.reason = "The agent ended the run with an error.";
    run.ms = Date.now() - run.at;
    run.cost = t.costMeasured ? t.cost : undefined;
    if (!run.output && task.saveOutput && !ev.is_error) {
      const text = finalText(this.threads.history(t.id) as any[]);
      if (text)
        try {
          run.output = this.commit(task, run, text);
        } catch (e: any) {
          run.reason = `The report could not be saved: ${e?.message || e}`;
        }
    }
    this.changed();
    this.threads.note(t.id, {
      type: "schedule_report",
      task: task.id,
      title: task.title,
      run: { ...run },
      ts: Date.now(),
    });
  }

  // save_output: an agent hands over its report explicitly. In a run it becomes that run's report; elsewhere it is filed by thread title.
  saveOutput(thread: string, markdown: string, title?: string) {
    const text = String(markdown ?? "").trim();
    if (!text) throw new Error("markdown is empty: pass the full report text.");
    if (text.length > 500_000) throw new Error("The report is too long (500 KB max).");
    const found = this.findRun(thread);
    const t = this.threads.get(thread);
    if (!found && !t) throw new Error("Unknown thread.");
    const name = found?.task.title ?? t!.title;
    const output = this.commit(
      { title: name, tz: found?.task.tz ?? this.tz },
      found?.run,
      title ? `# ${title}\n\n${text}` : text,
    );
    if (found) {
      found.run.output = output;
      this.changed();
    }
    return output;
  }

  // Write the report to <outputs>/<task>/<date>-<time>.md and commit it. The repo is local only: nothing is pushed.
  private commit(task: { title: string; tz: string }, run: Run | undefined, text: string) {
    const when = localParts(run?.at ?? Date.now(), task.tz);
    const rel = path.join(slug(task.title), `${when.date}-${when.time.replace(":", "")}.md`);
    const file = path.join(this.outputs, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text.endsWith("\n") ? text : text + "\n");
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        [
          "-C",
          this.outputs,
          "-c",
          "user.name=Agent Console",
          "-c",
          "user.email=agent-console@localhost" /* fallback identity; GIT_AUTHOR_* in the environment wins */,
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
    if (!fs.existsSync(path.join(this.outputs, ".git"))) git("init", "-q");
    git("add", "--", rel);
    let commit: string | undefined;
    try {
      git("commit", "-q", "-m", `${task.title}: ${when.date} ${when.time}`, "--", rel);
      commit = git("rev-parse", "--short", "HEAD");
    } catch {
      commit = undefined;
    } // identical text: nothing new to commit
    return { path: file, commit };
  }

  // ---- tools for agents (Pi extension, see providers/console-tools.mjs). Plain inputs, plain-English errors.
  tool(name: string, thread: string | undefined, input: any): unknown {
    const brief = (t: Task) => ({
      id: t.id,
      title: t.title,
      schedule: describe(t),
      timezone: t.tz,
      enabled: t.enabled,
      agent: t.provider,
      model: t.model,
      folder: t.cwd,
      next_run: t.nextRunAt ? new Date(t.nextRunAt).toISOString() : null,
      runs: t.runs.length,
      last_run: t.runs.at(-1)
        ? {
            status: t.runs.at(-1)!.status,
            at: new Date(t.runs.at(-1)!.at).toISOString(),
            report: t.runs.at(-1)!.output?.path,
          }
        : null,
    });
    const from = thread ? this.threads.get(thread) : undefined;
    const taskInput = (i: any): TaskInput => ({
      title: i.title,
      prompt: i.prompt,
      repeat: i.repeat,
      time: i.time,
      day: i.day,
      provider: i.agent,
      model: i.model,
      cwd: i.folder,
      enabled: i.enabled,
      saveOutput: i.save_output,
    });
    const pick = (i: any) => {
      const t =
        this.tasks.get(i?.id) ??
        this.list().find((x) => x.title.toLowerCase() === String(i?.id ?? "").toLowerCase());
      if (!t) throw new Error(`No scheduled task "${i?.id}". Call schedule_list to see ids.`);
      return t;
    };
    switch (name) {
      case "schedule_list":
        return { tasks: this.list().map(brief) };
      case "schedule_create":
        return {
          created: brief(this.create({ ...taskInput(input), cwd: input?.folder ?? from?.cwd })),
        };
      case "schedule_update":
        return { updated: brief(this.update(pick(input).id, taskInput(input))) };
      case "schedule_delete": {
        const t = pick(input);
        this.remove(t.id);
        return { deleted: t.title };
      }
      case "schedule_run_now": {
        const t = pick(input);
        const r = this.run(t.id, "manual");
        return { task: t.title, status: r.status, reason: r.reason, thread: r.thread };
      }
      case "save_output": {
        if (!thread) throw new Error("save_output works only inside an Agent Console thread.");
        return { saved: this.saveOutput(thread, input?.markdown, input?.title) };
      }
    }
    throw new Error(`Unknown tool ${name}.`);
  }

  shutdown() {
    for (const c of this.crons.values()) c.stop();
    this.crons.clear();
    for (const w of this.watchdogs.values()) clearTimeout(w);
    this.watchdogs.clear();
  }
}

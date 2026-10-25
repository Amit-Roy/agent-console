import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";

type Action = "scan" | "apply" | "verify";
type Scope = "all" | "console" | "native";
type CatalogEntry = { id: string; title: string; recent?: string[] };
type Counts = {
  matches: number;
  candidates: number;
  filesScanned: number;
  filesChanged: number;
  databasesScanned: number;
};
type Summary = Counts & {
  status: "complete" | "failed" | "incomplete";
  errors: { code: string; store: string }[];
};
type Job = Omit<Summary, "status"> & {
  job: string;
  action: Action;
  scope: Scope;
  status: Summary["status"] | "queued" | "running";
};
type Request = { action: Action; scope: Scope; catalog?: CatalogEntry[] };
type Runner = (request: Request, progress: (value: unknown) => void) => Promise<any>;
type Options = {
  dataDir: string;
  home?: string;
  runner?: Runner;
  threads: {
    redactionCatalog(): CatalogEntry[];
    applyRedactionCatalog(before: CatalogEntry[], after: CatalogEntry[]): boolean;
  };
  search: { beginMaintenance(): Promise<void>; endMaintenance(rebuild: boolean): Promise<void> };
};

const zero = (): Counts => ({
  matches: 0,
  candidates: 0,
  filesScanned: 0,
  filesChanged: 0,
  databasesScanned: 0,
});
const number = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
function counts(value: any): Counts {
  return Object.fromEntries(
    Object.keys(zero()).map((name) => [name, number(value?.[name])]),
  ) as Counts;
}
function summary(value: any): Summary {
  if (
    !value ||
    !["complete", "failed", "incomplete"].includes(value.status) ||
    !Array.isArray(value.errors)
  )
    throw new Error("engine_output");
  if (Object.keys(zero()).some((name) => !Number.isSafeInteger(value[name]) || value[name] < 0))
    throw new Error("engine_output");
  const failed = Array.isArray(value.errors) && value.errors.length > 0;
  return {
    ...counts(value),
    status: failed && value.status === "complete" ? "incomplete" : value.status,
    errors: failed ? [{ code: "engine_error", store: "transcripts" }] : [],
  };
}
function validCatalog(
  before: CatalogEntry[],
  value: any,
): value is { threads: CatalogEntry[]; matches: number; candidates: number; changed: number } {
  if (!Array.isArray(value?.threads) || value.threads.length !== before.length) return false;
  if (
    ["matches", "candidates", "changed"].some(
      (name) => !Number.isSafeInteger(value[name]) || value[name] < 0,
    )
  )
    return false;
  return value.threads.every((entry: any, index: number) => {
    if (!entry || entry.id !== before[index].id || typeof entry.title !== "string") return false;
    if (Object.keys(entry).some((name) => !["id", "title", "recent"].includes(name))) return false;
    return (
      entry.recent === undefined ||
      (Array.isArray(entry.recent) &&
        entry.recent.every((text: unknown) => typeof text === "string"))
    );
  });
}

class EngineOutput {
  private pending = "";
  private total = 0;
  private result: any;
  private invalid = false;
  private request: Request;
  private progress: (value: unknown) => void;
  private child: ChildProcessWithoutNullStreams;

  constructor(
    request: Request,
    progress: (value: unknown) => void,
    child: ChildProcessWithoutNullStreams,
  ) {
    this.request = request;
    this.progress = progress;
    this.child = child;
  }

  fail() {
    this.invalid = true;
    this.child.kill("SIGKILL");
  }

  consume(chunk: string) {
    this.total += Buffer.byteLength(chunk);
    this.pending += chunk;
    if (this.total > 32 * 1024 * 1024) return this.fail();
    if (this.request.catalog) return;
    const lines = this.pending.split("\n");
    this.pending = lines.pop()!;
    if (this.pending.length > 16384) return this.fail();
    for (const line of lines) if (line.trim()) this.parse(line);
  }

  private parse(line: string) {
    try {
      if (line.length > 16384) return this.fail();
      const value = JSON.parse(line);
      if (value.type === "result" && !this.result && value.action === this.request.action)
        this.result = value;
      else if (value.type === "progress") this.progress(value);
      else this.fail();
    } catch {
      this.fail();
    }
  }

  finish(code: number | null) {
    if (this.request.catalog) this.result = JSON.parse(this.pending);
    else if (this.pending.trim()) this.parse(this.pending);
    const incompleteVerify =
      this.request.action === "verify" &&
      code === 1 &&
      ["failed", "incomplete"].includes(this.result?.status);
    if (this.invalid || (code !== 0 && !incompleteVerify) || !this.result)
      throw new Error("engine_failed");
    return this.result;
  }
}

/** Owns child processes and sanitized, bounded job summaries; never stores child output in status. */
export class TranscriptRedaction {
  private options: Options;
  private runner: Runner;
  private jobs = new Map<string, Job>();
  private children = new Set<ChildProcessWithoutNullStreams>();
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: Options) {
    this.options = options;
    this.runner = options.runner ?? ((request, progress) => this.runEngine(request, progress));
  }

  tool(input: any = {}, caller?: { mode: string; issueRun?: unknown }) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Expected cleanup options.");
    if (Object.keys(input).some((name) => !["action", "scope", "job"].includes(name)))
      throw new Error("Unknown cleanup option.");
    if (input.action === "status") return this.status(input.job);
    const action = input.action ?? "scan",
      scope = input.scope ?? "all";
    if (
      !["scan", "apply", "verify"].includes(action) ||
      !["all", "console", "native"].includes(scope) ||
      input.job !== undefined
    )
      throw new Error("Use scan, apply, verify, or status with a job id.");
    if (action === "apply" && (!caller || caller.issueRun || caller.mode !== "bypassPermissions"))
      throw new Error(
        "Transcript cleanup apply requires a current manual thread in Bypass mode. Switch this thread to Bypass, then retry.",
      );
    if (this.closed) throw new Error("Transcript cleanup is closed.");
    this.makeRoom();
    const job = {
      ...zero(),
      job: randomUUID(),
      action,
      scope,
      status: "queued",
      errors: [],
    } as Job;
    this.jobs.set(job.job, job);
    this.tail = this.tail.then(() => this.execute(job));
    return this.status(job.job);
  }

  private makeRoom() {
    if (this.jobs.size < 32) return;
    const completed = [...this.jobs.values()].find(
      (job) => !["queued", "running"].includes(job.status),
    );
    if (!completed) throw new Error("Transcript cleanup queue is full.");
    this.jobs.delete(completed.job);
  }

  private status(identifier: unknown) {
    const job = typeof identifier === "string" ? this.jobs.get(identifier) : undefined;
    if (!job) throw new Error("Unknown cleanup job. Start a new scan or use a returned job id.");
    return {
      ...job,
      errors: job.errors.map((error) => ({ ...error })),
      next: ["queued", "running"].includes(job.status)
        ? "Poll session_redact with action=status and this job id."
        : "Finished.",
    };
  }

  private async execute(job: Job) {
    if (this.closed) {
      job.status = "failed";
      return this.fail(job, "closed");
    }
    job.status = "running";
    let acquired = false;
    let finalStatus: Summary["status"] = "failed";
    try {
      if (job.action === "apply" && job.scope !== "native") {
        await this.options.search.beginMaintenance();
        acquired = true;
      }
      const result = summary(await this.runner(job, (value) => Object.assign(job, counts(value))));
      const { status, ...details } = result;
      finalStatus = status;
      Object.assign(job, details);
      if (job.scope !== "native") await this.cleanCatalog(job);
      if (job.action === "verify" && job.matches > 0) finalStatus = "incomplete";
    } catch {
      this.fail(job, "cleanup_failed");
      finalStatus = "failed";
    } finally {
      if (acquired) {
        try {
          await this.options.search.endMaintenance(job.action === "apply");
        } catch {
          this.fail(job, "index_rebuild_failed");
          finalStatus = "failed";
        }
      }
      job.status = finalStatus;
    }
  }

  private fail(job: Job, code: string) {
    job.errors = [{ code, store: "transcripts" }];
  }

  private async cleanCatalog(job: Job) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = this.options.threads.redactionCatalog();
      const result = await this.runner({ ...job, catalog: before }, () => {});
      if (!validCatalog(before, result)) throw new Error("catalog_output");
      if (
        job.action === "apply" &&
        !this.options.threads.applyRedactionCatalog(before, result.threads)
      )
        continue;
      job.matches = Math.min(Number.MAX_SAFE_INTEGER, job.matches + number(result.matches));
      job.candidates = Math.min(
        Number.MAX_SAFE_INTEGER,
        job.candidates + number(result.candidates),
      );
      job.filesScanned = Math.min(Number.MAX_SAFE_INTEGER, job.filesScanned + 1);
      job.filesChanged = Math.min(
        Number.MAX_SAFE_INTEGER,
        job.filesChanged + (job.action === "apply" && number(result.changed) > 0 ? 1 : 0),
      );
      return;
    }
    throw new Error("catalog_busy");
  }

  private engineArgs(request: Request) {
    const args = [
      request.action,
      "--home",
      this.options.home ?? os.homedir(),
      "--data-dir",
      this.options.dataDir,
      "--scope",
      request.scope,
    ];
    return [...args, ...(request.catalog ? ["--catalog-stdio"] : ["--json", "--skip-catalog"])];
  }

  private runEngine(request: Request, progress: (value: unknown) => void): Promise<any> {
    const executable = fileURLToPath(new URL("../bin/transcript-redact", import.meta.url));
    return new Promise((resolve, reject) => {
      const child = spawn(executable, this.engineArgs(request), {
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.children.add(child);
      const output = new EngineOutput(request, progress, child);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => output.consume(chunk));
      child.stderr.on("data", () => {});
      child.stdin.on("error", () => output.fail());
      child.on("error", () => {
        this.children.delete(child);
        reject(new Error("engine_start"));
      });
      child.on("close", (code) => {
        this.children.delete(child);
        try {
          resolve(output.finish(code));
        } catch {
          reject(new Error("engine_failed"));
        }
      });
      child.stdin.end(request.catalog ? JSON.stringify({ threads: request.catalog }) : undefined);
    });
  }

  async close() {
    this.closed = true;
    for (const child of this.children) child.kill("SIGKILL");
    await this.tail;
  }
}

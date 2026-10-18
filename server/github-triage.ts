import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { verify } from "@octokit/webhooks-methods";
import { childEnv } from "./providers/env.ts";
import { classifyTriage, type TriageInput, type TriageDecision } from "./providers/triage-model.ts";

export const EFFORT_LABELS = { trivial: "Eff: Trivial", bau: "Eff: BAU", deep: "Eff: Deep" } as const;
export const PRIORITY_LABELS = { p0: "Pri: P0", p1: "Pri: P1", p2: "Pri: P2", p3: "Pri: P3" } as const;
const MANAGED = new Set<string>([...Object.values(EFFORT_LABELS), ...Object.values(PRIORITY_LABELS)]);
const ACTIONS = {
  issues: new Set(["opened", "edited", "reopened"]),
  pull_request: new Set(["opened", "edited", "reopened", "synchronize", "ready_for_review"]),
};
type Kind = "issue" | "pull_request";
type Job = { delivery: string; repo: string; number: number; kind: Kind; attempts: number };
export type GithubRequest = (method: string, endpoint: string, body?: unknown) => Promise<any>;
type Options = {
  secret: string;
  repos: string[];
  dbPath: string;
  classify?: (input: TriageInput) => Promise<TriageDecision>;
  github?: GithubRequest;
  retryDelaysMs?: number[];
  maxBodyBytes?: number;
  log?: (metadata: Record<string, unknown>) => void;
};

class GithubError extends Error {
  status?: number;
  constructor(status?: number) {
    super("GitHub API request failed");
    this.status = status;
  }
}

// Never invoke a shell or let webhook fields select a host, executable, or URL.
export const githubRequest: GithubRequest = (method, endpoint, body) => new Promise((resolve, reject) => {
  const args = ["api", "--hostname", "github.com", "--method", method, endpoint];
  if (body !== undefined) args.push("--input", "-");
  const child = execFile("gh", args, { env: childEnv(), timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) {
      const status = /HTTP\s+(\d{3})/.exec(stderr)?.[1];
      reject(new GithubError(status ? Number(status) : undefined));
      return;
    }
    try { resolve(stdout.trim() ? JSON.parse(stdout) : null); }
    catch { reject(new GithubError()); }
  });
  child.stdin?.on("error", () => {});
  child.stdin?.end(body === undefined ? undefined : JSON.stringify(body));
});

function labelNames(issue: any): string[] {
  return (Array.isArray(issue.labels) ? issue.labels : [])
    .map((label: any) => typeof label === "string" ? label : label?.name)
    .filter((label: unknown): label is string => typeof label === "string");
}

function managedLabels(issue: any): string {
  return labelNames(issue).filter(label => MANAGED.has(label)).sort().join("\n");
}

export function createTriageService(options: Options) {
  if (!options.secret || options.secret.length < 20) throw new Error("A webhook secret of at least 20 characters is required");
  if (!options.repos.length || options.repos.some(repo => !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))) {
    throw new Error("An explicit repository allowlist is required");
  }
  const repos = new Set(options.repos);
  const github = options.github ?? githubRequest;
  const classify = options.classify ?? classifyTriage;
  const retries = options.retryDelaysMs ?? [30_000, 120_000];
  const log = (event: string, fields: Record<string, unknown> = {}) => {
    try { options.log?.({ event, ...fields }); } catch {}
  };
  fs.mkdirSync(path.dirname(options.dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(options.dbPath);
  fs.chmodSync(options.dbPath, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS github_triage (
      delivery TEXT PRIMARY KEY, repo TEXT NOT NULL, number INTEGER NOT NULL,
      kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL, model TEXT
    );
    UPDATE github_triage SET status='queued' WHERE status='running';`);
  let closing = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  const idleListeners = new Set<() => void>();

  function status() {
    const counts = { queued: 0, running: 0, done: 0, failed: 0, skipped: 0 };
    for (const row of db.prepare("SELECT status, count(*) AS count FROM github_triage GROUP BY status").all() as any[]) {
      if (row.status in counts) counts[row.status as keyof typeof counts] = row.count;
    }
    const last = db.prepare("SELECT model FROM github_triage WHERE model IS NOT NULL ORDER BY updated DESC LIMIT 1").get() as any;
    return { ...counts, lastModel: last?.model ?? null };
  }

  function signalIdle() {
    if (active || closed) return;
    const pending = db.prepare("SELECT 1 FROM github_triage WHERE status IN ('queued','running') LIMIT 1").get();
    if (!pending) for (const resolve of idleListeners) resolve();
  }

  async function ensureLabel(repo: string, name: string) {
    try { await github("GET", `repos/${repo}/labels/${encodeURIComponent(name)}`); }
    catch (error) {
      if ((error as any)?.status !== 404) throw error;
      try {
        await github("POST", `repos/${repo}/labels`, {
          name, color: name.startsWith("Eff:") ? "1d76db" : "d93f0b",
          description: name.startsWith("Eff:") ? "Estimated implementation effort" : "Suggested delivery priority",
        });
      } catch (createError) {
        // Another worker or a maintainer can create the same label concurrently.
        if ((createError as any)?.status !== 422) throw createError;
        await github("GET", `repos/${repo}/labels/${encodeURIComponent(name)}`);
      }
    }
  }

  async function processJob(job: Job): Promise<{ status: "done" | "skipped"; model?: string }> {
    if (!repos.has(job.repo)) return { status: "skipped" };
    const endpoint = `repos/${job.repo}/issues/${job.number}`;
    const issue = await github("GET", endpoint);
    if (issue.state !== "open") return { status: "skipped" };
    if ((job.kind === "pull_request") !== Boolean(issue.pull_request)) return { status: "skipped" };
    const files: string[] = [];
    let draft = false;
    let head: string | undefined;
    if (job.kind === "pull_request") {
      const pr = await github("GET", `repos/${job.repo}/pulls/${job.number}`);
      if (pr.state !== "open") return { status: "skipped" };
      draft = Boolean(pr.draft);
      head = pr.head?.sha;
      for (let page = 1; page <= 30; page++) {
        const rows = await github("GET", `repos/${job.repo}/pulls/${job.number}/files?per_page=100&page=${page}`);
        if (!Array.isArray(rows)) throw new Error("Invalid GitHub files response");
        for (const row of rows) if (typeof row?.filename === "string") files.push(row.filename);
        if (rows.length < 100) break;
      }
    }
    const decision = await classify({
      repo: job.repo, number: job.number, kind: job.kind,
      title: typeof issue.title === "string" ? issue.title : "",
      body: typeof issue.body === "string" ? issue.body : "", files, draft,
    });
    if (!Object.hasOwn(EFFORT_LABELS, decision.effort) || !Object.hasOwn(PRIORITY_LABELS, decision.priority)
      || typeof decision.model !== "string" || !decision.model.length || decision.model.length > 200) {
      throw new Error("Invalid triage decision");
    }
    const current = await github("GET", endpoint);
    if (current.state !== "open") return { status: "skipped" };
    // Do not undo a maintainer's managed-label edits while the model was running.
    if (managedLabels(current) !== managedLabels(issue)) return { status: "skipped" };
    if (current.title !== issue.title || current.body !== issue.body) throw new Error("Item changed during classification");
    if (job.kind === "pull_request") {
      const currentPr = await github("GET", `repos/${job.repo}/pulls/${job.number}`);
      if (currentPr.state !== "open") return { status: "skipped" };
      if (currentPr.head?.sha !== head || Boolean(currentPr.draft) !== draft) throw new Error("Pull request changed during classification");
    }
    const desired = [EFFORT_LABELS[decision.effort], PRIORITY_LABELS[decision.priority]];
    for (const label of desired) await ensureLabel(job.repo, label);
    // Add first so a failed retry never leaves an item without its selected labels.
    await github("POST", `${endpoint}/labels`, { labels: desired });
    for (const label of labelNames(current)) {
      if (MANAGED.has(label) && !desired.includes(label as any)) {
        try { await github("DELETE", `${endpoint}/labels/${encodeURIComponent(label)}`); }
        catch (error) { if ((error as any)?.status !== 404) throw error; }
      }
    }
    return { status: "done", model: decision.model };
  }

  function schedule() {
    if (closing || active) return;
    if (timer) clearTimeout(timer);
    const next = db.prepare("SELECT min(next_attempt) AS at FROM github_triage WHERE status='queued'").get() as any;
    if (next.at === null) { signalIdle(); return; }
    timer = setTimeout(() => {
      timer = undefined;
      if (closing) return;
      const job = db.prepare("SELECT delivery,repo,number,kind,attempts FROM github_triage WHERE status='queued' AND next_attempt<=? ORDER BY next_attempt, rowid LIMIT 1").get(Date.now()) as Job | undefined;
      if (!job) { schedule(); return; }
      db.prepare("UPDATE github_triage SET status='running',attempts=attempts+1,updated=? WHERE delivery=?").run(Date.now(), job.delivery);
      active = (async () => {
        try {
          const result = await processJob(job);
          db.prepare("UPDATE github_triage SET status=?,model=?,updated=? WHERE delivery=?")
            .run(result.status, result.model ?? null, Date.now(), job.delivery);
          log(result.status, { repo: job.repo, number: job.number, model: result.model ?? null });
        } catch {
          const attempt = job.attempts + 1;
          const retry = attempt < 3;
          const delay = retries[Math.min(attempt - 1, retries.length - 1)] ?? 120_000;
          db.prepare("UPDATE github_triage SET status=?,next_attempt=?,updated=? WHERE delivery=?")
            .run(retry ? "queued" : "failed", Date.now() + Math.max(0, delay), Date.now(), job.delivery);
          log(retry ? "retry" : "failed", { repo: job.repo, number: job.number, attempt });
        }
      })().finally(() => { active = undefined; schedule(); });
    }, Math.min(2_147_483_647, Math.max(0, next.at - Date.now())));
    timer.unref();
  }

  const respond = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };

  async function receive(req: IncomingMessage, res: ServerResponse) {
    if (req.method === "GET" && req.url === "/health") {
      respond(res, closing ? 503 : 200, { ok: !closing, ...status() });
      return;
    }
    if (req.method !== "POST" || req.url !== "/api/github/webhook") { respond(res, 404, { error: "Not found" }); return; }
    if (closing) { respond(res, 503, { error: "Shutting down" }); return; }
    const signature = req.headers["x-hub-signature-256"];
    const delivery = req.headers["x-github-delivery"];
    const event = req.headers["x-github-event"];
    if (typeof signature !== "string" || !/^sha256=[a-f0-9]{64}$/.test(signature)
      || typeof delivery !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(delivery)
      || typeof event !== "string") { respond(res, 401, { error: "Invalid webhook headers" }); req.resume(); return; }
    const limit = options.maxBodyBytes ?? 1024 * 1024;
    if (Number(req.headers["content-length"]) > limit) { respond(res, 413, { error: "Body too large" }); req.resume(); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) { respond(res, 413, { error: "Body too large" }); req.resume(); return; }
      chunks.push(Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks);
    const text = raw.toString("utf8");
    // Octokit's verifier accepts UTF-8 strings. Reject lossy decoding to preserve
    // the exact signed bytes, including whitespace and escaped characters.
    if (!Buffer.from(text, "utf8").equals(raw) || !await verify(options.secret, text, signature)) {
      respond(res, 401, { error: "Invalid signature" }); return;
    }
    let payload: any;
    try { payload = JSON.parse(text); }
    catch { respond(res, 400, { error: "Invalid JSON" }); return; }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) { respond(res, 400, { error: "Invalid payload" }); return; }
    if (event === "ping") { respond(res, 200, { pong: true }); return; }
    if (!Object.hasOwn(ACTIONS, event)) { respond(res, 200, { ignored: true }); return; }
    const repo = payload.repository?.full_name;
    if (typeof repo !== "string" || !repos.has(repo)) { respond(res, 403, { error: "Repository not allowed" }); return; }
    if (!ACTIONS[event as keyof typeof ACTIONS].has(payload.action)) { respond(res, 200, { ignored: true }); return; }
    const item = event === "issues" ? payload.issue : payload.pull_request;
    const number = item?.number;
    if (!Number.isSafeInteger(number) || number <= 0) { respond(res, 400, { error: "Invalid item number" }); return; }
    if (event === "issues" && item.pull_request) { respond(res, 200, { ignored: true }); return; }
    const inserted = db.prepare("INSERT OR IGNORE INTO github_triage(delivery,repo,number,kind,updated) VALUES(?,?,?,?,?)")
      .run(delivery, repo, number, event === "issues" ? "issue" : "pull_request", Date.now());
    respond(res, 202, { accepted: true, duplicate: inserted.changes === 0 });
    schedule();
  }

  function handler(req: IncomingMessage, res: ServerResponse) {
    receive(req, res).catch(() => {
      log("request_failed");
      if (!res.headersSent) respond(res, 500, { error: "Webhook request failed" });
      else if (!res.writableEnded) res.end();
    });
  }

  function waitForIdle(timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = () => { clearTimeout(deadline); idleListeners.delete(done); resolve(); };
      const deadline = setTimeout(() => { idleListeners.delete(done); reject(new Error("Triage queue did not become idle")); }, timeoutMs);
      idleListeners.add(done);
      signalIdle();
    });
  }

  async function close() {
    if (closed) return;
    closing = true;
    if (timer) clearTimeout(timer);
    await active;
    db.close();
    closed = true;
    for (const resolve of idleListeners) resolve();
  }
  schedule();
  return { handler, status, waitForIdle, close };
}

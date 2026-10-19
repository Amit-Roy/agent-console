import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { verify } from "@octokit/webhooks-methods";
import { childEnv } from "./providers/env.ts";
import { classifyTriage, type TriageInput, type TriageDecision } from "./providers/triage-model.ts";
import { assessmentRevision, calibrationHealth } from "./triage-calibration.ts";
import { renderTriageComment, EFFORT_LABELS, PRIORITY_LABELS } from "./triage-comment.ts";
export { renderTriageComment, EFFORT_LABELS, PRIORITY_LABELS, TRIAGE_COMMENT_MARKER, TRIAGE_COMMENT_VERSION_MARKER } from "./triage-comment.ts";
import { TRIAGE_COMMENT_MARKER } from "./triage-comment.ts";

const MANAGED = new Set<string>([...Object.values(EFFORT_LABELS), ...Object.values(PRIORITY_LABELS)]);
const ACTIONS = {
  issues: new Set(["opened", "edited", "reopened", "unlabeled"]),
  pull_request: new Set(["opened", "edited", "reopened", "unlabeled", "synchronize", "ready_for_review"]),
};
type Kind = "issue" | "pull_request";
type Job = { delivery: string; repo: string; number: number; kind: Kind; attempts: number; reason: "webhook" | "repair" | "reconcile" };
export type GithubRequest = (method: string, endpoint: string, body?: unknown) => Promise<any>;
type Options = {
  secret: string;
  repos: string[];
  dbPath: string;
  classify?: (input: TriageInput) => Promise<TriageDecision>;
  github?: GithubRequest;
  retryDelaysMs?: number[];
  maxBodyBytes?: number;
  assessmentRevision?: () => string;
  // Called after the named CI workflow passes on a push to main of an allowed repository.
  deploy?: { workflow: string; run: (repo: string, sha: string) => void };
  log?: (metadata: Record<string, unknown>) => void;
  // Called for each accepted issue or pull request webhook; failures are logged, never thrown (token telemetry comment).
  onItem?: (item: { repo: string; number: number; kind: Kind }) => Promise<unknown> | void;
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

export function triageSourceMarker(issue: any, pr?: any, repoContext = ""): string {
  const source = JSON.stringify([issue.title ?? "", issue.body ?? "", pr?.head?.sha ?? null, Boolean(pr?.draft), repoContext]);
  return `<!-- agent-console-triage-source:${createHash("sha256").update(source).digest("hex")} -->`;
}

function managedLabels(issue: any): string {
  return labelNames(issue).filter(label => MANAGED.has(label)).sort().join("\n");
}

export function createTriageService(options: Options) {
  if (!options.secret || options.secret.length < 20) throw new Error("A webhook secret of at least 20 characters is required");
  if (!options.repos.length || options.repos.some(repo => !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))) {
    throw new Error("An explicit repository allowlist is required");
  }
  let repos = new Set(options.repos);
  function updateRepos(next: string[]) {
    if (!next.length || next.some(repo => !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))) {
      throw new Error("An explicit repository allowlist is required");
    }
    repos = new Set(next);
  }
  const github = options.github ?? githubRequest;
  const classify = options.classify ?? classifyTriage;
  const revision = options.assessmentRevision ?? assessmentRevision;
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
    UPDATE github_triage SET status='queued' WHERE status='running';
    CREATE TABLE IF NOT EXISTS github_triage_assessments (
      repo TEXT NOT NULL, number INTEGER NOT NULL, source TEXT NOT NULL, revision TEXT NOT NULL,
      body TEXT NOT NULL, effort TEXT NOT NULL, priority TEXT NOT NULL, model TEXT NOT NULL,
      updated INTEGER NOT NULL, PRIMARY KEY(repo, number)
    );`);
  if (!(db.prepare("PRAGMA table_info(github_triage)").all() as any[]).some(column => column.name === "reason")) {
    db.exec("ALTER TABLE github_triage ADD COLUMN reason TEXT NOT NULL DEFAULT 'webhook'");
  }
  let actor: Promise<string> | undefined;
  const actorLogin = () => actor ??= github("GET", "user").then(user => {
    if (typeof user?.login !== "string" || !user.login) throw new Error("Missing GitHub actor");
    return user.login;
  }).catch(error => { actor = undefined; throw error; });
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
    const drift = db.prepare("SELECT count(*) AS detected FROM github_triage WHERE reason='reconcile'").get() as { detected: number };
    const repaired = db.prepare("SELECT count(*) AS repaired FROM github_triage WHERE reason IN ('reconcile','repair') AND status='done'").get() as { repaired: number };
    return { ...counts, lastModel: last?.model ?? null, drift: { detected: drift.detected, repaired: repaired.repaired }, calibration: calibrationHealth() };
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

  async function findComment(repo: string, number: number) {
    const login = await actorLogin();
    for (let page = 1; page <= 100; page++) {
      const comments = await github("GET", `repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
      if (!Array.isArray(comments)) throw new Error("Invalid GitHub comments response");
      const comment = comments.find(comment => comment.user?.login === login && typeof comment.body === "string"
        && comment.body.split("\n")[0] === TRIAGE_COMMENT_MARKER && Number.isSafeInteger(comment.id));
      if (comment) return comment;
      if (comments.length < 100) return undefined;
    }
    throw new Error("Too many comments to safely locate triage assessment");
  }

  function enqueue(repo: string, number: number, kind: Kind, reason: Job["reason"], delivery = randomUUID()) {
    if (closing) throw new Error("Shutting down");
    if (reason !== "webhook" && db.prepare("SELECT 1 FROM github_triage WHERE repo=? AND number=? AND status='queued' LIMIT 1").get(repo, number)) return false;
    const inserted = db.prepare("INSERT OR IGNORE INTO github_triage(delivery,repo,number,kind,reason,updated) VALUES(?,?,?,?,?,?)")
      .run(delivery, repo, number, kind, reason, Date.now());
    schedule();
    return inserted.changes > 0;
  }

  type CachedAssessment = { body: string; effort: keyof typeof EFFORT_LABELS; priority: keyof typeof PRIORITY_LABELS; model: string };
  function cachedAssessment(repo: string, number: number, source: string, currentRevision: string): CachedAssessment | undefined {
    const row = db.prepare("SELECT body,effort,priority,model FROM github_triage_assessments WHERE repo=? AND number=? AND source=? AND revision=?")
      .get(repo, number, source, currentRevision) as CachedAssessment | undefined;
    if (!row || !Object.hasOwn(EFFORT_LABELS, row.effort) || !Object.hasOwn(PRIORITY_LABELS, row.priority)
      || typeof row.body !== "string" || row.body.length > 65_000 || typeof row.model !== "string" || row.model.length > 200) return;
    return row;
  }
  function matchesAssessment(issue: any, comment: any, assessment: CachedAssessment | undefined): boolean {
    if (!assessment || comment?.body !== assessment.body) return false;
    const wanted = [EFFORT_LABELS[assessment.effort], PRIORITY_LABELS[assessment.priority]].sort().join("\n");
    return managedLabels(issue) === wanted;
  }

  // Product description grounds workflow-frequency inference. Last good text survives API failures,
  // so a transient error never changes the source fingerprint and re-triages every item.
  const contexts = new Map<string, { text: string; fetched: number }>();
  async function repoContext(repo: string): Promise<string> {
    const cached = contexts.get(repo);
    if (cached && Date.now() - cached.fetched < 10 * 60_000) return cached.text;
    for (const file of ["PRODUCT.md", "README.md"]) {
      try {
        const found = await github("GET", `repos/${repo}/contents/${file}`);
        if (typeof found?.content === "string" && found.encoding === "base64") {
          const text = Buffer.from(found.content, "base64").toString("utf8").slice(0, 6_000);
          contexts.set(repo, { text, fetched: Date.now() });
          return text;
        }
      } catch (error) { if ((error as any)?.status !== 404) break; }
    }
    contexts.set(repo, { text: cached?.text ?? "", fetched: Date.now() });
    return cached?.text ?? "";
  }

  const reconciling = new Map<string, Promise<{ scanned: number; queued: number }>>();
  async function scan(selectedRepo?: string) {
    let scanned = 0;
    let queued = 0;
    for (const repo of selectedRepo ? [selectedRepo] : repos) {
      for (let page = 1; page <= 100; page++) {
        const items = await github("GET", `repos/${repo}/issues?state=open&per_page=100&page=${page}`);
        if (!Array.isArray(items)) throw new Error("Invalid GitHub issues response");
        for (const issue of items) {
          if (issue.state !== "open" || !Number.isSafeInteger(issue.number) || issue.number <= 0) continue;
          scanned++;
          if (db.prepare("SELECT 1 FROM github_triage WHERE repo=? AND number=? AND status IN ('queued','running') LIMIT 1").get(repo, issue.number)) continue;
          const kind = issue.pull_request ? "pull_request" : "issue";
          const pr = kind === "pull_request" ? await github("GET", `repos/${repo}/pulls/${issue.number}`) : undefined;
          const assessment = cachedAssessment(repo, issue.number, triageSourceMarker(issue, pr, await repoContext(repo)), revision());
          const comment = await findComment(repo, issue.number);
          if (matchesAssessment(issue, comment, assessment)) continue;
          if (enqueue(repo, issue.number, kind, "reconcile")) queued++;
        }
        if (items.length < 100) break;
        if (page === 100) throw new Error("Too many open items to reconcile safely");
      }
    }
    return { scanned, queued };
  }

  function reconcile(repo?: string) {
    if (repo !== undefined && !repos.has(repo)) return Promise.reject(new Error("Repository not allowed"));
    const key = repo ?? "*";
    const existing = reconciling.get(key) ?? reconciling.get("*");
    if (existing) return existing;
    const pending = scan(repo).finally(() => { reconciling.delete(key); });
    reconciling.set(key, pending);
    return pending;
  }

  async function processJob(job: Job): Promise<{ status: "done" | "skipped"; model?: string }> {
    if (!repos.has(job.repo)) return { status: "skipped" };
    const endpoint = `repos/${job.repo}/issues/${job.number}`;
    const issue = await github("GET", endpoint);
    if (issue.state !== "open") return { status: "skipped" };
    if ((job.kind === "pull_request") !== Boolean(issue.pull_request)) return { status: "skipped" };
    const files: string[] = [];
    let pr: any;
    let draft = false;
    let head: string | undefined;
    if (job.kind === "pull_request") {
      pr = await github("GET", `repos/${job.repo}/pulls/${job.number}`);
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
    const context = await repoContext(job.repo);
    const sourceMarker = triageSourceMarker(issue, pr, context);
    let existingComment = await findComment(job.repo, job.number);
    const currentRevision = revision();
    let assessment = cachedAssessment(job.repo, job.number, sourceMarker, currentRevision);
    if (matchesAssessment(issue, existingComment, assessment)) return { status: "skipped" };
    if (!assessment) {
      const decision = await classify({
        repo: job.repo, number: job.number, kind: job.kind,
        title: typeof issue.title === "string" ? issue.title : "",
        body: typeof issue.body === "string" ? issue.body : "", files, draft,
        changedFiles: pr?.changed_files, additions: pr?.additions, deletions: pr?.deletions,
        ...(context ? { repoContext: context } : {}),
      });
      if (!Object.hasOwn(EFFORT_LABELS, decision.effort) || !Object.hasOwn(PRIORITY_LABELS, decision.priority)
        || typeof decision.model !== "string" || !decision.model.length || decision.model.length > 200) {
        throw new Error("Invalid triage decision");
      }
      if (revision() !== currentRevision) throw new Error("Effort model changed during classification");
      assessment = { body: renderTriageComment(decision, sourceMarker), effort: decision.effort, priority: decision.priority, model: decision.model };
      if (assessment.body.length > 65_000) throw new Error("Triage comment exceeds size limit");
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
    const desired = [EFFORT_LABELS[assessment.effort], PRIORITY_LABELS[assessment.priority]];
    // Persist before external writes so retries and restarts repair the same assessment.
    db.prepare(`INSERT INTO github_triage_assessments(repo,number,source,revision,body,effort,priority,model,updated)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(repo,number) DO UPDATE SET source=excluded.source,revision=excluded.revision,
      body=excluded.body,effort=excluded.effort,priority=excluded.priority,model=excluded.model,updated=excluded.updated`)
      .run(job.repo, job.number, sourceMarker, currentRevision, assessment.body, assessment.effort, assessment.priority, assessment.model, Date.now());
    for (const label of desired) await ensureLabel(job.repo, label);
    // Add first so a failed retry never leaves an item without its selected labels.
    if (!desired.every(label => labelNames(current).includes(label))) await github("POST", `${endpoint}/labels`, { labels: desired });
    for (const label of labelNames(current)) {
      if (MANAGED.has(label) && !desired.includes(label as any)) {
        try { await github("DELETE", `${endpoint}/labels/${encodeURIComponent(label)}`); }
        catch (error) { if ((error as any)?.status !== 404) throw error; }
      }
    }
    const body = assessment.body;
    // Re-read after label writes: a previous POST may have succeeded before its response was lost.
    existingComment = await findComment(job.repo, job.number);
    if (existingComment) {
      if (existingComment.body !== body) await github("PATCH", `repos/${job.repo}/issues/comments/${existingComment.id}`, { body });
    } else await github("POST", `${endpoint}/comments`, { body });
    return { status: "done", model: assessment.model };
  }

  function schedule() {
    if (closing || active) return;
    if (timer) clearTimeout(timer);
    const next = db.prepare("SELECT min(next_attempt) AS at FROM github_triage WHERE status='queued'").get() as any;
    if (next.at === null) { signalIdle(); return; }
    timer = setTimeout(() => {
      timer = undefined;
      if (closing) return;
      const job = db.prepare("SELECT delivery,repo,number,kind,attempts,reason FROM github_triage WHERE status='queued' AND next_attempt<=? ORDER BY next_attempt, rowid LIMIT 1").get(Date.now()) as Job | undefined;
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
    const reconciliation = req.url === "/reconcile";
    if (req.method !== "POST" || (req.url !== "/api/github/webhook" && !reconciliation)) { respond(res, 404, { error: "Not found" }); return; }
    if (closing) { respond(res, 503, { error: "Shutting down" }); return; }
    const signature = req.headers["x-hub-signature-256"];
    const delivery = req.headers["x-github-delivery"];
    const event = req.headers["x-github-event"];
    if (typeof signature !== "string" || !/^sha256=[a-f0-9]{64}$/.test(signature)
      || (!reconciliation && (typeof delivery !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(delivery)
      || typeof event !== "string"))) { respond(res, 401, { error: "Invalid webhook headers" }); req.resume(); return; }
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
    if (reconciliation) {
      if (typeof payload.repository?.full_name !== "string" || !repos.has(payload.repository.full_name)) {
        respond(res, 403, { error: "Repository not allowed" }); return;
      }
      respond(res, 200, await reconcile(payload.repository.full_name)); return;
    }
    if (typeof event !== "string" || typeof delivery !== "string") { respond(res, 401, { error: "Invalid webhook headers" }); return; }
    if (event === "ping") { respond(res, 200, { pong: true }); return; }
    if (event === "workflow_run") {
      const run = payload.workflow_run;
      const repo = payload.repository?.full_name;
      if (!options.deploy || payload.action !== "completed" || run?.name !== options.deploy.workflow || run.conclusion !== "success"
        || run.event !== "push" || run.head_branch !== "main" || typeof run.head_sha !== "string" || !/^[a-f0-9]{40}$/.test(run.head_sha)) {
        respond(res, 200, { ignored: true }); return;
      }
      if (typeof repo !== "string" || !repos.has(repo)) { respond(res, 403, { error: "Repository not allowed" }); return; }
      log("deploy_requested", { repo, sha: run.head_sha });
      respond(res, 202, { deploying: true });
      try { options.deploy.run(repo, run.head_sha); } catch { log("deploy_failed", { repo }); }
      return;
    }
    if (!Object.hasOwn(ACTIONS, event)) { respond(res, 200, { ignored: true }); return; }
    const repo = payload.repository?.full_name;
    if (typeof repo !== "string" || !repos.has(repo)) { respond(res, 403, { error: "Repository not allowed" }); return; }
    if (!ACTIONS[event as keyof typeof ACTIONS].has(payload.action)) { respond(res, 200, { ignored: true }); return; }
    if (payload.action === "unlabeled" && !MANAGED.has(payload.label?.name)) { respond(res, 200, { ignored: true }); return; }
    const item = event === "issues" ? payload.issue : payload.pull_request;
    const number = item?.number;
    if (!Number.isSafeInteger(number) || number <= 0) { respond(res, 400, { error: "Invalid item number" }); return; }
    if (event === "issues" && item.pull_request) { respond(res, 200, { ignored: true }); return; }
    const inserted = enqueue(repo, number, event === "issues" ? "issue" : "pull_request", payload.action === "unlabeled" ? "repair" : "webhook", delivery);
    respond(res, 202, { accepted: true, duplicate: !inserted });
    if (options.onItem) {
      try { void Promise.resolve(options.onItem({ repo, number, kind: event === "issues" ? "issue" : "pull_request" })).catch(() => log("on_item_failed")); }
      catch { log("on_item_failed"); }
    }
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
    await Promise.allSettled([active, ...reconciling.values()].filter(Boolean));
    db.close();
    closed = true;
    for (const resolve of idleListeners) resolve();
  }
  schedule();
  return { handler, status, waitForIdle, reconcile, updateRepos, close };
}

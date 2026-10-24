import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { calibrationHealth } from "./triage-calibration.ts";
import { EFFORT_LABELS, PRIORITY_LABELS } from "./triage-comment.ts";
import {
  type CachedAssessment,
  type Job,
  type Kind,
  managedLabels,
  type TriageContext,
} from "./triage-types.ts";

export function openStore(dbPath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(dbPath);
  fs.chmodSync(dbPath, 0o600);
  database.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
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
  if (
    !(database.prepare("PRAGMA table_info(github_triage)").all() as any[]).some(
      (column) => column.name === "reason",
    )
  ) {
    database.exec("ALTER TABLE github_triage ADD COLUMN reason TEXT NOT NULL DEFAULT 'webhook'");
  }
  return database;
}

export function triageStatus(ctx: TriageContext) {
  const counts = { queued: 0, running: 0, done: 0, failed: 0, skipped: 0 };
  for (const row of ctx.database
    .prepare("SELECT status, count(*) AS count FROM github_triage GROUP BY status")
    .all() as any[]) {
    if (row.status in counts) counts[row.status as keyof typeof counts] = row.count;
  }
  const last = ctx.database
    .prepare(
      "SELECT model FROM github_triage WHERE model IS NOT NULL ORDER BY updated DESC LIMIT 1",
    )
    .get() as any;
  const drift = ctx.database
    .prepare("SELECT count(*) AS detected FROM github_triage WHERE reason='reconcile'")
    .get() as { detected: number };
  const repaired = ctx.database
    .prepare(
      "SELECT count(*) AS repaired FROM github_triage WHERE reason IN ('reconcile','repair') AND status='done'",
    )
    .get() as { repaired: number };
  return {
    ...counts,
    lastModel: last?.model ?? null,
    drift: { detected: drift.detected, repaired: repaired.repaired },
    calibration: calibrationHealth(),
  };
}

export function signalIdle(ctx: TriageContext) {
  if (ctx.active || ctx.closed) return;
  const pending = ctx.database
    .prepare("SELECT 1 FROM github_triage WHERE status IN ('queued','running') LIMIT 1")
    .get();
  if (!pending) for (const resolve of ctx.idleListeners) resolve();
}

export function hasQueuedJob(ctx: TriageContext, repo: string, number: number): boolean {
  return Boolean(
    ctx.database
      .prepare("SELECT 1 FROM github_triage WHERE repo=? AND number=? AND status='queued' LIMIT 1")
      .get(repo, number),
  );
}

export function hasPendingJob(ctx: TriageContext, repo: string, number: number): boolean {
  return Boolean(
    ctx.database
      .prepare(
        "SELECT 1 FROM github_triage WHERE repo=? AND number=? AND status IN ('queued','running') LIMIT 1",
      )
      .get(repo, number),
  );
}

export function insertJob(
  ctx: TriageContext,
  fields: { repo: string; number: number; kind: Kind; reason: Job["reason"]; delivery: string },
): boolean {
  const inserted = ctx.database
    .prepare(
      "INSERT OR IGNORE INTO github_triage(delivery,repo,number,kind,reason,updated) VALUES(?,?,?,?,?,?)",
    )
    .run(fields.delivery, fields.repo, fields.number, fields.kind, fields.reason, Date.now());
  return inserted.changes > 0;
}

export function cachedAssessment(
  ctx: TriageContext,
  repo: string,
  number: number,
  source: string,
  currentRevision: string,
): CachedAssessment | undefined {
  const row = ctx.database
    .prepare(
      "SELECT body,effort,priority,model FROM github_triage_assessments WHERE repo=? AND number=? AND source=? AND revision=?",
    )
    .get(repo, number, source, currentRevision) as CachedAssessment | undefined;
  if (
    !row ||
    !Object.hasOwn(EFFORT_LABELS, row.effort) ||
    !Object.hasOwn(PRIORITY_LABELS, row.priority) ||
    typeof row.body !== "string" ||
    row.body.length > 65_000 ||
    typeof row.model !== "string" ||
    row.model.length > 200
  )
    return;
  return row;
}

export function matchesAssessment(
  issue: any,
  comment: any,
  assessment: CachedAssessment | undefined,
): boolean {
  if (!assessment || comment?.body !== assessment.body) return false;
  const wanted = [EFFORT_LABELS[assessment.effort], PRIORITY_LABELS[assessment.priority]]
    .sort()
    .join("\n");
  return managedLabels(issue) === wanted;
}

export function saveAssessment(
  ctx: TriageContext,
  job: Job,
  sourceMarker: string,
  currentRevision: string,
  assessment: CachedAssessment,
) {
  ctx.database
    .prepare(`INSERT INTO github_triage_assessments(repo,number,source,revision,body,effort,priority,model,updated)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(repo,number) DO UPDATE SET source=excluded.source,revision=excluded.revision,
      body=excluded.body,effort=excluded.effort,priority=excluded.priority,model=excluded.model,updated=excluded.updated`)
    .run(
      job.repo,
      job.number,
      sourceMarker,
      currentRevision,
      assessment.body,
      assessment.effort,
      assessment.priority,
      assessment.model,
      Date.now(),
    );
}

export function nextAttemptAt(ctx: TriageContext): number | null {
  const next = ctx.database
    .prepare("SELECT min(next_attempt) AS soonest FROM github_triage WHERE status='queued'")
    .get() as any;
  return next.soonest;
}

export function claimDueJob(ctx: TriageContext): Job | undefined {
  return ctx.database
    .prepare(
      "SELECT delivery,repo,number,kind,attempts,reason FROM github_triage WHERE status='queued' AND next_attempt<=? ORDER BY next_attempt, rowid LIMIT 1",
    )
    .get(Date.now()) as Job | undefined;
}

export function markRunning(ctx: TriageContext, job: Job) {
  ctx.database
    .prepare(
      "UPDATE github_triage SET status='running',attempts=attempts+1,updated=? WHERE delivery=?",
    )
    .run(Date.now(), job.delivery);
}

export function markFinished(
  ctx: TriageContext,
  job: Job,
  result: { status: "done" | "skipped"; model?: string },
) {
  ctx.database
    .prepare("UPDATE github_triage SET status=?,model=?,updated=? WHERE delivery=?")
    .run(result.status, result.model ?? null, Date.now(), job.delivery);
}

export function markRetry(ctx: TriageContext, job: Job, retry: boolean, delay: number) {
  ctx.database
    .prepare("UPDATE github_triage SET status=?,next_attempt=?,updated=? WHERE delivery=?")
    .run(retry ? "queued" : "failed", Date.now() + Math.max(0, delay), Date.now(), job.delivery);
}

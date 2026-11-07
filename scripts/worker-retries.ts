import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

// Read-only report: live window dispatches whose worker turn ended in error or without a PR, with the
// retry and premium queue events that followed. It checks the recovery added for #201 on real data.

const RETRY_MSG = "resuming existing worker after an incomplete turn";
const PREMIUM_REASONS = [
  "budget-exhausted",
  "infrastructure-model-unavailable",
  "infrastructure-retries-exhausted",
];
const FILTER =
  "live window-dispatch.jsonl rows (dryRun false, no start error) dispatched in [since, until); " +
  "kept when a worker turn ended with kind fail, or ended ok with no PR event (data.pr or pr/ok 'PR #N') for the same ref; " +
  `retries = worker|redo start "${RETRY_MSG}"; premium = worker info with data.reason in ${PREMIUM_REASONS.join(", ")}`;

type Row = Record<string, any>;

const { values } = parseArgs({
  options: {
    since: { type: "string" },
    until: { type: "string" },
    json: { type: "boolean", default: false },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function dateOption(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) fail(`--${name} must be an ISO date, for example 2026-10-24.`);
  return ms;
}

function readJsonl(file: string, required: boolean): Row[] {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error: any) {
    if (required || error?.code !== "ENOENT") fail(`Cannot read ${file}: ${error?.code ?? error}`);
  }
  const rows: Row[] = [];
  for (const line of text.split("\n")) {
    try {
      if (line) rows.push(JSON.parse(line));
    } catch {}
  }
  return rows;
}

const iso = (ms: number) => new Date(ms).toISOString();
const isTurnEnd = (event: Row) =>
  event.step === "worker" &&
  /^turn ended/.test(event.msg ?? "") &&
  ["ok", "fail"].includes(event.kind);
const isRetry = (event: Row) =>
  ["worker", "redo"].includes(event.step) && event.kind === "start" && event.msg === RETRY_MSG;
const isPremium = (event: Row) =>
  event.step === "worker" && event.kind === "info" && PREMIUM_REASONS.includes(event.data?.reason);

// Review events carry data.pr; the pr step itself only names the number in its message ("PR #80").
function prNumber(event: Row): number | undefined {
  if (typeof event.data?.pr === "number") return event.data.pr;
  const match = event.step === "pr" && event.kind === "ok" && /^PR #(\d+)/.exec(event.msg ?? "");
  return match ? Number(match[1]) : undefined;
}

function issueReport(dispatch: Row, events: Row[], until: number) {
  const own = events.filter(
    (event) => event.ref === dispatch.key && event.ts >= dispatch.ts && event.ts < until,
  );
  const prs = [...new Set(own.map(prNumber).filter((pr) => pr !== undefined))];
  const turnEnds = own.filter(isTurnEnd);
  const stranded =
    turnEnds.some((event) => event.kind === "fail") || (turnEnds.length > 0 && !prs.length);
  if (!stranded) return undefined;
  return {
    key: dispatch.key,
    ledger: dispatch,
    prs,
    turnEnds,
    retries: own.filter(isRetry),
    premium: own.filter(isPremium),
  };
}

// The sha in RELEASE.json beside this script, so a live paste names the release it ran from. Source tree: null.
function releaseSha(): string | null {
  try {
    const file = path.join(import.meta.dirname, "..", "RELEASE.json");
    const sha = JSON.parse(fs.readFileSync(file, "utf8"))?.sha;
    return typeof sha === "string" && sha ? sha : null;
  } catch {
    return null;
  }
}

function buildReport(dir: string, since: number, until: number) {
  const ledger = readJsonl(path.join(dir, "window-dispatch.jsonl"), true);
  const logFile = path.join(dir, "automation-events.jsonl");
  const events = [...readJsonl(`${logFile}.1`, false), ...readJsonl(logFile, false)].sort(
    (left, right) => left.seq - right.seq,
  );
  const latest = new Map<string, Row>();
  for (const row of ledger)
    if (!row.dryRun && !row.error && row.ts >= since && row.ts < until) latest.set(row.key, row);
  const issues = [...latest.values()]
    .map((dispatch) => issueReport(dispatch, events, until))
    .filter((issue) => issue !== undefined);
  return {
    release: releaseSha(),
    dataDir: dir,
    range: { since: iso(since), until: iso(until) },
    filter: FILTER,
    ledger: { rows: ledger.length, liveInRange: latest.size },
    events: {
      rows: events.length,
      first: events.length ? iso(events[0].ts) : null,
      last: events.length ? iso(events.at(-1)!.ts) : null,
    },
    issues,
  };
}

function eventLine(event: Row): string {
  const reason = event.data?.reason ? ` reason=${event.data.reason}` : "";
  const data = event.data ? ` ${JSON.stringify(event.data)}` : "";
  return `  ${iso(event.ts)} ${event.step}/${event.kind} #${event.seq} ${event.msg ?? ""}${reason}${data}`;
}

function printText(report: ReturnType<typeof buildReport>) {
  console.log(`Release: ${report.release ?? "none (not a release build)"}`);
  console.log(`Data: ${report.dataDir}`);
  console.log(`Range: ${report.range.since} to ${report.range.until}`);
  console.log(`Filter: ${report.filter}`);
  console.log(
    `Ledger rows: ${report.ledger.rows} (${report.ledger.liveInRange} live in range); events: ${report.events.rows} (${report.events.first ?? "none"} to ${report.events.last ?? "none"})`,
  );
  console.log(`${report.issues.length} issues whose worker turn ended in error or without a PR`);
  for (const issue of report.issues) {
    console.log(
      `\n${issue.key} dispatched ${iso(issue.ledger.ts)} PR in log: ${issue.prs.length ? issue.prs.map((pr) => `#${pr}`).join(", ") : "none"}`,
    );
    console.log(`Ledger: ${JSON.stringify(issue.ledger)}`);
    for (const [label, rows] of [
      ["Turn ends", issue.turnEnds],
      ["Retries", issue.retries],
      ["Premium queue", issue.premium],
    ] as const) {
      console.log(`${label}: ${rows.length}`);
      for (const event of rows) console.log(eventLine(event));
    }
  }
}

const dir = process.env.AGENT_CONSOLE_DATA || path.join(os.homedir(), ".config", "agent-console");
const until = dateOption("until", values.until, Date.now());
const since = dateOption("since", values.since, until - 7 * 86_400_000);
if (!(since < until)) fail("--since must be before --until.");
const report = buildReport(dir, since, until);
if (values.json) console.log(JSON.stringify(report, null, 2));
else printText(report);

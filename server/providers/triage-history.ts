import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** These are measured delivery runs, not whole issues, human hours, or team totals. */
export interface HistoricalTask {
  id: string;
  group: string;
  startedAt: string;
  completedAt: string;
  request: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  commits: { repo: string; sha: string; title?: string }[];
}

export const HISTORY_POLICY = {
  minimumRows: 3,
  minimumGroups: 2,
  minimumSelectionGroups: 15,
  minimumTuningCases: 5,
  holdoutFraction: 0.2,
  maximumRows: 2_000,
  maximumBytes: 8 * 1024 * 1024,
  description:
    "Policy gates, not fitted coefficients: at least 3 measured runs in 2 independent groups; lexical selection requires 15 groups and 5 tuning cases. The newest ceil(20% of groups) are held out after method selection.",
} as const;

export type HistoryMethod = "global-median" | "lexical-k3" | "lexical-k5";
export interface HistoryMetrics {
  count: number;
  /** Mean absolute error in observed generated output tokens; input is only a budget estimate. */
  maeTokens: number | null;
  /** exp(mean(abs(log((prediction + 1) / (actual + 1))))). Lower is better. */
  multiplicativeError: number | null;
  rangeCoverage: number | null;
}
export interface HistoryValidation {
  selectionReason: string;
  tuning: { model: HistoryMetrics; baseline: HistoryMetrics };
  holdout: { model: HistoryMetrics; baseline: HistoryMetrics };
  trainingGroupCount: number;
  holdoutGroupCount: number;
}
export interface HistoryInsufficient {
  status: "insufficient-history";
  reason: string;
  scope: "completed-delivery-run";
}
export interface HistoryModel {
  status: "ready";
  tasks: HistoricalTask[];
  method: HistoryMethod;
  validation: HistoryValidation;
  asOf: string;
}
export interface HistoryEstimate {
  status: "ready";
  scope: "completed-delivery-run";
  workloadMetric: "outputTokens";
  effort: "trivial" | "bau" | "deep";
  method: HistoryMethod;
  evidence: "low" | "backtested";
  sampleCount: number;
  independentGroupCount: number;
  analogueCount: number;
  input: { median: number; range: [number, number] };
  output: { median: number; range: [number, number] };
  total: { median: number; range: [number, number] };
  thresholds: { trivialMax: number; deepMin: number };
  dateSpan: { startedAt: string; completedAt: string };
  analogues: { ids: string[]; provider: string; commits: HistoricalTask["commits"] }[];
  validation: HistoryValidation;
  formula: string;
}
export type ReadyHistoryEstimate = HistoryEstimate;

const insufficient = (reason: string): HistoryInsufficient => ({
  status: "insufficient-history",
  scope: "completed-delivery-run",
  reason,
});
const emptyMetrics = (): HistoryMetrics => ({
  count: 0,
  maeTokens: null,
  multiplicativeError: null,
  rangeCoverage: null,
});
const safeText = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= max &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const safeIdentifier = (value: unknown, max: number): value is string =>
  safeText(value, max) && !/[\r\n\t]/.test(value);
const timestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T/.test(value) &&
  value.length <= 40 &&
  Number.isFinite(Date.parse(value));
const groupCount = (tasks: readonly HistoricalTask[]) =>
  new Set(tasks.map((task) => task.group)).size;

/** Reject the entire dataset on bad records; silently dropping failures would bias calibration. */
export function validateHistory(
  value: unknown,
): { status: "ready"; tasks: HistoricalTask[] } | HistoryInsufficient {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return insufficient("History must be a versioned dataset.");
  const document = value as Record<string, unknown>;
  if (
    document.version !== 1 ||
    document.scope !== "completed-delivery-run" ||
    !Array.isArray(document.tasks)
  )
    return insufficient("Unsupported history version or scope.");
  if (document.tasks.length > HISTORY_POLICY.maximumRows)
    return insufficient("History exceeds the record limit.");
  const tasks: HistoricalTask[] = [];
  const ids = new Set<string>();
  const commitGroups = new Map<string, string>();
  const observations = new Set<string>();
  for (const raw of document.tasks) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return insufficient("History contains an invalid run.");
    const row = raw as Record<string, unknown>;
    if (
      !safeIdentifier(row.id, 200) ||
      !safeIdentifier(row.group, 200) ||
      !timestamp(row.startedAt) ||
      !timestamp(row.completedAt) ||
      Date.parse(row.completedAt) < Date.parse(row.startedAt) ||
      !safeText(row.request, 12_000) ||
      !safeIdentifier(row.provider, 120) ||
      !Number.isSafeInteger(row.inputTokens) ||
      (row.inputTokens as number) < 0 ||
      (row.inputTokens as number) > 1e12 ||
      !Number.isSafeInteger(row.outputTokens) ||
      (row.outputTokens as number) < 0 ||
      (row.outputTokens as number) > 1e12 ||
      (row.inputTokens as number) + (row.outputTokens as number) <= 0 ||
      !Array.isArray(row.commits) ||
      !row.commits.length ||
      row.commits.length > 100
    )
      return insufficient("History contains invalid measurements or provenance.");
    if (ids.has(row.id)) return insufficient("History contains duplicate run IDs.");
    ids.add(row.id);
    const observationKey = JSON.stringify([
      row.group,
      row.startedAt,
      row.completedAt,
      row.request,
      row.inputTokens,
      row.outputTokens,
    ]);
    if (observations.has(observationKey))
      return insufficient("History contains duplicate measurements.");
    observations.add(observationKey);
    const commits: HistoricalTask["commits"] = [];
    const seenCommits = new Set<string>();
    for (const rawCommit of row.commits) {
      if (!rawCommit || typeof rawCommit !== "object" || Array.isArray(rawCommit))
        return insufficient("History contains invalid commit provenance.");
      const commit = rawCommit as Record<string, unknown>;
      if (
        !safeIdentifier(commit.repo, 500) ||
        typeof commit.sha !== "string" ||
        !/^[a-f\d]{7,64}$/i.test(commit.sha) ||
        (commit.title !== undefined && !safeIdentifier(commit.title, 500))
      )
        return insufficient("History contains invalid commit provenance.");
      const key = `${commit.repo}:${commit.sha.toLowerCase()}`;
      if (commitGroups.has(key) && commitGroups.get(key) !== row.group)
        return insufficient("The same commit appears in independent history groups.");
      commitGroups.set(key, row.group);
      if (!seenCommits.has(key))
        commits.push({
          repo: commit.repo,
          sha: commit.sha.toLowerCase(),
          ...(commit.title === undefined ? {} : { title: commit.title }),
        });
      seenCommits.add(key);
    }
    tasks.push({
      id: row.id,
      group: row.group,
      startedAt: new Date(row.startedAt).toISOString(),
      completedAt: new Date(row.completedAt).toISOString(),
      request: row.request,
      provider: row.provider,
      inputTokens: row.inputTokens as number,
      outputTokens: row.outputTokens as number,
      commits,
    });
  }
  tasks.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
  return { status: "ready", tasks };
}

export function historyPath(): string {
  return (
    process.env.AGENT_CONSOLE_TRIAGE_HISTORY ||
    path.join(os.homedir(), ".config/agent-console/triage-history.json")
  );
}

/** History contains private requests. Require a regular, owner-only file; never return its contents in errors. */
export function loadHistory(
  file = historyPath(),
): { status: "ready"; tasks: HistoricalTask[] } | HistoryInsufficient {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    )
      return insufficient("History file must be a private file owned by the current user.");
    if (stat.size > HISTORY_POLICY.maximumBytes)
      return insufficient("History file exceeds the size limit.");
    return validateHistory(JSON.parse(fs.readFileSync(fd, "utf8")));
  } catch {
    return insufficient("Private measured history is unavailable or malformed.");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function historyQuantile(values: readonly number[], probability: number): number {
  if (!values.length || probability < 0 || probability > 1)
    throw new Error("Invalid empirical quantile.");
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower);
}

function summary(
  tasks: readonly HistoricalTask[],
  field: "inputTokens" | "outputTokens" | "total",
) {
  const values = tasks.map((task) =>
    field === "total" ? task.inputTokens + task.outputTokens : task[field],
  );
  return {
    median: Math.round(historyQuantile(values, 0.5)),
    range: [Math.floor(historyQuantile(values, 0.1)), Math.ceil(historyQuantile(values, 0.9))] as [
      number,
      number,
    ],
  };
}

/** FTS syntax is generated only from bounded word tokens. The query is always bound as data. */
export function lexicalHistoryQuery(request: string): string {
  return [
    ...new Set(
      request
        .slice(0, 12_000)
        .toLowerCase()
        .match(/[\p{L}\p{N}_]{3,40}/gu) || [],
    ),
  ]
    .slice(0, 48)
    .map((word) => `"${word}"`)
    .join(" OR ");
}

function selectRows(
  tasks: readonly HistoricalTask[],
  request: string,
  method: HistoryMethod,
): { rows: HistoricalTask[]; method: HistoryMethod } {
  if (method === "global-median") return { rows: [...tasks], method };
  const query = lexicalHistoryQuery(request);
  if (!query) return { rows: [...tasks], method: "global-median" };
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(
      "CREATE VIRTUAL TABLE requests USING fts5(id UNINDEXED, request, tokenize='porter unicode61')",
    );
    const insert = database.prepare("INSERT INTO requests(id, request) VALUES (?, ?)");
    for (const task of tasks) insert.run(task.id, task.request);
    const matches = database
      .prepare("SELECT id FROM requests WHERE requests MATCH ? ORDER BY bm25(requests), id")
      .all(query) as { id: string }[];
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const groups = new Set<string>();
    const rows: HistoricalTask[] = [];
    const k = method === "lexical-k3" ? 3 : 5;
    for (const match of matches) {
      const task = byId.get(match.id)!;
      if (groups.has(task.group)) continue;
      rows.push(task);
      groups.add(task.group);
      if (rows.length === k) return { rows, method };
    }
    return { rows: [...tasks], method: "global-median" };
  } finally {
    database.close();
  }
}

interface Group {
  id: string;
  startedAt: string;
  completedAt: string;
  rows: HistoricalTask[];
}
function grouped(tasks: readonly HistoricalTask[]): Group[] {
  const groups = new Map<string, Group>();
  for (const task of tasks) {
    const group = groups.get(task.group);
    if (!group)
      groups.set(task.group, {
        id: task.group,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
        rows: [task],
      });
    else {
      group.rows.push(task);
      if (task.startedAt < group.startedAt) group.startedAt = task.startedAt;
      if (task.completedAt > group.completedAt) group.completedAt = task.completedAt;
    }
  }
  return [...groups.values()].sort(
    (a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id),
  );
}

interface Case {
  predicted: number;
  actual: number;
  range: [number, number];
}
function metrics(cases: Case[]): HistoryMetrics {
  if (!cases.length) return emptyMetrics();
  return {
    count: cases.length,
    maeTokens: Math.round(
      cases.reduce((sum, item) => sum + Math.abs(item.predicted - item.actual), 0) / cases.length,
    ),
    multiplicativeError: Math.exp(
      cases.reduce(
        (sum, item) => sum + Math.abs(Math.log((item.predicted + 1) / (item.actual + 1))),
        0,
      ) / cases.length,
    ),
    rangeCoverage:
      cases.filter((item) => item.actual >= item.range[0] && item.actual <= item.range[1]).length /
      cases.length,
  };
}

function evaluateGroups(
  training: Group[],
  targets: Group[],
  method: HistoryMethod,
  expanding: boolean,
): HistoryMetrics {
  const cases: Case[] = [];
  const available = [...training];
  for (const target of targets) {
    // The entire independent group must finish before this group starts. Never train on its revisions.
    const pool = available
      .filter((group) => group.id !== target.id && group.completedAt < target.startedAt)
      .flatMap((group) => group.rows);
    if (
      pool.length >= HISTORY_POLICY.minimumRows &&
      groupCount(pool) >= HISTORY_POLICY.minimumGroups
    ) {
      for (const task of target.rows) {
        const selected = selectRows(pool, task.request, method);
        const output = summary(selected.rows, "outputTokens");
        cases.push({ predicted: output.median, actual: task.outputTokens, range: output.range });
      }
    }
    if (expanding) available.push(target);
  }
  return metrics(cases);
}

/** Pure statistical fit: all data stays in memory; SQLite only supplies its standard lexical ranking. */
export function trainHistory(
  tasks: readonly HistoricalTask[],
  options: { asOf?: string } = {},
): HistoryModel | HistoryInsufficient {
  const checked = validateHistory({ version: 1, scope: "completed-delivery-run", tasks });
  if (checked.status !== "ready") return checked;
  const asOf = options.asOf || new Date().toISOString();
  if (!timestamp(asOf)) return insufficient("History cutoff is invalid.");
  const normalizedAsOf = new Date(asOf).toISOString();
  // Incomplete/future groups cannot contribute even if one earlier turn has already completed.
  const groups = grouped(checked.tasks).filter((group) => group.completedAt < normalizedAsOf);
  const eligible = groups.flatMap((group) => group.rows);
  if (eligible.length < HISTORY_POLICY.minimumRows || groups.length < HISTORY_POLICY.minimumGroups)
    return insufficient(
      "At least 3 measured delivery runs in 2 completed independent groups are required.",
    );
  const cut = Math.max(1, Math.floor(groups.length * (1 - HISTORY_POLICY.holdoutFraction)));
  const prefix = groups.slice(0, cut);
  const holdout = groups.slice(cut);
  const baselineTuning = evaluateGroups([], prefix, "global-median", true);
  let method: HistoryMethod = "global-median";
  let tuning = baselineTuning;
  let selectionReason = `Only ${groups.length} independent groups; lexical selection requires ${HISTORY_POLICY.minimumSelectionGroups}. Using the empirical global median without differentiated effort claims.`;
  if (
    groups.length >= HISTORY_POLICY.minimumSelectionGroups &&
    baselineTuning.count >= HISTORY_POLICY.minimumTuningCases
  ) {
    selectionReason =
      "Lexical candidates did not improve chronological tuning error; using the empirical global median.";
    for (const candidate of ["lexical-k3", "lexical-k5"] as const) {
      const result = evaluateGroups([], prefix, candidate, true);
      if (
        result.count === baselineTuning.count &&
        result.multiplicativeError! < tuning.multiplicativeError! - 1e-10
      ) {
        method = candidate;
        tuning = result;
        selectionReason = `${candidate} had the lowest expanding-window tuning multiplicative error. Choice frozen before the newest 20% of groups were tested.`;
      }
    }
  } else if (groups.length >= HISTORY_POLICY.minimumSelectionGroups)
    selectionReason =
      "Too few eligible chronological tuning cases; using the empirical global median.";
  // The holdout never selects the method. Its training pool is frozen to the older prefix.
  const validation: HistoryValidation = {
    selectionReason,
    tuning: { model: tuning, baseline: baselineTuning },
    holdout: {
      model: evaluateGroups(prefix, holdout, method, false),
      baseline: evaluateGroups(prefix, holdout, "global-median", false),
    },
    trainingGroupCount: prefix.length,
    holdoutGroupCount: holdout.length,
  };
  return { status: "ready", tasks: eligible, method, validation, asOf: normalizedAsOf };
}

export function predictHistory(
  model: HistoryModel,
  request: string,
  options: { startedAt?: string } = {},
): HistoryEstimate | HistoryInsufficient {
  if (!safeText(request, 24_000))
    return insufficient("A bounded initial request is required for historical estimation.");
  const startedAt = options.startedAt || model.asOf;
  if (!timestamp(startedAt) || new Date(startedAt).toISOString() < model.asOf)
    return insufficient("Prediction cannot precede its fitted history cutoff.");
  const selection = selectRows(model.tasks, request, model.method);
  const workloads = model.tasks.map((task) => task.outputTokens);
  const thresholds = {
    trivialMax: Math.round(historyQuantile(workloads, 1 / 3)),
    deepMin: Math.round(historyQuantile(workloads, 2 / 3)),
  };
  const total = summary(selection.rows, "total");
  const output = summary(selection.rows, "outputTokens");
  const effort =
    thresholds.trivialMax >= thresholds.deepMin
      ? "bau"
      : output.median <= thresholds.trivialMax
        ? "trivial"
        : output.median >= thresholds.deepMin
          ? "deep"
          : "bau";
  const selectedIsLexical = selection.method !== "global-median";
  return {
    status: "ready",
    scope: "completed-delivery-run",
    workloadMetric: "outputTokens",
    effort,
    method: selection.method,
    evidence:
      selectedIsLexical && model.validation.holdout.model.count >= HISTORY_POLICY.minimumTuningCases
        ? "backtested"
        : "low",
    sampleCount: model.tasks.length,
    independentGroupCount: groupCount(model.tasks),
    analogueCount: selectedIsLexical ? selection.rows.length : 0,
    input: summary(selection.rows, "inputTokens"),
    output,
    total,
    thresholds,
    dateSpan: {
      startedAt: model.tasks.reduce(
        (earliest, task) => (task.startedAt < earliest ? task.startedAt : earliest),
        model.tasks[0].startedAt,
      ),
      completedAt: model.tasks.reduce(
        (latest, task) => (task.completedAt > latest ? task.completedAt : latest),
        model.tasks[0].completedAt,
      ),
    },
    analogues: selection.rows.map((task) => ({
      ids: [task.id],
      provider: task.provider,
      commits: structuredClone(task.commits),
    })),
    validation: structuredClone(model.validation),
    formula:
      "Workload target is observed generated direct-agent output tokens, not human hours or whole-issue effort. Cached context replay makes input unsuitable as this workload proxy. Method selection, backtesting, and effort terciles use outputTokens only. Input (including cached context), output, and total budgets each use the selected historical median and sample P10–P90; their medians need not add. Ranges are descriptive sample ranges, not guaranteed confidence intervals. Estimates cover one completed delivery run, not the whole issue or unmeasured child agents.",
  };
}

export function estimateHistory(
  request: string,
  options: { path?: string; startedAt?: string } = {},
): HistoryEstimate | HistoryInsufficient {
  const loaded = loadHistory(options.path);
  if (loaded.status !== "ready") return loaded;
  const model = trainHistory(loaded.tasks, { asOf: options.startedAt });
  return model.status === "ready"
    ? predictHistory(model, request, { startedAt: options.startedAt })
    : model;
}

export function evaluateHistory(
  tasks: readonly HistoricalTask[],
  options: { asOf?: string } = {},
): HistoryValidation | HistoryInsufficient {
  const model = trainHistory(tasks, options);
  return model.status === "ready" ? model.validation : model;
}

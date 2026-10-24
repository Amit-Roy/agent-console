import fs from "node:fs";
import path from "node:path";
import { Cron } from "croner";
import type { Turn } from "./analytics.ts";

const DAY = 86_400_000,
  HOUR = 3_600_000;
const known = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const value = (n: unknown) => (known(n) ? n : null);
export function normalizeModel(m: any) {
  const e = m.evaluations ?? {},
    p = m.pricing ?? {},
    perf = m.performance ?? {};
  return {
    id: m.id,
    name: m.name,
    slug: m.slug,
    creator: m.model_creator?.name ?? "Unknown",
    intelligence: value(e.artificial_analysis_intelligence_index),
    coding: value(e.artificial_analysis_coding_index),
    agentic: value(e.artificial_analysis_agentic_index),
    inputPrice: value(p.price_1m_input_tokens),
    outputPrice: value(p.price_1m_output_tokens),
    cacheReadPrice: value(p.price_1m_cache_hit_tokens),
    cacheWritePrice: value(p.price_1m_cache_write_tokens),
    speed: value(perf.median_output_tokens_per_second),
    latency: value(perf.median_time_to_first_answer_token_seconds),
  };
}

type UsageTotals = { fresh: number; cacheRead: number; cacheWrite: number; output: number };
type UsageScan = {
  intervals: number[][];
  totals: UsageTotals;
  turns: number;
  measuredTurns: number;
  durationMissing: number;
  telemetryDurations: number;
  boundaryTurns: number;
};

function measuredModels(row: Turn) {
  if (row.accounting !== 2 || row.unresolved || !row.models?.length) return undefined;
  const models = row.models.map((model) => ({
    ...model,
    cacheWrite: model.cacheWrite ?? (row.provider === "codex" ? 0 : undefined),
  }));
  const complete = models.every((model) =>
    [model.fresh, model.cacheRead, model.cacheWrite, model.output].every(known),
  );
  return complete ? models : undefined;
}

function scanUsageRow(
  scan: UsageScan,
  row: Turn,
  window: { from: number; to: number },
  timing: Map<string, any>,
) {
  const timingKey = `${row.thread}:${row.ts}`;
  const duration = timing.get(timingKey) ?? row.ms;
  const end = row.ts + (known(duration) ? duration : 0);
  if (row.ts > window.to || end < window.from) return;
  scan.turns++;
  // Exclude boundary-crossing turns: aggregate counters cannot be split accurately by time.
  if (row.ts < window.from || end > window.to) {
    scan.boundaryTurns++;
    return;
  }
  if (!known(duration) || duration === 0) {
    scan.durationMissing++;
    return;
  }
  const models = measuredModels(row);
  if (!models) return;
  scan.measuredTurns++;
  if (timing.has(timingKey)) scan.telemetryDurations++;
  for (const model of models) {
    scan.totals.fresh += model.fresh!;
    scan.totals.cacheRead += model.cacheRead!;
    scan.totals.cacheWrite += model.cacheWrite!;
    scan.totals.output += model.output!;
  }
  scan.intervals.push([row.ts, end]);
}

function unionDuration(intervals: number[][]) {
  intervals.sort((left, right) => left[0] - right[0]);
  let activeMs = 0,
    start = 0,
    end = 0;
  for (const [intervalStart, intervalEnd] of intervals) {
    if (intervalStart > end) {
      activeMs += end - start;
      start = intervalStart;
      end = intervalEnd;
    } else end = Math.max(end, intervalEnd);
  }
  return activeMs + (end - start);
}

/** Use the same measured population for both tokens and overlapping active-time intervals. */
export function benchmarkUsage(rows: Turn[], from: number, to: number, timings: any[] = []) {
  const timing = new Map(
    timings.map((entry) => [`${entry.thread}:${entry.turn_ts}`, entry.total_ms]),
  );
  const scan: UsageScan = {
    intervals: [],
    totals: { fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    turns: 0,
    measuredTurns: 0,
    durationMissing: 0,
    telemetryDurations: 0,
    boundaryTurns: 0,
  };
  for (const row of rows) scanUsageRow(scan, row, { from, to }, timing);
  const { turns, measuredTurns, durationMissing, telemetryDurations, boundaryTurns, totals } = scan;
  const activeMs = unionDuration(scan.intervals);
  return {
    from,
    to,
    days: (to - from) / DAY,
    turns,
    measuredTurns,
    durationMissing,
    boundaryTurns,
    telemetryDurations,
    activeHours: activeMs / HOUR,
    ...totals,
    assumptions: [
      "Token rates use completed, fully measured turns and the union of their active intervals. Parallel sessions count once in elapsed time.",
      "Server-measured duration is preferred; provider duration is the fallback. Agent-active time is not measured human productivity.",
      "Incomplete, unresolved, unfinished and boundary-crossing turns cannot establish total burn. Estimates describe the measured workload only.",
      "Reasoning tokens are included in output. API prices are hypothetical, not subscription charges or guaranteed access for 16 hours daily.",
      "Equal token volume across models is a scenario; retries, reasoning effort, caching, context tiers and task success can change actual costs.",
    ],
  };
}

export class BenchmarkError extends Error {
  status: number;
  constructor(message: string, status = 503) {
    super(message);
    this.status = status;
  }
}

type BenchmarkOptions = {
  dataDir: string;
  keyFile?: string;
  fetcher?: typeof fetch;
  now?: () => number;
  schedule?: boolean;
};
type BenchmarkContext = {
  options: BenchmarkOptions;
  now: () => number;
  fetcher: typeof fetch;
  file: string;
  state: any;
  pending: Promise<any> | undefined;
  cron: Cron | undefined;
};
type CatalogProgress = {
  models: any[];
  seen: Set<string>;
  quota: any;
  indexVersion: unknown;
  tier: unknown;
};

function saveBenchmarkState(context: BenchmarkContext) {
  const temp = context.file + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(context.state), { mode: 0o600 });
  fs.renameSync(temp, context.file);
}
function benchmarkReadyAt(context: BenchmarkContext) {
  const { state } = context;
  return Math.max(state.lastAttempt ? state.lastAttempt + HOUR : 0, state.blockedUntil || 0);
}
function benchmarkView(context: BenchmarkContext) {
  const { state } = context;
  return {
    snapshot: state.snapshot
      ? { ...state.snapshot, quota: state.quota ?? state.snapshot.quota }
      : null,
    weekly: state.weekly,
    error: state.error ?? null,
    nextRefreshAt: state.weekly ? (context.cron?.nextRun()?.getTime() ?? null) : null,
    refreshAllowedAt: benchmarkReadyAt(context),
    refreshing: !!context.pending,
  };
}
function benchmarkApiKey(options: BenchmarkOptions) {
  let key = process.env.ARTIFICIAL_ANALYSIS_API_KEY;
  if (!key && options.keyFile)
    try {
      key = fs.readFileSync(options.keyFile, "utf8").trim();
    } catch {}
  return key;
}
function headerNumber(response: Response, name: string) {
  const header = response.headers.get(name);
  return header !== null && known(Number(header)) ? Number(header) : null;
}
function assertQuotaReserve(context: BenchmarkContext, quota: any) {
  if (
    quota &&
    known(quota.remaining) &&
    quota.remaining <= 10 &&
    (!quota.resetAt || context.now() < quota.resetAt)
  ) {
    context.state.blockedUntil = quota.resetAt || context.now() + DAY;
    throw new BenchmarkError("API reserve reached: at least 10 requests are kept unused.", 429);
  }
}
function applyRateHeaders(
  context: BenchmarkContext,
  progress: CatalogProgress,
  response: Response,
) {
  const { quota } = progress;
  const reset = headerNumber(response, "x-ratelimit-reset");
  progress.quota = {
    limit: headerNumber(response, "x-ratelimit-limit") ?? quota.limit,
    remaining: headerNumber(response, "x-ratelimit-remaining") ?? quota.remaining,
    resetAt: reset === null ? quota.resetAt : reset * 1000,
  };
  context.state.quota = progress.quota;
  saveBenchmarkState(context);
}
function assertCatalogResponse(
  context: BenchmarkContext,
  progress: CatalogProgress,
  response: Response,
) {
  if (response.status === 429) {
    const retry = headerNumber(response, "retry-after");
    context.state.blockedUntil = Math.max(
      progress.quota.resetAt || 0,
      context.now() + (retry ?? 86_400) * 1000,
    );
    throw new BenchmarkError(
      "Artificial Analysis quota exhausted. The previous snapshot is retained until reset.",
      429,
    );
  }
  if (!response.ok)
    throw new BenchmarkError(
      `Artificial Analysis returned HTTP ${response.status}. The previous snapshot is retained.`,
    );
}
function assertCatalogBody(body: any, page: number, progress: CatalogProgress) {
  if (
    !Array.isArray(body.data) ||
    !body.pagination ||
    body.pagination.page !== page ||
    typeof body.pagination.has_more !== "boolean"
  )
    throw new BenchmarkError("Artificial Analysis returned an unexpected catalog format.");
  if (
    page > 1 &&
    (body.intelligence_index_version !== progress.indexVersion || body.tier !== progress.tier)
  )
    throw new BenchmarkError(
      "Benchmark version changed during refresh. The previous snapshot is retained.",
    );
}
function collectCatalogModels(entries: any[], progress: CatalogProgress) {
  for (const entry of entries) {
    if (typeof entry.id !== "string" || typeof entry.name !== "string")
      throw new BenchmarkError("Artificial Analysis returned an invalid model.");
    if (!progress.seen.has(entry.id)) {
      progress.seen.add(entry.id);
      progress.models.push(normalizeModel(entry));
    }
  }
}
// Returns whether more pages remain.
async function fetchCatalogPage(
  context: BenchmarkContext,
  key: string,
  page: number,
  progress: CatalogProgress,
) {
  assertQuotaReserve(context, progress.quota);
  // Persist a conservative request debit before I/O, including failed requests and process exits.
  progress.quota = { ...progress.quota, remaining: Math.max(0, progress.quota.remaining - 1) };
  context.state.quota = progress.quota;
  saveBenchmarkState(context);
  const response = await context.fetcher(
    `https://artificialanalysis.ai/api/v2/language/models/free?page=${page}`,
    {
      headers: { "x-api-key": key },
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    },
  );
  applyRateHeaders(context, progress, response);
  assertCatalogResponse(context, progress, response);
  const body = await response.json();
  assertCatalogBody(body, page, progress);
  progress.indexVersion = body.intelligence_index_version;
  progress.tier = body.tier;
  collectCatalogModels(body.data, progress);
  return body.pagination.has_more as boolean;
}
function commitSnapshot(context: BenchmarkContext, progress: CatalogProgress) {
  const { models, quota, indexVersion, tier } = progress;
  const { state } = context;
  if (!models.length) throw new BenchmarkError("Artificial Analysis returned an empty catalog.");
  const snapshot = { fetchedAt: context.now(), indexVersion, tier, models, quota };
  state.history = [
    ...(state.history ?? []),
    {
      fetchedAt: snapshot.fetchedAt,
      indexVersion,
      models: models.map((model) => ({
        id: model.id,
        intelligence: model.intelligence,
        coding: model.coding,
        agentic: model.agentic,
        inputPrice: model.inputPrice,
        outputPrice: model.outputPrice,
      })),
    },
  ].slice(-53);
  state.snapshot = snapshot;
  state.error = null;
  state.blockedUntil = 0;
  saveBenchmarkState(context);
  return snapshot;
}
async function downloadCatalog(context: BenchmarkContext, key: string) {
  const { state } = context;
  let quota: any = state.quota ?? state.snapshot?.quota ?? null;
  if (!quota || !quota.resetAt || context.now() >= quota.resetAt)
    quota = { limit: 100, remaining: 100, resetAt: context.now() + DAY };
  const progress: CatalogProgress = {
    models: [],
    seen: new Set<string>(),
    quota,
    indexVersion: undefined,
    tier: undefined,
  };
  for (let page = 1; page <= 10; page++) {
    const hasMore = await fetchCatalogPage(context, key, page, progress);
    if (!hasMore) return commitSnapshot(context, progress);
  }
  throw new BenchmarkError(
    "Catalog exceeds the 10-page safety cap. The previous snapshot is retained.",
  );
}
async function runCatalogRefresh(context: BenchmarkContext, key: string) {
  try {
    return await downloadCatalog(context, key);
  } catch (error) {
    // Never expose upstream bodies or exception text, which could contain request credentials.
    const safe =
      error instanceof BenchmarkError
        ? error
        : new BenchmarkError(
            "Benchmark refresh failed or timed out. The previous snapshot is retained.",
          );
    context.state.error = safe.message;
    saveBenchmarkState(context);
    throw safe;
  } finally {
    context.pending = undefined;
  }
}
async function refreshBenchmarks(context: BenchmarkContext) {
  if (context.pending) return context.pending;
  if (context.now() < benchmarkReadyAt(context))
    throw new BenchmarkError(
      "Refresh is paused to protect your API quota. Use the cached snapshot until the cooldown ends.",
      429,
    );
  const key = benchmarkApiKey(context.options);
  if (!key) throw new BenchmarkError("Artificial Analysis key is not configured on the server.");
  context.state.lastAttempt = context.now();
  saveBenchmarkState(context);
  context.pending = Promise.resolve().then(() => runCatalogRefresh(context, key));
  return context.pending;
}

export function createBenchmarks(options: BenchmarkOptions) {
  const { dataDir } = options;
  const file = path.join(dataDir, "benchmarks.json");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  let state: any = { weekly: true, snapshot: null, lastAttempt: 0, blockedUntil: 0 };
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {}
  const context: BenchmarkContext = {
    options,
    now: options.now ?? Date.now,
    fetcher: options.fetcher ?? fetch,
    file,
    state,
    pending: undefined,
    cron: undefined,
  };
  const refresh = () => refreshBenchmarks(context);
  context.cron =
    options.schedule === false
      ? undefined
      : new Cron("0 8 * * 1", { timezone: "UTC", protect: true }, async () => {
          if (context.state.weekly)
            try {
              await refresh();
            } catch {}
        });
  return {
    view: () => benchmarkView(context),
    refresh,
    settings(weekly: boolean) {
      context.state.weekly = weekly;
      saveBenchmarkState(context);
      return benchmarkView(context);
    },
    close() {
      context.cron?.stop();
    },
  };
}

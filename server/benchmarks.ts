import fs from "node:fs";
import path from "node:path";
import { Cron } from "croner";
import type { Turn } from "./analytics.ts";

const DAY = 86_400_000, HOUR = 3_600_000;
const known = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const value = (n: unknown) => known(n) ? n : null;
export function normalizeModel(m: any) {
  const e = m.evaluations ?? {}, p = m.pricing ?? {}, perf = m.performance ?? {};
  return { id: m.id, name: m.name, slug: m.slug, creator: m.model_creator?.name ?? "Unknown",
    intelligence: value(e.artificial_analysis_intelligence_index), coding: value(e.artificial_analysis_coding_index),
    agentic: value(e.artificial_analysis_agentic_index), inputPrice: value(p.price_1m_input_tokens),
    outputPrice: value(p.price_1m_output_tokens), cacheReadPrice: value(p.price_1m_cache_hit_tokens),
    cacheWritePrice: value(p.price_1m_cache_write_tokens), speed: value(perf.median_output_tokens_per_second),
    latency: value(perf.median_time_to_first_answer_token_seconds) };
}

/** Use the same measured population for both tokens and overlapping active-time intervals. */
export function benchmarkUsage(rows: Turn[], from: number, to: number, timings: any[] = []) {
  const timing = new Map(timings.map(t => [`${t.thread}:${t.turn_ts}`, t.total_ms]));
  const intervals: number[][] = [];
  const totals = { fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let turns = 0, measuredTurns = 0, durationMissing = 0, telemetryDurations = 0, boundaryTurns = 0;
  for (const row of rows) {
    const duration = timing.get(`${row.thread}:${row.ts}`) ?? row.ms;
    const end = row.ts + (known(duration) ? duration : 0);
    if (row.ts > to || end < from) continue;
    turns++;
    // Exclude boundary-crossing turns: aggregate counters cannot be split accurately by time.
    if (row.ts < from || end > to) { boundaryTurns++; continue; }
    if (!known(duration) || duration === 0) { durationMissing++; continue; }
    if (row.accounting !== 2 || row.unresolved || !row.models?.length) continue;
    const models = row.models.map(m => ({ ...m, cacheWrite: m.cacheWrite ?? (row.provider === "codex" ? 0 : undefined) }));
    if (!models.every(m => [m.fresh, m.cacheRead, m.cacheWrite, m.output].every(known))) continue;
    measuredTurns++;
    if (timing.has(`${row.thread}:${row.ts}`)) telemetryDurations++;
    for (const m of models) { totals.fresh += m.fresh!; totals.cacheRead += m.cacheRead!; totals.cacheWrite += m.cacheWrite!; totals.output += m.output!; }
    intervals.push([row.ts, end]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let activeMs = 0, start = 0, end = 0;
  for (const [a, b] of intervals) {
    if (a > end) { activeMs += end - start; start = a; end = b; }
    else end = Math.max(end, b);
  }
  activeMs += end - start;
  return { from, to, days: (to - from) / DAY, turns, measuredTurns, durationMissing, boundaryTurns, telemetryDurations,
    activeHours: activeMs / HOUR, ...totals, assumptions: [
      "Token rates use completed, fully measured turns and the union of their active intervals. Parallel sessions count once in elapsed time.",
      "Server-measured duration is preferred; provider duration is the fallback. Agent-active time is not measured human productivity.",
      "Incomplete, unresolved, unfinished and boundary-crossing turns cannot establish total burn. Estimates describe the measured workload only.",
      "Reasoning tokens are included in output. API prices are hypothetical, not subscription charges or guaranteed access for 16 hours daily.",
      "Equal token volume across models is a scenario; retries, reasoning effort, caching, context tiers and task success can change actual costs.",
    ] };
}

export class BenchmarkError extends Error {
  status: number;
  constructor(message: string, status = 503) { super(message); this.status = status; }
}

export function createBenchmarks(options: { dataDir: string; keyFile?: string; fetcher?: typeof fetch; now?: () => number; schedule?: boolean }) {
  const { dataDir } = options, now = options.now ?? Date.now, fetcher = options.fetcher ?? fetch;
  const file = path.join(dataDir, "benchmarks.json");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  let state: any = { weekly: true, snapshot: null, lastAttempt: 0, blockedUntil: 0 };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(file, "utf8")) }; } catch {}
  let pending: Promise<any> | undefined;
  const save = () => {
    const temp = file + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 }); fs.renameSync(temp, file);
  };
  const readyAt = () => Math.max(state.lastAttempt ? state.lastAttempt + HOUR : 0, state.blockedUntil || 0);
  const view = () => ({ snapshot: state.snapshot ? { ...state.snapshot, quota: state.quota ?? state.snapshot.quota } : null, weekly: state.weekly, error: state.error ?? null,
    nextRefreshAt: state.weekly ? cron?.nextRun()?.getTime() ?? null : null, refreshAllowedAt: readyAt(), refreshing: !!pending });
  async function refresh() {
    if (pending) return pending;
    if (now() < readyAt()) throw new BenchmarkError("Refresh is paused to protect your API quota. Use the cached snapshot until the cooldown ends.", 429);
    let key = process.env.ARTIFICIAL_ANALYSIS_API_KEY;
    if (!key && options.keyFile) try { key = fs.readFileSync(options.keyFile, "utf8").trim(); } catch {}
    if (!key) throw new BenchmarkError("Artificial Analysis key is not configured on the server.");
    state.lastAttempt = now(); save();
    pending = Promise.resolve().then(async () => {
      try {
        const models: any[] = [], seen = new Set<string>();
        let page = 1, quota: any = state.quota ?? state.snapshot?.quota ?? null, indexVersion: unknown, tier: unknown;
        if (!quota || !quota.resetAt || now() >= quota.resetAt) quota = { limit: 100, remaining: 100, resetAt: now() + DAY };
        while (page <= 10) {
          if (quota && known(quota.remaining) && quota.remaining <= 10 && (!quota.resetAt || now() < quota.resetAt)) {
            state.blockedUntil = quota.resetAt || now() + DAY;
            throw new BenchmarkError("API reserve reached: at least 10 requests are kept unused.", 429);
          }
          // Persist a conservative request debit before I/O, including failed requests and process exits.
          quota = { ...quota, remaining: Math.max(0, quota.remaining - 1) }; state.quota = quota; save();
          const response = await fetcher(`https://artificialanalysis.ai/api/v2/language/models/free?page=${page}`, {
            headers: { "x-api-key": key! }, signal: AbortSignal.timeout(30_000), redirect: "error",
          });
          const headerNumber = (name: string) => { const h = response.headers.get(name); return h !== null && known(Number(h)) ? Number(h) : null; };
          const reset = headerNumber("x-ratelimit-reset");
          quota = { limit: headerNumber("x-ratelimit-limit") ?? quota.limit, remaining: headerNumber("x-ratelimit-remaining") ?? quota.remaining, resetAt: reset === null ? quota.resetAt : reset * 1000 };
          state.quota = quota; save();
          if (response.status === 429) {
            const retry = headerNumber("retry-after");
            state.blockedUntil = Math.max(quota.resetAt || 0, now() + (retry ?? 86_400) * 1000);
            throw new BenchmarkError("Artificial Analysis quota exhausted. The previous snapshot is retained until reset.", 429);
          }
          if (!response.ok) throw new BenchmarkError(`Artificial Analysis returned HTTP ${response.status}. The previous snapshot is retained.`);
          const body = await response.json();
          if (!Array.isArray(body.data) || !body.pagination || body.pagination.page !== page || typeof body.pagination.has_more !== "boolean") throw new BenchmarkError("Artificial Analysis returned an unexpected catalog format.");
          if (page > 1 && (body.intelligence_index_version !== indexVersion || body.tier !== tier)) throw new BenchmarkError("Benchmark version changed during refresh. The previous snapshot is retained.");
          indexVersion = body.intelligence_index_version; tier = body.tier;
          for (const m of body.data) {
            if (typeof m.id !== "string" || typeof m.name !== "string") throw new BenchmarkError("Artificial Analysis returned an invalid model.");
            if (!seen.has(m.id)) { seen.add(m.id); models.push(normalizeModel(m)); }
          }
          if (!body.pagination.has_more) {
            if (!models.length) throw new BenchmarkError("Artificial Analysis returned an empty catalog.");
            const snapshot = { fetchedAt: now(), indexVersion, tier, models, quota };
            state.history = [...(state.history ?? []), { fetchedAt: snapshot.fetchedAt, indexVersion, models: models.map(m => ({ id: m.id, intelligence: m.intelligence, coding: m.coding, agentic: m.agentic, inputPrice: m.inputPrice, outputPrice: m.outputPrice })) }].slice(-53);
            state.snapshot = snapshot; state.error = null; state.blockedUntil = 0; save();
            return snapshot;
          }
          page++;
        }
        throw new BenchmarkError("Catalog exceeds the 10-page safety cap. The previous snapshot is retained.");
      } catch (error) {
        // Never expose upstream bodies or exception text, which could contain request credentials.
        const safe = error instanceof BenchmarkError ? error : new BenchmarkError("Benchmark refresh failed or timed out. The previous snapshot is retained.");
        state.error = safe.message; save(); throw safe;
      } finally { pending = undefined; }
    });
    return pending;
  }
  const cron = options.schedule === false ? undefined : new Cron("0 8 * * 1", { timezone: "UTC", protect: true }, async () => {
    if (state.weekly) try { await refresh(); } catch {}
  });
  return { view, refresh, settings(weekly: boolean) { state.weekly = weekly; save(); return view(); }, close() { cron?.stop(); } };
}

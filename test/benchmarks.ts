import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Turn } from "../server/analytics.ts";
import { benchmarkUsage, createBenchmarks, normalizeModel } from "../server/benchmarks.ts";

const HOUR = 3_600_000;
const model = (id = "one") => ({
  id,
  name: `Model ${id}`,
  slug: `model-${id}`,
  evaluations: { artificial_analysis_intelligence_index: 50 },
  pricing: { price_1m_input_tokens: 1, price_1m_output_tokens: 2 },
});
const page = (n = 1, more = false, data = [model()]) => ({
  data,
  pagination: { page: n, has_more: more },
  intelligence_index_version: "v1",
  tier: "free",
});
const response = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const catalog = ({ quota, ...snapshot }: any) => snapshot;

function fixture(t: any, fetcher: typeof fetch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "benchmarks-test-"));
  const keyFile = path.join(dir, "test-key");
  fs.writeFileSync(keyFile, "test-placeholder", { mode: 0o600 });
  let time = 10 * HOUR;
  const services: ReturnType<typeof createBenchmarks>[] = [];
  const create = () => {
    const service = createBenchmarks({
      dataDir: dir,
      keyFile,
      fetcher,
      now: () => time,
      schedule: false,
    });
    services.push(service);
    return service;
  };
  t.after(() => {
    services.forEach((s) => s.close());
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    create,
    advance: (ms: number) => {
      time += ms;
    },
    now: () => time,
  };
}

test("burn uses overlapping fully measured intervals, disjoint tokens and server timing", () => {
  const row = (thread: string, ts: number, ms: number, extra: Partial<Turn> = {}): Turn => ({
    thread,
    ts,
    ms,
    provider: "codex",
    accounting: 2,
    models: [
      { model: "sample", role: "agent", fresh: 10, cacheRead: 20, output: 30, reasoning: 25 },
    ],
    ...extra,
  });
  const rows = [
    row("a", HOUR, HOUR),
    row("b", 1.5 * HOUR, HOUR),
    row("unresolved", HOUR, HOUR, { unresolved: "missing" }),
    row("partial", HOUR, HOUR, {
      models: [{ model: "sample", role: "agent", fresh: 1, output: 2 }],
    }),
    row("missing-duration", HOUR, 0),
    row("before", -HOUR, 2 * HOUR),
    row("after", 3 * HOUR, 2 * HOUR),
    row("outside", 5 * HOUR, HOUR),
  ];
  const result = benchmarkUsage(rows, 0, 4 * HOUR, [
    { thread: "a", turn_ts: HOUR, total_ms: 2 * HOUR },
  ]);
  assert.equal(result.activeHours, 2);
  assert.equal(result.measuredTurns, 2);
  assert.equal(result.turns, 7);
  assert.equal(result.boundaryTurns, 2);
  assert.equal(result.durationMissing, 1);
  assert.equal(result.telemetryDurations, 1);
  assert.equal(result.fresh, 20);
  assert.equal(result.cacheRead, 40);
  assert.equal(result.cacheWrite, 0);
  assert.equal(result.output, 60);
});

test("missing scores and prices remain null, while genuine zero remains zero", () => {
  const result = normalizeModel({
    id: "missing",
    name: "Missing",
    evaluations: {
      artificial_analysis_intelligence_index: null,
      artificial_analysis_coding_index: 0,
      artificial_analysis_agentic_index: -1,
    },
    pricing: { price_1m_input_tokens: null, price_1m_output_tokens: 0 },
    performance: { median_output_tokens_per_second: "100" },
  });
  assert.equal(result.intelligence, null);
  assert.equal(result.agentic, null);
  assert.equal(result.coding, 0);
  assert.equal(result.inputPrice, null);
  assert.equal(result.outputPrice, 0);
  assert.equal(result.cacheReadPrice, null);
  assert.equal(result.cacheWritePrice, null);
  assert.equal(result.speed, null);
});

test("full pagination deduplicates models and cached views make no requests", async (t) => {
  const calls: string[] = [];
  const f = fixture(t, (async (url) => {
    calls.push(String(url));
    return response(calls.length === 1 ? page(1, true) : page(2, false, [model(), model("two")]));
  }) as typeof fetch);
  const service = f.create();
  service.view();
  assert.equal(calls.length, 0);
  const snapshot = await service.refresh();
  assert.deepEqual(
    snapshot.models.map((m: any) => m.id),
    ["one", "two"],
  );
  assert.deepEqual(
    calls.map((url) => new URL(url).searchParams.get("page")),
    ["1", "2"],
  );
  assert.deepEqual(service.view().snapshot, snapshot);
  service.view();
  assert.equal(calls.length, 2);
});

test("concurrent refreshes share upstream work and restart preserves one-hour cooldown", async (t) => {
  let calls = 0,
    release!: (r: Response) => void;
  const f = fixture(t, (async () => {
    calls++;
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  }) as typeof fetch);
  const service = f.create();
  const first = service.refresh(),
    second = service.refresh();
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(service.view().refreshing, true);
  release(response(page()));
  assert.deepEqual(await first, await second);
  const restarted = f.create();
  assert.equal(restarted.view().refreshAllowedAt, f.now() + HOUR);
  await assert.rejects(restarted.refresh(), (e: any) => e.status === 429);
  assert.equal(calls, 1);
});

test("429 respects Retry-After without retries and retains stale snapshot", async (t) => {
  let calls = 0;
  const f = fixture(t, (async () =>
    ++calls === 1
      ? response(page())
      : response({}, 429, {
          "retry-after": "7200",
          "x-ratelimit-reset": "43200",
        })) as typeof fetch);
  const service = f.create();
  const old = await service.refresh();
  f.advance(HOUR);
  await assert.rejects(service.refresh(), (e: any) => e.status === 429);
  assert.equal(calls, 2);
  assert.deepEqual(catalog(service.view().snapshot), catalog(old));
  assert.equal(service.view().snapshot.quota.remaining, old.quota.remaining - 1);
  assert.equal(service.view().refreshAllowedAt, f.now() + 2 * HOUR);
  await assert.rejects(f.create().refresh(), (e: any) => e.status === 429);
  assert.equal(calls, 2);
});

test("partial refresh failure retains the complete prior snapshot", async (t) => {
  let calls = 0;
  const f = fixture(t, (async () => {
    calls++;
    return calls === 1
      ? response(page())
      : calls === 2
        ? response(page(1, true, [model("replacement")]))
        : response({}, 503);
  }) as typeof fetch);
  const service = f.create();
  const old = await service.refresh();
  f.advance(HOUR);
  await assert.rejects(service.refresh(), /HTTP 503/);
  assert.equal(calls, 3);
  assert.deepEqual(catalog(service.view().snapshot), catalog(old));
  assert.equal(service.view().snapshot.quota.remaining, old.quota.remaining - 2);
  const restarted = f.create();
  assert.deepEqual(catalog(restarted.view().snapshot), catalog(old));
  assert.equal(restarted.view().snapshot.quota.remaining, old.quota.remaining - 2);
});

test("ten-request reserve stops pagination before spending reserved calls", async (t) => {
  let calls = 0;
  const f = fixture(t, (async () => {
    calls++;
    return calls === 1
      ? response(page(1, true), 200, {
          "x-ratelimit-remaining": "10",
          "x-ratelimit-reset": String((10 * HOUR + 86_400_000) / 1000),
        })
      : response(page());
  }) as typeof fetch);
  const service = f.create();
  await assert.rejects(service.refresh(), /reserve reached/);
  assert.equal(calls, 1);
  assert.equal(service.view().snapshot, null);
  await assert.rejects(f.create().refresh(), (e: any) => e.status === 429);
  assert.equal(calls, 1);
  f.advance(86_400_000);
  const reset = f.create();
  await reset.refresh();
  assert.equal(calls, 2);
  assert.equal(reset.view().snapshot.quota.remaining, 99);
});

test("headerless failed requests debit local quota durably across restart", async (t) => {
  let calls = 0;
  const f = fixture(t, (async () => {
    calls++;
    if (calls === 2) throw new TypeError("Simulated network failure");
    return response(page());
  }) as typeof fetch);
  const service = f.create();
  const old = await service.refresh();
  assert.equal(old.quota.limit, 100);
  assert.equal(old.quota.remaining, 99);
  assert.equal(old.quota.resetAt, f.now() + 86_400_000);
  f.advance(HOUR);
  await assert.rejects(service.refresh(), /failed or timed out/);
  const restarted = f.create();
  assert.deepEqual(catalog(restarted.view().snapshot), catalog(old));
  assert.equal(restarted.view().snapshot.quota.remaining, 98);
  await assert.rejects(restarted.refresh(), (e: any) => e.status === 429);
  assert.equal(calls, 2);
  f.advance(HOUR);
  await restarted.refresh();
  assert.equal(calls, 3);
  assert.equal(restarted.view().snapshot.quota.remaining, 97);
});

test("ten-page cap stops unbounded catalogs without publishing partial results", async (t) => {
  let calls = 0;
  const f = fixture(t, (async () =>
    response(page(++calls, true, [model(String(calls))]))) as typeof fetch);
  const service = f.create();
  await assert.rejects(service.refresh(), /10-page safety cap/);
  assert.equal(calls, 10);
  assert.equal(service.view().snapshot, null);
});

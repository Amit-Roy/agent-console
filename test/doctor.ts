import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-doctor-"));
Object.assign(process.env, {
  AGENT_CONSOLE_DATA: data,
  AGENT_CONSOLE_MOCK: "1",
  AGENT_CONSOLE_BRAIN: path.join(data, "absent"),
});
const { Threads } = await import("../server/threads.ts");
const { headroom } = await import("../server/headroom.ts");
const { PROVIDERS } = await import("../server/providers/index.ts");
const { createDoctor, probeUpstream } = await import("../server/doctor.ts");
const threads = new Threads(() => {});
const internal = threads as any;
let kills = 0;
const make = (active = false, background = false) => {
  const t = threads.create({ provider: "mock", cwd: data });
  t.status = active ? "running" : "idle";
  if (background) t.background = 1;
  internal.live.set(t.id, {
    agent: {
      alive: true,
      kill() {
        kills++;
      },
    },
    aborted: false,
    proxyUrl: "http://127.0.0.1:8790",
    spawnAt: Date.now(),
  });
  return t;
};
try {
  const claude = PROVIDERS.get("claude")!;
  const originalStart = claude.start,
    originalUrl = headroom.url;
  const originalEndpoint = process.env.ANTHROPIC_BASE_URL;
  try {
    delete process.env.ANTHROPIC_BASE_URL;
    headroom.url = () => "http://127.0.0.1:8790";
    claude.start = () => ({ alive: true, send() {}, abort() {}, kill() {} });
    const routed = threads.create({ provider: "claude", cwd: data });
    assert.equal(threads.warm(routed.id), true);
    assert.equal(
      internal.live.get(routed.id).proxyUrl,
      headroom.url(),
      "Actual warm Claude launch records managed proxy routing",
    );
    process.env.ANTHROPIC_BASE_URL = "https://custom.example";
    const external = threads.create({ provider: "claude", cwd: data });
    assert.equal(threads.warm(external.id), true);
    assert.equal(
      internal.live.get(external.id).proxyUrl,
      undefined,
      "External endpoint remains user controlled",
    );
    headroom.url = () => undefined;
    assert.deepEqual(threads.repairRouting(), { fixed: 1, deferred: 0 });
    assert.ok(
      internal.live.has(external.id),
      "Unrelated external endpoint process survives repair",
    );
    threads.remove(external.id);
    kills = 0;
  } finally {
    claude.start = originalStart;
    headroom.url = originalUrl;
    if (originalEndpoint === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = originalEndpoint;
  }
  const idle = make(),
    active = make(true),
    background = make(false, true);
  assert.deepEqual(threads.routingHealth(), { idle: 1, active: 2, silent: 0 });
  assert.deepEqual(threads.repairRouting(), { fixed: 1, deferred: 2 });
  assert.equal(kills, 1);
  assert.ok(!internal.live.has(idle.id));
  assert.ok(internal.live.has(active.id));
  assert.ok(internal.live.has(background.id));
  assert.deepEqual(threads.repairRouting(), { fixed: 0, deferred: 2 });
  assert.equal(kills, 1, "Repeated repair never interrupts active work");
  internal.onEvent(active, { type: "result", is_error: true });
  assert.ok(!internal.live.has(active.id), "Deferred active routing recycles after result");
  delete background.background;
  threads.sweep(1);
  assert.ok(!internal.live.has(background.id), "Background work recycles after it finishes");
  const expired = make(true),
    waiting = make(true),
    healthy = make(true),
    busyBackground = make(true, true);
  for (const t of [expired, waiting, busyBackground])
    internal.live.get(t.id).spawnAt = Date.now() - 31 * 60_000;
  internal.questions.add(waiting.id, {
    id: "doctor-question",
    toolUseId: "doctor-tool",
    questions: [{ id: "q", question: "Wait?", options: [] }],
  });
  assert.equal(
    threads.routingHealth().silent,
    1,
    "Only expired turns count; questions and background work are excluded",
  );
  assert.equal(threads.repairStaleTurns(), 1);
  assert.equal(expired.status, "idle");
  for (const t of [waiting, healthy, busyBackground]) assert.equal(t.status, "running");
  const queued = make(true);
  internal.live.get(queued.id).spawnAt = Date.now() - 31 * 60_000;
  threads.send(queued.id, "queued recovery", { mode: "queue" });
  assert.equal(internal.queues.get(queued.id).length, 1);
  assert.equal(threads.repairStaleTurns(), 1);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(
    internal.queues.get(queued.id)?.length ?? 0,
    0,
    "Expired turn drains queued message",
  );
  assert.ok(
    threads
      .history(queued.id)
      .some((event: any) => event.type === "user_input" && event.text === "queued recovery"),
    "Queued message starts through a fresh agent",
  );
  assert.notEqual(internal.live.get(queued.id)?.proxyUrl, "http://127.0.0.1:8790");
  threads.shutdown();
  internal.closed = false;
  const beforeSend = make();
  threads.send(beforeSend.id, "hello");
  assert.notEqual(
    internal.live.get(beforeSend.id)?.proxyUrl,
    "http://127.0.0.1:8790",
    "Next send replaces stale warm process",
  );
  threads.abort(beforeSend.id);

  let probes = 0;
  const proxy = {
    ...headroom,
    async probe() {
      probes++;
      return {
        enabled: true,
        running: false,
        reachable: false,
        latched: true,
        url: "http://127.0.0.1:8790",
        owned: false,
        error: "CPU safety breaker is open",
      };
    },
  };
  const doctor = createDoctor(threads, {
    proxy,
    executable: () => true,
    accountReady: () => true,
    upstream: async () => "reachable",
  });
  const report = await doctor.inspect();
  assert.equal(report.status, "issues");
  assert.equal(report.checks.find((c) => c.id === "headroom")?.repairable, false);
  const probeCount = probes;
  const [first, second] = await Promise.all([doctor.repair(), doctor.repair()]);
  assert.deepEqual(first, second);
  assert.equal(
    probes - probeCount,
    2,
    "Concurrent repairs share one probe and verification sequence",
  );
  assert.ok(first.repairs.some((r) => r.id === "headroom" && r.status === "manual"));
  assert.equal((await proxy.probe()).latched, true, "Doctor did not mutate the safety latch");

  let probeMethod = "";
  assert.equal(
    await probeUpstream((async (_url, options) => {
      probeMethod = options?.method || "";
      return new Response(null, { status: 404 });
    }) as typeof fetch),
    "reachable",
  );
  assert.equal(probeMethod, "HEAD");
  const keepAlive = setTimeout(() => {}, 1000);
  const started = performance.now();
  assert.equal(
    await probeUpstream(
      (async (_url, options) =>
        new Promise((_resolve, reject) =>
          options!.signal!.addEventListener("abort", () => reject(new Error("timeout")), {
            once: true,
          }),
        )) as typeof fetch,
      30,
    ),
    "unreachable",
  );
  clearTimeout(keepAlive);
  assert.ok(performance.now() - started < 500, "Probe timeout remains bounded");
  console.log(
    "PASS Doctor: stale warm routing, safe deferred recovery, repeated/concurrent repair, preserved breaker, bounded no-inference network probe",
  );
} finally {
  threads.shutdown();
  fs.rmSync(data, { recursive: true, force: true });
}
process.exit(0);

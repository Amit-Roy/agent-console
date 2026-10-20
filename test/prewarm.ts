// Pre-warm, Stop-by-interrupt and in-place settings, in-process with the mock agent: no server, no model calls.
// AGENT_CONSOLE_MOCK_START_MS gives the mock a cold start so the warm gain is measurable.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-prewarm-"));
Object.assign(process.env, { AGENT_CONSOLE_DATA: data, AGENT_CONSOLE_MOCK: "1", AGENT_CONSOLE_MOCK_START_MS: "800", AGENT_CONSOLE_BRAIN: path.join(data, "no-brain") });
const { Threads } = await import("../server/threads.ts");
const { PROVIDERS } = await import("../server/providers/index.ts");
const mock = PROVIDERS.get("mock")!;
let starts = 0;
const realStart = mock.start;
mock.start = (t, ctx) => { starts++; return realStart(t, ctx); };
const out: any[] = [];
const threads = new Threads((m) => out.push(m));
const live = (id: string) => (threads as any).live.get(id);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean, ms = 5000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error("timed out"); await pause(5); } };
const firstDelta = async (id: string, text: string) => {
  const t0 = performance.now(), from = out.length;
  threads.send(id, text);
  await until(() => out.slice(from).some((m) => m.thread === id && m.event?.type === "stream_event" && m.event.event?.type === "content_block_delta"));
  const ms = performance.now() - t0;
  await until(() => threads.get(id)!.status === "idle");
  return ms;
};
const mk = () => threads.create({ provider: "mock", cwd: data }).id;

try {
  const cold = mk(), warm = mk();
  const coldMs = await firstDelta(cold, "hello cold");
  assert.equal(threads.warm(warm), true);
  assert.equal(threads.warm(warm), false, "a live agent is not started twice");
  assert.equal(starts, 2);
  assert.ok(!out.some((m) => m.thread === warm && m.t === "event"), "warming publishes nothing");
  await pause(900); // the user reads the thread while the agent starts
  const warmMs = await firstDelta(warm, "hello warm");
  assert.equal(starts, 2, "the send reused the warm agent");
  assert.ok(coldMs >= 790 && warmMs < 200, JSON.stringify({ coldMs, warmMs }));
  console.log(`PASS  prewarm: first token cold ${Math.round(coldMs)} ms -> warm ${Math.round(warmMs)} ms, agent reused`);

  const archived = mk(); threads.archive(archived, true);
  assert.equal(threads.warm(archived), false);
  const [a, b, c] = [mk(), mk(), mk()];
  for (const id of [a, b, c]) threads.warm(id);
  assert.equal([...(threads as any).live.values()].filter((l: any) => l.warm).length, 2, "at most WARM_MAX unused agents");
  assert.ok(!live(a) && live(b) && live(c), "the oldest unused agent is dropped");
  console.log("PASS  prewarm: archived threads skipped, unused agents capped at 2 (oldest dropped)");

  const agent = live(warm).agent;
  threads.update(warm, { mode: "plan" });
  assert.equal(live(warm)?.agent, agent, "settings applied in place");
  agent.configure = () => false; // a harness that cannot: restart, then warm again
  threads.update(warm, { mode: "bypassPermissions" });
  await until(() => !!live(warm));
  assert.notEqual(live(warm).agent, agent); assert.equal(live(warm).warm, true);
  assert.match(await (async () => { const from = out.length; await firstDelta(warm, "hi"); return out.slice(from).find((m) => m.event?.type === "assistant").event.message.content[0].text; })(), /bypassPermissions/);
  console.log("PASS  settings: applied to the idle agent in place, or restarted and re-warmed");

  const before = starts, runner = live(warm).agent;
  threads.send(warm, "slow stop me");
  await pause(100);
  threads.abort(warm);
  assert.ok(out.some((m) => m.thread === warm && m.event?.type === "aborted"));
  assert.equal(threads.get(warm)!.status, "idle");
  assert.equal(live(warm)?.agent, runner, "Stop interrupts and keeps the process");
  const afterStop = await firstDelta(warm, "after stop");
  assert.equal(starts, before); assert.ok(afterStop < 200, String(afterStop));
  console.log(`PASS  stop: interrupt keeps the agent, next first token in ${Math.round(afterStop)} ms`);
} finally {
  threads.shutdown();
  fs.rmSync(data, { recursive: true, force: true });
}
process.exit(0);

// End-to-end check against a running server: auth gate, websocket origin check, provider plumbing via the mock agent.
// Start the server like:  AGENT_CONSOLE_MOCK=1 AGENT_CONSOLE_DATA=/tmp/ac-test PORT=7071 node server/index.ts
// REAL=1 also runs one turn against the real claude CLI (spends a little subscription quota).
import { WebSocket } from "ws";
import { makeToken } from "../server/auth.ts";

const BASE = process.env.BASE || "http://127.0.0.1:7070";
const cookie = `ac_session=${makeToken()}`;
let failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${extra}`);
  if (!ok) failed++;
};

const { CODER_HOST } = await import("../server/auth.ts");
const { request } = await import("node:http");
const withHost = (host: string) =>
  new Promise<number>((res, rej) => {
    const u = new URL(BASE + "/vendor/marked.js");
    const r = request({ host: u.hostname, port: u.port, path: u.pathname, headers: { host } }, (x) => { x.resume(); res(x.statusCode ?? 0); });
    r.on("error", rej);
    r.end();
  });
if (CODER_HOST) {
  check("coder host passes without cookie (SSO)", (await withHost(CODER_HOST)) === 200);
  check("wrong host without cookie blocked", (await withHost("evil.example")) === 401);
} else console.log("SKIP  SSO checks (no VSCODE_PROXY_URI)");
check("unauthenticated API is blocked", (await fetch(BASE + "/vendor/marked.js")).status === 401);
check("page redirects to login", (await fetch(BASE + "/", { redirect: "manual", headers: { accept: "text/html" } })).status === 302);
check("bad password rejected", (await fetch(BASE + "/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "nope" }) })).status === 401);
check("authed index loads", (await fetch(BASE + "/", { headers: { cookie } })).status === 200);
check("authed vendor lib loads", (await fetch(BASE + "/vendor/marked.js", { headers: { cookie } })).status === 200);

const open = (headers: Record<string, string>) =>
  new Promise<WebSocket | null>((res) => {
    const w = new WebSocket(BASE.replace("http", "ws") + "/ws", { headers });
    w.on("open", () => res(w));
    w.on("error", () => res(null));
    w.on("unexpected-response", () => res(null));
  });
check("ws without cookie refused", (await open({ origin: BASE })) === null);
check("ws with foreign origin refused", (await open({ cookie, origin: "https://evil.example" })) === null);

const ws = await open({ cookie, origin: BASE });
check("ws with cookie+origin accepted", ws !== null);
if (!ws) process.exit(1);

const inbox: any[] = [];
ws.on("message", (d) => inbox.push(JSON.parse(String(d))));
const waitFor = async (pred: (m: any) => boolean, ms = 90_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const m = inbox.find(pred);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
};
const hello = await waitFor((m) => m.t === "hello");
check("hello received", !!hello);

check("hello lists providers with readiness", Array.isArray(hello?.providers) && hello.providers.some((p: any) => p.id === "claude" && p.ok), JSON.stringify(hello?.providers?.map((p: any) => p.id)));
check("pi and codex are registered", ["pi", "codex"].every((id) => hello?.providers?.some((p: any) => p.id === id)));

const dir = process.env.TEST_DIR || new URL("./tmp", import.meta.url).pathname;
(await import("node:fs")).mkdirSync(dir, { recursive: true });
const clear = () => (inbox.length = 0);
const events = (id: string) => inbox.filter((m) => m.t === "event" && m.thread === id).map((m) => m.event);
const create = async (o: object) => {
  clear();
  ws.send(JSON.stringify({ t: "create", cwd: dir, title: "e2e", ...o }));
  const m = await waitFor((m) => m.t === "created" || m.t === "error", 10_000);
  return m;
};

// a provider that is not ready, or unknown, must refuse cleanly instead of spawning anything
const unknown = await create({ provider: "nope" });
check("unknown provider is rejected", unknown?.t === "error");
const notReady = hello.providers.find((p: any) => !p.ok);
if (notReady) check(`not-ready provider (${notReady.id}) is rejected with its hint`, (await create({ provider: notReady.id }))?.message?.includes("not ready"));

if (hello.providers.some((p: any) => p.id === "mock")) {
  const made = await create({ provider: "mock", mode: "plan", model: "echo" });
  check("mock thread created with provider + mode", made?.thread?.provider === "mock" && made.thread.mode === "plan");
  const id = made.thread.id;

  clear();
  ws.send(JSON.stringify({ t: "send", thread: id, text: "hello there" }));
  check("mock turn finishes", !!(await waitFor((m) => m.t === "event" && m.event.type === "result", 5000)));
  const ev = events(id);
  check("mock: streamed deltas + final assistant text", ev.some((e) => e.type === "stream_event") && ev.some((e) => e.type === "assistant" && e.message.content[0].text.includes("hello there")));
  check("mock: reply reflects plan mode and model", ev.some((e) => e.type === "assistant" && e.message.content[0].text.includes("plan, echo")));

  clear();
  ws.send(JSON.stringify({ t: "send", thread: id, text: "tool please" }));
  await waitFor((m) => m.t === "event" && m.event.type === "result", 5000);
  const ev2 = events(id);
  check("mock: tool_use then tool_result then result", ["assistant", "user", "assistant", "result"].every((t, i) => ev2.filter((e) => !["system", "stream_event", "user_input"].includes(e.type))[i]?.type === t));

  clear();
  ws.send(JSON.stringify({ t: "send", thread: id, text: "fail now" }));
  await waitFor((m) => m.t === "event" && m.event.type === "result", 5000);
  check("mock: failure surfaces console_error and unlocks the thread", events(id).some((e) => e.type === "console_error") && inbox.some((m) => m.t === "thread" && m.thread.id === id && m.thread.status === "idle"));

  clear();
  ws.send(JSON.stringify({ t: "send", thread: id, text: "slow burn" }));
  await waitFor((m) => m.t === "event" && m.event.type === "stream_event", 3000);
  ws.send(JSON.stringify({ t: "abort", thread: id }));
  check("abort stops a running mock turn", !!(await waitFor((m) => m.t === "event" && m.event.type === "aborted", 3000)));
  clear();
  ws.send(JSON.stringify({ t: "send", thread: id, text: "after stop" }));
  check("thread works again after abort", !!(await waitFor((m) => m.t === "event" && m.event.type === "result", 5000)));

  clear();
  ws.send(JSON.stringify({ t: "update", thread: id, mode: "bypassPermissions", model: "nonexistent" }));
  const upd = await waitFor((m) => m.t === "thread" && m.thread.id === id, 3000);
  check("update applies valid mode, ignores unknown model", upd?.thread?.mode === "bypassPermissions" && upd.thread.model === "echo");
  clear();
  ws.send(JSON.stringify({ t: "update", thread: id, mode: "acceptEdits" }));
  const upd2 = await waitFor((m) => m.t === "thread" && m.thread.id === id, 3000);
  check("mock accepts every mode", upd2?.thread?.mode === "acceptEdits");

  clear();
  ws.send(JSON.stringify({ t: "open", thread: id }));
  const hist = await waitFor((m) => m.t === "history", 3000);
  check("history replay available", (hist?.events?.length ?? 0) > 8, `events=${hist?.events?.length}`);
  check("history omits stream deltas", !hist.events.some((e: any) => e.type === "stream_event"));

  ws.send(JSON.stringify({ t: "delete", thread: id }));
  check("delete removes the thread", !!(await waitFor((m) => m.t === "removed", 3000)));
} else console.log("SKIP  mock-provider checks (start the server with AGENT_CONSOLE_MOCK=1)");

if (process.env.REAL === "1") {
  const made = await create({ provider: "claude", mode: "bypassPermissions", model: "haiku" });
  const id = made.thread.id;
  clear();
  ws.send(JSON.stringify({ t: "send", thread: id, text: "Use the Write tool to create e2e-out.txt containing the word pong, then reply with exactly: DONE" }));
  const result = await waitFor((m) => m.t === "event" && m.event.type === "result");
  check("claude: turn finished", !!result, result ? `cost=$${result.event.total_cost_usd?.toFixed(4)}` : "");
  const text = events(id).filter((e) => e.type === "assistant").flatMap((e) => e.message.content).filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ");
  check("claude: replied DONE", /DONE/.test(text), JSON.stringify(text).slice(0, 80));
  clear();
  ws.send(JSON.stringify({ t: "send", thread: id, text: "What word did the file contain? Answer in one word." }));
  await waitFor((m) => m.t === "event" && m.event.type === "result");
  const text2 = events(id).filter((e) => e.type === "assistant").flatMap((e) => e.message.content).filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ");
  check("claude: second turn remembers context", /pong/i.test(text2), JSON.stringify(text2).slice(0, 60));
  ws.send(JSON.stringify({ t: "delete", thread: id }));
  await waitFor((m) => m.t === "removed", 5000);
}

ws.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);

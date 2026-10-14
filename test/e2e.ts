// End-to-end check against a running server: auth gate, websocket origin check, a real claude turn.
import { WebSocket } from "ws";
import { makeToken } from "../server/auth.ts";

const BASE = process.env.BASE || "http://127.0.0.1:7070";
const cookie = `ac_session=${makeToken()}`;
let failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${extra}`);
  if (!ok) failed++;
};

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

const dir = process.env.TEST_DIR || new URL("./tmp", import.meta.url).pathname;
import("node:fs").then((fs) => fs.mkdirSync(dir, { recursive: true }));
await new Promise((r) => setTimeout(r, 50));
ws.send(JSON.stringify({ t: "create", cwd: dir, mode: "bypassPermissions", model: "haiku", title: "e2e" }));
const created = await waitFor((m) => m.t === "created" || m.t === "error");
if (created?.t === "error") { console.log("create error:", created.message); process.exit(1); }
check("thread created", !!created);
const id = created.thread.id;
ws.send(JSON.stringify({ t: "send", thread: id, text: "Use the Write tool to create e2e-out.txt containing the word pong, then reply with exactly: DONE" }));
const result = await waitFor((m) => m.t === "event" && m.event.type === "result");
check("turn finished", !!result, result ? `cost=$${result.event.total_cost_usd?.toFixed(4)}` : "");
const types = new Set(inbox.filter((m) => m.t === "event").map((m) => m.event.type));
check("streamed text deltas", types.has("stream_event"));
check("tool call + result seen", types.has("assistant") && types.has("user"));
const text = inbox.filter((m) => m.t === "event" && m.event.type === "assistant").flatMap((m) => m.event.message.content).filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ");
check("assistant replied DONE", /DONE/.test(text), JSON.stringify(text).slice(0, 80));

// second turn on the same thread proves the long-lived process keeps context
inbox.length = 0;
ws.send(JSON.stringify({ t: "send", thread: id, text: "What word did the file contain? Answer in one word." }));
await waitFor((m) => m.t === "event" && m.event.type === "result");
const text2 = inbox.filter((m) => m.t === "event" && m.event.type === "assistant").flatMap((m) => m.event.message.content).filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ");
check("second turn remembers context", /pong/i.test(text2), JSON.stringify(text2).slice(0, 60));

ws.send(JSON.stringify({ t: "open", thread: id }));
const hist = await waitFor((m) => m.t === "history");
check("history replay available", (hist?.events?.length ?? 0) > 3, `events=${hist?.events?.length}`);

ws.send(JSON.stringify({ t: "delete", thread: id }));
await waitFor((m) => m.t === "removed", 5000);
ws.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);

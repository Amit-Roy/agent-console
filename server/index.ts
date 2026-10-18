import "./privacy.ts";
import { usage, refreshRouterUsage, refreshUsage } from "./usage.ts";
import express from "express";
import fs from "node:fs";
import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { authed, CODER_HOSTS, cookieFrom, limited, makeToken, passwordOk, PASSWORD, recordFail, setCookie, tokenValid } from "./auth.ts";
import { providerInfo, refreshPiModels } from "./providers/index.ts";
import { threadToMarkdown } from "./export.ts";
import { Threads, turnTiming } from "./threads.ts";
import { dashboard } from "./analytics.ts";
import { pricing, rates } from "./api-pricing.ts";
import { contextAllocation } from "./context-allocation.ts";
import { headroom } from "./headroom.ts";
import { LatencyStore } from "./latency.ts";
import { fileMedia, fileTree, fileViewer } from "./files.ts";
import { createAcodeBridge } from "./acode.ts";
import { acodeConfig, acodePublicApp } from "./acode-http.ts";
import { DATA_DIR } from "./auth.ts";
import { isId, MAX_FILE_BYTES, removeUpload, SAFE_NAME, saveUpload, sniffImageFile, UPLOAD_DIR } from "./uploads.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 7070);
const HOST = "127.0.0.1"; // never listen publicly; Coder's port proxy is the only way in
const HOME = os.homedir();
const REPOS = path.join(HOME, "repos");

const clients = new Set<WebSocket>();
const subscriptions = new WeakMap<WebSocket, string>();
const broadcast = (msg: unknown) => {
  const s = JSON.stringify(msg);
  const event = msg as { t?: string; thread?: string };
  const invalidation = event.t === "event" ? JSON.stringify({ t: "invalidate", thread: event.thread }) : null;
  for (const c of clients) if (c.readyState === c.OPEN) {
    const selected = subscriptions.get(c);
    c.send(invalidation && selected && selected !== event.thread ? invalidation : s);
  }
};
const threads = new Threads(broadcast);
const acode = createAcodeBridge(id => threads.get(id));
const acodeSettings = acodeConfig();
let latency: LatencyStore | undefined;
try { latency = new LatencyStore(path.join(DATA_DIR, "latency.sqlite")); }
catch { console.warn("Local latency storage is unavailable."); }
usage.subscribe((provider, usage) => broadcast({ t: "usage", provider, usage }));
setInterval(() => threads.sweep(), 60_000).unref();

const app = express();
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data: blob: https: http:; media-src 'self' blob: https: http:; style-src 'self' 'unsafe-inline'; connect-src 'self' wss: ws:; frame-ancestors 'none'",
  );
  next();
});

app.get("/login", (req, res) => (authed(req) ? res.redirect("/") : res.sendFile(path.join(ROOT, "public", "login.html"))));
app.post("/login", express.json({ limit: "1kb" }), (req, res) => {
  if (limited()) return void res.status(429).json({ error: "Too many attempts. Try again later." });
  if (!passwordOk(req.body?.password)) {
    recordFail();
    return void res.status(401).json({ error: "Wrong password." });
  }
  res.setHeader("Set-Cookie", setCookie(makeToken()));
  res.json({ ok: true });
});
app.get("/login.js", (_req, res) => res.sendFile(path.join(ROOT, "public", "login.js")));
app.get("/style.css", (_req, res) => res.sendFile(path.join(ROOT, "public", "style.css")));
app.use("/fonts", express.static(path.join(ROOT, "public", "fonts"), { maxAge: "7d" })); // OFL fonts: public, so the sign-in page can use them too
app.get("/icon.svg", (_req, res) => res.sendFile(path.join(ROOT, "public", "icon.svg")));
app.get("/manifest.webmanifest", (_req, res) => res.sendFile(path.join(ROOT, "public", "manifest.webmanifest")));

// everything below requires the session cookie
app.use((req, res, next) => {
  if (authed(req)) return next();
  if (req.method === "GET" && String(req.headers.accept || "").includes("text/html")) return res.redirect("/login");
  res.status(401).end();
});
app.get("/vendor/marked.js", (_req, res) => res.sendFile(path.join(ROOT, "node_modules/marked/lib/marked.esm.js")));
app.get("/vendor/purify.js", (_req, res) => res.sendFile(path.join(ROOT, "node_modules/dompurify/dist/purify.es.mjs")));

// ---- attachments: upload (raw bytes), download, discard. State-changing, so cookie auth alone is not enough: same-origin only.
const sameOrigin: express.RequestHandler = (req, res, next) => {
  try {
    if (new URL(String(req.headers.origin)).host === req.headers.host) return next();
  } catch {}
  res.status(403).json({ error: "Cross-site request refused." });
};
// Restart button: the same detached watcher as `bin/agent-console restart-when-idle` (waits for running turns, then replaces this process).
const RUN_DIR = process.env.AGENT_CONSOLE_RUN || path.join(os.homedir(), ".cache", "agent-console");
// Set by bin/agent-console for the server it starts. Removed from our env so agents and the scratch servers their tests start
// (which inherit everything else) can never overwrite the live server's pid file.
const PID_FILE = process.env.AGENT_CONSOLE_PID_FILE;
delete process.env.AGENT_CONSOLE_PID_FILE;
app.post("/restart", sameOrigin, (_req, res) => {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const out = fs.openSync(path.join(RUN_DIR, "idle-restart.log"), "a");
  spawn(process.execPath, [path.join(ROOT, "scripts", "idle-restart.mjs")], { cwd: ROOT, detached: true, stdio: ["ignore", out, out] }).unref();
  res.json({ ok: true });
});
app.post("/uploads/:thread", sameOrigin, express.raw({ type: () => true, limit: MAX_FILE_BYTES }), (req, res) => {
  const { thread } = req.params;
  if (!isId(thread) || !threads.get(thread)) return void res.status(404).json({ error: "Unknown thread." });
  try {
    const name = (() => { try { return decodeURIComponent(String(req.headers["x-name"] ?? "")); } catch { return ""; } })();
    res.json(saveUpload(thread, name, req.headers["content-type"], Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)));
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "Upload failed." });
  }
});
app.delete("/uploads/:thread/:id", sameOrigin, (req, res) => {
  removeUpload(req.params.thread, req.params.id);
  res.status(204).end();
});
app.get("/export/:thread", (req, res) => {
  const t = threads.get(req.params.thread);
  if (!t) return void res.status(404).end();
  const label = providerInfo().find((p) => p.id === t.provider)?.label ?? t.provider;
  res.attachment(`${t.title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").trim().slice(0, 60) || "conversation"}.md`).type("text/markdown");
  res.send(threadToMarkdown(t, label, threads.history(t.id)));
});
app.get("/api/latency", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try { res.json(latency ? { available: true, ...latency.summary() } : { available: false }); }
  catch { res.status(503).json({ available: false }); }
});
// Turn timing stats for agents and the dashboard: metadata only (durations, tool names, counts, error classes).
const turnLatency = (from: number, to: number, thread?: string) => {
  const store = turnTiming();
  if (!store) return { available: false };
  let phone: { provider: string; total_ms: number }[] = [];
  try { if (!thread) phone = latency?.samples("first_token", from, to) ?? []; } catch {} // device samples are per provider, not per thread
  return { available: true, ...store.summary(from, to, { thread, phone }) };
};
app.get("/api/turn-latency", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const to = Number(req.query.to) || Date.now();
  const from = Number(req.query.from) || to - 7 * 86_400_000;
  const thread = typeof req.query.thread === "string" && isId(req.query.thread) ? req.query.thread : undefined;
  // ?thread=&detail=N: an existing thread's last N turns (max 20) with their full timelines, for Run details' Full breakdown.
  const known = typeof req.query.thread === "string" && threads.get(req.query.thread) ? req.query.thread : undefined;
  if (req.query.detail != null) {
    const store = turnTiming();
    if (!known) return void res.status(404).json({ error: "Unknown thread." });
    try { return void res.json(store ? { available: true, turns: store.recent(known, Number(req.query.detail) || 10) } : { available: false }); }
    catch { return void res.status(503).json({ available: false }); }
  }
  if (!(from < to) || to - from > 400 * 86_400_000) return void res.status(400).json({ error: "Choose a range of up to 400 days." });
  try { res.json(turnLatency(from, to, thread)); }
  catch { res.status(503).json({ available: false }); }
});
app.get("/api/file", fileViewer(id => threads.get(id)));
app.post("/api/acode/edit", sameOrigin, (req, res, next) => {
  if (!acodeSettings) return void res.status(503).json({ error: "Acode editing is not configured on this server." });
  // Never derive the capability endpoint from a client-controlled Host header.
  res.locals.acodeEndpoint = acodeSettings.endpoint;
  next();
}, acode.create);
app.get("/acode-setup", (_req, res) => res.sendFile(path.join(ROOT, "public", "acode-setup.html")));
app.get("/api/acode/setup", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ available: !!acodeSettings, version: "1.1.1", plugin: acodeSettings ? `${acodeSettings.endpoint}/acode-plugin.zip` : null });
});
app.get("/api/file-image", fileViewer(id => threads.get(id), true));
app.get("/api/file-media", fileMedia(id => threads.get(id)));
app.get("/api/files", fileTree(id => threads.get(id)));
app.get("/api/context-pricing", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ ...pricing, rates });
});
app.get("/api/context-allocation/:thread", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const thread = threads.get(req.params.thread);
  if (!thread) return void res.status(404).json({ error: "Unknown thread." });
  res.json(await contextAllocation(thread));
});
app.get("/api/dashboard", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const to = Number(req.query.to) || Date.now();
  const from = Number(req.query.from) || to - 7 * 86_400_000;
  if (!(from < to) || to - from > 400 * 86_400_000) return void res.status(400).json({ error: "Choose a range of up to 400 days." });
  try {
    const d = await dashboard(from, to);
    const titles: Record<string, string> = {};
    for (const t of d.turns) titles[t.thread] ??= threads.get(t.thread)?.title ?? "Deleted thread";
    let turnLatencyStats: any = { available: false };
    try { turnLatencyStats = turnLatency(from, to); } catch {}
    res.json({ ...d, titles, latency: turnLatencyStats });
  }
  catch { res.status(503).json({ error: "Dashboard data is unavailable." }); }
});
app.get("/uploads/:thread/:id/:name", (req, res) => {
  const { thread, id, name } = req.params;
  if (!isId(thread) || !isId(id) || !SAFE_NAME.test(name)) return void res.status(404).end();
  const type = sniffImageFile(path.join(UPLOAD_DIR, thread, id, name));
  res.setHeader("Cache-Control", "private, max-age=86400, immutable");
  // only verified images render inline; anything else (html, svg, ...) is a download, so an upload can never run as a page on this origin
  if (type) res.type(type);
  else res.attachment(name).type("application/octet-stream");
  // `root` matters: without it send() 404s any absolute path with a dot segment, and the data dir lives under ~/.config
  res.sendFile(`${thread}/${id}/${name}`, { root: UPLOAD_DIR }, (err) => err && !res.headersSent && res.status(404).end());
});
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (!req.path.startsWith("/uploads/")) return next(err);
  res.status(err?.status ?? 400).json({ error: err?.type === "entity.too.large" ? `Files must be under ${MAX_FILE_BYTES >> 20} MB.` : "Upload failed." });
});
app.use(express.static(path.join(ROOT, "public"), { index: "index.html", extensions: ["html"] }));

const server = http.createServer(app);
const wss = new WebSocketServer({
  noServer: true, maxPayload: 1 << 20,
  // Browser-supported compression cuts history and tool traffic on remote/mobile links.
  // Independent messages bound memory and avoid retaining prior message dictionaries.
  perMessageDeflate: { serverNoContextTakeover: true, clientNoContextTakeover: true, concurrencyLimit: 2, threshold: 1024, zlibDeflateOptions: { level: 3 } },
});

server.on("upgrade", (req, socket, head) => {
  const okAuth = authed(req);
  // block cross-site websocket hijacking: Origin host must match the Host header
  let okOrigin = false;
  try {
    okOrigin = new URL(String(req.headers.origin)).host === req.headers.host;
  } catch {}
  if (req.url !== "/ws" || !okAuth || !okOrigin) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    return void socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
});

function safeCwd(p: unknown): string {
  if (typeof p !== "string") throw new Error("Invalid directory.");
  const r = path.resolve(p);
  if (r !== HOME && !r.startsWith(HOME + path.sep)) throw new Error("Directory must be inside your home folder.");
  if (!fs.statSync(r, { throwIfNoEntry: false })?.isDirectory()) throw new Error("Directory does not exist.");
  return r;
}

function dirs(): string[] {
  const out = [REPOS];
  try {
    for (const e of fs.readdirSync(REPOS, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith(".")) out.push(path.join(REPOS, e.name));
    }
  } catch {}
  return out;
}

// Client message ids already handled: a message resent after a reconnect (its ack was lost) is acknowledged, not run twice.
const seenCids = new Map<string, number>();
const firstDelivery = (cid: string) => {
  if (seenCids.has(cid)) return false;
  seenCids.set(cid, Date.now());
  if (seenCids.size > 2000) seenCids.delete(seenCids.keys().next().value!);
  return true;
};

wss.on("connection", (ws) => {
  clients.add(ws);
  void refreshRouterUsage(); // quota refresh only on demand; no idle network polling
  const reply = (m: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
  reply({ t: "hello", build: BUILD, features: { acks: true, queueEditing: true, questions: true, latency: !!latency, selectiveEvents: true }, questions: threads.getQuestions(), usage: usage.all(), commands: threads.getCommands(), threads: threads.list(), queues: threads.getQueues(), dirs: dirs(), providers: providerInfo() });
  let metricsWindow = Date.now(), metricsCount = 0;
  // A socket that misses a whole ping interval is dead (phone slept, network changed): drop it so its client reconnects cleanly.
  let isAlive = true;
  ws.on("pong", () => (isAlive = true));
  const ping = setInterval(() => {
    if (!isAlive) return void ws.terminate();
    isAlive = false;
    if (ws.readyState === ws.OPEN) ws.ping();
  }, Number(process.env.AGENT_CONSOLE_WS_PING_MS) || 25_000);
  ws.on("close", () => {
    clearInterval(ping);
    clients.delete(ws);
  });
  ws.on("message", (raw) => {
    isAlive = true;
    let m: any;
    try {
      m = JSON.parse(String(raw));
      switch (m.t) {
        case "ping": return reply({ t: "pong" });
        case "telemetry": {
          if (Date.now() - metricsWindow > 60_000) { metricsWindow = Date.now(); metricsCount = 0; }
          if (!Array.isArray(m.samples) || m.samples.length > 20 || (metricsCount += m.samples.length) > 200) return;
          try { latency?.record(m.samples, id => threads.get(id)); } catch { console.warn("Local latency sample write failed."); }
          return;
        }
        case "refresh_usage": void refreshUsage(); return;
        case "answer": {
          try {
            threads.answer(m.thread, m.id, m.answers, m.skip === true);
            return reply({ t: "answer_done", thread: m.thread, id: m.id, request: m.request });
          } catch (e: any) {
            return reply({ t: "answer_error", thread: m.thread, id: m.id, request: m.request, message: e?.message || "Could not send your answer." });
          }
        }
        case "queue_edit":
        case "queue_save":
        case "queue_cancel_edit": {
          try {
            if (m.t === "queue_edit") return reply({ t: "queue_edit", request: m.request, thread: m.thread, ...threads.editQueued(m.thread, m.id) });
            if (m.t === "queue_save") threads.saveQueued(m.thread, m.id, m.revision, m.text);
            else threads.cancelQueuedEdit(m.thread, m.id, m.revision);
            return reply({ t: "queue_edit_done", request: m.request, thread: m.thread, id: m.id });
          } catch (e: any) { return reply({ t: "queue_edit_error", request: m.request, message: e?.message || "Could not update this queued message." }); }
        }
        case "subscribe":
          if (threads.get(m.thread)) subscriptions.set(ws, m.thread);
          return;
        case "open":
          if (m.foregroundOnly === true && threads.get(m.thread)) subscriptions.set(ws, m.thread);
          return reply({ t: "history", thread: m.thread, request: m.request, before: Number.isInteger(m.before) ? m.before : null, ...threads.page(m.thread, Number.isInteger(m.before) ? m.before : undefined, Number.isInteger(m.since) && m.since >= 0 ? m.since : undefined, m.small === true) });
        case "create": {
          const t = threads.create({ provider: m.provider, cwd: safeCwd(m.cwd), mode: m.mode, model: m.model, effort: m.effort, title: m.title });
          return reply({ t: "created", thread: t });
        }
        case "send":
          if (typeof m.cid === "string" && !firstDelivery(m.cid)) return reply({ t: "ack", cid: m.cid });
          if (typeof m.text === "string" && (m.text.trim() || (Array.isArray(m.attachments) && m.attachments.length))) {
            threads.send(m.thread, m.text.slice(0, 100_000), { attachments: m.attachments, mode: m.mode === "steer" ? "steer" : "queue" });
          }
          return typeof m.cid === "string" && reply({ t: "ack", cid: m.cid });
        case "steer_queued":
          return threads.steerQueued(m.thread, m.id);
        case "compact":
          return threads.compact(m.thread);
        case "unqueue":
          return threads.unqueue(m.thread, String(m.id));
        case "fork":
          return reply({ t: "created", thread: threads.fork(m.thread, typeof m.provider === "string" ? m.provider : undefined, m.context === "recent") });
        case "abort":
          if (typeof m.cid === "string" && !firstDelivery(m.cid)) return reply({ t: "ack", cid: m.cid });
          threads.abort(m.thread);
          return typeof m.cid === "string" && reply({ t: "ack", cid: m.cid });
        case "warm":
          if (typeof m.thread === "string") threads.warm(m.thread);
          return;
        case "update": {
          return threads.update(m.thread, {
            mode: typeof m.mode === "string" ? m.mode : undefined,
            model: typeof m.model === "string" ? m.model : undefined,
            effort: typeof m.effort === "string" ? m.effort : undefined,
            advisor: typeof m.advisor === "string" ? m.advisor : undefined,
            idleCompaction: typeof m.idleCompaction === "boolean" ? m.idleCompaction : undefined,
            title: typeof m.title === "string" ? m.title : undefined,
          });
        }
        case "archive":
          return threads.archive(m.thread, m.archived !== false);
        case "delete":
          return threads.remove(m.thread);
      }
    } catch (e: any) {
      reply({ t: "error", message: e?.message ?? String(e), ...(typeof m?.cid === "string" ? { cid: m.cid } : {}) });
    }
  });
});

void refreshPiModels();
await headroom.start();

if (acodeSettings) {
  const bridgeServer = acodePublicApp(acode, ROOT).listen(acodeSettings.port, HOST);
  bridgeServer.on("error", () => { console.error("Acode bridge could not listen on its configured port."); process.exit(1); });
}

server.listen(PORT, HOST, () => {
  if (PID_FILE) fs.writeFileSync(PID_FILE, String(process.pid)); // only the process that holds the port may claim it
  console.log(`agent-console listening on http://${HOST}:${PORT}`);
  console.log(CODER_HOSTS.length ? `auth: Coder SSO for ${CODER_HOSTS.join(", ")} (password cookie still works elsewhere)` : "auth: password only");
  if (process.env.AGENT_CONSOLE_SHOW_PASSWORD) console.log(`password: ${PASSWORD}`);
});

// A hash of the code this process loaded. Open tabs compare it on reconnect and reload themselves when the server was replaced
// (`bin/agent-console restart-when-idle` -> scripts/idle-restart.mjs).
const sources = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === "fonts" || e.name === "node_modules" ? [] : e.isDirectory() ? sources(path.join(dir, e.name)) : [path.join(dir, e.name)]));
function buildId() {
  const h = crypto.createHash("sha1");
  for (const f of [...sources(path.join(ROOT, "server")), ...sources(path.join(ROOT, "public"))].sort()) { const st = fs.statSync(f); h.update(`${f}:${st.mtimeMs}:${st.size}`); }
  return h.digest("hex").slice(0, 12);
}
const BUILD = buildId();

let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    threads.shutdown();
    await headroom.stop();
    latency?.close();
    process.exit(0);
  });
}

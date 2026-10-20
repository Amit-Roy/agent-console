import { acquireModelRequest, reportModel429, startModelRateBroker } from "./providers/model-rate-client.ts";
import { MODEL_REQUEST_PRIORITIES } from "./providers/model-rate-limit.ts";
import "./privacy.ts";
import { usage, refreshRouterUsage, refreshUsage, readCodexUsage } from "./usage.ts";
import { hostMetrics, hostProcesses, hostKill, hostPorts, hostProcessDetail } from "./host.ts";
import { startHostSampler, hostHistory, hostDu, hostDuRescan } from "./host-history.ts";
import { createDispatcher, startIssue, defaultDirs } from "./window-dispatch.ts";
import { route as routeWork } from "./automation/router.ts";
import { createOpener } from "./window-opener.ts";
import { claudeAccounts } from "./providers/claude-accounts.ts";
import { cancelClaudeLogin, finishClaudeLogin, startClaudeLogin } from "./claude-login.ts";
import { createReviewer } from "./issue-review.ts";
import { createEventLog } from "./automation/events.ts";
import { createTriageBridge } from "./automation/triage-bridge.ts";
import { usageEvents } from "./automation/usage-events.ts";
import { automationApi, scanHooks } from "./automation/snapshot.ts";
import { startDebug } from "./automation/debug.ts";
import { loadConfig as loadDispatchConfig } from "./window-dispatch.ts";
import { loadOpenerConfig } from "./window-opener.ts";
import express from "express";
import fs from "node:fs";
import crypto from "node:crypto";
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { authed, CODER_HOSTS, cookieFrom, limited, makeToken, passwordOk, PASSWORD, recordFail, setCookie, tokenValid } from "./auth.ts";
import { providerInfo, refreshPiModels } from "./providers/index.ts";
import { threadToMarkdown } from "./export.ts";
import { Threads, turnTiming } from "./threads.ts";
import { createTelemetryService } from "./token-telemetry.ts";
import { Schedules, describe } from "./schedules.ts";
import { SessionSearch } from "./session-search.ts";
import { Notifications } from "./notifications.ts";
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
let notifications: Notifications | undefined;
try { notifications = new Notifications(DATA_DIR); }
catch { console.warn("Browser notification storage is unavailable."); }
const threads = new Threads(broadcast, notice => {
  void notifications?.notify(notice).catch(() => console.warn("Browser notification delivery failed."));
});
const schedules = new Schedules(threads, broadcast);
const sessionSearch = new SessionSearch(DATA_DIR);
// Agent tools (Pi extension providers/console-tools.mjs) call back over loopback with a per-process secret, never the session cookie
const TOOL_TOKEN = crypto.randomBytes(24).toString("base64url");
process.env.AGENT_CONSOLE_TOOL_URL = `http://${HOST}:${PORT}/api/agent-tools`;
process.env.AGENT_CONSOLE_TOOL_TOKEN = TOOL_TOKEN;
const acode = createAcodeBridge(id => threads.get(id));
const acodeSettings = acodeConfig();
let latency: LatencyStore | undefined;
try { latency = new LatencyStore(path.join(DATA_DIR, "latency.sqlite")); }
catch { console.warn("Local latency storage is unavailable."); }
setInterval(() => threads.sweep(), 60_000).unref();
// Every automation stage writes here; the dashboard reads it. A previous process's unfinished runs are closed as abandoned.
const automationLog = createEventLog({ file: path.join(DATA_DIR, "automation-events.jsonl") });
automationLog.recoverOpenRuns();
const recordUsage = usageEvents(automationLog);
usage.subscribe((provider, u) => { broadcast({ t: "usage", provider, usage: u }); recordUsage(provider, u); });
const triageBridge = createTriageBridge({ dbPath: path.join(DATA_DIR, "github-triage.sqlite"), events: automationLog });
setInterval(() => triageBridge.poll(), 30_000).unref();
const automation = automationApi({
  log: automationLog,
  config: () => ({ dispatch: loadDispatchConfig(), opener: loadOpenerConfig() }),
  hooks: () => scanHooks(defaultDirs().worktrees),
  runs: () => threads.list().filter(t => t.issueRun && !t.archived).map(t => ({ thread: t.id, key: t.issueRun!.key, role: t.issueRun!.role, effort: t.issueRun!.effort, state: t.status, title: t.title })),
  schedules: () => schedules.list().map(t => ({ id: t.id, title: t.title, schedule: describe(t), enabled: t.enabled })),
});
// One upserted token-usage comment per GitHub issue/PR the finished thread links to (repos = the triage allowlist).
if (process.env.AGENT_CONSOLE_MOCK !== "1") {
  const triageRepos = (): string[] => {
    try { const r = JSON.parse(fs.readFileSync(process.env.AGENT_CONSOLE_TRIAGE_CONFIG || path.join(os.homedir(), ".config/agent-console/github-triage.json"), "utf8")).repos; return Array.isArray(r) ? r : []; } catch { return []; }
  };
  const telemetry = createTelemetryService({ repos: triageRepos, dataDir: DATA_DIR, threads: () => threads.list() as any,
    log: (event, fields) => console.warn(JSON.stringify({ event, ...fields })) });
  threads.onTurnDone = t => { void telemetry.threadTurnEnded(t as any); };
}
// Plan-only until ~/.config/agent-console/window-dispatch.json sets enabled (see docs/window-dispatch.md).
if (process.env.AGENT_CONSOLE_MOCK !== "1") {
  const activeRuns = () => threads.list().filter(t => t.issueRun && t.status === "running").map(t => ({ provider: t.provider, role: t.issueRun!.role }));
  const dispatcher = createDispatcher({
    usage: () => usage.all(), events: automationLog,
    active: () => activeRuns(),
    start: d => startIssue(d, { create: o => threads.create(o), send: (id, text) => threads.send(id, text) }),
  });
  const reviewer = createReviewer({
    canResume: t => {
      const live = threads.get(t.id);
      if (!live || live.archived || live.status === "running") return false;
      const cfg = loadDispatchConfig();
      if (!cfg.enabled || cfg.dryRun || cfg.routing.mode !== "live") return false;
      const answer = routeWork({ role: "work", effort: t.issueRun!.effort as any, usage: usage.all(), active: activeRuns(), now: Date.now(), flags: { bauOnPi: cfg.routing.bauOnPi } });
      return answer.decision === "route" && answer.route?.provider === t.provider;
    },
    runner: { create: o => threads.create(o), send: (id, text) => threads.send(id, text), mark: (id, patch) => threads.setIssueRun(id, patch) },
    route: effort => routeWork({ role: "review", effort: effort as any, usage: usage.all(), active: activeRuns(), now: Date.now() }),
    events: automationLog,
  });
  threads.onIssueTurnEnd = (t, ev) => reviewer.turnEnded(t, ev);
  setInterval(() => { dispatcher.tick().catch(() => {}); reviewer.sweep(threads.list()).catch(() => {}); }, 5 * 60_000).unref();
  const opener = createOpener({
    usage: () => usage.all(), events: automationLog,
    refresh: readCodexUsage,
    claudeAccounts: () => claudeAccounts().filter(a => a.ready).map(a => a.id),
    open: (provider, route, account) => {
      const t = threads.create({ provider, ...route, ...(account ? { claudeAccount: account } : {}), cwd: path.join(os.homedir(), "repos"), mode: "bypassPermissions", title: `Window opener · ${provider}${account ? ":" + account : ""}` });
      threads.send(t.id, "Reply with the single word: ok");
      threads.archive(t.id, true);
    },
  });
  setInterval(() => { opener.tick().catch(() => {}); }, 5 * 60_000).unref();
}

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

// Loopback broker for the single model queue. Pi, the triage worker and the label helpers all admit through here.
const MODEL_RATE_TOKEN_HEADER = "x-agent-console-tool";
app.post("/api/model-request", express.json({ limit: "4kb" }), async (req, res) => {
  const given = Buffer.from(String(req.headers[MODEL_RATE_TOKEN_HEADER] || ""));
  const expected = Buffer.from(String(process.env.AGENT_CONSOLE_RATE_TOKEN || ""));
  if (!expected.length || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return void res.status(401).json({ error: "Not an Agent Console model request." });
  const provider = req.body?.provider === "nvidia" || req.body?.provider === "openrouter" ? req.body.provider : "other";
  const priority = typeof req.body?.priority === "string" && req.body.priority in MODEL_REQUEST_PRIORITIES ? req.body.priority : "interactive";
  const abort = new AbortController();
  const disconnected = () => abort.abort();
  res.once("close", disconnected);
  try {
    if (req.body?.action === "acquire") await acquireModelRequest({ provider, priority, signal: abort.signal });
    else if (req.body?.action === "cooldown") await reportModel429(typeof req.body.retryAfter === "string" || typeof req.body.retryAfter === "number" ? req.body.retryAfter : null, provider);
    else return void res.status(400).json({ error: "Unknown model admission action." });
    if (!res.destroyed) res.json({ ok: true });
  } catch (error: any) {
    const message = error?.code === "MODEL_PROVIDER_QUOTA_EXHAUSTED" ? error.message : "Model admission unavailable.";
    if (!res.destroyed) res.status(503).json({ error: message, message, code: error?.code, retryAt: error?.retryAt, provider: error?.provider });
  } finally { res.removeListener("close", disconnected); }
});

app.post("/api/agent-tools/:name", express.json({ limit: "1mb" }), async (req, res) => {
  const given = Buffer.from(String(req.headers["x-agent-console-tool"] || ""));
  if (given.length !== TOOL_TOKEN.length || !crypto.timingSafeEqual(given, Buffer.from(TOOL_TOKEN))) return void res.status(401).json({ error: "Not an Agent Console tool call." });
  const thread = typeof req.headers["x-agent-console-thread"] === "string" ? req.headers["x-agent-console-thread"] : undefined;
  try {
    if (thread && threads.get(thread)?.issueRun && !["session_search", "session_read"].includes(req.params.name)) {
      throw new Error("Unattended issue runs may only use read-only session tools.");
    }
    const input = req.body ?? {};
    const result = req.params.name === "session_search" ? await sessionSearch.search(input)
      : req.params.name === "session_read" ? await sessionSearch.read(input)
      : schedules.tool(req.params.name, thread, input);
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  }
  catch (e: any) { res.status(400).json({ error: e?.message || String(e) }); }
});

// everything below requires the session cookie
app.use((req, res, next) => {
  if (authed(req)) return next();
  if (req.method === "GET" && String(req.headers.accept || "").includes("text/html")) return res.redirect("/login");
  res.status(401).end();
});
// Session transcripts stay behind the same authentication as the conversations.
app.get("/api/sessions/search", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try { res.json(await sessionSearch.search({ query: req.query.q, provider: req.query.provider, limit: req.query.limit === undefined ? undefined : Number(req.query.limit) } as any)); }
  catch (e: any) { res.status(400).json({ error: e?.message || "Search failed." }); }
});
app.get("/api/sessions/prs", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try { res.json(await sessionSearch.prs({ thread: req.query.thread as any, ref: req.query.ref as any })); }
  catch (e: any) { res.status(400).json({ error: e?.message || "PR lookup failed." }); }
});
app.get("/api/sessions/:thread", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try { res.json(await sessionSearch.read({ thread: req.params.thread, start: req.query.start === undefined ? undefined : Number(req.query.start), limit: req.query.limit === undefined ? undefined : Number(req.query.limit) } as any)); }
  catch (e: any) { res.status(400).json({ error: e?.message || "Session unavailable." }); }
});
app.get("/sessions", (_req, res) => res.sendFile(path.join(ROOT, "public", "sessions.html")));
app.get("/vendor/marked.js", (_req, res) => res.sendFile(path.join(ROOT, "node_modules/marked/lib/marked.esm.js")));
app.get("/vendor/purify.js", (_req, res) => res.sendFile(path.join(ROOT, "node_modules/dompurify/dist/purify.es.mjs")));

// ---- attachments: upload (raw bytes), download, discard. State-changing, so cookie auth alone is not enough: same-origin only.
const sameOrigin: express.RequestHandler = (req, res, next) => {
  try {
    if (new URL(String(req.headers.origin)).host === req.headers.host) return next();
  } catch {}
  res.status(403).json({ error: "Cross-site request refused." });
};
// Browser push is opt-in per device. Both writes require a same-origin session.
app.get("/api/notifications", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ enabled: !!notifications, publicKey: notifications?.publicKey });
});
app.post("/api/notifications/subscriptions", sameOrigin, express.json({ limit: "8kb" }), (req, res) => {
  if (!notifications) return void res.status(503).json({ error: "Notifications are unavailable." });
  try {
    notifications.subscribe(req.body, String(req.headers.origin));
    res.json({ ok: true });
  } catch (error: any) { res.status(400).json({ error: error.message }); }
});
app.delete("/api/notifications/subscriptions", sameOrigin, express.json({ limit: "8kb" }), (req, res) => {
  if (!notifications) return void res.status(503).json({ error: "Notifications are unavailable." });
  if (typeof req.body?.endpoint !== "string") return void res.status(400).json({ error: "Missing subscription endpoint." });
  try {
    notifications.unsubscribe(req.body.endpoint, String(req.headers.origin));
    res.json({ ok: true });
  } catch { res.status(503).json({ error: "Could not save notification settings." }); }
});
// Restart button: the same detached watcher as `bin/agent-console restart-when-idle` (waits for running turns, then replaces this process).
const RUN_DIR = process.env.AGENT_CONSOLE_RUN || path.join(os.homedir(), ".cache", "agent-console");
// Set by bin/agent-console for the server it starts. Removed from our env so agents and the scratch servers their tests start
// (which inherit everything else) can never overwrite the live server's pid file.
const PID_FILE = process.env.AGENT_CONSOLE_PID_FILE;
delete process.env.AGENT_CONSOLE_PID_FILE;
delete process.env.NODE_COMPILE_CACHE; // the launcher caches compiled server code; agents this server spawns must not share it
// In-app Claude sign-in: start returns Anthropic's link, finish takes the code its page shows.
app.post("/api/claude-login/:account", sameOrigin, express.json({ limit: "4kb" }), async (req, res) => {
  try {
    const { account } = req.params;
    if (req.body?.cancel) { cancelClaudeLogin(account); return res.json({ ok: true }); }
    if (req.body?.code === undefined) return res.json(await startClaudeLogin(account));
    await finishClaudeLogin(account, req.body.code);
    res.json({ ok: true, providers: providerInfo() });
  } catch (e: any) { res.status(400).json({ error: e?.message || "Sign-in failed." }); }
});
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
app.get("/api/automation", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try { res.json(automation.snapshot({ v: req.query.v ? Number(req.query.v) : undefined, limit: Number(req.query.limit) || undefined })); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
if (process.env.AGENT_CONSOLE_MOCK === "1") { // UI tests add events after start-up; never exists on a real server
  app.post("/api/automation/_mock/event", express.json(), (req, res) => { try { res.json(automationLog.record(req.body)); } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); } });
}
app.post("/api/automation/debug", sameOrigin, express.json({ limit: "4kb" }), (req, res) => {
  try {
    const mock = process.env.AGENT_CONSOLE_MOCK === "1"; // the mock server has no real agents: debug runs on the mock provider
    const out = startDebug({ v: req.body?.v, focus: req.body?.focus, note: req.body?.note }, {
      api: automation, log: automationLog, usage: () => usage.all(), dirs: defaultDirs(),
      active: () => threads.list().filter(t => t.issueRun && t.status === "running").map(t => ({ provider: t.provider, role: t.issueRun!.role })),
      runner: { create: o => threads.create(mock ? { ...o, provider: "mock", model: "echo", effort: "default" } : o), send: (id, text) => threads.send(id, text) },
    });
    res.json(out);
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
app.get("/api/automation/log", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try { res.json(automation.log({ v: req.query.v ? Number(req.query.v) : undefined, step: String(req.query.step) as any, limit: Number(req.query.limit) || undefined, before: req.query.before ? Number(req.query.before) : undefined })); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
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
app.get("/api/host/metrics", hostMetrics);
app.get("/api/host/processes", hostProcesses);
app.get("/api/host/processes/:pid/detail", hostProcessDetail);
app.get("/api/host/ports", hostPorts);
app.get("/api/host/history", hostHistory);
app.get("/api/host/du", hostDu);
app.post("/api/host/du/rescan", sameOrigin, hostDuRescan);
app.post("/api/host/processes/:pid/kill", express.json({ limit: "1kb" }), sameOrigin, hostKill);
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
  reply({ t: "hello", build: BUILD, features: { piRateLimit: 1, autoIsolation: 1, acks: true, queueEditing: true, questions: true, latency: !!latency, selectiveEvents: true }, questions: threads.getQuestions(), tasks: schedules.list(), usage: usage.all(), commands: threads.getCommands(), threads: threads.list(), queues: threads.getQueues(), dirs: dirs(), providers: providerInfo() });
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
          const t = threads.create({ provider: m.provider, claudeAccount: typeof m.claudeAccount === "string" ? m.claudeAccount : undefined, cwd: safeCwd(m.cwd), mode: m.mode, model: m.model, effort: m.effort, title: m.title });
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
          return reply({ t: "created", thread: threads.fork(m.thread, typeof m.provider === "string" ? m.provider : undefined, m.context === "recent", {
            ...Object.fromEntries(["model", "effort", "mode", "claudeAccount"].filter(k => typeof m[k] === "string").map(k => [k, m[k]])),
          }) });
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
            claudeAccount: typeof m.claudeAccount === "string" ? m.claudeAccount : undefined,
            advisor: typeof m.advisor === "string" ? m.advisor : undefined,
            idleCompaction: typeof m.idleCompaction === "boolean" ? m.idleCompaction : undefined,
            title: typeof m.title === "string" ? m.title : undefined,
          });
        }
        case "task_save": {
          const input = { title: m.title, prompt: m.prompt, provider: m.provider, model: m.model, effort: m.effort, mode: m.mode, cwd: m.cwd === undefined ? undefined : safeCwd(m.cwd), repeat: m.repeat, time: m.time, day: m.day, tz: m.tz, enabled: typeof m.enabled === "boolean" ? m.enabled : undefined, saveOutput: typeof m.saveOutput === "boolean" ? m.saveOutput : undefined };
          const task = typeof m.id === "string" ? schedules.update(m.id, input) : schedules.create(input);
          return reply({ t: "task_saved", request: m.request, task });
        }
        case "task_delete":
          return schedules.remove(String(m.id));
        case "task_run": {
          const run = schedules.run(String(m.id), "manual");
          if (run.status === "skipped") return reply({ t: "error", message: run.reason });
          if (run.status === "failed") return reply({ t: "error", message: run.reason });
          return run.thread && reply({ t: "created", thread: threads.get(run.thread) });
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

if (acodeSettings) {
  const bridgeServer = acodePublicApp(acode, ROOT).listen(acodeSettings.port, HOST);
  // a scratch server reads the same env file as the live one: exiting here made agents hunt down the port's owner, the live server
  bridgeServer.on("error", () => console.error(`Acode bridge port ${acodeSettings.port} is in use (normally by the live server); Acode Edit is off in this one.`));
}

server.listen(PORT, HOST, () => {
  if (PID_FILE) fs.writeFileSync(PID_FILE, String(process.pid)); // only the process that holds the port may claim it
  startModelRateBroker(PORT); // same rule: a scratch server that lost the port must not repoint the live broker
  startHostSampler(); // 5 s host samples for the Host page's history charts
  console.log(`agent-console listening on http://${HOST}:${PORT}`);
  console.log(CODER_HOSTS.length ? `auth: Coder SSO for ${CODER_HOSTS.join(", ")} (password cookie still works elsewhere)` : "auth: password only");
  if (process.env.AGENT_CONSOLE_SHOW_PASSWORD) console.log(`password: ${PASSWORD}`);
  void refreshPiModels(); // `pi --list-models` takes seconds; spawn it once the port is taken
  // Boot work nothing waits on runs once the first page has had its turn on the event loop.
  setTimeout(() => {
    // Never wait for the proxy: a cold Headroom launch takes up to 10 s, and turns go direct until it is healthy.
    void headroom.start().catch(() => console.warn("Headroom proxy failed to start."));
    threads.restoreTelemetry();
    threads.warmAccounting();
    void sessionSearch.warm().catch(() => console.warn("Session search index will retry on the next query."));
  }, 1000).unref();
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
    // Node cannot tell who sent the signal; the sender is usually among the newest processes, so log those
    let newest = "";
    try { newest = execFileSync("ps", ["-eo", "pid,ppid,etime,args", "--sort=-start_time"], { encoding: "utf8" }).split("\n").slice(0, 16).map(l => l.slice(0, 240)).join("\n"); } catch {}
    console.log(`[${new Date().toISOString()}] stopping on ${sig}; newest processes:\n${newest}`);
    schedules.shutdown();
    threads.shutdown();
    await headroom.stop();
    latency?.close();
    process.exit(0);
  });
}

import express from "express";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { cookieFrom, limited, makeToken, passwordOk, PASSWORD, recordFail, setCookie, tokenValid } from "./auth.ts";
import { MODELS, MODES, Threads, type Mode } from "./threads.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 7070);
const HOST = "127.0.0.1"; // never listen publicly; Coder's port proxy is the only way in
const HOME = os.homedir();
const REPOS = path.join(HOME, "repos");

const clients = new Set<WebSocket>();
const broadcast = (msg: unknown) => {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === c.OPEN) c.send(s);
};
const threads = new Threads(broadcast);
setInterval(() => threads.sweep(), 60_000).unref();

const app = express();
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self' wss: ws:; frame-ancestors 'none'",
  );
  next();
});

app.get("/login", (_req, res) => res.sendFile(path.join(ROOT, "public", "login.html")));
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
app.get("/icon.svg", (_req, res) => res.sendFile(path.join(ROOT, "public", "icon.svg")));
app.get("/manifest.webmanifest", (_req, res) => res.sendFile(path.join(ROOT, "public", "manifest.webmanifest")));

// everything below requires the session cookie
app.use((req, res, next) => {
  if (tokenValid(cookieFrom(req.headers.cookie))) return next();
  if (req.method === "GET" && String(req.headers.accept || "").includes("text/html")) return res.redirect("/login");
  res.status(401).end();
});
app.get("/vendor/marked.js", (_req, res) => res.sendFile(path.join(ROOT, "node_modules/marked/lib/marked.esm.js")));
app.get("/vendor/purify.js", (_req, res) => res.sendFile(path.join(ROOT, "node_modules/dompurify/dist/purify.es.mjs")));
app.use(express.static(path.join(ROOT, "public"), { index: "index.html", extensions: ["html"] }));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

server.on("upgrade", (req, socket, head) => {
  const okAuth = tokenValid(cookieFrom(req.headers.cookie));
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

wss.on("connection", (ws) => {
  clients.add(ws);
  const reply = (m: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
  reply({ t: "hello", threads: threads.list(), dirs: dirs(), modes: MODES, models: MODELS });
  const ping = setInterval(() => ws.readyState === ws.OPEN && ws.ping(), 25_000);
  ws.on("close", () => {
    clearInterval(ping);
    clients.delete(ws);
  });
  ws.on("message", (raw) => {
    try {
      const m = JSON.parse(String(raw));
      switch (m.t) {
        case "open":
          return reply({ t: "history", thread: m.thread, events: threads.history(m.thread) });
        case "create": {
          const mode: Mode = MODES.includes(m.mode) ? m.mode : "acceptEdits";
          const model = MODELS.includes(m.model) ? m.model : "sonnet";
          const t = threads.create({ cwd: safeCwd(m.cwd), mode, model, title: m.title });
          return reply({ t: "created", thread: t });
        }
        case "send":
          if (typeof m.text !== "string" || !m.text.trim()) return;
          return threads.send(m.thread, m.text.slice(0, 100_000));
        case "abort":
          return threads.abort(m.thread);
        case "update": {
          const patch: { mode?: Mode; model?: string; title?: string } = {};
          if (MODES.includes(m.mode)) patch.mode = m.mode;
          if (MODELS.includes(m.model)) patch.model = m.model;
          if (typeof m.title === "string") patch.title = m.title;
          return threads.update(m.thread, patch);
        }
        case "delete":
          return threads.remove(m.thread);
      }
    } catch (e: any) {
      reply({ t: "error", message: e?.message ?? String(e) });
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`agent-console listening on http://${HOST}:${PORT}`);
  if (process.env.AGENT_CONSOLE_SHOW_PASSWORD) console.log(`password: ${PASSWORD}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    threads.shutdown();
    process.exit(0);
  });
}

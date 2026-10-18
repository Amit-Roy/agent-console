import express from "express";
import path from "node:path";
import type { RequestHandler } from "express";
import { fileEnv } from "./providers/env.ts";

/** A separate, capability-only port lets Acode connect without a Coder browser session. */
export function acodeConfig() {
  // Scratch servers inherit the live agent environment; never claim its public bridge port.
  if (process.env.AGENT_CONSOLE_MOCK === "1" && process.env.AGENT_CONSOLE_ACODE_TEST !== "1") return undefined;
  const env = fileEnv();
  const endpoint = process.env.AGENT_CONSOLE_ACODE_URL ?? env.AGENT_CONSOLE_ACODE_URL;
  if (!endpoint) return undefined;
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("AGENT_CONSOLE_ACODE_URL must be an HTTPS origin.");
  }
  const port = Number(process.env.AGENT_CONSOLE_ACODE_PORT ?? env.AGENT_CONSOLE_ACODE_PORT ?? 7076);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Choose a valid Acode bridge port.");
  return { endpoint: url.origin, port };
}

export function acodePublicApp(bridge: { exchange: RequestHandler; read: RequestHandler; save: RequestHandler }, root: string) {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const origin = req.headers.origin;
    // Cordova uses file:// or a local WebView origin. No browser session is accepted here.
    if (origin) {
      if (!["null", "file://", "https://localhost", "http://localhost", "http://localhost:8080"].includes(origin)) {
        return void res.status(403).json({ error: "This origin cannot use the Acode bridge." });
      }
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
    }
    if (req.method === "OPTIONS") return void res.status(204).end();
    next();
  });
  app.get("/acode-plugin.zip", (_req, res) => res.download(path.join(root, "public", "acode-plugin.zip"), "agent-console-acode.zip"));
  app.post("/api/acode/exchange", express.json({ limit: "2kb" }), bridge.exchange);
  app.get("/api/acode/file", bridge.read);
  app.put("/api/acode/file", express.json({ limit: "7mb" }), bridge.save);
  app.use((_req, res) => { res.status(404).json({ error: "Not found." }); });
  app.use(((err, _req, res, _next) => {
    res.status(err.status === 413 ? 413 : 400).json({ error: err.status === 413 ? "The file is too large to edit." : "Invalid bridge request." });
  }) as express.ErrorRequestHandler);
  return app;
}

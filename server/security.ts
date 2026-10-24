import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type express from "express";
import { createSecAutomations, type SecAutomations, statusKeyFile } from "./sec-automations.ts";
import { createSecCrashes, type SecCrashes } from "./sec-crashes.ts";
import { createToolWatch, RemoteError, type ToolWatch } from "./tool-watch.ts";

// Security scans run on the VPS host (clamav, falco, trivy, nmap). This workspace only reads their
// results over SSH with a forced-command key: the remote side accepts latest | history | get <id> | status | run [quick|full].
const LATEST_TTL = 30_000;
const SSH_TIMEOUT = 20_000;
const ID = /^[0-9A-Za-z_-]{6,40}$/;
const MODES = new Set(["quick", "full"]);
const SCAN_ID = /^[0-9]{8}T[0-9]{6}Z$/;

const target = () => process.env.SECSCAN_SSH_TARGET || "root@206.51.227.101";
const keyFile = () => process.env.SECSCAN_SSH_KEY || path.join(os.homedir(), ".ssh", "id_secscan");
const sshBin = () => process.env.SECSCAN_SSH_BIN || "ssh";

class SshError extends Error {}
class NotFound extends Error {}

/* One forced-command call. Resolves with parsed JSON; rejects with a short human message. */
export function remote(cmd: string, key: string = keyFile()): Promise<any> {
  const args = [
    "-i",
    key,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=5",
    target(),
    cmd,
  ];
  return new Promise((resolve, reject) => {
    execFile(
      sshBin(),
      args,
      { timeout: SSH_TIMEOUT, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        let parsed: any;
        try {
          parsed = JSON.parse(stdout);
        } catch {}
        // The remote exits non-zero with a JSON {"error"} body for unknown ids; pass that through so callers can 404.
        if (err && !parsed?.error)
          return reject(
            new SshError(
              (err as any).killed
                ? "The scan host did not answer in time."
                : "Could not reach the scan host over SSH.",
            ),
          );
        if (parsed === undefined)
          return reject(new SshError("The scan host sent an unreadable answer."));
        resolve(parsed);
      },
    );
  });
}

let latestCache: { at: number; value: any } | null = null;
let latestPending: Promise<any> | null = null;

async function latest() {
  if (latestCache && Date.now() - latestCache.at < LATEST_TTL) return latestCache.value;
  latestPending ||= remote("latest")
    .then((value) => {
      latestCache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      latestPending = null;
    });
  return latestPending;
}

export function resetSecurityCache() {
  latestCache = null;
  latestPending = null;
}

export function mountSecurity(
  app: express.Express,
  sameOrigin: express.RequestHandler,
  tools: ToolWatch = createToolWatch(),
  automations: SecAutomations = createSecAutomations({
    fetchStatus: () => remote("status", statusKeyFile()),
    bridge: () => tools.bridgeView(),
  }),
  crashes: SecCrashes = createSecCrashes({ fetch: () => remote("crashes", statusKeyFile()) }),
) {
  const guard =
    (fn: (req: express.Request) => Promise<any>): express.RequestHandler =>
    async (req, res) => {
      res.set("Cache-Control", "no-store");
      try {
        res.json(await fn(req));
      } catch (e: any) {
        res
          .status(
            e instanceof SshError || e instanceof RemoteError
              ? 502
              : e instanceof NotFound
                ? 404
                : 500,
          )
          .json({
            error:
              e instanceof SshError || e instanceof RemoteError
                ? e.message
                : e instanceof NotFound
                  ? "No such scan."
                  : "Security scan data is unavailable.",
          });
      }
    };
  app.get(
    "/api/security/latest",
    guard(async () => {
      const result = await latest();
      return {
        result: result && result.id ? result : null,
        cachedAt: latestCache?.at ?? Date.now(),
      };
    }),
  );
  app.get(
    "/api/security/history",
    guard(async () => ({ scans: await remote("history") })),
  );
  app.get(
    "/api/security/status",
    guard(() => remote("status")),
  );
  app.get("/api/security/scans/:id", async (req, res, next) => {
    if (!ID.test(req.params.id)) return void res.status(400).json({ error: "Invalid scan id." });
    return guard(async () => {
      const result = await remote(`get ${req.params.id}`);
      if (!result || !result.id) throw new NotFound("not found");
      return result;
    })(req, res, next);
  });
  app.get("/api/security/scans/:id/log", async (req, res, next) => {
    const after = req.query.after === undefined ? "0" : String(req.query.after);
    if (!SCAN_ID.test(req.params.id) || !/^[0-9]{1,9}$/.test(after))
      return void res.status(400).json({ error: "Invalid scan id or position." });
    return guard(async () => {
      const result = await remote(`log ${req.params.id} ${Number(after)}`);
      if (!result || result.error || !Array.isArray(result.lines)) throw new NotFound("not found");
      return result;
    })(req, res, next);
  });
  app.post(
    "/api/security/run",
    sameOrigin,
    (req, res, next) => {
      const mode = req.query.mode === undefined ? "full" : req.query.mode;
      if (typeof mode !== "string" || !MODES.has(mode))
        return void res.status(400).json({ error: "Invalid scan mode." });
      res.locals.mode = mode;
      next();
    },
    guard(async (req) => {
      const out = await remote(`run ${req.res?.locals.mode}`);
      resetSecurityCache();
      automations.invalidate();
      return out;
    }),
  );
  // Every security automation (VPS timers, OpenCVE, the patch bridge) with schedule, last and next run, colour. Cached 60 s.
  app.get(
    "/api/security/automations",
    guard(() => automations.view()),
  );
  // Process crashes of the last 24 h, re-validated and redacted again here. Cached 10 s, one shared request.
  app.get(
    "/api/security/crashes",
    guard(() =>
      crashes.view().catch((e: Error) => {
        throw new SshError(e.message); // the parser's messages are fixed or sanitised, so they are safe to show
      }),
    ),
  );
  // Tool-watch: fixed tool versions and unsanctioned changes from the VPS. Untrusted advisory text never leaves the server.
  app.get(
    "/api/security/tools",
    guard(() => tools.publicView()),
  );
  app.post(
    "/api/security/tools/run",
    sameOrigin,
    guard(async () => {
      const out = await tools.run();
      void tools.tick().catch(() => {});
      automations.invalidate();
      return out;
    }),
  );
}

import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import type express from "express";

// Security scans run on the VPS host (clamav, falco, trivy, nmap). This workspace only reads their
// results over SSH with a forced-command key: the remote side accepts latest | history | get <id> | status | run.
const LATEST_TTL = 30_000;
const SSH_TIMEOUT = 20_000;
const ID = /^[0-9A-Za-z_-]{6,40}$/;

const target = () => process.env.SECSCAN_SSH_TARGET || "root@206.51.227.101";
const keyFile = () => process.env.SECSCAN_SSH_KEY || path.join(os.homedir(), ".ssh", "id_secscan");
const sshBin = () => process.env.SECSCAN_SSH_BIN || "ssh";

class SshError extends Error {}
class NotFound extends Error {}

/* One forced-command call. Resolves with parsed JSON; rejects with a short human message. */
function remote(cmd: string): Promise<any> {
  const args = ["-i", keyFile(), "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=5", target(), cmd];
  return new Promise((resolve, reject) => {
    execFile(sshBin(), args, { timeout: SSH_TIMEOUT, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      let parsed: any;
      try { parsed = JSON.parse(stdout); } catch {}
      // The remote exits non-zero with a JSON {"error"} body for unknown ids; pass that through so callers can 404.
      if (err && !parsed?.error) return reject(new SshError((err as any).killed ? "The scan host did not answer in time." : "Could not reach the scan host over SSH."));
      if (parsed === undefined) return reject(new SshError("The scan host sent an unreadable answer."));
      resolve(parsed);
    });
  });
}

let latestCache: { at: number; value: any } | null = null;
let latestPending: Promise<any> | null = null;

async function latest() {
  if (latestCache && Date.now() - latestCache.at < LATEST_TTL) return latestCache.value;
  latestPending ||= remote("latest").then((value) => { latestCache = { at: Date.now(), value }; return value; }).finally(() => { latestPending = null; });
  return latestPending;
}

export function resetSecurityCache() { latestCache = null; latestPending = null; }

export function mountSecurity(app: express.Express, sameOrigin: express.RequestHandler) {
  const guard = (fn: (req: express.Request) => Promise<any>): express.RequestHandler => async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { res.json(await fn(req)); }
    catch (e: any) { res.status(e instanceof SshError ? 502 : e instanceof NotFound ? 404 : 500).json({ error: e instanceof SshError ? e.message : e instanceof NotFound ? "No such scan." : "Security scan data is unavailable." }); }
  };
  app.get("/api/security/latest", guard(async () => {
    const result = await latest();
    return { result: result && result.id ? result : null, cachedAt: latestCache?.at ?? Date.now() };
  }));
  app.get("/api/security/history", guard(async () => ({ scans: await remote("history") })));
  app.get("/api/security/status", guard(() => remote("status")));
  app.get("/api/security/scans/:id", async (req, res, next) => {
    if (!ID.test(req.params.id)) return void res.status(400).json({ error: "Invalid scan id." });
    return guard(async () => {
      const result = await remote(`get ${req.params.id}`);
      if (!result || !result.id) throw new NotFound("not found");
      return result;
    })(req, res, next);
  });
  app.post("/api/security/run", sameOrigin, guard(async () => {
    const out = await remote("run");
    resetSecurityCache();
    return out;
  }));
}

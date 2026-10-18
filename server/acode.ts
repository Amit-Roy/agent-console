import { constants, fstatSync, lstatSync, realpathSync, readSync, renameSync, unlinkSync } from "node:fs";
import { open, realpath, lstat } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import path from "node:path";
import type { RequestHandler } from "express";
import { MAX_VIEW_BYTES, ViewError, reachable, scopedPath, viewerScope, type Lookup } from "./files.ts";

const TICKET_MS = 60_000;
const SESSION_MS = 8 * 60 * 60_000;
const MAX_GRANTS = 1000;
const token = () => randomBytes(32).toString("base64url");
const revision = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type Grant = { cwd: string; requested: string; threadId?: string; target: string; candidate: string; dev: number; ino: number; expiresAt: number };

function textContent(bytes: Buffer) {
  if (bytes.length > MAX_VIEW_BYTES) throw new ViewError(413, "File exceeds the edit size limit.");
  let content: string;
  try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new ViewError(415, "Only UTF-8 text files can be edited."); }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content) || /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/.test(content)) throw new ViewError(403, "This file cannot be edited.");
  return content;
}

// Authentication and same-origin middleware must precede create. Parent middleware
// applies strict Cordova origin CORS to public routes. Public routes use
// single-file bearer grants and never derive authority from browser cookies.
export function createAcodeBridge(lookup: Lookup, now: () => number = Date.now) {
  const tickets = new Map<string, Grant>();
  const sessions = new Map<string, Grant>();
  const locks = new Map<string, Promise<unknown>>();
  function prune(map: Map<string, Grant>) {
    for (const [key, grant] of map) if (grant.expiresAt <= now()) map.delete(key);
    while (map.size >= MAX_GRANTS) map.delete(map.keys().next().value!);
  }
  function handler(fn: (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1]) => Promise<void>): RequestHandler {
    return async (req, res) => {
      try { res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff"); await fn(req, res); }
      catch (error) {
        const status = error instanceof ViewError ? error.status : ["ENOENT", "ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code || "") ? 409 : 403;
        res.status(status).json({ error: error instanceof ViewError ? error.message : "File is unavailable or has changed." });
      }
    };
  }
  async function checked(grant: Grant, write = false) {
    const resolved = await scopedPath(grant.cwd, grant.requested, grant.threadId);
    if (resolved.target !== grant.target || resolved.candidate !== grant.candidate || (await lstat(resolved.candidate)).isSymbolicLink()) throw new ViewError(409, "File path has changed. Reopen the file.");
    const handle = await open(grant.target, (write ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      const opened = await realpath(`/proc/self/fd/${handle.fd}`);
      if (opened !== grant.target || !reachable(resolved.root, opened) || !info.isFile() || info.dev !== grant.dev || info.ino !== grant.ino) throw new ViewError(409, "File has changed. Reopen the file.");
      if (info.size > MAX_VIEW_BYTES) throw new ViewError(413, "File exceeds the edit size limit.");
      const bytes = Buffer.alloc(MAX_VIEW_BYTES + 1);
      let size = 0;
      while (size < bytes.length) {
        const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      const data = bytes.subarray(0, size);
      const content = textContent(data);
      return { handle, content, revision: revision(data) };
    } catch (error) { await handle.close(); throw error; }
  }
  function session(req: Parameters<RequestHandler>[0]) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get("Authorization") || "");
    const grant = match ? sessions.get(match[1]) : undefined;
    if (!grant || grant.expiresAt <= now()) { if (match) sessions.delete(match[1]); throw new ViewError(401, "Edit session expired. Reopen the file."); }
    return grant;
  }
  const create = handler(async (req, res) => {
    const scope = viewerScope(req.query, lookup);
    if (typeof req.query.path !== "string" || !req.query.path || req.query.path.includes("\0")) throw new ViewError(400, "Choose a valid file path.");
    const resolved = await scopedPath(scope.cwd, req.query.path, scope.threadId);
    if ((await lstat(resolved.candidate)).isSymbolicLink()) throw new ViewError(403, "Open the original file to edit it.");
    const info = await lstat(resolved.target);
    const grant: Grant = { cwd: scope.cwd, requested: req.query.path, threadId: scope.threadId, ...resolved, dev: info.dev, ino: info.ino, expiresAt: now() + TICKET_MS };
    const file = await checked(grant); await file.handle.close();
    prune(tickets); const ticket = token(); tickets.set(ticket, grant);
    res.json({ ticket, expiresAt: grant.expiresAt, endpoint: res.locals.acodeEndpoint });
  });
  const exchange = handler(async (req, res) => {
    const ticket = typeof req.body?.ticket === "string" ? req.body.ticket : "";
    const grant = tickets.get(ticket); tickets.delete(ticket);
    if (!grant || grant.expiresAt <= now()) throw new ViewError(401, "Edit ticket expired. Reopen the file.");
    const file = await checked(grant); await file.handle.close();
    prune(sessions); const session = token(); const expiresAt = now() + SESSION_MS;
    sessions.set(session, { ...grant, expiresAt });
    res.json({ token: session, expiresAt, name: path.basename(grant.target), path: grant.target, content: file.content, revision: file.revision });
  });
  const read = handler(async (req, res) => {
    const grant = session(req); const file = await checked(grant);
    try { res.json({ name: path.basename(grant.target), path: grant.target, content: file.content, revision: file.revision }); }
    finally { await file.handle.close(); }
  });
  const save = handler(async (req, res) => {
    const grant = session(req);
    if (typeof req.body?.content !== "string" || !/^[a-f0-9]{64}$/.test(req.body?.revision || "")) throw new ViewError(400, "Content and revision are required.");
    const bytes = Buffer.from(req.body.content, "utf8");
    textContent(bytes);
    if (bytes.toString("utf8") !== req.body.content) throw new ViewError(415, "Only UTF-8 text can be saved.");
    const key = grant.target;
    const previous = locks.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      const file = await checked(grant);
      let directory: Awaited<ReturnType<typeof open>> | undefined;
      let temporary: Awaited<ReturnType<typeof open>> | undefined;
      let temporaryPath: string | undefined;
      try {
        if (file.revision !== req.body.revision) throw new ViewError(409, "File changed. Reopen before saving.");
        const original = fstatSync(file.handle.fd, { bigint: true });
        if (original.nlink !== 1n) throw new ViewError(403, "Hard-linked files cannot be edited.");
        directory = await open(path.dirname(grant.target), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        const directoryPath = `/proc/self/fd/${directory.fd}`;
        const destination = path.join(directoryPath, path.basename(grant.target));
        temporaryPath = path.join(directoryPath, `.agent-console-edit-${token()}`);
        temporary = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, Number(original.mode & 0o777n));
        await temporary.chmod(Number(original.mode & 0o777n));
        await temporary.writeFile(bytes); await temporary.sync();
        const replacement = fstatSync(temporary.fd);
        const resolved = await scopedPath(grant.cwd, grant.requested, grant.threadId);
        // From this check through rename, synchronous operations prevent other bridge
        // saves from interleaving. The pinned directory prevents parent-path swaps.
        const unchanged = (current: typeof original) => current.dev === original.dev && current.ino === original.ino && current.size === original.size && current.mtimeNs === original.mtimeNs && current.ctimeNs === original.ctimeNs && current.nlink === 1n;
        if (resolved.target !== grant.target || resolved.candidate !== grant.candidate || realpathSync(directoryPath) !== path.dirname(grant.target) || realpathSync(grant.candidate) !== grant.target || lstatSync(grant.candidate).isSymbolicLink()) throw new ViewError(409, "File path has changed. Reopen the file.");
        const currentRevision = () => {
          const buffer = Buffer.alloc(MAX_VIEW_BYTES + 1);
          let length = 0;
          while (length < buffer.length) { const count = readSync(file.handle.fd, buffer, length, buffer.length - length, length); if (!count) break; length += count; }
          return revision(buffer.subarray(0, length));
        };
        if (!unchanged(lstatSync(destination, { bigint: true })) || !unchanged(fstatSync(file.handle.fd, { bigint: true })) || currentRevision() !== req.body.revision || !unchanged(fstatSync(file.handle.fd, { bigint: true })) || !unchanged(lstatSync(destination, { bigint: true }))) throw new ViewError(409, "File changed. Reopen before saving.");
        renameSync(temporaryPath, destination);
        temporaryPath = undefined;
        for (const map of [tickets, sessions]) for (const active of map.values()) {
          if (active.target === grant.target && active.dev === Number(original.dev) && active.ino === Number(original.ino)) { active.dev = replacement.dev; active.ino = replacement.ino; }
        }
        await directory.sync();
        res.json({ revision: revision(bytes) });
      } finally {
        if (temporaryPath) { try { unlinkSync(temporaryPath); } catch {} }
        await temporary?.close(); await directory?.close(); await file.handle.close();
      }
    });
    locks.set(key, current);
    try { await current; } finally { if (locks.get(key) === current) locks.delete(key); }
  });
  return { create, exchange, read, save };
}

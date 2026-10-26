import { createHash, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import type { RequestHandler } from "express";
import {
  type Lookup,
  MAX_VIEW_BYTES,
  reachable,
  scopedPath,
  sensitive,
  ViewError,
} from "./files.ts";

export const TICKET_MS = 60_000;
// File and project grants have no practical time limit; process restart revokes them.
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_GRANTS = 1000;
export const token = () => randomBytes(32).toString("base64url");
export const revision = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export type Project = { root: string; dev: number; ino: number; expiresAt: number };
export const inside = (root: string, target: string) =>
  target === root || target.startsWith(root + path.sep);
export type Grant = {
  project?: Project;
  cwd: string;
  requested: string;
  threadId?: string;
  target: string;
  candidate: string;
  dev: number;
  ino: number;
  expiresAt: number;
};
export type Req = Parameters<RequestHandler>[0];
export type Res = Parameters<RequestHandler>[1];
/** Shared mutable bridge state; the maps are mutated in place by every route. */
export type BridgeContext = {
  lookup: Lookup;
  now: () => number;
  tickets: Map<string, Grant>;
  sessions: Map<string, Grant>;
  projects: Map<string, Project>;
  locks: Map<string, Promise<unknown>>;
};

export function textContent(bytes: Buffer) {
  if (bytes.length > MAX_VIEW_BYTES) throw new ViewError(413, "File exceeds the edit size limit.");
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ViewError(415, "Only UTF-8 text files can be edited.");
  }
  if (
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content) ||
    /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/.test(content)
  )
    throw new ViewError(403, "This file cannot be edited.");
  return content;
}

export function prune<Expiring extends { expiresAt: number }>(
  ctx: BridgeContext,
  map: Map<string, Expiring>,
) {
  for (const [key, grant] of map) if (grant.expiresAt <= ctx.now()) map.delete(key);
  while (map.size >= MAX_GRANTS) map.delete(map.keys().next().value!);
}

function errorStatus(error: unknown) {
  if (error instanceof ViewError) return error.status;
  return ["ENOENT", "ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code || "")
    ? 409
    : 403;
}

export function handler(action: (req: Req, res: Res) => Promise<void>): RequestHandler {
  return async (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      await action(req, res);
    } catch (error) {
      res.status(errorStatus(error)).json({
        error: error instanceof ViewError ? error.message : "File is unavailable or has changed.",
      });
    }
  };
}

async function resolveGrant(grant: Grant) {
  if (grant.project) await checkedProject(grant.project);
  const resolved = await scopedPath(grant.cwd, grant.requested, grant.threadId);
  if (
    grant.project &&
    (await projectPath(grant.project, path.relative(grant.project.root, resolved.candidate))) !==
      grant.target
  )
    throw new ViewError(409, "File path has changed. Reopen the file.");
  if (resolved.target !== grant.target || resolved.candidate !== grant.candidate)
    throw new ViewError(409, "File path has changed. Reopen the file.");
  return resolved;
}

function verifyOpened(grant: Grant, root: string, opened: string, info: Stats) {
  if (
    opened !== grant.target ||
    !reachable(root, opened) ||
    !info.isFile() ||
    info.dev !== grant.dev ||
    info.ino !== grant.ino
  )
    throw new ViewError(409, "File has changed. Reopen the file.");
  if (info.size > MAX_VIEW_BYTES) throw new ViewError(413, "File exceeds the edit size limit.");
}

async function readBounded(handle: FileHandle) {
  const bytes = Buffer.alloc(MAX_VIEW_BYTES + 1);
  let size = 0;
  while (size < bytes.length) {
    const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
    if (!bytesRead) break;
    size += bytesRead;
  }
  return bytes.subarray(0, size);
}

export async function checked(grant: Grant, write = false) {
  const resolved = await resolveGrant(grant);
  const handle = await open(
    grant.target,
    (write ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    const opened = await realpath(`/proc/self/fd/${handle.fd}`);
    verifyOpened(grant, resolved.root, opened, info);
    const data = await readBounded(handle);
    const content = textContent(data);
    return { handle, content, revision: revision(data) };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

const BEARER_PATTERN = /^Bearer ([A-Za-z0-9_-]{43})$/;

export function sessionFromRequest(ctx: BridgeContext, req: Req) {
  const match = BEARER_PATTERN.exec(req.get("Authorization") || "");
  const grant = match ? ctx.sessions.get(match[1]) : undefined;
  if (!grant || grant.expiresAt <= ctx.now()) {
    if (match) ctx.sessions.delete(match[1]);
    throw new ViewError(401, "Edit session expired. Reopen the file.");
  }
  return grant;
}

export async function projectRoot(grant: Grant, now: number) {
  const cwd = await realpath(grant.cwd);
  // Preserve the chosen workspace, including sibling repositories. A symlinked
  // instructions file must not narrow ~/repos to its backing brain repository.
  const root = inside(cwd, grant.target) ? cwd : path.dirname(grant.target);
  const info = await lstat(root);
  return { root, dev: info.dev, ino: info.ino, expiresAt: now + SESSION_TTL_MS };
}

export async function projectFromRequest(ctx: BridgeContext, req: Req) {
  const match = BEARER_PATTERN.exec(req.get("Authorization") || "");
  const grant = match ? ctx.projects.get(match[1]) : undefined;
  if (!grant || grant.expiresAt <= ctx.now()) {
    if (match) ctx.projects.delete(match[1]);
    throw new ViewError(401, "Project session expired. Reopen the file.");
  }
  await checkedProject(grant);
  return grant;
}

export async function checkedProject(grant: Project) {
  const info = await lstat(grant.root);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.dev !== grant.dev ||
    info.ino !== grant.ino ||
    (await realpath(grant.root)) !== grant.root
  )
    throw new ViewError(409, "Project folder changed. Reopen the file.");
  return grant;
}

function validateRequested(grant: Project, requested: unknown, directory: boolean) {
  if (
    typeof requested !== "string" ||
    requested.length > 8192 ||
    requested.includes("\0") ||
    path.isAbsolute(requested) ||
    requested.split(/[\\/]/).includes("..") ||
    (!directory && !requested)
  )
    throw new ViewError(400, "Choose a valid project path.");
  const candidate = path.resolve(grant.root, requested);
  if (
    !inside(grant.root, candidate) ||
    sensitive(candidate) ||
    candidate.split(path.sep).some((part) => part.startsWith(".agent-console-edit-"))
  )
    throw new ViewError(403, "This path cannot be opened.");
  return candidate;
}

/** Returns the next target when a file link is followed, or undefined when the chain has no link. */
async function followFirstLink(grant: Project, target: string, directory: boolean) {
  let current = grant.root;
  const parts = path.relative(grant.root, target).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    if (sensitive(current) || path.basename(current).startsWith(".agent-console-edit-"))
      throw new ViewError(403, "This path cannot be opened.");
    if ((await lstat(current)).isSymbolicLink()) {
      if (directory || index !== parts.length - 1)
        throw new ViewError(403, "Directory symbolic links cannot be opened.");
      return path.resolve(path.dirname(current), await readlink(current));
    }
  }
  return undefined;
}

async function finishChain(candidate: string, target: string) {
  if (target !== candidate && !(await lstat(target)).isFile())
    throw new ViewError(403, "Only file symbolic links can be opened.");
  if ((await realpath(candidate)) !== target)
    throw new ViewError(409, "File path has changed. Reopen the file.");
  return target;
}

export async function projectPath(grant: Project, requested: unknown, directory = false) {
  const candidate = validateRequested(grant, requested, directory);
  // Only file links are supported. Check every alias in the chain so neither
  // credential names nor directory links can bypass the project boundary.
  let target = candidate;
  for (let hop = 0; hop < 40; hop++) {
    if (!inside(grant.root, target)) throw new ViewError(403, "This file is outside the project.");
    const next = await followFirstLink(grant, target, directory);
    if (next === undefined) return finishChain(candidate, target);
    target = next;
  }
  throw new ViewError(403, "Symbolic link chain is too long.");
}

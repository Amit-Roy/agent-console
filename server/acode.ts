import { createHash, randomBytes } from "node:crypto";
import {
  constants,
  fstatSync,
  lstatSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { lstat, open, opendir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import type { RequestHandler } from "express";
import {
  type Lookup,
  MAX_VIEW_BYTES,
  reachable,
  scopedPath,
  sensitive,
  ViewError,
  viewerScope,
} from "./files.ts";

const TICKET_MS = 60_000;
// File and project grants have no practical time limit; process restart revokes them.
const SESSION_EXPIRES_AT = Number.MAX_SAFE_INTEGER;
const MAX_GRANTS = 1000;
const token = () => randomBytes(32).toString("base64url");
const revision = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type Project = { root: string; dev: number; ino: number; expiresAt: number };
const inside = (root: string, target: string) =>
  target === root || target.startsWith(root + path.sep);
type Grant = {
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

function textContent(bytes: Buffer) {
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

// Authentication and same-origin middleware must precede create. Parent middleware
// applies strict Cordova origin CORS to public routes. Public routes use
// single-file bearer grants and never derive authority from browser cookies.
export function createAcodeBridge(lookup: Lookup, now: () => number = Date.now) {
  const tickets = new Map<string, Grant>();
  const sessions = new Map<string, Grant>();
  const projects = new Map<string, Project>();
  const locks = new Map<string, Promise<unknown>>();
  function prune<T extends { expiresAt: number }>(map: Map<string, T>) {
    for (const [key, grant] of map) if (grant.expiresAt <= now()) map.delete(key);
    while (map.size >= MAX_GRANTS) map.delete(map.keys().next().value!);
  }
  function handler(
    fn: (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1]) => Promise<void>,
  ): RequestHandler {
    return async (req, res) => {
      try {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        await fn(req, res);
      } catch (error) {
        const status =
          error instanceof ViewError
            ? error.status
            : ["ENOENT", "ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code || "")
              ? 409
              : 403;
        res.status(status).json({
          error: error instanceof ViewError ? error.message : "File is unavailable or has changed.",
        });
      }
    };
  }
  async function checked(grant: Grant, write = false) {
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
    const handle = await open(
      grant.target,
      (write ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      const opened = await realpath(`/proc/self/fd/${handle.fd}`);
      if (
        opened !== grant.target ||
        !reachable(resolved.root, opened) ||
        !info.isFile() ||
        info.dev !== grant.dev ||
        info.ino !== grant.ino
      )
        throw new ViewError(409, "File has changed. Reopen the file.");
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
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  function session(req: Parameters<RequestHandler>[0]) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get("Authorization") || "");
    const grant = match ? sessions.get(match[1]) : undefined;
    if (!grant || grant.expiresAt <= now()) {
      if (match) sessions.delete(match[1]);
      throw new ViewError(401, "Edit session expired. Reopen the file.");
    }
    return grant;
  }
  async function projectRoot(grant: Grant) {
    const cwd = await realpath(grant.cwd);
    // Preserve the chosen workspace, including sibling repositories. A symlinked
    // instructions file must not narrow ~/repos to its backing brain repository.
    const root = inside(cwd, grant.target) ? cwd : path.dirname(grant.target);
    const info = await lstat(root);
    return { root, dev: info.dev, ino: info.ino, expiresAt: SESSION_EXPIRES_AT };
  }
  async function project(req: Parameters<RequestHandler>[0]) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get("Authorization") || "");
    const grant = match ? projects.get(match[1]) : undefined;
    if (!grant || grant.expiresAt <= now()) {
      if (match) projects.delete(match[1]);
      throw new ViewError(401, "Project session expired. Reopen the file.");
    }
    await checkedProject(grant);
    return grant;
  }
  async function checkedProject(grant: Project) {
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
  async function projectPath(grant: Project, requested: unknown, directory = false) {
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
    // Only file links are supported. Check every alias in the chain so neither
    // credential names nor directory links can bypass the project boundary.
    let target = candidate;
    for (let hop = 0; hop < 40; hop++) {
      if (!inside(grant.root, target))
        throw new ViewError(403, "This file is outside the project.");
      let current = grant.root;
      const parts = path.relative(grant.root, target).split(path.sep).filter(Boolean);
      let followed = false;
      for (let index = 0; index < parts.length; index++) {
        current = path.join(current, parts[index]);
        if (sensitive(current) || path.basename(current).startsWith(".agent-console-edit-"))
          throw new ViewError(403, "This path cannot be opened.");
        if ((await lstat(current)).isSymbolicLink()) {
          if (directory || index !== parts.length - 1)
            throw new ViewError(403, "Directory symbolic links cannot be opened.");
          target = path.resolve(path.dirname(current), await readlink(current));
          followed = true;
          break;
        }
      }
      if (!followed) {
        if (target !== candidate && !(await lstat(target)).isFile())
          throw new ViewError(403, "Only file symbolic links can be opened.");
        if ((await realpath(candidate)) !== target)
          throw new ViewError(409, "File path has changed. Reopen the file.");
        return target;
      }
    }
    throw new ViewError(403, "Symbolic link chain is too long.");
  }
  const tree = handler(async (req, res) => {
    const grant = await project(req);
    const requested = req.query.path ?? "";
    const target = await projectPath(grant, requested, true);
    const rawCursor = req.query.cursor ?? "0";
    if (typeof rawCursor !== "string" || !/^\d+$/.test(rawCursor) || Number(rawCursor) > 100000)
      throw new ViewError(400, "Invalid folder cursor.");
    const cursor = Number(rawCursor);
    const handle = await open(
      target,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const opened = await realpath(`/proc/self/fd/${handle.fd}`);
      if (opened !== target || !inside(grant.root, opened))
        throw new ViewError(409, "Folder changed. Reopen the file.");
      await project(req);
      const directory = await opendir(`/proc/self/fd/${handle.fd}`);
      const entries: { name: string; path: string; type: "file" | "directory" }[] = [];
      let offset = 0;
      let scanned = 0;
      let next: number | null = null;
      try {
        while (offset < cursor) {
          if (!(await directory.read())) break;
          offset++;
        }
        while (scanned < 1000 && entries.length < 200 && offset < 100000) {
          const entry = await directory.read();
          if (!entry) break;
          offset++;
          scanned++;
          if (!entry.isSymbolicLink() && !entry.isFile() && !entry.isDirectory()) continue;
          const absolute = path.join(target, entry.name);
          if (sensitive(absolute) || entry.name.startsWith(".agent-console-edit-")) continue;
          if (entry.isSymbolicLink()) {
            try {
              await projectPath(grant, path.relative(grant.root, absolute));
            } catch {
              continue;
            }
          }
          entries.push({
            name: entry.name,
            path: path.relative(grant.root, absolute),
            type: entry.isDirectory() ? "directory" : "file",
          });
        }
        if (offset < 100000 && (scanned === 1000 || entries.length === 200)) next = offset;
      } finally {
        await directory.close();
      }
      if ((await realpath(`/proc/self/fd/${handle.fd}`)) !== target)
        throw new ViewError(409, "Folder changed. Reopen the file.");
      res.json({ path: path.relative(grant.root, target), entries, next });
    } finally {
      await handle.close();
    }
  });
  const openFile = handler(async (req, res) => {
    const projectGrant = await project(req);
    // Acode probes project files such as index.html and tsconfig.json; a missing file is not an edit conflict.
    const missing = (error: NodeJS.ErrnoException) => {
      throw ["ENOENT", "ENOTDIR"].includes(error.code || "")
        ? new ViewError(404, "File not found.")
        : error;
    };
    const target = await projectPath(projectGrant, req.body?.path).catch(missing);
    const candidate = path.resolve(projectGrant.root, req.body.path);
    const info = await lstat(target).catch(missing);
    if (!info.isFile()) throw new ViewError(415, "Only regular text files can be edited.");
    const grant: Grant = {
      project: projectGrant,
      cwd: projectGrant.root,
      requested: candidate,
      target,
      candidate,
      dev: info.dev,
      ino: info.ino,
      expiresAt: SESSION_EXPIRES_AT,
    };
    const file = await checked(grant);
    try {
      await project(req);
      if (!inside(projectGrant.root, await realpath(`/proc/self/fd/${file.handle.fd}`)))
        throw new ViewError(403, "This file is outside the project.");
      prune(sessions);
      const session = token();
      sessions.set(session, grant);
      res.json({
        token: session,
        expiresAt: grant.expiresAt,
        name: path.basename(candidate),
        path: candidate,
        content: file.content,
        revision: file.revision,
      });
    } finally {
      await file.handle.close();
    }
  });
  const create = handler(async (req, res) => {
    const scope = viewerScope(req.query, lookup);
    if (typeof req.query.path !== "string" || !req.query.path || req.query.path.includes("\0"))
      throw new ViewError(400, "Choose a valid file path.");
    const resolved = await scopedPath(scope.cwd, req.query.path, scope.threadId);
    const workspace = await realpath(scope.cwd);
    const isAlias = resolved.candidate !== resolved.target;
    let aliasProject: Project | undefined;
    if (isAlias) {
      const info = await lstat(workspace);
      aliasProject = {
        root: workspace,
        dev: info.dev,
        ino: info.ino,
        expiresAt: SESSION_EXPIRES_AT,
      };
      await projectPath(aliasProject, path.relative(workspace, resolved.candidate));
    }
    const info = await lstat(resolved.target);
    const grant: Grant = {
      project: aliasProject,
      cwd: scope.cwd,
      requested: req.query.path,
      threadId: scope.threadId,
      ...resolved,
      dev: info.dev,
      ino: info.ino,
      expiresAt: now() + TICKET_MS,
    };
    const file = await checked(grant);
    await file.handle.close();
    prune(tickets);
    const ticket = token();
    tickets.set(ticket, grant);
    res.json({ ticket, expiresAt: grant.expiresAt, endpoint: res.locals.acodeEndpoint });
  });
  const exchange = handler(async (req, res) => {
    const ticket = typeof req.body?.ticket === "string" ? req.body.ticket : "";
    const grant = tickets.get(ticket);
    tickets.delete(ticket);
    if (!grant || grant.expiresAt <= now())
      throw new ViewError(401, "Edit ticket expired. Reopen the file.");
    const file = await checked(grant);
    await file.handle.close();
    prune(sessions);
    const session = token();
    const expiresAt = SESSION_EXPIRES_AT;
    sessions.set(session, { ...grant, expiresAt });
    prune(projects);
    const projectToken = token();
    const projectGrant = await projectRoot(grant);
    projects.set(projectToken, projectGrant);
    res.json({
      project: {
        token: projectToken,
        root: projectGrant.root,
        name: path.basename(projectGrant.root),
      },
      token: session,
      expiresAt,
      name: path.basename(grant.candidate),
      path: grant.candidate,
      content: file.content,
      revision: file.revision,
    });
  });
  const read = handler(async (req, res) => {
    const grant = session(req);
    const file = await checked(grant);
    try {
      res.json({
        name: path.basename(grant.candidate),
        path: grant.candidate,
        content: file.content,
        revision: file.revision,
      });
    } finally {
      await file.handle.close();
    }
  });
  const save = handler(async (req, res) => {
    const grant = session(req);
    if (typeof req.body?.content !== "string" || !/^[a-f0-9]{64}$/.test(req.body?.revision || ""))
      throw new ViewError(400, "Content and revision are required.");
    const bytes = Buffer.from(req.body.content, "utf8");
    textContent(bytes);
    if (bytes.toString("utf8") !== req.body.content)
      throw new ViewError(415, "Only UTF-8 text can be saved.");
    const key = grant.target;
    const previous = locks.get(key) || Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(async () => {
        const file = await checked(grant);
        let directory: Awaited<ReturnType<typeof open>> | undefined;
        let temporary: Awaited<ReturnType<typeof open>> | undefined;
        let temporaryPath: string | undefined;
        try {
          if (file.revision !== req.body.revision)
            throw new ViewError(409, "File changed. Reopen before saving.");
          const original = fstatSync(file.handle.fd, { bigint: true });
          if (original.nlink !== 1n)
            throw new ViewError(403, "Hard-linked files cannot be edited.");
          directory = await open(
            path.dirname(grant.target),
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
          const directoryPath = `/proc/self/fd/${directory.fd}`;
          const destination = path.join(directoryPath, path.basename(grant.target));
          temporaryPath = path.join(directoryPath, `.agent-console-edit-${token()}`);
          temporary = await open(
            temporaryPath,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            Number(original.mode & 0o777n),
          );
          await temporary.chmod(Number(original.mode & 0o777n));
          await temporary.writeFile(bytes);
          await temporary.sync();
          const replacement = fstatSync(temporary.fd);
          const resolved = await scopedPath(grant.cwd, grant.requested, grant.threadId);
          // From this check through rename, synchronous operations prevent other bridge
          // saves from interleaving. The pinned directory prevents parent-path swaps.
          const unchanged = (current: typeof original) =>
            current.dev === original.dev &&
            current.ino === original.ino &&
            current.size === original.size &&
            current.mtimeNs === original.mtimeNs &&
            current.ctimeNs === original.ctimeNs &&
            current.nlink === 1n;
          if (
            resolved.target !== grant.target ||
            resolved.candidate !== grant.candidate ||
            realpathSync(directoryPath) !== path.dirname(grant.target) ||
            realpathSync(grant.candidate) !== grant.target
          )
            throw new ViewError(409, "File path has changed. Reopen the file.");
          const currentRevision = () => {
            const buffer = Buffer.alloc(MAX_VIEW_BYTES + 1);
            let length = 0;
            while (length < buffer.length) {
              const count = readSync(
                file.handle.fd,
                buffer,
                length,
                buffer.length - length,
                length,
              );
              if (!count) break;
              length += count;
            }
            return revision(buffer.subarray(0, length));
          };
          if (
            !unchanged(lstatSync(destination, { bigint: true })) ||
            !unchanged(fstatSync(file.handle.fd, { bigint: true })) ||
            currentRevision() !== req.body.revision ||
            !unchanged(fstatSync(file.handle.fd, { bigint: true })) ||
            !unchanged(lstatSync(destination, { bigint: true }))
          )
            throw new ViewError(409, "File changed. Reopen before saving.");
          renameSync(temporaryPath, destination);
          temporaryPath = undefined;
          for (const map of [tickets, sessions])
            for (const active of map.values()) {
              if (
                active.target === grant.target &&
                active.dev === Number(original.dev) &&
                active.ino === Number(original.ino)
              ) {
                active.dev = replacement.dev;
                active.ino = replacement.ino;
              }
            }
          await directory.sync();
          res.json({ revision: revision(bytes) });
        } finally {
          if (temporaryPath) {
            try {
              unlinkSync(temporaryPath);
            } catch {}
          }
          await temporary?.close();
          await directory?.close();
          await file.handle.close();
        }
      });
    locks.set(key, current);
    try {
      await current;
    } finally {
      if (locks.get(key) === current) locks.delete(key);
    }
  });
  return { create, exchange, read, save, tree, openFile };
}

import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import {
  type BridgeContext,
  checked,
  type Grant,
  handler,
  inside,
  type Project,
  projectFromRequest,
  projectPath,
  projectRoot,
  prune,
  type Req,
  type Res,
  SESSION_EXPIRES_AT,
  sessionFromRequest,
  TICKET_MS,
  token,
} from "./acode-core.ts";
import { treeRoute } from "./acode-folder.ts";
import { saveRoute } from "./acode-save.ts";
import { type Lookup, scopedPath, ViewError, viewerScope } from "./files.ts";

/** Acode probes project files such as index.html and tsconfig.json; a missing file is not an edit conflict. */
function missingOrThrow(error: NodeJS.ErrnoException): never {
  throw ["ENOENT", "ENOTDIR"].includes(error.code || "")
    ? new ViewError(404, "File not found.")
    : error;
}

async function openFileRoute(ctx: BridgeContext, req: Req, res: Res) {
  const projectGrant = await projectFromRequest(ctx, req);
  const target = await projectPath(projectGrant, req.body?.path).catch(missingOrThrow);
  const candidate = path.resolve(projectGrant.root, req.body.path);
  const info = await lstat(target).catch(missingOrThrow);
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
    await projectFromRequest(ctx, req);
    if (!inside(projectGrant.root, await realpath(`/proc/self/fd/${file.handle.fd}`)))
      throw new ViewError(403, "This file is outside the project.");
    prune(ctx, ctx.sessions);
    const session = token();
    ctx.sessions.set(session, grant);
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
}

async function aliasProjectFor(workspace: string, candidate: string) {
  const info = await lstat(workspace);
  const aliasProject: Project = {
    root: workspace,
    dev: info.dev,
    ino: info.ino,
    expiresAt: SESSION_EXPIRES_AT,
  };
  await projectPath(aliasProject, path.relative(workspace, candidate));
  return aliasProject;
}

async function createRoute(ctx: BridgeContext, req: Req, res: Res) {
  const scope = viewerScope(req.query, ctx.lookup);
  if (typeof req.query.path !== "string" || !req.query.path || req.query.path.includes("\0"))
    throw new ViewError(400, "Choose a valid file path.");
  const resolved = await scopedPath(scope.cwd, req.query.path, scope.threadId);
  const workspace = await realpath(scope.cwd);
  const isAlias = resolved.candidate !== resolved.target;
  const aliasProject = isAlias ? await aliasProjectFor(workspace, resolved.candidate) : undefined;
  const info = await lstat(resolved.target);
  const grant: Grant = {
    project: aliasProject,
    cwd: scope.cwd,
    requested: req.query.path,
    threadId: scope.threadId,
    ...resolved,
    dev: info.dev,
    ino: info.ino,
    expiresAt: ctx.now() + TICKET_MS,
  };
  const file = await checked(grant);
  await file.handle.close();
  prune(ctx, ctx.tickets);
  const ticket = token();
  ctx.tickets.set(ticket, grant);
  res.json({ ticket, expiresAt: grant.expiresAt, endpoint: res.locals.acodeEndpoint });
}

async function exchangeRoute(ctx: BridgeContext, req: Req, res: Res) {
  const ticket = typeof req.body?.ticket === "string" ? req.body.ticket : "";
  const grant = ctx.tickets.get(ticket);
  ctx.tickets.delete(ticket);
  if (!grant || grant.expiresAt <= ctx.now())
    throw new ViewError(401, "Edit ticket expired. Reopen the file.");
  const file = await checked(grant);
  await file.handle.close();
  prune(ctx, ctx.sessions);
  const session = token();
  const expiresAt = SESSION_EXPIRES_AT;
  ctx.sessions.set(session, { ...grant, expiresAt });
  prune(ctx, ctx.projects);
  const projectToken = token();
  const projectGrant = await projectRoot(grant);
  ctx.projects.set(projectToken, projectGrant);
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
}

async function readRoute(ctx: BridgeContext, req: Req, res: Res) {
  const grant = sessionFromRequest(ctx, req);
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
}

// Authentication and same-origin middleware must precede create. Parent middleware
// applies strict Cordova origin CORS to public routes. Public routes use
// single-file bearer grants and never derive authority from browser cookies.
export function createAcodeBridge(lookup: Lookup, now: () => number = Date.now) {
  const ctx: BridgeContext = {
    lookup,
    now,
    tickets: new Map(),
    sessions: new Map(),
    projects: new Map(),
    locks: new Map(),
  };
  return {
    create: handler((req, res) => createRoute(ctx, req, res)),
    exchange: handler((req, res) => exchangeRoute(ctx, req, res)),
    read: handler((req, res) => readRoute(ctx, req, res)),
    save: handler((req, res) => saveRoute(ctx, req, res)),
    tree: handler((req, res) => treeRoute(ctx, req, res)),
    openFile: handler((req, res) => openFileRoute(ctx, req, res)),
  };
}

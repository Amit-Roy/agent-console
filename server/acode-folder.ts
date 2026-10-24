import type { Dirent } from "node:fs";
import { constants } from "node:fs";
import { open, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  type BridgeContext,
  inside,
  type Project,
  projectFromRequest,
  projectPath,
  type Req,
  type Res,
} from "./acode-core.ts";
import { sensitive, ViewError } from "./files.ts";

type FolderEntry = { name: string; path: string; type: "file" | "directory" };

function parseCursor(rawCursor: unknown) {
  if (typeof rawCursor !== "string" || !/^\d+$/.test(rawCursor) || Number(rawCursor) > 100000)
    throw new ViewError(400, "Invalid folder cursor.");
  return Number(rawCursor);
}

async function listedEntry(grant: Project, target: string, entry: Dirent) {
  if (!entry.isSymbolicLink() && !entry.isFile() && !entry.isDirectory()) return undefined;
  const absolute = path.join(target, entry.name);
  if (sensitive(absolute) || entry.name.startsWith(".agent-console-edit-")) return undefined;
  if (entry.isSymbolicLink()) {
    try {
      await projectPath(grant, path.relative(grant.root, absolute));
    } catch {
      return undefined;
    }
  }
  const listed: FolderEntry = {
    name: entry.name,
    path: path.relative(grant.root, absolute),
    type: entry.isDirectory() ? "directory" : "file",
  };
  return listed;
}

async function skipEntries(directory: Awaited<ReturnType<typeof opendir>>, cursor: number) {
  let offset = 0;
  while (offset < cursor) {
    if (!(await directory.read())) break;
    offset++;
  }
  return offset;
}

async function listDirectory(grant: Project, target: string, descriptor: number, cursor: number) {
  const directory = await opendir(`/proc/self/fd/${descriptor}`);
  const entries: FolderEntry[] = [];
  let scanned = 0;
  let next: number | null = null;
  try {
    let offset = await skipEntries(directory, cursor);
    while (scanned < 1000 && entries.length < 200 && offset < 100000) {
      const entry = await directory.read();
      if (!entry) break;
      offset++;
      scanned++;
      const listed = await listedEntry(grant, target, entry);
      if (listed) entries.push(listed);
    }
    if (offset < 100000 && (scanned === 1000 || entries.length === 200)) next = offset;
  } finally {
    await directory.close();
  }
  return { entries, next };
}

export async function treeRoute(ctx: BridgeContext, req: Req, res: Res) {
  const grant = await projectFromRequest(ctx, req);
  const requested = req.query.path ?? "";
  const target = await projectPath(grant, requested, true);
  const cursor = parseCursor(req.query.cursor ?? "0");
  const handle = await open(
    target,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await realpath(`/proc/self/fd/${handle.fd}`);
    if (opened !== target || !inside(grant.root, opened))
      throw new ViewError(409, "Folder changed. Reopen the file.");
    await projectFromRequest(ctx, req);
    const { entries, next } = await listDirectory(grant, target, handle.fd, cursor);
    if ((await realpath(`/proc/self/fd/${handle.fd}`)) !== target)
      throw new ViewError(409, "Folder changed. Reopen the file.");
    res.json({ path: path.relative(grant.root, target), entries, next });
  } finally {
    await handle.close();
  }
}

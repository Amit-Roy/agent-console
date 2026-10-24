import {
  type BigIntStats,
  constants,
  fstatSync,
  lstatSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import path from "node:path";
import {
  type BridgeContext,
  checked,
  type Grant,
  type Req,
  type Res,
  revision,
  sessionFromRequest,
  textContent,
  token,
} from "./acode-core.ts";
import { MAX_VIEW_BYTES, scopedPath, ViewError } from "./files.ts";

type SaveState = {
  directory?: FileHandle;
  temporary?: FileHandle;
  temporaryPath?: string;
};

function validateSaveBody(body: { content?: unknown; revision?: unknown } | undefined) {
  if (typeof body?.content !== "string" || !/^[a-f0-9]{64}$/.test((body?.revision as string) || ""))
    throw new ViewError(400, "Content and revision are required.");
  const bytes = Buffer.from(body.content, "utf8");
  textContent(bytes);
  if (bytes.toString("utf8") !== body.content)
    throw new ViewError(415, "Only UTF-8 text can be saved.");
  return bytes;
}

function unchangedSince(original: BigIntStats, current: BigIntStats) {
  return (
    current.dev === original.dev &&
    current.ino === original.ino &&
    current.size === original.size &&
    current.mtimeNs === original.mtimeNs &&
    current.ctimeNs === original.ctimeNs &&
    current.nlink === 1n
  );
}

function currentRevision(descriptor: number) {
  const buffer = Buffer.alloc(MAX_VIEW_BYTES + 1);
  let length = 0;
  while (length < buffer.length) {
    const count = readSync(descriptor, buffer, length, buffer.length - length, length);
    if (!count) break;
    length += count;
  }
  return revision(buffer.subarray(0, length));
}

async function stageTemporary(
  grant: Grant,
  bytes: Buffer,
  original: BigIntStats,
  state: SaveState,
) {
  state.directory = await open(
    path.dirname(grant.target),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const directoryPath = `/proc/self/fd/${state.directory.fd}`;
  const destination = path.join(directoryPath, path.basename(grant.target));
  state.temporaryPath = path.join(directoryPath, `.agent-console-edit-${token()}`);
  state.temporary = await open(
    state.temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    Number(original.mode & 0o777n),
  );
  await state.temporary.chmod(Number(original.mode & 0o777n));
  await state.temporary.writeFile(bytes);
  await state.temporary.sync();
  return { directoryPath, destination, replacement: fstatSync(state.temporary.fd) };
}

async function verifyBeforeRename(
  grant: Grant,
  file: { handle: FileHandle },
  original: BigIntStats,
  expectedRevision: string,
  staged: { directoryPath: string; destination: string },
) {
  const resolved = await scopedPath(grant.cwd, grant.requested, grant.threadId);
  // From this check through rename, synchronous operations prevent other bridge
  // saves from interleaving. The pinned directory prevents parent-path swaps.
  if (
    resolved.target !== grant.target ||
    resolved.candidate !== grant.candidate ||
    realpathSync(staged.directoryPath) !== path.dirname(grant.target) ||
    realpathSync(grant.candidate) !== grant.target
  )
    throw new ViewError(409, "File path has changed. Reopen the file.");
  const descriptor = file.handle.fd;
  if (
    !unchangedSince(original, lstatSync(staged.destination, { bigint: true })) ||
    !unchangedSince(original, fstatSync(descriptor, { bigint: true })) ||
    currentRevision(descriptor) !== expectedRevision ||
    !unchangedSince(original, fstatSync(descriptor, { bigint: true })) ||
    !unchangedSince(original, lstatSync(staged.destination, { bigint: true }))
  )
    throw new ViewError(409, "File changed. Reopen before saving.");
}

function updateActiveGrants(
  ctx: BridgeContext,
  grant: Grant,
  original: BigIntStats,
  replacement: { dev: number; ino: number },
) {
  for (const map of [ctx.tickets, ctx.sessions])
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
}

async function cleanupSave(state: SaveState, file: { handle: FileHandle }) {
  if (state.temporaryPath) {
    try {
      unlinkSync(state.temporaryPath);
    } catch {}
  }
  await state.temporary?.close();
  await state.directory?.close();
  await file.handle.close();
}

async function replaceFile(
  ctx: BridgeContext,
  grant: Grant,
  bytes: Buffer,
  expectedRevision: string,
  res: Res,
) {
  const file = await checked(grant);
  const state: SaveState = {};
  try {
    if (file.revision !== expectedRevision)
      throw new ViewError(409, "File changed. Reopen before saving.");
    const original = fstatSync(file.handle.fd, { bigint: true });
    if (original.nlink !== 1n) throw new ViewError(403, "Hard-linked files cannot be edited.");
    const staged = await stageTemporary(grant, bytes, original, state);
    await verifyBeforeRename(grant, file, original, expectedRevision, staged);
    renameSync(state.temporaryPath!, staged.destination);
    state.temporaryPath = undefined;
    updateActiveGrants(ctx, grant, original, staged.replacement);
    await state.directory!.sync();
    res.json({ revision: revision(bytes) });
  } finally {
    await cleanupSave(state, file);
  }
}

export async function saveRoute(ctx: BridgeContext, req: Req, res: Res) {
  const grant = sessionFromRequest(ctx, req);
  const bytes = validateSaveBody(req.body);
  const key = grant.target;
  const previous = ctx.locks.get(key) || Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(() => replaceFile(ctx, grant, bytes, req.body.revision, res));
  ctx.locks.set(key, current);
  try {
    await current;
  } finally {
    if (ctx.locks.get(key) === current) ctx.locks.delete(key);
  }
}

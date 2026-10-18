import fs from "node:fs";
import { open, opendir, realpath, stat as statPath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import os from "node:os";
import path from "node:path";
import type { RequestHandler } from "express";

export const MAX_VIEW_BYTES = 1 << 20;
export const MAX_PREVIEW_IMAGE_BYTES = 5 << 20;
export const TREE_PAGE_SIZE = 200;
const TREE_SCAN_SIZE = 1000;
const MAX_TREE_OFFSET = 100_000;

class ViewError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

// This endpoint displays project text, not credential stores. Check both the requested
// name and the real target so a friendly symlink cannot expose a hidden secret.
function sensitive(file: string): boolean {
  const parts = file.split(path.sep).map(part => part.toLowerCase());
  if (parts.some(part => [".git", ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker"].includes(part))) return true;
  const name = parts.at(-1) || "";
  if (/^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.git-credentials|credentials(?:\..*)?|auth\.json|password|secret|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/.test(name)) return true;
  if (/\.(?:pem|key|p12|pfx|keystore)$/.test(name)) return true;
  const home = os.homedir();
  return [".config", ".local/share/keyrings"].some(dir => inside(path.join(home, dir), file));
}

async function scopedPath(cwd: string, requested: string) {
  const root = await realpath(cwd);
  const expanded = requested.startsWith("~/") ? path.join(os.homedir(), requested.slice(2)) : requested;
  const candidate = path.resolve(cwd, expanded);
  if (sensitive(candidate)) throw new ViewError(403, "This file is outside the thread folder or contains private credentials.");
  // A lexically outside link (~/.claude/CLAUDE.md) is fine when its real target is inside the root.
  const lexicalInside = inside(path.resolve(cwd), candidate) || inside(root, candidate);
  const target = await realpath(candidate).catch(error => { if (lexicalInside) throw error; throw new ViewError(403, "This file is outside the thread folder or contains private credentials."); });
  if (!inside(root, target) || sensitive(target)) throw new ViewError(403, "This file is outside the thread folder or contains private credentials.");
  return { root, target };
}

async function openScoped(root: string, target: string, directory = false): Promise<FileHandle> {
  // Nonblocking avoids waiting on pipes; no-follow prevents a swapped final symlink.
  const handle = await open(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | (directory ? fs.constants.O_DIRECTORY : 0));
  try {
    // Verify the opened inode too, closing parent-directory symlink races on Linux.
    if (process.platform === "linux") {
      const opened = await realpath(`/proc/self/fd/${handle.fd}`);
      if (!inside(root, opened) || sensitive(opened)) throw new ViewError(403, "This file is outside the thread folder or contains private credentials.");
    }
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

function imageType(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

async function readProjectFile(cwd: string, requested: string, binary = false) {
  const { root, target } = await scopedPath(cwd, requested);
  const handle = await openScoped(root, target);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new ViewError(415, "Only regular text and image files can be viewed.");
    const head = Buffer.alloc(16);
    const peek = await handle.read(head, 0, head.length, 0);
    const media_type = imageType(head.subarray(0, peek.bytesRead));
    const limit = media_type ? MAX_PREVIEW_IMAGE_BYTES : MAX_VIEW_BYTES;
    if (stat.size > limit) throw new ViewError(413, `The file is too large to preview (maximum ${limit >> 20} MB).`);
    if (binary && !media_type) throw new ViewError(415, "Only PNG, JPEG, GIF and WebP images can be previewed.");
    // Metadata does not read the whole image; the authenticated image request does.
    if (media_type && !binary) return { kind: "image" as const, root, path: target, name: path.basename(target), media_type, bytes: stat.size };
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > limit) throw new ViewError(413, `The file is too large to preview (maximum ${limit >> 20} MB).`);
    if (size > stat.size) throw new ViewError(409, "This file changed while opening. Open it again.");
    if (media_type) return { kind: "image" as const, root, path: target, name: path.basename(target), media_type, bytes: size, data: buffer.subarray(0, size) };
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size)); }
    catch { throw new ViewError(415, "Only UTF-8 text files can be viewed."); }
    if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(content)) throw new ViewError(415, "Only text files can be viewed.");
    if (/-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/.test(content)) throw new ViewError(403, "Private keys cannot be previewed.");
    return { kind: "text" as const, root, path: target, name: path.basename(target), content, bytes: size };
  } finally { await handle.close(); }
}

function requestPath(requested: unknown): string {
  if (typeof requested !== "string" || !requested || requested.length > 8192 || requested.includes("\0")) throw new ViewError(400, "Choose a valid file path.");
  return requested;
}

function failure(error: any) {
  if (error instanceof ViewError) return { status: error.status, error: error.message };
  if (["ENOENT", "ENOTDIR"].includes(error?.code)) return { status: 404, error: "The file or folder no longer exists." };
  if (["EACCES", "EPERM", "ELOOP"].includes(error?.code)) return { status: 403, error: "This file or folder cannot be previewed." };
  return { status: 415, error: "This file or folder cannot be previewed." };
}

function timing(res: Parameters<RequestHandler>[1], start: number, kind: "file" | "tree") {
  const ms = Math.round((performance.now() - start) * 100) / 100;
  res.setHeader("Server-Timing", `${kind};dur=${ms}`);
  return ms;
}

type Lookup = (id: string) => { cwd: string } | undefined;

// These routes mount after authentication. Every request resolves scope afresh;
// image URLs stay within the selected thread's real cwd or the fixed repos root.
function viewerScope(query: Record<string, unknown>, lookup: Lookup) {
  if (query.scope !== undefined) {
    if (query.scope !== "repos" || query.thread !== undefined) throw new ViewError(400, "Choose a valid file scope.");
    return { cwd: path.join(os.homedir(), "repos"), params: { scope: "repos" } };
  }
  const thread = typeof query.thread === "string" ? lookup(query.thread) : undefined;
  if (!thread) throw new ViewError(404, "Unknown thread.");
  return { cwd: thread.cwd, params: { thread: String(query.thread) } };
}

export function fileViewer(lookup: Lookup, binary = false): RequestHandler {
  return async (req, res) => {
    const start = performance.now();
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    try {
      const scope = viewerScope(req.query, lookup);
      const file = await readProjectFile(scope.cwd, requestPath(req.query.path), binary);
      const read_ms = timing(res, start, "file");
      if (binary && file.kind === "image" && file.data) {
        res.setHeader("Content-Type", file.media_type!);
        res.setHeader("Content-Disposition", "inline");
        res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
        return void res.send(file.data);
      }
      const url = file.kind === "image" ? `/api/file-image?${new URLSearchParams({ ...scope.params, path: file.path })}` : undefined;
      res.json({ ...file, url, read_ms });
    } catch (error) {
      timing(res, start, "file");
      const result = failure(error); res.status(result.status).json({ error: result.error });
    }
  };
}

const VIDEO_TYPES: Record<string, string> = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm" };

function videoMagic(ext: string, head: Buffer): boolean {
  if (ext === ".webm") return head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3;
  return head.length >= 12 && ["ftyp", "moov", "mdat", "wide", "free", "skip"].includes(head.subarray(4, 8).toString("latin1"));
}

/** Parse a single `Range: bytes=` spec against `size`. null = ignore the header (serve 200), "bad" = 416. */
export function parseRange(header: unknown, size: number): { start: number; end: number } | null | "bad" {
  if (typeof header !== "string" || !header.startsWith("bytes=")) return null;
  const spec = header.slice(6).trim();
  if (spec.includes(",")) return null;
  const m = /^(\d*)-(\d*)$/.exec(spec);
  if (!m || (m[1] === "" && m[2] === "")) return "bad";
  let start: number, end: number;
  if (m[1] === "") { const n = Number(m[2]); if (!n) return "bad"; start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (!Number.isSafeInteger(start) || start >= size || end < start) return "bad";
  return { start, end };
}

// Video for the inline player. Same scope and secret rules as the viewer; streamed from the verified descriptor with HTTP Range
// so phones can seek. Only known video containers (extension + magic bytes) are served, always inline under a locked-down CSP.
export function fileMedia(lookup: Lookup): RequestHandler {
  return async (req, res) => {
    res.setHeader("Cache-Control", "private, no-cache");
    res.setHeader("X-Content-Type-Options", "nosniff");
    let handle: FileHandle | undefined;
    try {
      const scope = viewerScope(req.query, lookup);
      const { root, target } = await scopedPath(scope.cwd, requestPath(req.query.path));
      const ext = path.extname(target).toLowerCase();
      const type = VIDEO_TYPES[ext];
      if (!type) throw new ViewError(415, "Only MP4, WebM and MOV video can be played.");
      handle = await openScoped(root, target);
      const stat = await handle.stat();
      if (!stat.isFile()) throw new ViewError(415, "Only regular video files can be played.");
      const head = Buffer.alloc(12);
      const peek = await handle.read(head, 0, head.length, 0);
      if (!videoMagic(ext, head.subarray(0, peek.bytesRead))) throw new ViewError(415, "This file is not a playable video.");
      const range = parseRange(req.headers.range, stat.size);
      if (range === "bad") { res.setHeader("Content-Range", `bytes */${stat.size}`); throw new ViewError(416, "Invalid byte range."); }
      const [start, end] = range ? [range.start, range.end] : [0, stat.size - 1];
      res.status(range ? 206 : 200);
      if (range) res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Type", type);
      res.setHeader("Content-Disposition", "inline");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      if (stat.size === 0 || req.method === "HEAD") { res.setHeader("Content-Length", stat.size === 0 ? 0 : end - start + 1); await handle.close(); return void res.end(); }
      res.setHeader("Content-Length", end - start + 1);
      const stream = handle.createReadStream({ start, end }); // owns the descriptor from here (autoClose)
      handle = undefined;
      res.on("close", () => stream.destroy());
      stream.on("error", () => res.destroy());
      stream.pipe(res);
    } catch (error) {
      await handle?.close().catch(() => {});
      const result = failure(error);
      res.status(result.status).json({ error: result.error });
    }
  };
}

// One level only, using Dirent types (stat only for symlinks). Special files
// are omitted; opening a symlink still enforces realpath scope.
// The cursor counts raw directory entries so filtered entries cannot stall paging.
export function fileTree(lookup: Lookup): RequestHandler {
  return async (req, res) => {
    const start = performance.now();
    res.setHeader("Cache-Control", "no-store");
    try {
      const scope = viewerScope(req.query, lookup);
      const { root, target } = await scopedPath(scope.cwd, requestPath(req.query.path ?? "."));
      const rawCursor = req.query.cursor;
      const offset = rawCursor === undefined ? 0 : typeof rawCursor === "string" && /^\d{1,6}$/.test(rawCursor) ? Number(rawCursor) : -1;
      if (offset < 0 || offset > MAX_TREE_OFFSET) throw new ViewError(400, "Invalid folder cursor.");
      const handle = await openScoped(root, target, true);
      const entries: { name: string; path: string; kind: "directory" | "file" }[] = [];
      let index = 0, done = false;
      try {
        const dir = await opendir(process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : target, { bufferSize: 64 });
        try {
          while (index < offset) { if (!await dir.read()) { done = true; break; } index++; }
          while (!done && index < offset + TREE_SCAN_SIZE && index < MAX_TREE_OFFSET && entries.length < TREE_PAGE_SIZE) {
            const entry = await dir.read();
            if (!entry) { done = true; break; }
            index++;
            const child = path.join(target, entry.name);
            if (sensitive(child)) continue;
            let kind: "directory" | "file" | undefined = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : undefined;
            // Symlinks (CLAUDE.md, AGENTS.md, .mcp.json in ~/repos) list as their target kind; opening still enforces realpath scope.
            if (!kind && entry.isSymbolicLink()) {
              const real = await realpath(child).catch(() => undefined);
              if (real && inside(root, real) && !sensitive(real)) {
                const target = await statPath(real).catch(() => undefined);
                kind = target?.isDirectory() ? "directory" : target?.isFile() ? "file" : undefined;
              }
            }
            if (kind) entries.push({ name: entry.name, path: child, kind });
          }
        } finally { await dir.close(); }
      } finally { await handle.close(); }
      const read_ms = timing(res, start, "tree");
      const result = { root, path: target, parent: target === root ? null : path.dirname(target), entries, cursor: done || index >= MAX_TREE_OFFSET ? null : String(index), truncated: !done, limit_reached: !done && index >= MAX_TREE_OFFSET, bytes: 0, read_ms };
      // Include the complete decoded JSON payload size (including this field).
      let encoded = JSON.stringify(result);
      while (result.bytes !== Buffer.byteLength(encoded)) {
        result.bytes = Buffer.byteLength(encoded); encoded = JSON.stringify(result);
      }
      res.type("json").send(encoded);
    } catch (error) {
      timing(res, start, "tree");
      const result = failure(error); res.status(result.status).json({ error: result.error });
    }
  };
}

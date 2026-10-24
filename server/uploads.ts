import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./auth.ts";
import type { Attachment } from "./providers/types.ts";

// Files the user pastes, drops or attaches are uploaded over HTTP (raw bytes, no base64) and stored at
//   uploads/<thread>/<id>/<name>
// A message then refers to them by id. The thread log keeps only {id, name, kind, media_type, size}: history replays the whole log
// over the websocket, so file bytes never go in it. Images are also handed to the agent as vision input; every attachment is
// listed by absolute path in the prompt so the agent can open it with its own tools.

export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
export const MAX_ATTACHMENTS = 20;
export const MAX_IMAGE_BYTES = 5 << 20;
export const MAX_FILE_BYTES = 25 << 20;

const UUID = /^[a-f0-9-]{36}$/;
export const isId = (s: unknown): s is string => typeof s === "string" && UUID.test(s);
// what safeName() can produce: letters/digits of any script, dot, dash, underscore, space, parens; never a leading dot
export const SAFE_NAME = /^[\p{L}\p{N}_()\- ][\p{L}\p{N}._()\- ]{0,119}$/u;

const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export function sniffImage(b: Buffer): string | null {
  if (b.length < 12) return null;
  if (b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (
    b.subarray(0, 4).toString("latin1") === "RIFF" &&
    b.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "image/webp";
  return null;
}

export function sniffImageFile(file: string): string | null {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const head = Buffer.alloc(12);
      fs.readSync(fd, head, 0, 12, 0);
      return sniffImage(head);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Untrusted client file name -> a harmless single path segment. */
export function safeName(raw: unknown): string {
  let n =
    String(raw ?? "")
      .normalize("NFC")
      .split(/[\\/]/)
      .pop() ?? "";
  n = n
    .replace(/[^\p{L}\p{N}._()\- ]/gu, "_")
    .replace(/^[. ]+/, "")
    .trim();
  if (n.length > 120) {
    const ext = path.extname(n).slice(0, 12);
    n = n.slice(0, 120 - ext.length) + ext;
  }
  return n && SAFE_NAME.test(n) ? n : "file";
}

export const threadDir = (id: string) => path.join(UPLOAD_DIR, id);
const attachDir = (thread: string, id: string) => path.join(UPLOAD_DIR, thread, id);

export interface Saved {
  id: string;
  name: string;
  kind: "image" | "file";
  media_type: string;
  size: number;
}

/** Validates and stores one upload for a thread. Images are recognised by their bytes, never by the claimed type. */
export function saveUpload(
  thread: string,
  rawName: unknown,
  claimedType: unknown,
  bytes: Buffer,
): Saved {
  if (!isId(thread)) throw new Error("Invalid thread.");
  if (!bytes.length) throw new Error("That file is empty.");
  if (bytes.length > MAX_FILE_BYTES)
    throw new Error(`Files must be under ${MAX_FILE_BYTES >> 20} MB.`);
  const image = sniffImage(bytes);
  if (image && bytes.length > MAX_IMAGE_BYTES)
    throw new Error(`Images must be under ${MAX_IMAGE_BYTES >> 20} MB.`);
  let name = safeName(rawName);
  if (image) name = `${name.replace(/\.[^.]*$/, "") || "image"}.${IMAGE_EXT[image]}`; // the extension must agree with the bytes
  const id = crypto.randomUUID();
  const dir = attachDir(thread, id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, name), bytes, { mode: 0o600 });
  const type = String(claimedType ?? "");
  return {
    id,
    name,
    kind: image ? "image" : "file",
    media_type: image ?? (/^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : "application/octet-stream"),
    size: bytes.length,
  };
}

/** Moves a server-side file into a thread's uploads (used by share targets). Same layout and id format as saveUpload. */
export function adoptUpload(
  thread: string,
  srcPath: string,
  rawName: string,
  maxBytes: number,
): Saved {
  if (!isId(thread)) throw new Error("Invalid thread.");
  const size = fs.statSync(srcPath).size;
  if (!size) throw new Error("That file is empty.");
  if (size > maxBytes) throw new Error(`Files must be under ${maxBytes >> 20} MB.`);
  const name = safeName(rawName);
  const uploadId = crypto.randomUUID();
  const dir = attachDir(thread, uploadId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, name);
  try {
    fs.renameSync(srcPath, target);
  } catch {
    fs.copyFileSync(srcPath, target);
    fs.rmSync(srcPath, { force: true });
  }
  fs.chmodSync(target, 0o600);
  const image = sniffImageFile(target);
  return {
    id: uploadId,
    name,
    kind: image ? "image" : "file",
    media_type: image ?? (name.endsWith(".mp4") ? "video/mp4" : "text/plain"),
    size,
  };
}

/** Turns the `{id}` references in a send message into stored attachments; throws on anything unknown. */
export function resolveAttachments(thread: string, raw: unknown): Attachment[] {
  if (raw == null || (Array.isArray(raw) && !raw.length)) return [];
  if (!Array.isArray(raw)) throw new Error("Invalid attachments.");
  if (raw.length > MAX_ATTACHMENTS)
    throw new Error(`At most ${MAX_ATTACHMENTS} attachments per message.`);
  if (!isId(thread)) throw new Error("Invalid thread.");
  const seen = new Set<string>();
  return raw.map((r: any) => {
    const id = r?.id;
    if (!isId(id) || seen.has(id)) throw new Error("Unknown attachment.");
    seen.add(id);
    const dir = attachDir(thread, id);
    const name = fs.existsSync(dir) ? fs.readdirSync(dir)[0] : undefined;
    if (!name) throw new Error("An attachment expired. Attach it again.");
    const file = path.join(dir, name);
    const image = sniffImageFile(file);
    const n = Number.isInteger(r?.n) && r.n >= 1 && r.n <= 99 ? r.n : undefined;
    return {
      id,
      name,
      path: file,
      kind: image ? "image" : "file",
      media_type: image ?? "application/octet-stream",
      size: fs.statSync(file).size,
      ...(image && n ? { n } : {}),
    } satisfies Attachment;
  });
}

const human = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1 << 20
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / (1 << 20)).toFixed(1)} MB`;

/** The prompt the agent sees: the user's text plus the absolute paths of any non-image attachments (images arrive as vision input). */
export function withFileList(text: string, attachments: Attachment[]): string {
  const files = attachments.filter((a) => a.kind === "file");
  const images = attachments.filter((a) => a.kind === "image");
  if (!files.length && !images.length) return text;
  const blocks: string[] = [];
  // The composer inserts "[Image #n]" where the user pastes; the image blocks themselves carry no label, so say which is which.
  if (images.length)
    blocks.push(
      `[Images attached to this message, in order: ${images.map((a, i) => `[Image #${a.n ?? i + 1}] ${a.name}`).join("; ")}. The message may refer to them by these labels.]`,
    );
  if (files.length)
    blocks.push(
      `[Attached files, saved on this machine. Open them with your file tools.]\n${files.map((f) => `- ${f.path} (${human(f.size)})`).join("\n")}`,
    );
  return `${text.trim() ? text.trimEnd() + "\n\n" : ""}${blocks.join("\n\n")}`;
}

export function removeUpload(thread: string, id: string) {
  if (isId(thread) && isId(id)) fs.rmSync(attachDir(thread, id), { recursive: true, force: true });
}

export function removeUploads(threadId: string) {
  if (isId(threadId)) fs.rmSync(threadDir(threadId), { recursive: true, force: true });
}

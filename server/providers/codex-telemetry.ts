import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { linesWith } from "../history.ts";

export function codexTokenEvent(row: any) {
  if (row?.type === "compacted") return { observedAt: Date.parse(row.timestamp) || undefined, context: { reset: true, source: "codex/last_request" } };
  const p = row?.type === "event_msg" ? row.payload : undefined;
  if (p?.type !== "token_count") return undefined;
  const last = p.info?.last_token_usage;
  const used = last?.total_tokens ?? (Number(last?.input_tokens) + Number(last?.output_tokens));
  return {
    observedAt: Date.parse(row.timestamp) || undefined,
    ...(Number.isFinite(used) && used >= 0 ? { context: { used, max: p.info.model_context_window, source: "codex/last_request" } } : {}),
    ...(p.rate_limits ? { rateLimits: p.rate_limits } : {}),
  };
}
// One directory walk serves every thread looking up its session at once (boot restores them all); misses retry after 2 s.
let listing: { at: number; root: string; files: string[] } | undefined;
function sessionFile(root: string, session: string) {
  if (!listing || listing.root !== root || Date.now() - listing.at > 2000) {
    listing = { at: Date.now(), root, files: [] };
    try { listing.files = [...fs.globSync("**/*.jsonl", { cwd: root })]; } catch {}
  }
  const match = listing.files.find(f => f.endsWith(`${session}.jsonl`));
  return match && path.join(root, match);
}
// Tail only new bytes, bounded to 512 KiB. Prompts and completions never leave this reader.
export class CodexTelemetry {
  private file?: string;
  private offset = 0;
  private partial = Buffer.alloc(0);
  private searched = 0;
  constructor(privateSession: string) { this.session = privateSession; }
  private session: string;
  read() {
    if (!/^[\w-]+$/.test(this.session)) return [];
    if (!this.file && Date.now() - this.searched > 2000) {
      this.searched = Date.now();
      const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
      this.file = sessionFile(root, this.session);
    }
    if (!this.file) return [];
    const stat = fs.statSync(this.file, { throwIfNoEntry: false });
    if (!stat || stat.size === this.offset) return [];
    if (stat.size < this.offset) { this.offset = 0; this.partial = Buffer.alloc(0); }
    const start = Math.max(this.offset, stat.size - 512 * 1024);
    const buf = Buffer.alloc(stat.size - start);
    const fd = fs.openSync(this.file, "r");
    try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
    let body = start === this.offset && this.partial.length ? Buffer.concat([this.partial, buf]) : buf;
    if (start > this.offset) body = body.subarray(body.indexOf(10) + 1);
    const last = body.lastIndexOf(10);
    this.partial = Buffer.from(body.subarray(last + 1));
    this.offset = stat.size;
    // Only token counts and compactions matter; never decode the transcript lines around them.
    return linesWith(body.subarray(0, last + 1), ['"token_count"', '"compacted"'])
      .flatMap(l => { try { const ev = codexTokenEvent(JSON.parse(l)); return ev ? [ev] : []; } catch { return []; } });
  }
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
// Tail only new bytes, bounded to 512 KiB. Prompts and completions never leave this reader.
export class CodexTelemetry {
  private file?: string;
  private offset = 0;
  private partial = "";
  private searched = 0;
  constructor(privateSession: string) { this.session = privateSession; }
  private session: string;
  read() {
    if (!/^[\w-]+$/.test(this.session)) return [];
    if (!this.file && Date.now() - this.searched > 2000) {
      this.searched = Date.now();
      const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
      try { const match = [...fs.globSync(`**/*${this.session}.jsonl`, { cwd: root })][0]; if (match) this.file = path.join(root, match); } catch {}
    }
    if (!this.file) return [];
    const stat = fs.statSync(this.file, { throwIfNoEntry: false });
    if (!stat || stat.size === this.offset) return [];
    if (stat.size < this.offset) { this.offset = 0; this.partial = ""; }
    const start = Math.max(this.offset, stat.size - 512 * 1024);
    const buf = Buffer.alloc(stat.size - start);
    const fd = fs.openSync(this.file, "r");
    try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
    let text = (start === this.offset ? this.partial : "") + buf.toString("utf8");
    if (start > this.offset) text = text.slice(text.indexOf("\n") + 1);
    const lines = text.split("\n");
    this.partial = lines.pop() || "";
    this.offset = stat.size;
    return lines.flatMap(l => { try { const ev = codexTokenEvent(JSON.parse(l)); return ev ? [ev] : []; } catch { return []; } });
  }
}

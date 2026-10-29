import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { claudeConfigDir } from "./providers/claude-accounts.ts";
import type { Thread } from "./threads.ts";

export interface AllocationCategory {
  id: string;
  label: string;
  tokens: number;
  estimated: boolean;
}
export interface ContextAllocation {
  used: number | null;
  max: number | null;
  source: string;
  categories: AllocationCategory[];
  note: string;
}
const labels: Record<string, string> = {
  system: "System and instructions",
  tools: "Tool definitions",
  messages: "Messages",
  tool_results: "Tool results",
  unknown: "Other / unobserved",
  free: "Free space",
};
const MAX_BYTES = 16 * 1024 * 1024;
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const estimate = (value: unknown) =>
  Math.ceil((typeof value === "string" ? value.length : JSON.stringify(value ?? "").length) / 4);

// Only inspect textual content. Encrypted compaction state, image data, and opaque payloads
// cannot be translated into tokens and belong in the unobserved remainder.
function contentSize(value: any): number {
  if (typeof value === "string") return estimate(value);
  if (!Array.isArray(value)) return 0;
  return value.reduce(
    (sum, block) =>
      sum +
      (typeof block === "string"
        ? estimate(block)
        : typeof block?.text === "string"
          ? estimate(block.text)
          : block?.type === "tool_use"
            ? estimate({ name: block.name, input: block.input })
            : 0),
    0,
  );
}
function addMessage(counts: Record<string, number>, message: any) {
  if (!message) return;
  const type = message.type;
  if (["function_call_output", "custom_tool_call_output"].includes(type)) {
    counts.tool_results += contentSize(message.output);
    return;
  }
  if (["function_call", "custom_tool_call"].includes(type)) {
    counts.messages += estimate(message.arguments ?? message.input ?? "");
    return;
  }
  if (type && type !== "message" && !message.role) return;
  const category = ["system", "developer"].includes(message.role) ? "system" : "messages";
  const blocks = message.content;
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      if (block?.type === "tool_result") counts.tool_results += contentSize(block.content);
      else counts[category] += contentSize([block]);
    }
  } else counts[category] += contentSize(blocks);
}

type ClaudeRequestIndex = {
  blobs: Map<string, any>;
  shapes: Map<string, any>;
  requests: Map<string, any>;
  latest: any;
};
function indexClaudeRequests(rows: any[]): ClaudeRequestIndex {
  const index: ClaudeRequestIndex = {
    blobs: new Map<string, any>(),
    shapes: new Map<string, any>(),
    requests: new Map<string, any>(),
    latest: undefined,
  };
  for (const row of rows) {
    if (row.type === "api-request-blob") index.blobs.set(row.hash, row.message);
    if (row.type === "api-request-shape") index.shapes.set(row.shapeHash, row.shape);
    if (row.type === "api-request") {
      index.requests.set(row.id, row);
      index.latest = row;
    }
  }
  return index;
}
// Resolve only the latest request. Walk backwards through retained prefixes, collecting
// disjoint tail segments instead of copying every historical request's full hash list.
function claudeTailSegments(index: ClaudeRequestIndex): string[][] | undefined {
  const segments: string[][] = [],
    seen = new Set<any>();
  let row = index.latest,
    needed = Infinity;
  for (let depth = 0; ; depth++) {
    if (!row || seen.has(row) || depth >= 4096 || !Array.isArray(row.tail)) return undefined;
    seen.add(row);
    const keep = row.base ? Number(row.keep) : 0;
    if (!Number.isSafeInteger(keep) || keep < 0) return undefined;
    if (Number.isFinite(needed) && needed > keep + row.tail.length) return undefined;
    const tailCount = Math.max(0, Math.min(row.tail.length, needed - keep));
    segments.push(row.tail.slice(0, tailCount));
    needed = Math.min(needed, keep);
    if (needed === 0) break;
    row = index.requests.get(row.base);
  }
  return segments;
}
function claudeAllocationCounts(rows: any[]): Record<string, number> | undefined {
  const counts = { system: 0, tools: 0, messages: 0, tool_results: 0 };
  const index = indexClaudeRequests(rows);
  if (!index.latest) return undefined;
  const segments = claudeTailSegments(index);
  if (!segments) return undefined;
  const shape = index.shapes.get(index.latest.shapeHash);
  if (shape) {
    counts.system = contentSize(shape.system);
    counts.tools = Array.isArray(shape.tools) && shape.tools.length ? estimate(shape.tools) : 0;
  }
  for (let position = segments.length - 1; position >= 0; position--) {
    for (const hash of segments[position]) addMessage(counts, index.blobs.get(hash));
  }
  return counts;
}
function codexAllocationCounts(rows: any[]): Record<string, number> | undefined {
  const counts = { system: 0, tools: 0, messages: 0, tool_results: 0 };
  let active: any[] = [],
    seenStart = false,
    base: any;
  for (const row of rows) {
    if (row.type === "session_meta") {
      seenStart = true;
      base = row.payload?.base_instructions;
    }
    if (row.type === "compacted") {
      // Missing replacement history means the retained state is opaque. Never reuse old rows.
      active = Array.isArray(row.payload?.replacement_history)
        ? [...row.payload.replacement_history]
        : [];
      seenStart = true;
    }
    if (row.type === "response_item") active.push(row.payload);
  }
  if (!seenStart) return undefined;
  if (base) counts.system = contentSize(typeof base === "string" ? base : base.text);
  for (const item of active) addMessage(counts, item);
  return counts;
}

/** Extract only retained native request contents, never the cumulative visible transcript. */
export function nativeAllocationCounts(
  provider: string,
  rows: any[],
): Record<string, number> | undefined {
  if (provider === "claude") return claudeAllocationCounts(rows);
  if (provider === "codex") return codexAllocationCounts(rows);
  return undefined;
}

function allocationCategories(
  used: number,
  max: number | null,
  counts?: Record<string, number>,
): AllocationCategory[] {
  const categories: AllocationCategory[] = [];
  const entries = Object.entries(counts || {}).filter(
    ([id, count]) => labels[id] && finite(count) && count > 0,
  );
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  // Character estimates may exceed measured usage. Scale down only, preserving an honest
  // unknown remainder when native system context or opaque compaction is unavailable.
  const scale = total > used ? used / total : 1;
  let allocated = 0;
  for (const [id, count] of entries) {
    const tokens = Math.floor(count * scale);
    allocated += tokens;
    if (tokens) categories.push({ id, label: labels[id], tokens, estimated: true });
  }
  if (used > allocated)
    categories.push({
      id: "unknown",
      label: labels.unknown,
      tokens: used - allocated,
      estimated: true,
    });
  if (max !== null && max > used)
    categories.push({ id: "free", label: labels.free, tokens: max - used, estimated: false });
  return categories;
}

export function buildContextAllocation(
  thread: Pick<Thread, "context" | "provider">,
  counts?: Record<string, number>,
): ContextAllocation {
  const used = finite(thread.context?.used) ? Math.round(thread.context.used) : null;
  const max =
    finite(thread.context?.max) && thread.context.max > 0 ? Math.round(thread.context.max) : null;
  const categories = used !== null ? allocationCategories(used, max, counts) : [];
  return {
    used,
    max,
    source: counts ? `${thread.provider}/native-context` : `${thread.provider}/usage-only`,
    categories,
    note: "Total usage comes from provider telemetry. Category counts estimate retained native text at four characters per token. Other includes hidden instructions, memory, images, encrypted summaries, and tokenizer differences. Categories may reflect the last sent request; they are not provider-exact token counts.",
  };
}

const locations = new Map<string, string>();
async function sessionFile(thread: Thread): Promise<string | undefined> {
  if (!thread.sessionId || !/^[\w-]+$/.test(thread.sessionId)) return;
  const key = `${thread.provider}:${thread.claudeAccount || "primary"}:${thread.sessionId}`;
  if (locations.has(key)) return locations.get(key);
  const root =
    thread.provider === "codex"
      ? path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions")
      : thread.provider === "claude"
        ? path.join(claudeConfigDir(thread.claudeAccount), "projects")
        : undefined;
  if (!root) return;
  for await (const relative of fs.glob(`**/*${thread.sessionId}.jsonl`, { cwd: root })) {
    // Claude subagent logs are nested under a session; select only the session itself.
    if (thread.provider === "claude" && path.basename(relative) !== `${thread.sessionId}.jsonl`)
      continue;
    const file = path.join(root, relative);
    if (locations.size >= 128) locations.delete(locations.keys().next().value!);
    locations.set(key, file);
    return file;
  }
}

/** Read-only local metadata endpoint: no provider calls, prompts, or filesystem paths returned. */
export async function contextAllocation(thread: Thread): Promise<ContextAllocation> {
  try {
    const file = await sessionFile(thread);
    if (file) {
      const handle = await fs.open(file, "r");
      try {
        const stat = await handle.stat();
        // A partial old session can omit request bases or compaction boundaries. Use unknown
        // rather than accidentally count an archived transcript as active context.
        if (stat.size <= MAX_BYTES) {
          const bytes = Buffer.alloc(stat.size);
          let offset = 0;
          while (offset < bytes.length) {
            const { bytesRead } = await handle.read(
              bytes,
              offset,
              Math.min(256 * 1024, bytes.length - offset),
              offset,
            );
            if (!bytesRead) break;
            offset += bytesRead;
          }
          // A concurrent truncate would leave an incomplete request chain.
          if (offset !== bytes.length) return buildContextAllocation(thread);
          const rows = bytes
            .toString("utf8")
            .split("\n")
            .flatMap((line) => {
              try {
                return [JSON.parse(line)];
              } catch {
                return [];
              }
            });
          return buildContextAllocation(thread, nativeAllocationCounts(thread.provider, rows));
        }
      } finally {
        await handle.close();
      }
    }
  } catch {
    /* Missing, inaccessible, or changing native sessions retain measured totals. */
  }
  return buildContextAllocation(thread);
}

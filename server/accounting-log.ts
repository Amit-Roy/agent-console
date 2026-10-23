import { type Accounting, codexAccounting, piAccounting, SessionAccounting } from "./accounting.ts";

/** Reconstruct only provider-reported usage; never infer a price for missing telemetry. */
export function accountingSamples(
  raw: string,
  thread: { id: string; provider: string; model?: string; createdAt?: number },
) {
  const accounting = new SessionAccounting();
  let session = thread.id,
    start: number | undefined,
    usage: any,
    compact = false,
    confirmed = false;
  let tools: Record<string, number> = {};
  const samples: ({
    ts: number;
    tools?: Record<string, number>;
    ms?: number;
    err?: 1;
  } & Accounting)[] = [];
  for (const line of raw.split("\n")) {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "system" && ev.subtype === "init" && ev.session_id) {
      if (session !== ev.session_id) accounting.seedFork(ev.session_id, session);
      session = ev.session_id;
    }
    if (ev.type === "user_input" && typeof ev.ts === "number" && start == null) {
      start = ev.ts;
      usage = undefined;
      tools = {};
      compact = /^\/compact(?:\s|$)/.test(ev.text || "");
      confirmed = false;
    }
    if (ev.type === "system" && ev.subtype === "compact_boundary") confirmed = true;
    if (ev.type === "token_usage") usage = ev;
    if (ev.type === "assistant")
      for (const b of ev.message?.content || [])
        if (b?.type === "tool_use") tools[b.name] = (tools[b.name] || 0) + 1;
    if (ev.type !== "result") continue;
    if (compact && !confirmed && ev.num_turns === 0 && !ev.is_error) continue;
    const measured: Accounting = ev.modelUsage
      ? accounting.consume(ev.session_id || session, ev)
      : ev.usageModels
        ? piAccounting(ev.usageModels)
        : thread.provider === "codex" && usage
          ? codexAccounting(usage, thread.model || "unknown")
          : {
              accounting: 2,
              ...(thread.provider === "pi" && typeof ev.total_cost_usd === "number"
                ? { cost: ev.total_cost_usd }
                : {}),
            };
    if (start != null && start >= (thread.createdAt || 0) && !measured.duplicate)
      samples.push({
        ts: start,
        ...measured,
        ms: ev.duration_ms,
        ...(ev.is_error ? { err: 1 } : {}),
        ...(Object.keys(tools).length ? { tools } : {}),
      });
    start = undefined;
    usage = undefined;
    compact = false;
  }
  return samples;
}

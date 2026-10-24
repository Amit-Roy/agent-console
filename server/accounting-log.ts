import { type Accounting, codexAccounting, piAccounting, SessionAccounting } from "./accounting.ts";

type AccountingThread = { id: string; provider: string; model?: string; createdAt?: number };
type AccountingSample = {
  ts: number;
  tools?: Record<string, number>;
  ms?: number;
  err?: 1;
} & Accounting;

type ReplayState = {
  accounting: SessionAccounting;
  thread: AccountingThread;
  session: string;
  start: number | undefined;
  usage: any;
  compact: boolean;
  confirmed: boolean;
  tools: Record<string, number>;
  samples: AccountingSample[];
};

function trackSession(state: ReplayState, event: any) {
  if (event.type !== "system" || event.subtype !== "init" || !event.session_id) return;
  if (state.session !== event.session_id)
    state.accounting.seedFork(event.session_id, state.session);
  state.session = event.session_id;
}

function trackToolUse(state: ReplayState, event: any) {
  for (const block of event.message?.content || [])
    if (block?.type === "tool_use") state.tools[block.name] = (state.tools[block.name] || 0) + 1;
}

function trackTurnEvent(state: ReplayState, event: any) {
  trackSession(state, event);
  if (event.type === "user_input" && typeof event.ts === "number" && state.start == null) {
    state.start = event.ts;
    state.usage = undefined;
    state.tools = {};
    state.compact = /^\/compact(?:\s|$)/.test(event.text || "");
    state.confirmed = false;
  }
  if (event.type === "system" && event.subtype === "compact_boundary") state.confirmed = true;
  if (event.type === "token_usage") state.usage = event;
  if (event.type === "assistant") trackToolUse(state, event);
}

function measureResult(state: ReplayState, event: any): Accounting {
  const { thread } = state;
  if (event.modelUsage) return state.accounting.consume(event.session_id || state.session, event);
  if (event.usageModels) return piAccounting(event.usageModels);
  if (thread.provider === "codex" && state.usage)
    return codexAccounting(state.usage, thread.model || "unknown");
  return {
    accounting: 2,
    ...(thread.provider === "pi" && typeof event.total_cost_usd === "number"
      ? { cost: event.total_cost_usd }
      : {}),
  };
}

function finishResult(state: ReplayState, event: any) {
  if (state.compact && !state.confirmed && event.num_turns === 0 && !event.is_error) return;
  const measured = measureResult(state, event);
  const { start, tools } = state;
  if (start != null && start >= (state.thread.createdAt || 0) && !measured.duplicate)
    state.samples.push({
      ts: start,
      ...measured,
      ms: event.duration_ms,
      ...(event.is_error ? { err: 1 } : {}),
      ...(Object.keys(tools).length ? { tools } : {}),
    });
  state.start = undefined;
  state.usage = undefined;
  state.compact = false;
}

/** Reconstruct only provider-reported usage; never infer a price for missing telemetry. */
export function accountingSamples(raw: string, thread: AccountingThread) {
  const state: ReplayState = {
    accounting: new SessionAccounting(),
    thread,
    session: thread.id,
    start: undefined,
    usage: undefined,
    compact: false,
    confirmed: false,
    tools: {},
    samples: [],
  };
  for (const line of raw.split("\n")) {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    trackTurnEvent(state, event);
    if (event.type === "result") finishResult(state, event);
  }
  return state.samples;
}

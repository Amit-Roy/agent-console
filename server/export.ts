import { toolName, toolSummary } from "../public/tool-display.js";
// Turns a thread's event log into readable text: for Download / Share (Markdown) and for seeding a forked thread whose agent has
// no native fork (the earlier conversation is replayed as a transcript in its first prompt).

export interface Turn {
  role: "user" | "agent";
  text: string;
  tool?: boolean; // a tool call or error line, not words the agent said
}

const oneLine = (s: string, n = 160) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/** user_input / assistant text / tool calls, in order. `tools:false` keeps only what was said. */
export function turnsOf(events: any[], opts: { tools?: boolean } = {}): Turn[] {
  const labels = new Map<string, string>();
  const updates = new Map<string, any>();
  for (const e of events) if (e?.type === "tool_label") labels.set(e.tool_use_id, e.label);
  for (const e of events) if (e?.type === "tool_update") updates.set(e.tool_use_id, e);
  const out: Turn[] = [];
  const push = (role: Turn["role"], text: string, tool = false) => {
    if (text.trim()) out.push({ role, text, ...(tool ? { tool: true } : {}) });
  };
  for (const e of events) {
    if (e?.type === "user_input" && !e.auto && !e.questionAnswer) {
      const names = (e.attachments ?? []).map((a: any) => a.name);
      push("user", [e.text ?? "", ...(names.length ? [`(attached: ${names.join(", ")})`] : [])].filter(Boolean).join("\n"));
    } else if (e?.type === "question") {
      for (const q of e.questions ?? []) push("agent", q.question);
    } else if (e?.type === "question_answer") {
      if (e.cancelled) continue;
      push("user", e.skip ? "Skipped these questions; continue with your best judgment." : e.note ?? Object.values<string[]>(e.answers ?? {}).map(a => a.join(", ")).join("\n"));
    } else if (e?.type === "assistant") {
      for (const original of e.message?.content ?? []) {
        const update = original.type === "tool_use" && updates.get(original.id);
        const b = update ? { ...original, name: update.name, input: update.input } : original;
        if (b.type === "text") push("agent", b.text);
        else if (b.type === "tool_use" && opts.tools !== false) {
          const what = labels.get(b.id) || b.input?.description || toolSummary(b.name, b.input || {});
          push("agent", `${toolName(b.name, b.input)}${what && what !== "{}" ? `: ${oneLine(String(what))}` : ""}`, true);
        }
      }
    } else if (e?.type === "console_error" && opts.tools !== false) push("agent", `Error: ${oneLine(String(e.text), 300)}`, true);
  }
  return out;
}

export function threadToMarkdown(t: { title: string; provider: string; model: string; cwd: string; createdAt: number }, label: string, events: any[]): string {
  const lines = [`# ${t.title}`, "", `*${label} · ${t.model} · ${t.cwd} · started ${new Date(t.createdAt).toISOString().slice(0, 16).replace("T", " ")} UTC*`, ""];
  let last: Turn["role"] | undefined;
  for (const turn of turnsOf(events)) {
    if (turn.role !== last) lines.push(turn.role === "user" ? "## You" : "## Agent", "");
    last = turn.role;
    lines.push(turn.tool ? `> ${turn.text.replace(/\n/g, " ")}` : turn.text, ""); // tool lines are quoted so they read as activity
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** Context for an agent that cannot fork natively: the earlier conversation as plain text, newest part kept if it is long. */
export function replayPreamble(events: any[], maxChars = 24_000): string {
  const body = turnsOf(events, { tools: false }).map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`).join("\n\n");
  const clipped = body.length > maxChars ? "… (earlier part omitted)\n\n" + body.slice(body.length - maxChars) : body;
  return `This conversation was forked from an earlier one. Here is what was said so far (tool output omitted); continue from it.\n\n--- earlier conversation ---\n${clipped}\n--- end of earlier conversation ---\n\n`;
}

/** A bounded, local handoff: no summarizer call and no native session history carried into the new run. */
export function recentPreamble(events: any[], maxChars = 6000): string {
  const limit = Math.max(0, Math.floor(maxChars));
  const header = "This is a fresh session with a short handoff: the initial request and recent conversation only. Earlier constraints may be omitted; the full transcript remains available in Console. Inspect the working tree before continuing.\n\n";
  if (limit <= header.length) return header.slice(0, limit);
  const turns = turnsOf(events.filter(e => !e?.parent_tool_use_id), { tools: false });
  const recent = turns.slice(-6);
  const first = turns.find(t => t.role === "user");
  const excerpt = (s: string, n: number) => s.length <= n ? s : n < 40 ? s.slice(0, n) : s.slice(0, Math.floor((n - 25) / 2)) + "\n… (middle omitted) …\n" + s.slice(-Math.floor((n - 25) / 2));
  let budget = limit - header.length;
  let initial = "";
  if (first && !recent.includes(first)) {
    initial = "Initial request: " + excerpt(first.text, Math.max(0, Math.min(1200, Math.floor(budget / 4))));
    budget -= initial.length + 2;
  }
  const parts: string[] = [];
  for (const turn of recent.toReversed()) {
    const label = turn.role === "user" ? "User: " : "Assistant: ";
    const available = Math.min(1200, budget - label.length - 2);
    if (available <= 0) break;
    const text = label + excerpt(turn.text, available);
    parts.unshift(text);
    budget -= text.length + 2;
  }
  return (header + [initial, ...parts].filter(Boolean).join("\n\n") + "\n\n").slice(0, limit);
}

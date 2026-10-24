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

type TurnContext = {
  labels: Map<string, string>;
  updates: Map<string, any>;
  out: Turn[];
  tools: boolean;
};
function pushTurn(context: TurnContext, role: Turn["role"], text: string, tool = false) {
  if (text.trim()) context.out.push({ role, text, ...(tool ? { tool: true } : {}) });
}
function userInputText(event: any) {
  const names = (event.attachments ?? []).map((attachment: any) => attachment.name);
  return [event.text ?? "", ...(names.length ? [`(attached: ${names.join(", ")})`] : [])]
    .filter(Boolean)
    .join("\n");
}
function answerText(event: any) {
  if (event.skip) return "Skipped these questions; continue with your best judgment.";
  return (
    event.note ??
    Object.values<string[]>(event.answers ?? {})
      .map((answer) => answer.join(", "))
      .join("\n")
  );
}
function toolCallText(context: TurnContext, block: any) {
  const what =
    context.labels.get(block.id) ||
    block.input?.description ||
    toolSummary(block.name, block.input || {});
  return `${toolName(block.name, block.input)}${what && what !== "{}" ? `: ${oneLine(String(what))}` : ""}`;
}
function pushAssistantTurns(context: TurnContext, event: any) {
  for (const original of event.message?.content ?? []) {
    const update = original.type === "tool_use" && context.updates.get(original.id);
    const block = update ? { ...original, name: update.name, input: update.input } : original;
    if (block.type === "text") pushTurn(context, "agent", block.text);
    else if (block.type === "tool_use" && context.tools)
      pushTurn(context, "agent", toolCallText(context, block), true);
  }
}
function pushEventTurns(context: TurnContext, event: any) {
  switch (event?.type) {
    case "user_input":
      if (!event.auto && !event.questionAnswer) pushTurn(context, "user", userInputText(event));
      return;
    case "question":
      for (const question of event.questions ?? []) pushTurn(context, "agent", question.question);
      return;
    case "question_answer":
      if (!event.cancelled) pushTurn(context, "user", answerText(event));
      return;
    case "assistant":
      pushAssistantTurns(context, event);
      return;
    case "console_error":
      if (context.tools)
        pushTurn(context, "agent", `Error: ${oneLine(String(event.text), 300)}`, true);
  }
}

/** user_input / assistant text / tool calls, in order. `tools:false` keeps only what was said. */
export function turnsOf(events: any[], opts: { tools?: boolean } = {}): Turn[] {
  const context: TurnContext = {
    labels: new Map<string, string>(),
    updates: new Map<string, any>(),
    out: [],
    tools: opts.tools !== false,
  };
  for (const event of events)
    if (event?.type === "tool_label") context.labels.set(event.tool_use_id, event.label);
  for (const event of events)
    if (event?.type === "tool_update") context.updates.set(event.tool_use_id, event);
  for (const event of events) pushEventTurns(context, event);
  return context.out;
}

export function threadToMarkdown(
  t: { title: string; provider: string; model: string; cwd: string; createdAt: number },
  label: string,
  events: any[],
): string {
  const lines = [
    `# ${t.title}`,
    "",
    `*${label} · ${t.model} · ${t.cwd} · started ${new Date(t.createdAt).toISOString().slice(0, 16).replace("T", " ")} UTC*`,
    "",
  ];
  let last: Turn["role"] | undefined;
  for (const turn of turnsOf(events)) {
    if (turn.role !== last) lines.push(turn.role === "user" ? "## You" : "## Agent", "");
    last = turn.role;
    lines.push(turn.tool ? `> ${turn.text.replace(/\n/g, " ")}` : turn.text, ""); // tool lines are quoted so they read as activity
  }
  return (
    lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n"
  );
}

/** Context for an agent that cannot fork natively: the earlier conversation as plain text, newest part kept if it is long. */
export function replayPreamble(events: any[], maxChars = 24_000): string {
  const body = turnsOf(events, { tools: false })
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`)
    .join("\n\n");
  const clipped =
    body.length > maxChars
      ? "… (earlier part omitted)\n\n" + body.slice(body.length - maxChars)
      : body;
  return `This conversation was forked from an earlier one. Here is what was said so far (tool output omitted); continue from it.\n\n--- earlier conversation ---\n${clipped}\n--- end of earlier conversation ---\n\n`;
}

/** A bounded, local handoff: no summarizer call and no native session history carried into the new run. */
export function recentPreamble(events: any[], maxChars = 6000): string {
  const limit = Math.max(0, Math.floor(maxChars));
  const header =
    "This is a fresh session with a short handoff: the initial request and recent conversation only. Earlier constraints may be omitted; the full transcript remains available in Console. Inspect the working tree before continuing.\n\n";
  if (limit <= header.length) return header.slice(0, limit);
  const turns = turnsOf(
    events.filter((e) => !e?.parent_tool_use_id),
    { tools: false },
  );
  const recent = turns.slice(-6);
  const first = turns.find((t) => t.role === "user");
  const excerpt = (s: string, n: number) =>
    s.length <= n
      ? s
      : n < 40
        ? s.slice(0, n)
        : s.slice(0, Math.floor((n - 25) / 2)) +
          "\n… (middle omitted) …\n" +
          s.slice(-Math.floor((n - 25) / 2));
  let budget = limit - header.length;
  let initial = "";
  if (first && !recent.includes(first)) {
    initial =
      "Initial request: " +
      excerpt(first.text, Math.max(0, Math.min(1200, Math.floor(budget / 4))));
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

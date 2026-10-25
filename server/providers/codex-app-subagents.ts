import { codexTranslator } from "./codex.ts";
import { adaptItem } from "./codex-app-items.ts";
import type { AgentCtx } from "./types.ts";

interface ChildAgent {
  path: string;
  call: string;
  text: string;
  translate: (row: any) => void;
  done?: boolean;
  failed?: string;
}

const PARENT_ACTIVITY_TYPES = ["agentMessage", "reasoning", "commandExecution", "mcpToolCall"];

// A subagent that dies (usage exhausted, crash) never sends subAgentActivity "completed"; without this it counts as background work forever.
function childFailure(method: string, params: any): string {
  if (method === "turn/completed" && ["failed", "interrupted"].includes(params.turn?.status))
    return params.turn?.error?.message || `turn ${params.turn.status}`;
  if (method === "error" && !params.willRetry) return params.error?.message || "Codex error.";
  return "";
}

// Subagents by thread id. Codex does not start a parent turn when one finishes after the parent's turn ended, so we do.
export class SubagentTracker {
  readonly children = new Map<string, ChildAgent>();
  heartbeat = 0; // child progress never reaches ctx.event otherwise; the stale-background sweep needs proof of life
  unseen: string[] = []; // finished while the parent turn ran, before the parent model looked again
  private readonly ctx: AgentCtx;

  constructor(ctx: AgentCtx) {
    this.ctx = ctx;
  }

  backgroundChanged(): void {
    this.ctx.event({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [...this.children]
        .filter(([, child]) => !child.done)
        .map(([threadId, child]) => ({
          task_id: threadId,
          tool_use_id: child.call,
          description: child.path,
        })),
    });
  }

  doneText(threadId: string): string {
    const child = this.children.get(threadId)!;
    if (child.failed) return `[Background subagent ${child.path} failed: ${child.failed}]`;
    return `[Background subagent ${child.path} finished. Its final message:]\n${child.text.trim() || "(no message)"}`;
  }

  // A notification for another thread than the parent session.
  onChildNotification(method: string, params: any, busy: boolean): void {
    const child = this.children.get(params.threadId);
    if (!child) return;
    if (!child.done && Date.now() - this.heartbeat > 60_000) {
      this.heartbeat = Date.now();
      this.ctx.event({ type: "system", subtype: "task_updated", task_id: params.threadId });
    }
    if (
      method === "item/completed" &&
      params.item?.type === "agentMessage" &&
      typeof params.item.text === "string"
    )
      child.text = params.item.text;
    // Child output reaches the parent card through the child's own translator, tagged with the spawning call. Turn lifecycle is never fed to it.
    if (!child.done && (method === "item/started" || method === "item/completed"))
      forwardChildItem(child, params.item || {}, method === "item/completed");
    const failure = childFailure(method, params);
    if (!child.done && failure) {
      child.done = true;
      child.failed = failure.slice(0, 300);
      this.ctx.event({
        type: "system",
        subtype: "task_notification",
        task_id: params.threadId,
        tool_use_id: child.call,
        status: "failed",
        summary: child.failed,
      });
      this.settled(params.threadId, busy);
    }
  }

  // The parent model ran after the result arrived.
  noteParentActivity(itemType: string): void {
    if (
      itemType !== "subAgentActivity" &&
      this.unseen.length &&
      PARENT_ACTIVITY_TYPES.includes(itemType)
    )
      this.unseen = [];
  }

  // A subAgentActivity item in the parent thread.
  onActivity(item: any, done: boolean, busy: boolean): void {
    if (!done || !item.agentThreadId) return;
    const child = this.children.get(item.agentThreadId);
    if (item.kind === "started" && !this.children.has(item.agentThreadId)) this.started(item);
    else if (item.kind === "completed" && child && !child.done)
      this.completed(item.agentThreadId, child, busy);
  }

  wakeUnseen(): void {
    for (const threadId of this.unseen.splice(0))
      this.ctx.event({ type: "subagent_wake", text: this.doneText(threadId) });
  }

  private started(item: any): void {
    const ctx = this.ctx;
    this.children.set(item.agentThreadId, {
      path: item.agentPath || "subagent",
      call: item.id,
      text: "",
      translate: codexTranslator((event) => ctx.event({ ...event, parent_tool_use_id: item.id })),
    });
    ctx.event({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: item.id,
            name: "Agent",
            input: { description: item.agentPath || "Subagent" },
          },
        ],
      },
    });
    ctx.event({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: item.id,
            content: "Started in the background.",
          },
        ],
      },
    });
    ctx.event({
      type: "system",
      subtype: "task_started",
      task_id: item.agentThreadId,
      tool_use_id: item.id,
      task_type: "local_agent",
      is_backgrounded: true,
      description: item.agentPath,
    });
    this.backgroundChanged();
  }

  private completed(threadId: string, child: ChildAgent, busy: boolean): void {
    child.done = true;
    this.ctx.event({
      type: "system",
      subtype: "task_notification",
      task_id: threadId,
      tool_use_id: child.call,
      status: "completed",
      summary: child.text.slice(0, 300),
    });
    this.settled(threadId, busy);
  }

  private settled(threadId: string, busy: boolean): void {
    this.backgroundChanged();
    if (busy) this.unseen.push(threadId);
    else this.ctx.event({ type: "subagent_wake", text: this.doneText(threadId) });
  }
}

function forwardChildItem(child: ChildAgent, item: any, done: boolean): void {
  const row = adaptItem(item, done);
  if (row)
    child.translate(
      row.item?.questions ? { ...row, item: { ...row.item, questions: undefined } } : row,
    ); // a child cannot raise a console question card
}

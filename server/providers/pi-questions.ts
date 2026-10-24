import { QUESTION_DIALOG } from "./pi-questions-extension.mjs";
import { cleanQuestions, type QuestionReply } from "./types.ts";

interface PendingQuestion {
  rpcId: string;
  method: string;
  structured: boolean;
  toolCallId?: string;
  timer?: NodeJS.Timeout;
}

interface QuestionContext {
  pending: Map<string, PendingQuestion>;
  write: (msg: object) => void;
  emit: (event: any) => void;
}

function cancelQuestion(ctx: QuestionContext, questionId: string) {
  const entry = ctx.pending.get(questionId);
  if (!entry) return;
  clearTimeout(entry.timer);
  ctx.pending.delete(questionId);
  ctx.emit({ type: "question_answer", id: questionId, cancelled: true });
}

function cancelSettled(ctx: QuestionContext, req: any) {
  if (req?.type === "agent_settled") {
    for (const questionId of ctx.pending.keys()) cancelQuestion(ctx, questionId);
  }
  if (req?.type === "tool_execution_end") {
    for (const [questionId, entry] of ctx.pending)
      if (entry.toolCallId === req.toolCallId) cancelQuestion(ctx, questionId);
  }
}

function structuredPayload(req: any): any {
  if (req.method !== "input" || req.title !== QUESTION_DIALOG) return undefined;
  let payload: any;
  try {
    payload = JSON.parse(req.placeholder);
  } catch {}
  return payload?.agentConsoleQuestions === 1 ? payload : undefined;
}

function plainQuestionOptions(req: any) {
  if (req.method === "confirm") return [{ label: "Yes" }, { label: "No" }];
  return req.method === "select" ? req.options : [];
}

function requestQuestions(req: any, payload: any) {
  if (payload)
    return cleanQuestions(
      Array.isArray(payload.questions)
        ? payload.questions.map((question: any) => ({ ...question, allowOther: true }))
        : [],
    );
  return cleanQuestions([
    {
      id: "answer",
      question: [req.title, req.message].filter(Boolean).join("\n\n"),
      options: plainQuestionOptions(req),
      allowOther: ["input", "editor"].includes(req.method),
    },
  ]);
}

function handleQuestionRequest(ctx: QuestionContext, req: any): boolean {
  cancelSettled(ctx, req);
  if (req?.type !== "extension_ui_request") return false;
  if (!["select", "confirm", "input", "editor"].includes(req.method)) return true;
  const payload = structuredPayload(req);
  const questions = requestQuestions(req, payload);
  if (!questions.length) {
    ctx.write({ type: "extension_ui_response", id: req.id, cancelled: true });
    return true;
  }
  const questionId = `pi-${req.id}`;
  const entry = {
    rpcId: req.id,
    method: req.method,
    structured: !!payload,
    toolCallId: payload?.toolCallId,
    timer: undefined as NodeJS.Timeout | undefined,
  };
  ctx.pending.set(questionId, entry);
  if (Number.isFinite(req.timeout) && req.timeout > 0)
    entry.timer = setTimeout(() => cancelQuestion(ctx, questionId), req.timeout).unref();
  ctx.emit({ type: "question", id: questionId, questions, ts: Date.now() });
  return true;
}

function questionResponse(entry: PendingQuestion, reply: QuestionReply, value: string): object {
  if (reply.skip) return { cancelled: true };
  if (entry.structured)
    return {
      value: JSON.stringify(
        reply.note !== undefined ? { note: reply.note } : { answers: reply.answers },
      ),
    };
  if (entry.method !== "confirm") return { value };
  return reply.note !== undefined ? { cancelled: true } : { confirmed: value === "Yes" };
}

function answerQuestion(ctx: QuestionContext, questionId: string, reply: QuestionReply): boolean {
  const entry = ctx.pending.get(questionId);
  if (!entry) throw new Error("This question is no longer waiting for an answer.");
  const value = reply.note ?? Object.values(reply.answers).flat().join(", ");
  const response = questionResponse(entry, reply, value);
  ctx.write({ type: "extension_ui_response", id: entry.rpcId, ...response });
  clearTimeout(entry.timer);
  ctx.pending.delete(questionId);
  return reply.note !== undefined && entry.method !== "confirm";
}

// Pi's extension UI is a separate RPC subprotocol. Dialog ids are owned by Pi;
// keep their lifetime separate from command acknowledgements and model turns.
export function piQuestions(write: (msg: object) => void, emit: (event: any) => void) {
  const ctx: QuestionContext = { pending: new Map(), write, emit };
  return {
    cancelAll() {
      for (const questionId of ctx.pending.keys()) cancelQuestion(ctx, questionId);
    },
    handle(req: any): boolean {
      return handleQuestionRequest(ctx, req);
    },
    answer(questionId: string, reply: QuestionReply): boolean {
      return answerQuestion(ctx, questionId, reply);
    },
  };
}

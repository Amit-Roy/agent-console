import { cleanQuestions, type QuestionReply } from "./types.ts";
import { QUESTION_DIALOG } from "./pi-questions-extension.mjs";

// Pi's extension UI is a separate RPC subprotocol. Dialog ids are owned by Pi;
// keep their lifetime separate from command acknowledgements and model turns.
export function piQuestions(write: (msg: object) => void, emit: (ev: any) => void) {
  const pending = new Map<
    string,
    {
      rpcId: string;
      method: string;
      structured: boolean;
      toolCallId?: string;
      timer?: NodeJS.Timeout;
    }
  >();
  const cancel = (id: string) => {
    const p = pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(id);
    emit({ type: "question_answer", id, cancelled: true });
  };
  return {
    cancelAll() {
      for (const id of pending.keys()) cancel(id);
    },
    handle(r: any): boolean {
      if (r?.type === "agent_settled") {
        for (const id of pending.keys()) cancel(id);
      }
      if (r?.type === "tool_execution_end") {
        for (const [id, p] of pending) if (p.toolCallId === r.toolCallId) cancel(id);
      }
      if (r?.type !== "extension_ui_request") return false;
      if (!["select", "confirm", "input", "editor"].includes(r.method)) return true;
      let payload: any;
      if (r.method === "input" && r.title === QUESTION_DIALOG) {
        try {
          payload = JSON.parse(r.placeholder);
        } catch {}
        if (payload?.agentConsoleQuestions !== 1) payload = undefined;
      }
      const questions = payload
        ? cleanQuestions(
            Array.isArray(payload.questions)
              ? payload.questions.map((q: any) => ({ ...q, allowOther: true }))
              : [],
          )
        : cleanQuestions([
            {
              id: "answer",
              question: [r.title, r.message].filter(Boolean).join("\n\n"),
              options:
                r.method === "confirm"
                  ? [{ label: "Yes" }, { label: "No" }]
                  : r.method === "select"
                    ? r.options
                    : [],
              allowOther: ["input", "editor"].includes(r.method),
            },
          ]);
      if (!questions.length) {
        write({ type: "extension_ui_response", id: r.id, cancelled: true });
        return true;
      }
      const id = `pi-${r.id}`;
      const p = {
        rpcId: r.id,
        method: r.method,
        structured: !!payload,
        toolCallId: payload?.toolCallId,
        timer: undefined as NodeJS.Timeout | undefined,
      };
      pending.set(id, p);
      if (Number.isFinite(r.timeout) && r.timeout > 0)
        p.timer = setTimeout(() => cancel(id), r.timeout).unref();
      emit({ type: "question", id, questions, ts: Date.now() });
      return true;
    },
    answer(id: string, reply: QuestionReply): boolean {
      const p = pending.get(id);
      if (!p) throw new Error("This question is no longer waiting for an answer.");
      const value = reply.note ?? Object.values(reply.answers).flat().join(", ");
      const response = reply.skip
        ? { cancelled: true }
        : p.structured
          ? {
              value: JSON.stringify(
                reply.note !== undefined ? { note: reply.note } : { answers: reply.answers },
              ),
            }
          : p.method === "confirm"
            ? reply.note !== undefined
              ? { cancelled: true }
              : { confirmed: value === "Yes" }
            : { value };
      write({ type: "extension_ui_response", id: p.rpcId, ...response });
      clearTimeout(p.timer);
      pending.delete(id);
      return reply.note !== undefined && p.method !== "confirm";
    },
  };
}

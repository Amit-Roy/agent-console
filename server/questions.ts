import {
  type Agent,
  cleanQuestions,
  type Question,
  type QuestionReply,
} from "./providers/types.ts";

export interface PendingQuestion {
  type: "question";
  id: string;
  questions: Question[];
  ts?: number;
  async?: true;
}

// Blocking requests belong to a live process; async messages remain answerable after it exits.
export class Questions {
  private threads = new Map<string, Map<string, PendingQuestion>>();
  list(thread: string): PendingQuestion[] {
    return [...(this.threads.get(thread)?.values() ?? [])];
  }
  all() {
    return Object.fromEntries([...this.threads].map(([id]) => [id, this.list(id)]));
  }
  add(thread: string, event: any): PendingQuestion {
    if (typeof event.id !== "string" || !event.id || event.id.length > 500)
      throw new Error("Invalid question request.");
    const questions = cleanQuestions(event.questions);
    if (!questions.length || new Set(questions.map((q) => q.id)).size !== questions.length)
      throw new Error("Invalid question request.");
    if (event.async && questions.some((q) => q.secret))
      throw new Error("Secret fields require a blocking question.");
    const pending = this.threads.get(thread) ?? new Map();
    if (pending.has(event.id)) throw new Error("Duplicate question request.");
    const request = { ...event, type: "question" as const, questions };
    pending.set(event.id, request);
    this.threads.set(thread, pending);
    return request;
  }
  remove(thread: string, id: string) {
    const pending = this.threads.get(thread);
    const request = pending?.get(id);
    pending?.delete(id);
    if (!pending?.size) this.threads.delete(thread);
    return request;
  }
  answer(
    thread: string,
    id: string,
    raw: unknown,
    agent?: Agent,
    skip = false,
    note?: string,
    deliver?: (reply: QuestionReply) => boolean,
  ) {
    const request = this.threads.get(thread)?.get(id);
    if (!request || (!deliver && (!agent?.alive || !agent.answer)))
      throw new Error("This question is no longer waiting for an answer.");
    if (!skip && note === undefined && (!raw || typeof raw !== "object" || Array.isArray(raw)))
      throw new Error("Invalid answers.");
    const answers: Record<string, string[]> = Object.create(null);
    if (!skip && note === undefined) {
      for (const key of Object.keys(raw))
        if (!request.questions.some((q) => q.id === key)) throw new Error("Unknown question.");
      for (const q of request.questions) {
        const values = (raw as Record<string, unknown>)[q.id];
        if (
          !Array.isArray(values) ||
          !values.length ||
          values.length > 20 ||
          values.some((a) => typeof a !== "string" || !a.trim() || a.length > 10_000)
        )
          throw new Error("Answer each question before continuing.");
        if (!q.multiSelect && values.length !== 1)
          throw new Error("Choose one answer for this question.");
        if (new Set(values).size !== values.length) throw new Error("Duplicate answer.");
        if (
          q.options.length &&
          !q.allowOther &&
          values.some((a) => !q.options.some((o) => o.label === a))
        )
          throw new Error("Choose one of the available answers.");
        answers[q.id] = values;
      }
    }
    const reply: QuestionReply = {
      answers,
      ...(skip ? { skip: true } : {}),
      ...(note !== undefined ? { note } : {}),
    };
    // Remove first: an adapter may synchronously emit completion or a result while writing the response.
    this.remove(thread, id);
    let consumed: boolean;
    try {
      consumed = deliver ? deliver(reply) : agent!.answer!(id, reply);
    } catch (error) {
      this.add(thread, request);
      throw error;
    }
    const visible = Object.fromEntries(
      request.questions
        .filter((q) => answers[q.id])
        .map((q) => [q.id, q.secret ? ["••••••"] : answers[q.id]]),
    );
    return {
      consumed,
      event: {
        type: "question_answer",
        id,
        answers: visible,
        ...(skip ? { skip: true } : {}),
        ...(note !== undefined
          ? { note: request.questions.some((q) => q.secret) ? "••••••" : note }
          : {}),
        ts: Date.now(),
      },
    };
  }
}

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

function validateAnswerValues(question: Question, values: unknown): string[] {
  if (
    !Array.isArray(values) ||
    !values.length ||
    values.length > 20 ||
    values.some((value) => typeof value !== "string" || !value.trim() || value.length > 10_000)
  )
    throw new Error("Answer each question before continuing.");
  if (!question.multiSelect && values.length !== 1)
    throw new Error("Choose one answer for this question.");
  if (new Set(values).size !== values.length) throw new Error("Duplicate answer.");
  if (
    question.options.length &&
    !question.allowOther &&
    values.some((value) => !question.options.some((option) => option.label === value))
  )
    throw new Error("Choose one of the available answers.");
  return values;
}

function collectAnswers(
  request: PendingQuestion,
  raw: Record<string, unknown>,
  answers: Record<string, string[]>,
) {
  for (const key of Object.keys(raw))
    if (!request.questions.some((question) => question.id === key))
      throw new Error("Unknown question.");
  for (const question of request.questions)
    answers[question.id] = validateAnswerValues(question, raw[question.id]);
}

function buildAnswerEvent(
  request: PendingQuestion,
  requestId: string,
  answers: Record<string, string[]>,
  skip: boolean,
  note: string | undefined,
) {
  const visible = Object.fromEntries(
    request.questions
      .filter((question) => answers[question.id])
      .map((question) => [question.id, question.secret ? ["••••••"] : answers[question.id]]),
  );
  return {
    type: "question_answer",
    id: requestId,
    answers: visible,
    ...(skip ? { skip: true } : {}),
    ...(note !== undefined
      ? { note: request.questions.some((question) => question.secret) ? "••••••" : note }
      : {}),
    ts: Date.now(),
  };
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
    if (!skip && note === undefined)
      collectAnswers(request, raw as Record<string, unknown>, answers);
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
    return {
      consumed,
      event: buildAnswerEvent(request, id, answers, skip, note),
    };
  }
}

import { cleanQuestions, type Question, type QuestionReply } from "./types.ts";

export interface CodexQuestionCard {
  questions: Question[];
  consumesNote: boolean;
  reply(answer: QuestionReply): any;
}

const FORM_FIELD_TYPES = ["string", "boolean", "number", "integer", "array"];

// Codex asks the user through app-server server requests (exec mode refuses: "request_user_input not supported in exec mode"):
//   item/tool/requestUserInput   {questions:[{id,header,question,isOther,isSecret,options:[{label,description}]|null}]}
//                                -> {answers:{[id]:{answers:[...]}}}; no answers = "continue with best judgment"
//   mcpServer/elicitation/request (mode "form") an MCP server's JSON-schema form -> {action:"accept"|"decline", content}
// request_user_input is offered to the model in Plan collaboration mode, or in default mode behind the
// default_mode_request_user_input feature, which we enable (AGENT_CONSOLE_CODEX_ASK=0 turns it off). Returns undefined for
// requests that cannot be shown as a question card.
export function codexQuestion(method: string, params: any): CodexQuestionCard | undefined {
  if (method === "item/tool/requestUserInput" && Array.isArray(params?.questions))
    return userInputCard(params.questions);
  if (
    method === "mcpServer/elicitation/request" &&
    ["form", "openai/form"].includes(params?.mode) &&
    params.requestedSchema?.properties
  )
    return elicitationCard(params);
  return undefined;
}

function userInputCard(rawQuestions: any[]): CodexQuestionCard {
  const questions = cleanQuestions(
    rawQuestions.map((raw: any) => ({
      ...raw,
      options: raw.options ?? [],
      allowOther: raw.isOther || !raw.options?.length,
      secret: raw.isSecret,
    })),
  );
  return {
    questions,
    consumesNote: true,
    reply: (answer) => userInputReply(questions, answer),
  };
}

function userInputReply(questions: Question[], reply: QuestionReply) {
  if (reply.note !== undefined)
    return { answers: questions[0] ? { [questions[0].id]: { answers: [reply.note] } } : {} };
  if (reply.skip) return { answers: {} };
  return {
    answers: Object.fromEntries(
      questions
        .map((question) => [
          question.id,
          { answers: (reply.answers[question.id] ?? []).map(String).filter(Boolean) },
        ])
        .filter(([, entry]: any) => entry.answers.length),
    ),
  };
}

function enumValues(schema: any): string[] {
  return (
    schema?.enum ??
    schema?.oneOf?.map((option: any) => option.const) ??
    schema?.anyOf?.map((option: any) => option.const) ??
    []
  );
}

// Nested objects and large forms need a dedicated form renderer. Decline
// unsupported schemas instead of silently truncating or changing their types.
function unsupportedField(schema: any): boolean {
  if (!schema || !FORM_FIELD_TYPES.includes(schema.type)) return true;
  const isArray = schema.type === "array";
  if (isArray && schema.items?.type !== "string" && !Array.isArray(schema.items?.enum)) return true;
  return enumValues(isArray ? schema.items : schema).length > 20;
}

function elicitationCard(params: any): CodexQuestionCard | undefined {
  const fields = Object.entries<any>(params.requestedSchema.properties);
  const required = new Set<string>(params.requestedSchema.required ?? []);
  if (!fields.length || fields.length > 10 || fields.some(([, schema]) => unsupportedField(schema)))
    return undefined;
  const questions = cleanQuestions(
    fields.map(([key, schema], index) =>
      fieldQuestion(params, key, schema, index, required.has(key)),
    ),
  );
  return {
    questions,
    consumesNote: false,
    reply: (answer) => elicitationReply(fields, required, answer),
  };
}

function fieldQuestion(params: any, key: string, schema: any, index: number, isRequired: boolean) {
  const multi = schema.type === "array";
  const values =
    schema.type === "boolean" ? ["Yes", "No"] : enumValues(multi ? schema.items : schema);
  const first = index === 0;
  return {
    id: key,
    header: first ? params.serverName : undefined,
    question:
      [first ? params.message : "", schema.title || schema.description || key]
        .filter(Boolean)
        .join("\n\n") + (isRequired ? "" : " (optional)"),
    options: values.map((value: string) => ({ label: String(value) })),
    multiSelect: multi,
    allowOther: !values.length,
  };
}

function elicitationReply(fields: [string, any][], required: Set<string>, reply: QuestionReply) {
  if (reply.skip || reply.note !== undefined)
    return { action: "decline", content: null, _meta: null };
  const content: Record<string, unknown> = {};
  for (const [key, schema] of fields) {
    const values = (reply.answers[key] ?? []).map(String).filter(Boolean);
    if (!values.length) {
      if (required.has(key)) throw new Error(`Please answer ${schema.title || key}.`);
      continue;
    }
    validateField(key, schema, values[0]);
    content[key] = fieldValue(schema, values);
  }
  return { action: "accept", content, _meta: null };
}

function validateField(key: string, schema: any, first: string): void {
  const label = schema.title || key;
  const numeric = schema.type === "number" || schema.type === "integer";
  if (
    numeric &&
    (!Number.isFinite(Number(first)) ||
      (schema.type === "integer" && !Number.isInteger(Number(first))))
  )
    throw new Error(`Enter a valid ${schema.type} for ${label}.`);
  if (schema.type === "boolean" && !["Yes", "No"].includes(first))
    throw new Error(`Choose Yes or No for ${label}.`);
}

function fieldValue(schema: any, values: string[]): unknown {
  if (schema.type === "array") return values;
  if (schema.type === "boolean") return values[0] === "Yes";
  if (schema.type === "number" || schema.type === "integer") return Number(values[0]);
  return values[0];
}

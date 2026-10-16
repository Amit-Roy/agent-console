import { completeLabel } from "./small-model.ts";

// A new thread is titled after its folder. After the first message, Haiku (on the user's Claude login) names it after what is
// actually being discussed. One small headless call per thread: no tools, no MCP, no hooks, no project settings (~600 tokens).

const MAX_INPUT = 1500;
const MAX_WORDS = 6;

const PROMPT = (message: string) =>
  `Write a title of 2 to 5 words for a chat that begins with the message below. Reply with ONLY the title: no quotes, no trailing punctuation, no explanation.\n\nMessage:\n${message}`;

/** Model output -> a tidy thread title, or undefined when it does not look like one. */
export function cleanTitle(raw: unknown): string | undefined {
  let t = String(raw ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  t = t.replace(/^(?:title|name)\s*:\s*/i, "").replace(/^[#>*\-\s"'“”‘’`]+|[\s"'“”‘’`*.!:;,]+$/g, "").replace(/\s+/g, " ");
  const words = t.split(" ");
  if (!t || words.length > MAX_WORDS + 4) return undefined; // a sentence, not a title
  t = words.slice(0, MAX_WORDS).join(" ");
  return t.length > 48 ? t.slice(0, 47).trimEnd() + "…" : t;
}

/** Deterministic stand-in for tests (AGENT_CONSOLE_MOCK=1): the first few words of the message. */
const fake = (message: string) => cleanTitle(message.split(/\s+/).slice(0, 4).join(" "));

export async function suggestTitle(message: string): Promise<string | undefined> {
  const text = message.trim().slice(0, MAX_INPUT);
  if (!text) return undefined;
  if (process.env.AGENT_CONSOLE_MOCK === "1") return fake(text);
  return completeLabel(PROMPT(text), "You write short conversation titles.", cleanTitle);
}

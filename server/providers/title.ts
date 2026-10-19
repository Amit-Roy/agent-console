import { completeLabel } from "./small-model.ts";

// A new thread is titled after its folder. After each prompt with substance, Nemotron (via NVIDIA, a free model; never Haiku or
// Luna) names it after what is being discussed: all user messages, text only, newest first within a character budget.
// One small call: no tools, no MCP, no hooks.

export const MAX_INPUT = 100_000; // chars of user text per call; the oldest messages fall off first
const MAX_WORDS = 5;
export const MAX_TITLE = 30; // chars: a sidebar row shows about this many before it truncates

const PROMPT = (messages: string[]) =>
  `Write a title of 2 to 4 words, at most ${MAX_TITLE} characters, for a chat from its user messages below, oldest first. Later messages matter more: name what the chat is about now. Reply with ONLY the title: no quotes, no trailing punctuation, no explanation.\n\nMessages:\n${messages.map((m) => `- ${m}`).join("\n")}`;

/** One user message as plain text for naming: media references dropped, whitespace collapsed. */
export function titleText(message: unknown): string {
  return String(message ?? "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // markdown images
    .replace(/\[(?:Image|Video|Audio|File)\s*#?\d*\]/gi, " ") // attachment placeholders
    .replace(/data:[a-z]+\/[^\s)]+/gi, " ") // inline data URLs
    .replace(/\s+/g, " ").trim();
}

/** Non-empty user messages, cleaned for naming, oldest first. The newest fill the budget; the one that overflows is cut short. */
export function titleInput(messages: unknown[], budget = MAX_INPUT): string[] {
  const kept: string[] = [];
  for (const m of messages.map(titleText).filter(Boolean).reverse()) {
    if (m.length <= budget) { kept.push(m); budget -= m.length; continue; }
    if (budget >= 200) kept.push(m.slice(0, budget).trim()); // enough left to say something; otherwise stop
    break;
  }
  return kept.reverse();
}

/** Model output -> a tidy thread title, or undefined when it does not look like one. */
export function cleanTitle(raw: unknown): string | undefined {
  let t = String(raw ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  t = t.replace(/^(?:title|name)\s*:\s*/i, "").replace(/^[#>*\-\s"'“”‘’`]+|[\s"'“”‘’`*.!:;,]+$/g, "").replace(/\s+/g, " ");
  const words = t.split(" ");
  if (!t || words.length > MAX_WORDS + 4) return undefined; // a sentence, not a title
  let kept = words.slice(0, MAX_WORDS);
  while (kept.length > 1 && kept.join(" ").length > MAX_TITLE) kept.pop(); // drop whole words rather than cut one
  return kept.join(" ").slice(0, MAX_TITLE).trimEnd();
}

/** Deterministic stand-in for tests (AGENT_CONSOLE_MOCK=1): the first few words of the latest message. */
const fake = (messages: string[]) => cleanTitle(messages[messages.length - 1].split(" ").slice(0, 4).join(" "));

export async function suggestTitle(messages: string | string[]): Promise<string | undefined> {
  const input = titleInput([messages].flat());
  if (!input.length) return undefined;
  if (process.env.AGENT_CONSOLE_MOCK === "1") return fake(input);
  return completeLabel(PROMPT(input), "You write short conversation titles.", cleanTitle);
}

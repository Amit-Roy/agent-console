import { completeLabel } from "./small-model.ts";

// A new thread is titled after its folder. After the first message, and again every few prompts, Nemotron (via NVIDIA) names it
// after what is being discussed now: its last two user messages, text only. One small call: no tools, no MCP, no hooks.

export const MAX_MESSAGES = 2;
const MAX_MESSAGE = 100; // chars per message, so the model sees at most 200
const MAX_WORDS = 5;
export const MAX_TITLE = 30; // chars: a sidebar row shows about this many before it truncates

const PROMPT = (messages: string[]) =>
  `Write a title of 2 to 4 words, at most ${MAX_TITLE} characters, for a chat from its latest user messages below, oldest first. Reply with ONLY the title: no quotes, no trailing punctuation, no explanation.\n\nMessages:\n${messages.map((m) => `- ${m}`).join("\n")}`;

/** One user message as plain text for naming: media references dropped, whitespace collapsed, capped at 100 chars. */
export function titleText(message: unknown): string {
  return String(message ?? "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // markdown images
    .replace(/\[(?:Image|Video|Audio|File)\s*#?\d*\]/gi, " ") // attachment placeholders
    .replace(/data:[a-z]+\/[^\s)]+/gi, " ") // inline data URLs
    .replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE).trim();
}

/** The last two non-empty user messages, cleaned for naming. */
export const titleInput = (messages: unknown[]) => messages.map(titleText).filter(Boolean).slice(-MAX_MESSAGES);

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

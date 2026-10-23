import { completeLabel } from "./small-model.ts";
import metrics from "./title-metrics.json" with { type: "json" };

// A new thread is titled after its folder. After each prompt with substance, Nemotron (via NVIDIA, a free model; never Haiku or
// Luna) names it after what is being discussed: all user messages, text only, oldest first within a character budget.
// One small call: no tools, no MCP, no hooks.

export const MAX_INPUT = 100_000; // chars of user text per call; the oldest messages fall off first
const MAX_WORDS = 3;
const MAX_TOPIC = 8;
export const MAX_TITLE = 20;
const MAX_TITLE_WIDTH = 174; // px: 180px running desktop row, with 6px reserve; Android has 220px
const advances: Record<string, number> = metrics.advances;

function titleWidth(text: string): number {
  // Pad 14px default Inter advances by 5% for the selected medium weight.
  // Reserve two ems for glyphs supplied by a fallback font.
  return Array.from(text).reduce((px, c) => {
    const code = c.codePointAt(0)!;
    return (
      px + (advances[code] !== undefined ? (advances[code] * 14 * 1.05) / metrics.unitsPerEm : 28)
    );
  }, 0);
}

/** Shared character and pixel budgets for generated titles, preserving whole feature words when possible. */
export function fitTitle(input: { prefix: string; text: string }): { title: string } {
  const fits = (text: string) => text.length <= MAX_TITLE && titleWidth(text) <= MAX_TITLE_WIDTH;
  const kept = input.text.trim().split(" ");
  while (kept.length > 1 && !fits(input.prefix + kept.join(" "))) kept.pop();
  let feature = "";
  for (const c of kept.join(" ")) {
    if (!fits(input.prefix + feature + c)) break;
    feature += c;
  }
  return { title: input.prefix + feature.trimEnd() };
}

const PROMPT = (messages: string[]) =>
  `Write a title in Topic:feat format, at most ${MAX_WORDS} words total and ${MAX_TITLE} characters including the colon. Topic is one short subject (at most ${MAX_TOPIC} characters); feat means the specific feature or task, not the literal word "feat". Examples: Auth:fix redirect, Chat:image paste. For a chat from its user messages below, oldest first. Later messages matter more: name what the chat is about now. Reply with ONLY the title: no quotes, no trailing punctuation, no explanation.\n\nMessages:\n${messages.map((m) => `- ${m}`).join("\n")}`;

/** One user message as plain text for naming: media references dropped, whitespace collapsed. */
export function titleText(message: unknown): string {
  return String(message ?? "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // markdown images
    .replace(/\[(?:Image|Video|Audio|File)\s*#?\d*\]/gi, " ") // attachment placeholders
    .replace(/data:[a-z]+\/[^\s)]+/gi, " ") // inline data URLs
    .replace(/\s+/g, " ")
    .trim();
}

/** Non-empty user messages, cleaned for naming, oldest first. The newest fill the budget; the one that overflows is cut short. */
export function titleInput(messages: unknown[], budget = MAX_INPUT): string[] {
  const kept: string[] = [];
  for (const m of messages.map(titleText).filter(Boolean).reverse()) {
    if (m.length <= budget) {
      kept.push(m);
      budget -= m.length;
      continue;
    }
    if (budget >= 200) kept.push(m.slice(0, budget).trim()); // enough left to say something; otherwise stop
    break;
  }
  return kept.reverse();
}

/** Model output -> a tidy thread title, or undefined when it does not look like one. */
export function cleanTitle(raw: unknown): string | undefined {
  let t =
    String(raw ?? "")
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? "";
  t = t
    .replace(/^(?:title|name)\s*:\s*(?=[^:]*:)/i, "")
    .replace(/^[#>*\-\s"'“”‘’`]+|[\s"'“”‘’`*.!:;,]+$/g, "")
    .replace(/\s+/g, " ");
  const match = /^([^\s:]+)\s*:\s*([^:]+)$/.exec(t);
  if (!match) return undefined;
  const words = match[2].trim().split(" ");
  if (words.length > MAX_WORDS + 4) return undefined; // a sentence, not a title
  let topic = Array.from(match[1]).slice(0, MAX_TOPIC).join("");
  while (Array.from(topic).length > 1 && titleWidth(`${topic}:`) > MAX_TITLE_WIDTH / 2)
    topic = Array.from(topic).slice(0, -1).join("");
  const kept = words.slice(0, MAX_WORDS - 1);
  const prefix = `${topic}:`;
  const { title } = fitTitle({ prefix, text: kept.join(" ") });
  return title.length > prefix.length ? title : undefined;
}

/** Deterministic stand-in for tests (AGENT_CONSOLE_MOCK=1), using the same format and validator. */
const fake = (messages: string[]) => {
  const text = messages[messages.length - 1];
  if (text.includes(":")) return cleanTitle(text);
  const [topic, ...feature] = text.split(" ");
  return cleanTitle(`${topic}:${feature.slice(0, MAX_WORDS - 1).join(" ")}`);
};

export async function suggestTitle(messages: string | string[]): Promise<string | undefined> {
  const input = titleInput([messages].flat());
  if (!input.length) return undefined;
  if (process.env.AGENT_CONSOLE_MOCK === "1") return fake(input);
  return completeLabel(PROMPT(input), "You write short conversation titles.", cleanTitle);
}

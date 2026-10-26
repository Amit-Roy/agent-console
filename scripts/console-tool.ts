import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { callTool } from "../server/providers/console-tools.mjs";

export const CONSOLE_TOOL_USAGE = [
  "console-tool search TERMS [--provider claude|codex|pi] [--limit N]   past sessions (BM25)",
  "console-tool read SESSION LINE [--limit N]                           bounded range of a session found by search",
  "console-tool cli TERMS...                                            find command-line tools",
  'console-tool research "TASK" [--folder DIR]                          Pi research subagent; takes up to 11 min: run with run_in_background',
  "console-tool redact scan|apply|verify|status [--job ID]             transcript credential cleanup",
  "Needs an Agent Console session (tool URL/token). Output is clipped to 20000 chars.",
].join("\n");

export const OUTPUT_LIMIT = 20_000;
const PROVIDERS = ["claude", "codex", "pi"];
const REDACT_ACTIONS = ["scan", "apply", "verify", "status"];

type ToolRequest = { tool: string; input: Record<string, unknown>; timeoutMs: number };

function wholeNumber(text: string | undefined, label: string): number | undefined {
  if (text === undefined) return undefined;
  if (!/^[1-9]\d{0,5}$/.test(text)) throw new Error(`${label} must be a positive integer.`);
  return Number(text);
}

function withDefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function requireWords(words: string[], what: string): string[] {
  if (words.length === 0 || words.some((word) => word.trim() === ""))
    throw new Error(`Give ${what}.\n${CONSOLE_TOOL_USAGE}`);
  return words;
}

export function parseConsoleToolArgs(args: string[]): ToolRequest | undefined {
  const { positionals, values } = parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h" },
      provider: { type: "string" },
      limit: { type: "string" },
      folder: { type: "string" },
      job: { type: "string" },
    },
    allowPositionals: true,
  });
  if (values.help || positionals.length === 0) return;
  const [verb, ...rest] = positionals;
  const limit = wholeNumber(values.limit, "--limit");
  if (verb === "search") {
    if (values.provider !== undefined && !PROVIDERS.includes(values.provider))
      throw new Error(`--provider must be one of ${PROVIDERS.join(", ")}.`);
    const query = requireWords(rest, "search terms").join(" ");
    return {
      tool: "session_search",
      input: withDefined({ query, provider: values.provider, limit }),
      timeoutMs: 30_000,
    };
  }
  if (verb === "read") {
    if (rest.length !== 2) throw new Error(`read needs SESSION and LINE.\n${CONSOLE_TOOL_USAGE}`);
    const start = wholeNumber(rest[1], "LINE");
    return {
      tool: "session_read",
      input: withDefined({ thread: rest[0], start, limit }),
      timeoutMs: 30_000,
    };
  }
  if (verb === "cli")
    return {
      tool: "cli_search",
      input: { terms: requireWords(rest, "CLI search terms").slice(0, 10), ...withDefined({ limit }) },
      timeoutMs: 30_000,
    };
  if (verb === "research") {
    if (rest.length !== 1 || rest[0].trim() === "")
      throw new Error(`research needs one quoted TASK.\n${CONSOLE_TOOL_USAGE}`);
    return {
      tool: "pi_research",
      input: withDefined({ task: rest[0], folder: values.folder }),
      timeoutMs: 11 * 60_000,
    };
  }
  if (verb === "redact") {
    if (rest.length !== 1 || !REDACT_ACTIONS.includes(rest[0]))
      throw new Error(`redact needs one of ${REDACT_ACTIONS.join("|")}.`);
    return {
      tool: "session_redact",
      input: withDefined({ action: rest[0], job: values.job }),
      timeoutMs: 30_000,
    };
  }
  throw new Error(CONSOLE_TOOL_USAGE);
}

export function clipOutput(text: string): string {
  return text.length <= OUTPUT_LIMIT
    ? text
    : `${text.slice(0, OUTPUT_LIMIT)}\n... clipped ${text.length - OUTPUT_LIMIT} chars; narrow the query or use --limit.`;
}

export async function runConsoleTool(args: string[]): Promise<string> {
  const request = parseConsoleToolArgs(args);
  if (!request) return CONSOLE_TOOL_USAGE;
  const text: string = await callTool(
    request.tool,
    request.input,
    AbortSignal.timeout(request.timeoutMs),
  );
  if (text.startsWith("Error:") || text.startsWith("Agent Console is not reachable"))
    throw new Error(text.replace(/^Error:\s*/, ""));
  return clipOutput(text);
}

const entry = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";
if (entry === import.meta.url) {
  try {
    console.log(await runConsoleTool(process.argv.slice(2)));
  } catch (failure) {
    console.error(`console-tool: ${failure instanceof Error ? failure.message : "Command failed."}`);
    process.exitCode = 1;
  }
}

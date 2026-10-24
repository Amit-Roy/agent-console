import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// bin/share-trace <agentId>
// Prints a share-analyzer subagent's tool calls and final report as JSON for the safety classifier.
// Tool results are never included: they hold the untrusted asset contents.
const USAGE = "usage: share-trace <agentId>";
const MAX_INPUT_BYTES = 2048;
const MAX_REPORT_BYTES = 20480;
const AGENT_TYPE = "share-analyzer";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Claude config dirs that may hold the transcript: env override, default, second account. */
function configDirs(): string[] {
  const home = os.homedir();
  const dirs = [
    process.env.CLAUDE_CONFIG_DIR,
    path.join(home, ".claude"),
    path.join(home, ".claude-nefro"),
  ];
  return [...new Set(dirs.filter((dir): dir is string => !!dir))];
}

function findTranscript(agentId: string): string | undefined {
  const name = `agent-${agentId}.jsonl`;
  for (const dir of configDirs()) {
    const projects = path.join(dir, "projects");
    if (!fs.existsSync(projects)) continue;
    for (const slug of fs.readdirSync(projects)) {
      const sessions = path.join(projects, slug);
      if (!fs.statSync(sessions).isDirectory()) continue;
      for (const session of fs.readdirSync(sessions)) {
        const file = path.join(sessions, session, "subagents", name);
        if (fs.existsSync(file)) return file;
      }
    }
  }
  return undefined;
}

function truncate(text: string, limit: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return text;
  return `${bytes.subarray(0, limit).toString("utf8")}…[truncated ${bytes.length - limit} bytes]`;
}

type Call = { name: string; input: string; isError: boolean };
type Trace = { calls: Map<string, Call>; report: string };

function parseRecord(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function applyAssistant(trace: Trace, content: any[]) {
  const texts: string[] = [];
  for (const block of content) {
    if (block?.type === "tool_use")
      trace.calls.set(block.id, {
        name: String(block.name),
        input: truncate(JSON.stringify(block.input ?? {}), MAX_INPUT_BYTES),
        isError: false,
      });
    else if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
  }
  if (texts.length) trace.report = texts.join("\n");
}

/** Only the error flag of a tool_result is kept; its content is never read. */
function applyUser(trace: Trace, content: any[]) {
  for (const block of content) {
    const call = block?.type === "tool_result" ? trace.calls.get(block.tool_use_id) : undefined;
    if (call && block.is_error === true) call.isError = true;
  }
}

function readTrace(file: string) {
  const trace: Trace = { calls: new Map(), report: "" };
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const record = line.trim() ? parseRecord(line) : undefined;
    const content = record?.message?.content;
    if (!Array.isArray(content)) continue;
    if (record.type === "assistant") applyAssistant(trace, content);
    else if (record.type === "user") applyUser(trace, content);
  }
  return { toolCalls: [...trace.calls.values()], report: truncate(trace.report, MAX_REPORT_BYTES) };
}

function main() {
  const [agentId, ...rest] = process.argv.slice(2);
  if (!agentId || rest.length || !/^[A-Za-z0-9]+$/.test(agentId)) fail(USAGE);
  const file = findTranscript(agentId);
  if (!file) fail(`No subagent transcript found for ${agentId}.`);
  let agentType: unknown;
  try {
    agentType = JSON.parse(
      fs.readFileSync(file.replace(/\.jsonl$/, ".meta.json"), "utf8"),
    ).agentType;
  } catch {
    fail(`No readable meta file for ${agentId}.`);
  }
  if (agentType !== AGENT_TYPE) fail(`Agent ${agentId} is not a ${AGENT_TYPE} subagent.`);
  console.log(JSON.stringify({ agentId, ...readTrace(file) }, null, 2));
}

main();

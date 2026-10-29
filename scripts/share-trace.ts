import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// bin/share-trace <agentId> [--out <path>]
// Prints a share-analyzer subagent's tool calls and final report as JSON for the safety classifier.
// Tool results are never included: they hold the untrusted asset contents. Only a coarse
// `blocked` kind is derived from an error result's text; no result text is ever emitted.
// With --out the trace goes to a file (canonical path only), the analyzer's scratch `out/` dir is copied
// to a vetted dir next to it, the scratch dir is deleted, and stdout carries counts only.
const USAGE = "usage: share-trace <agentId> [--out <path>]";
const MAX_INPUT_BYTES = 2048;
const MAX_BASH_INPUT_BYTES = 8192;
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
    path.join(home, ".claude-secondary"),
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

type Blocked = "network" | "fs" | "denied" | "timeout" | null;
// Checked in order; first match wins.
const BLOCKED_PATTERNS: [Exclude<Blocked, null>, RegExp][] = [
  ["denied", /share jail unavailable|hook|has been denied|permission to use|blocked|not allowed/i],
  ["timeout", /timed out|timeout/i],
  [
    "network",
    /network is unreachable|could not resolve|name or service not known|temporary failure in name resolution|connection refused|no route to host|failed to connect/i,
  ],
  ["fs", /no such file|permission denied|read-only file system|not a directory|cannot access/i],
];

/** Flattens tool_result content to text for classification only; the text is never stored. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
}

function classifyBlocked(content: unknown): Blocked {
  const text = resultText(content);
  return BLOCKED_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

type Call = {
  name: string;
  input: string;
  truncated: boolean;
  isError: boolean;
  blocked: Blocked;
};
type Trace = { calls: Map<string, Call>; report: string };

function parseRecord(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function newCall(block: any): Call {
  const name = String(block.name);
  const full = JSON.stringify(block.input ?? {});
  const limit = name === "Bash" ? MAX_BASH_INPUT_BYTES : MAX_INPUT_BYTES;
  const input = truncate(full, limit);
  return { name, input, truncated: input !== full, isError: false, blocked: null };
}

function applyAssistant(trace: Trace, content: any[]) {
  const texts: string[] = [];
  for (const block of content) {
    if (block?.type === "tool_use") trace.calls.set(block.id, newCall(block));
    else if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
  }
  if (texts.length) trace.report = texts.join("\n");
}

/** Keeps the error flag and a coarse blocked kind (errors only); result text is never kept. */
function applyUser(trace: Trace, content: any[]) {
  for (const block of content) {
    const call = block?.type === "tool_result" ? trace.calls.get(block.tool_use_id) : undefined;
    if (!call || block.is_error !== true) continue;
    call.isError = true;
    call.blocked = classifyBlocked(block.content);
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
  return { toolCalls: [...trace.calls.values()], lastText: trace.report };
}

// ---- --out mode
const MAX_TRACE_BYTES = 64 * 1024;
const MAX_FINAL_BYTES = 2048;
const CHUNK_CHARS = 1400;
const MAX_OUT_FILES = 200;
const MAX_OUT_TOTAL = 512 * 1024 * 1024;
const MAX_SKIPPED_LISTED = 50;
const ACK = "REPORT WRITTEN";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OUT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const dataDir = () =>
  process.env.AGENT_CONSOLE_DATA || path.join(os.homedir(), ".config", "agent-console");

/** Accepts only DATA/uploads/<uuid>/.share/trace-<agentId>.json. */
function validateOutPath(out: string, agentId: string): string {
  const expectedName = `trace-${agentId}.json`;
  const parts = path.relative(path.join(dataDir(), "uploads"), out).split(path.sep);
  const canonical =
    path.isAbsolute(out) &&
    path.resolve(out) === out &&
    parts.length === 3 &&
    UUID.test(parts[0]) &&
    parts[1] === ".share" &&
    parts[2] === expectedName;
  if (!canonical) fail(`--out must be ${dataDir()}/uploads/<thread-uuid>/.share/${expectedName}`);
  return out;
}

/** Creates `dir` (0700) when missing; refuses a symlink or non-directory. */
function ensurePrivateDir(dir: string) {
  let info: fs.Stats | undefined;
  try {
    info = fs.lstatSync(dir);
  } catch {
    fs.mkdirSync(dir, { mode: 0o700 });
    return;
  }
  if (!info.isDirectory() || info.isSymbolicLink())
    fail(`Refusing non-directory or symlink: ${dir}`);
  fs.chmodSync(dir, 0o700);
}

type Skip = { name: string; reason: string };
type OutFile = { name: string; bytes: number };
type CopyResult = { files: OutFile[]; skipped: Skip[]; skippedMore: number; capped: boolean };

/** Opens a top-level regular file without following symlinks; returns an fd or a skip reason. */
function openRegular(file: string): number | string {
  let before: fs.Stats;
  try {
    before = fs.lstatSync(file);
  } catch {
    return "vanished";
  }
  if (before.isSymbolicLink()) return "symlink";
  if (!before.isFile()) return "not-regular";
  const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
  let fd: number;
  try {
    fd = fs.openSync(file, flags);
  } catch (error: any) {
    return error?.code === "ELOOP" ? "symlink" : "unreadable";
  }
  const after = fs.fstatSync(fd);
  if (after.isFile() && after.ino === before.ino && after.dev === before.dev) return fd;
  fs.closeSync(fd);
  return "changed";
}

/** Copies fd to `dest` (0600); returns bytes copied, or undefined (dest removed) when over `limit`. */
function copyFd(fd: number, dest: string, limit: number): number | undefined {
  const target = fs.openSync(dest, "wx", 0o600);
  const buffer = Buffer.alloc(1 << 20);
  let total = 0;
  let over = false;
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!read) break;
      total += read;
      over = total > limit;
      if (over) break;
      fs.writeSync(target, buffer, 0, read);
    }
  } finally {
    fs.closeSync(target);
  }
  if (over) fs.rmSync(dest, { force: true });
  return over ? undefined : total;
}

/** Copies one scratch file; returns its size, or the reason it was skipped. */
function copyOne(srcDir: string, destDir: string, name: string, budget: number): number | string {
  const fd = openRegular(path.join(srcDir, name));
  if (typeof fd === "string") return fd;
  try {
    return copyFd(fd, path.join(destDir, name), budget) ?? "too-large";
  } finally {
    fs.closeSync(fd);
  }
}

function addSkip(result: CopyResult, name: string, reason: string) {
  if (reason === "too-large" || reason === "too-many-files") result.capped = true;
  if (result.skipped.length < MAX_SKIPPED_LISTED) result.skipped.push({ name, reason });
  else result.skippedMore++;
}

/** Copies top-level regular files of the analyzer scratch dir into the vetted dir. */
function copyOutDir(srcDir: string, destDir: string): CopyResult {
  const result: CopyResult = { files: [], skipped: [], skippedMore: 0, capped: false };
  let info: fs.Stats | undefined;
  try {
    info = fs.lstatSync(srcDir);
  } catch {
    return result;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    addSkip(result, "out", "not-directory");
    return result;
  }
  let total = 0;
  const names = fs.readdirSync(srcDir).sort();
  for (const [index, name] of names.entries()) {
    // names that fail the pattern are never echoed: they could carry prompt text
    if (!OUT_NAME.test(name)) addSkip(result, `invalid-name-${index}`, "bad-name");
    else if (result.files.length >= MAX_OUT_FILES) addSkip(result, name, "too-many-files");
    else {
      const copied = copyOne(srcDir, destDir, name, MAX_OUT_TOTAL - total);
      if (typeof copied === "string") addSkip(result, name, copied);
      else {
        total += copied;
        result.files.push({ name, bytes: copied });
      }
    }
  }
  return result;
}

const escapedLength = (text: string) => JSON.stringify(text).length - 2;

/** Splits text so every chunk serializes to at most `limit` characters. */
function chunkText(text: string, limit = CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let current = "";
  let size = 0;
  for (const char of text) {
    const cost = escapedLength(char);
    if (size + cost > limit) {
      chunks.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += cost;
  }
  if (current) chunks.push(current);
  return chunks;
}

const maybeChunk = (text: string): string | string[] =>
  escapedLength(text) <= CHUNK_CHARS ? text : chunkText(text);

/** Reads at most `limit` bytes of report.md from the vetted copy. */
function readReport(vettedDir: string, files: OutFile[]) {
  const entry = files.find((file) => file.name === "report.md");
  if (!entry) return { text: "", bytes: 0, capped: false };
  const fd = fs.openSync(path.join(vettedDir, "report.md"), "r");
  try {
    const buffer = Buffer.alloc(Math.min(entry.bytes, MAX_REPORT_BYTES));
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return {
      text: buffer.subarray(0, read).toString("utf8"),
      bytes: entry.bytes,
      capped: entry.bytes > MAX_REPORT_BYTES,
    };
  } finally {
    fs.closeSync(fd);
  }
}

type OutTrace = {
  agentId: string;
  toolCalls: any[];
  droppedToolCalls: number;
  finalMessage: string | string[];
  finalMessageIsAck: boolean;
  report: string[];
  reportBytes: number;
  outFiles: OutFile[];
  skippedFiles: Skip[];
  skippedMore: number;
  truncated: boolean;
};

const serialize = (trace: OutTrace) => `${JSON.stringify(trace, null, 2)}\n`;
const fits = (trace: OutTrace) => Buffer.byteLength(serialize(trace)) <= MAX_TRACE_BYTES;

/** Shrinks the trace under the total cap: report chunks, then the final message, then trailing calls. */
function fitCap(trace: OutTrace): string {
  while (!fits(trace) && trace.report.length) {
    trace.report.pop();
    trace.truncated = true;
  }
  if (!fits(trace)) {
    trace.finalMessage = "";
    trace.truncated = true;
  }
  if (!fits(trace)) {
    const all = trace.toolCalls;
    let low = 0;
    let high = all.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      trace.toolCalls = all.slice(0, mid);
      if (fits(trace)) low = mid;
      else high = mid - 1;
    }
    trace.toolCalls = all.slice(0, low);
    trace.droppedToolCalls = all.length - low;
    trace.truncated = true;
  }
  return serialize(trace);
}

function outCall(call: Call) {
  return { ...call, input: maybeChunk(call.input) };
}

function writeFileNoFollow(file: string, text: string) {
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC;
  const fd = fs.openSync(file, flags | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
}

function writeOutMode(agentId: string, outPath: string, toolCalls: Call[], lastText: string) {
  const shareDir = path.dirname(outPath);
  const threadDir = path.dirname(shareDir);
  fs.mkdirSync(threadDir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(threadDir).isSymbolicLink()) fail(`Refusing symlink: ${threadDir}`);
  ensurePrivateDir(shareDir);
  const vettedDir = path.join(shareDir, agentId);
  fs.rmSync(vettedDir, { recursive: true, force: true });
  fs.mkdirSync(vettedDir, { mode: 0o700 });
  const runDir = path.join(dataDir(), "share-runs", agentId);
  const copy = copyOutDir(path.join(runDir, "out"), vettedDir);
  const report = readReport(vettedDir, copy.files);
  const finalText = truncate(lastText, MAX_FINAL_BYTES);
  const trace: OutTrace = {
    agentId,
    toolCalls: toolCalls.map(outCall),
    droppedToolCalls: 0,
    finalMessage: maybeChunk(finalText),
    finalMessageIsAck: lastText === ACK,
    report: chunkText(report.text),
    reportBytes: report.bytes,
    outFiles: copy.files,
    skippedFiles: copy.skipped,
    skippedMore: copy.skippedMore,
    truncated:
      copy.capped ||
      report.capped ||
      finalText !== lastText ||
      toolCalls.some((call) => call.truncated),
  };
  const text = fitCap(trace);
  writeFileNoFollow(outPath, text);
  fs.rmSync(runDir, { recursive: true, force: true });
  console.log(
    JSON.stringify({
      path: outPath,
      bytes: Buffer.byteLength(text),
      toolCalls: toolCalls.length,
      blockedCalls: toolCalls.filter((call) => call.blocked).length,
      truncatedCalls: toolCalls.filter((call) => call.truncated).length + trace.droppedToolCalls,
      outFiles: copy.files.length,
      reportBytes: report.bytes,
      finalMessageIsAck: trace.finalMessageIsAck,
      vettedDir,
    }),
  );
}

function loadTrace(agentId: string) {
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
  return readTrace(file);
}

function parseArgs(argv: string[]): { agentId: string; out?: string } {
  const [agentId, ...rest] = argv;
  if (!agentId || !/^[A-Za-z0-9]+$/.test(agentId)) fail(USAGE);
  if (!rest.length) return { agentId };
  if (rest.length !== 2 || rest[0] !== "--out" || !rest[1]) fail(USAGE);
  return { agentId, out: rest[1] };
}

function main() {
  const { agentId, out } = parseArgs(process.argv.slice(2));
  const outPath = out === undefined ? undefined : validateOutPath(out, agentId);
  const { toolCalls, lastText } = loadTrace(agentId);
  if (outPath) return writeOutMode(agentId, outPath, toolCalls, lastText);
  const report = truncate(lastText, MAX_REPORT_BYTES);
  console.log(JSON.stringify({ agentId, toolCalls, report }, null, 2));
}

main();

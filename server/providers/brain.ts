import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { SESSION_INSTRUCTIONS } from "./console-mcp.mjs";

// The shared "brain" wiki (~/repos/brain, see its CLAUDE.md) is one memory for every agent on this machine. Claude Code reaches it through
// user-level hooks. Pi and Codex have no equivalent installed, so we do the same two jobs here, for any harness:
//   recall: hand the harness only the same brain index the Claude hook injects when its process starts
//   save:   agents edit wiki pages themselves; after each turn we run `brain commit` (file-locked, idempotent)
export const BRAIN_BIN = process.env.AGENT_CONSOLE_BRAIN || path.join(os.homedir(), "repos", "brain", "bin", "brain");
// `brain context` prints wiki/index.md. Run it off the event loop (a sync exec stalled every request ~250 ms) and keep the result until
// the index changes (mtime+size, a cheap stat) or 5 minutes pass. Concurrent starts share one run.
const TTL = 5 * 60_000;
const INDEX = process.env.AGENT_CONSOLE_BRAIN_INDEX || path.join(path.dirname(path.dirname(BRAIN_BIN)), "wiki", "index.md");
const run = promisify(execFile);
let cache: { at: number; stamp: string; text: string } | undefined;
let inflight: { stamp: string; promise: Promise<string> } | undefined;
const indexStamp = () => { try { const s = fs.statSync(INDEX); return `${s.mtimeMs}:${s.size}`; } catch { return ""; } };

export const brainAvailable = () => fs.existsSync(BRAIN_BIN);

export function brainContext(): Promise<string> {
  if (!brainAvailable()) return Promise.resolve("");
  const stamp = indexStamp();
  if (cache && cache.stamp === stamp && Date.now() - cache.at < TTL) return Promise.resolve(cache.text);
  if (inflight?.stamp === stamp) return inflight.promise;
  const promise: Promise<string> = run(BRAIN_BIN, ["context"], { encoding: "utf8", timeout: 5000, env: { ...process.env, BRAIN_NO_NUDGE: "1" } })
    .then((r) => String(r.stdout).trim(), () => "")
    .then((text) => {
      cache = { at: Date.now(), stamp, text };
      if (inflight?.promise === promise) inflight = undefined;
      return text;
    });
  inflight = { stamp, promise };
  return promise;
}

export function brainCommit() {
  if (brainAvailable()) execFile(BRAIN_BIN, ["commit"], { timeout: 15_000 }, () => {});
}

// Reply-style preamble (ADHD + caveman ultra) shared by every harness, replacing the always-loaded caveman / i-have-adhd skills.
export const STYLE_FILE = process.env.AGENT_CONSOLE_STYLE || path.join(os.homedir(), "repos", "brain", "config", "style-preamble.md");

export function stylePreamble(): string {
  try { return fs.readFileSync(STYLE_FILE, "utf8").trim(); } catch { return ""; }
}

/** Keep the write contract discoverable without loading the schema or full memory pages. */
export function brainInstructions(): string {
  if (!brainAvailable()) return "";
  const root = path.dirname(path.dirname(BRAIN_BIN));
  return [
    "# Shared brain: required save workflow",
    `Use the shared memory repository at ${root}; do not create another memory store.`,
    `Before any memory write, read ${path.join(root, "CLAUDE.md")} and follow its schema.`,
    `Use the full CLI path ${BRAIN_BIN}; do not assume brain is on PATH.`,
    "Search existing pages first. Save only durable preferences, decisions, and non-obvious lessons; exclude code inventories, test status, and conversation dumps.",
    "Update flat wiki/<lowercase-kebab-slug>.md pages with required frontmatter and concise facts. Update wiki/index.md with one summary and explicit file reference per page.",
    `Append the log using ${BRAIN_BIN} log, then run ${BRAIN_BIN} lint and fix findings before claiming the save is complete.`,
    "Never edit wiki/log.md by hand or run git in the brain repository. The console commits saved changes after each turn.",
    "Automatic recall below contains only the index. Open relevant referenced pages on demand.",
  ].join("\n");
}

/** Style, memory write contract, and index for harnesses accepting one instruction string. */
export const harnessInstructions = async () => [stylePreamble(), brainInstructions(), SESSION_INSTRUCTIONS, await brainContext()].filter(Boolean).join("\n\n");

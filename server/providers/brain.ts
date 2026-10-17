import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The shared "brain" wiki (~/repos/brain, see its CLAUDE.md) is one memory for every agent on this machine. Claude Code reaches it through
// user-level hooks. Pi and Codex have no equivalent installed, so we do the same two jobs here, for any harness:
//   recall: hand the harness only the same brain index the Claude hook injects when its process starts
//   save:   agents edit wiki pages themselves; after each turn we run `brain commit` (file-locked, idempotent)
export const BRAIN_BIN = process.env.AGENT_CONSOLE_BRAIN || path.join(os.homedir(), "repos", "brain", "bin", "brain");
const ttl = 15_000;
let cache: { at: number; text: string } | undefined;

export const brainAvailable = () => fs.existsSync(BRAIN_BIN);

export function brainContext(): string {
  if (!brainAvailable()) return "";
  if (cache && Date.now() - cache.at < ttl) return cache.text;
  let text = "";
  try {
    text = execFileSync(BRAIN_BIN, ["context"], { encoding: "utf8", timeout: 5000, env: { ...process.env, BRAIN_NO_NUDGE: "1" } }).trim();
  } catch {}
  cache = { at: Date.now(), text };
  return text;
}

export function brainCommit() {
  if (brainAvailable()) execFile(BRAIN_BIN, ["commit"], { timeout: 15_000 }, () => {});
}

// Reply-style preamble (ADHD + caveman max) shared by every harness, replacing the always-loaded caveman / i-have-adhd skills.
export const STYLE_FILE = process.env.AGENT_CONSOLE_STYLE || path.join(os.homedir(), "repos", "brain", "config", "style-preamble.md");

export function stylePreamble(): string {
  try { return fs.readFileSync(STYLE_FILE, "utf8").trim(); } catch { return ""; }
}

/** Style preamble plus brain index, for harnesses that take one instruction string. */
export const harnessInstructions = () => [stylePreamble(), brainContext()].filter(Boolean).join("\n\n");

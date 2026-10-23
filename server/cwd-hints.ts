import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "./auth.ts";

const TAIL = 512 * 1024;
const within = (root: string, dir: string) => dir === root || dir.startsWith(root + path.sep);
const expand = (p: string) =>
  p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;

/**
 * Folders a thread has been working in, newest first, read from its shared Claude/Codex/Pi event log:
 * shell working directories and `cd` targets in Bash calls,
 * plus every folder from the thread cwd down to any absolute path a tool call touched. Lets the viewer resolve
 * a relative citation like `public/render.js` that the agent wrote after `cd agent-console`.
 * Folders outside cwd (a screenshot in /tmp/shots) count only themselves, and paths quoted in replies count too,
 * so a bare `after-open.png` finds the file the agent named earlier. The viewer still applies its own scope rules.
 */
export function contextDirs(threadId: string, cwd: string): string[] {
  let text = "",
    offset = 0;
  try {
    const file = path.join(DATA_DIR, "logs", `${threadId}.jsonl`);
    const size = fs.statSync(file).size,
      fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(Math.min(size, TAIL));
      offset = size - buf.length;
      fs.readSync(fd, buf, 0, buf.length, offset);
      text = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  const found: string[] = [];
  const add = (target: string) => {
    let dir = path.resolve(target);
    if (/\.[\w-]+$/.test(path.basename(dir))) dir = path.dirname(dir);
    if (!within(cwd, dir)) return void found.push(dir);
    for (; within(cwd, dir) && dir !== cwd; dir = path.dirname(dir)) found.push(dir);
  };
  for (const line of text.split("\n").slice(offset ? 1 : 0)) {
    // discard only a potentially cut line
    if (!line.includes('"tool_use"') && !line.includes('"text"')) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    for (const block of event?.message?.content || []) {
      if (block?.type === "text" && event.type === "assistant" && typeof block.text === "string") {
        for (const m of block.text.matchAll(
          /(?<![\w.~\/-])(?:~|\/(?:home|tmp)\b)[^\s"'`;|&()<>\[\]*]*\.\w+/g,
        ))
          add(expand(m[0]));
        continue;
      }
      if (block?.type !== "tool_use" || !block.input) continue;
      const input = block.input;
      const workdir = input.workdir ?? input.cwd;
      const base = typeof workdir === "string" ? path.resolve(cwd, expand(workdir)) : cwd;
      if (base !== cwd) add(base);
      for (const key of ["file_path", "path", "notebook_path"])
        if (typeof input[key] === "string" && path.isAbsolute(expand(input[key])))
          add(expand(input[key]));
      for (const change of Array.isArray(input.changes) ? input.changes : []) {
        if (typeof change?.path === "string") add(path.resolve(base, expand(change.path)));
      }
      const command = input.command ?? input.cmd;
      if (typeof command !== "string") continue;
      let cur = base;
      for (const m of command.matchAll(/\bcd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|`()]+))/g)) {
        cur = path.resolve(cur, expand(m[1] ?? m[2] ?? m[3]));
        add(cur);
      }
      for (const m of command.matchAll(/(?:~|\/(?:home|tmp)\b)\/[^\s"'`;|&)<>]+/g))
        add(expand(m[0]));
    }
  }
  return [...new Set(found.reverse())].slice(0, 60);
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "./auth.ts";

const TAIL = 512 * 1024;
const within = (root: string, dir: string) => dir === root || dir.startsWith(root + path.sep);
const expand = (p: string) => p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;

/**
 * Folders a thread has been working in, newest first, read from the tail of its event log: `cd` targets in Bash calls,
 * plus every folder from the thread cwd down to any absolute path a tool call touched. Lets the viewer resolve
 * a relative citation like `public/render.js` that the agent wrote after `cd agent-console`.
 */
export function contextDirs(threadId: string, cwd: string): string[] {
  let text = "";
  try {
    const file = path.join(DATA_DIR, "logs", `${threadId}.jsonl`);
    const size = fs.statSync(file).size, fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(Math.min(size, TAIL));
      fs.readSync(fd, buf, 0, buf.length, size - buf.length);
      text = buf.toString("utf8");
    } finally { fs.closeSync(fd); }
  } catch { return []; }
  const found: string[] = [];
  const add = (target: string) => {
    let dir = path.resolve(target);
    if (!within(cwd, dir)) return;
    if (/\.[\w-]+$/.test(path.basename(dir))) dir = path.dirname(dir);
    for (; within(cwd, dir) && dir !== cwd; dir = path.dirname(dir)) found.push(dir);
  };
  for (const line of text.split("\n").slice(1)) { // first line may be cut by the tail window
    if (!line.includes('"tool_use"')) continue;
    let event: any; try { event = JSON.parse(line); } catch { continue; }
    for (const block of event?.message?.content || []) {
      if (block?.type !== "tool_use" || !block.input) continue;
      const input = block.input;
      for (const key of ["file_path", "path", "notebook_path"]) if (typeof input[key] === "string" && path.isAbsolute(expand(input[key]))) add(expand(input[key]));
      if (typeof input.command !== "string") continue;
      let cur = cwd;
      for (const m of input.command.matchAll(/\bcd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g)) { cur = path.resolve(cur, expand(m[1] ?? m[2] ?? m[3])); add(cur); }
      for (const m of input.command.matchAll(/(?:~|\/home\/[\w.-]+)\/[^\s"'`;|&)<>]+/g)) add(expand(m[0]));
    }
  }
  return [...new Set(found.reverse())].slice(0, 60);
}

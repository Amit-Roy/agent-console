// Which GitHub pull requests did a session raise? Read from the canonical log: the result of a `gh pr create` tool call.
export type RaisedPr = { repo: string; number: number; url: string };

// A command position, not a quoted mention such as `grep "gh pr create"`.
const CREATE = /(?:^|[;&|(]|\n)\s*(?:\w+=\S+\s+)*gh\s+pr\s+create\b/;
const PR_URL = /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d{1,9})(?!\d)/g;

export const isPrCreate = (command: unknown) => typeof command === "string" && CREATE.test(command);

/** PR URLs printed by a `gh pr create` result. gh prints the new PR URL last; earlier URLs are existing PRs it mentions. */
export function prsFromResult(content: unknown): RaisedPr[] {
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map(c => typeof c?.text === "string" ? c.text : "").join("\n") : "";
  const all = [...text.matchAll(PR_URL)];
  const last = all.at(-1);
  return last ? [{ repo: last[1], number: Number(last[2]), url: last[0] }] : [];
}

/** Whole-log scan for callers without an incremental index. Returns each PR once, in creation order. */
export function raisedPrs(log: string): RaisedPr[] {
  const calls = new Set<string>();
  const out: RaisedPr[] = [];
  for (const line of log.split("\n")) {
    if (!line.includes("tool_use") && !line.includes("tool_result")) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    const content = ev?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "tool_use" && typeof block.id === "string" && isPrCreate(block.input?.command)) calls.add(block.id);
      else if (block?.type === "tool_result" && calls.has(block.tool_use_id))
        for (const pr of prsFromResult(block.content)) if (!out.some(o => o.repo === pr.repo && o.number === pr.number)) out.push(pr);
    }
  }
  return out;
}

/** Accepts a github.com PR/issue/comment URL, `owner/repo#n`, or a bare number (any repo). */
export function parsePrRef(input: unknown): { repo?: string; number: number } | null {
  if (typeof input !== "string") return null;
  const s = input.trim();
  const url = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(?:pull|issues)\/(\d{1,9})(?![\d])/.exec(s);
  if (url) return { repo: url[1], number: Number(url[2]) };
  const short = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d{1,9})$/.exec(s);
  if (short) return { repo: short[1], number: Number(short[2]) };
  const bare = /^#?(\d{1,9})$/.exec(s);
  return bare ? { number: Number(bare[1]) } : null;
}

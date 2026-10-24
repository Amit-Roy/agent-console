// Which GitHub pull requests did a session raise? Read from the canonical log: the result of a `gh pr create` tool call.
export type RaisedPr = { repo: string; number: number; url: string };

// A command position, not a quoted mention such as `grep "gh pr create"`.
// Wrapper CLIs open PRs/issues too: `pr-evidence create ...` or `pr-evidence ... --create` (PR), `task-issue ...` (issue).
const COMMAND_START = String.raw`(?:^|[;&|(]|\n)\s*(?:\w+=\S+\s+)*(?:[\w.~/-]*/)?`;
const PR_CREATE_FORMS = String.raw`gh\s+pr\s+create\b|pr-evidence(?![\w-])(?:\s+create\b|[^;&|\n]*?\s--create\b)`;
const CREATE = new RegExp(`${COMMAND_START}(?:${PR_CREATE_FORMS})`);
const PR_URL = /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d{1,9})(?!\d)/g;

const CREATE_ITEM = new RegExp(
  `${COMMAND_START}(?:gh\\s+issue\\s+create\\b|task-issue(?![\\w-])|${PR_CREATE_FORMS})`,
);
const ITEM_URL =
  /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(?:pull|issues)\/(\d{1,9})(?!\d)/g;

export const isPrCreate = (command: unknown) => typeof command === "string" && CREATE.test(command);

/** PR URLs printed by a `gh pr create` result. gh prints the new PR URL last; earlier URLs are existing PRs it mentions. */
export function prsFromResult(content: unknown, url = PR_URL): RaisedPr[] {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n")
        : "";
  const all = [...text.matchAll(url)];
  const last = all.at(-1);
  return last ? [{ repo: last[1], number: Number(last[2]), url: last[0] }] : [];
}

/** Whole-log scan for callers without an incremental index. Returns each PR once, in creation order. */
export function raisedPrs(log: string): RaisedPr[] {
  return scan(log, CREATE, PR_URL);
}

/** Like raisedPrs, but also counts issues made with `gh issue create`, so their telemetry finds the thread that filed them. */
export function raisedItems(log: string): RaisedPr[] {
  return scan(log, CREATE_ITEM, ITEM_URL);
}

function scan(log: string, create: RegExp, url: RegExp): RaisedPr[] {
  const calls = new Set<string>();
  const out: RaisedPr[] = [];
  for (const line of log.split("\n")) {
    if (!line.includes("tool_use") && !line.includes("tool_result")) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const content = ev?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        block?.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.input?.command === "string" &&
        create.test(block.input.command)
      )
        calls.add(block.id);
      else if (block?.type === "tool_result" && calls.has(block.tool_use_id))
        for (const pr of prsFromResult(block.content, url))
          if (!out.some((o) => o.repo === pr.repo && o.number === pr.number)) out.push(pr);
    }
  }
  return out;
}

/** Accepts a github.com PR/issue/comment URL, `owner/repo#n`, or a bare number (any repo). */
export function parsePrRef(input: unknown): { repo?: string; number: number } | null {
  if (typeof input !== "string") return null;
  const s = input.trim();
  const url =
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(?:pull|issues)\/(\d{1,9})(?![\d])/.exec(
      s,
    );
  if (url) return { repo: url[1], number: Number(url[2]) };
  const short = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d{1,9})$/.exec(s);
  if (short) return { repo: short[1], number: Number(short[2]) };
  const bare = /^#?(\d{1,9})$/.exec(s);
  return bare ? { number: Number(bare[1]) } : null;
}

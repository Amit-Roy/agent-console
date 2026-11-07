import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

// Thread graph (#421): which threads relate to which. Pure builder over thread records plus the session-search `touches` and `prs` rows;
// only repoKeys() talks to git. Threads link through peer messages, forks, shared files and brain pages, issues and PRs; repos and
// scheduled tasks are hubs (many threads, one shared key) so they never explode into pairwise edges.
const run = promisify(execFile);

export const FANOUT_CAP = 25; // a file or brain page touched by more threads than this is noise (lockfiles, index.md): dropped
export const NODE_CAP = 500;
const CURSOR_OVERLAP_MS = 2000; // delta fetches start slightly before the last answer so a write racing it is never missed

export type GraphThread = {
  id: string;
  provider: string;
  title: string;
  status: string;
  waiting?: number;
  background?: number;
  archived?: number;
  updatedAt: number;
  createdAt?: number;
  cwd: string;
  forkedFrom?: string;
  schedule?: { task: string; run: string };
  issueRun?: { repo: string; number: number; pr?: number };
};
export type TouchRow = { thread: string; kind: string; key: string; line: number; ts: number };
export type PrRow = { thread: string; repo: string; number: number };
export type EdgeKind = "peer" | "fork" | "file" | "brain" | "issue" | "repo" | "schedule";
export type GraphNode = {
  id: string;
  title: string;
  provider: string;
  status: string;
  waiting: boolean;
  archived: boolean;
  lastActivity: number;
  schedule?: string;
  subagents: number;
};
export type GraphHub = { kind: string; key: string; threads: string[] };
export type GraphEdge = { kind: EdgeKind; a: string; b: string; w: number; last: number };
export type ThreadGraph = {
  nodes: GraphNode[];
  hubs: GraphHub[];
  edges: GraphEdge[];
  cursor: number;
  dropped: { keys: number; nodes: number };
};
export type GraphInput = {
  threads: GraphThread[];
  touches: TouchRow[];
  prs?: PrRow[];
  repos?: Map<string, string | undefined>; // cwd -> repo key (see repoKeys)
  since?: number; // only threads active at or after this time (epoch ms) become nodes
  kinds?: Set<string>; // edge kinds to keep; default all
  now?: number;
};

export const hubId = (kind: string, key: string) => `hub:${kind}:${key}`;

// key -> threads (with the newest timestamp) for one hub kind; keys held by one thread are no relation and are skipped.
type Groups = Map<string, Map<string, number>>;
function addTo(groups: Groups, key: string, thread: string, stamp: number) {
  const members = groups.get(key) ?? new Map<string, number>();
  members.set(thread, Math.max(members.get(thread) ?? 0, stamp));
  groups.set(key, members);
}

function nodeOf(thread: GraphThread): GraphNode {
  return {
    id: thread.id,
    title: thread.title,
    provider: thread.provider,
    status: thread.status,
    waiting: (thread.waiting ?? 0) > 0,
    archived: !!thread.archived,
    lastActivity: thread.updatedAt,
    ...(thread.schedule ? { schedule: thread.schedule.task } : {}),
    subagents: thread.background ?? 0,
  };
}

type EdgeBook = Map<string, GraphEdge>;
function bump(book: EdgeBook, kind: EdgeKind, from: string, to: string, last: number) {
  const [low, high] = kind === "peer" || kind === "fork" ? [from, to] : [from, to].sort();
  const id = `${kind}|${low}|${high}`;
  const edge = book.get(id) ?? { kind, a: low, b: high, w: 0, last: 0 };
  edge.w++;
  edge.last = Math.max(edge.last, last);
  book.set(id, edge);
}

type LinkOptions = {
  groups: Groups;
  kind: EdgeKind;
  book: EdgeBook;
  hubs: GraphHub[];
  toHub?: boolean; // many threads, one shared key: edges go to a hub node instead of every pair
  capped?: boolean; // drop keys held by more than FANOUT_CAP threads
};

function linkMembers(opts: LinkOptions, key: string, members: Map<string, number>) {
  const threadIds = [...members.keys()];
  opts.hubs.push({ kind: opts.kind, key, threads: threadIds });
  if (opts.toHub) {
    for (const threadId of threadIds)
      bump(opts.book, opts.kind, threadId, hubId(opts.kind, key), members.get(threadId) ?? 0);
    return;
  }
  threadIds.forEach((first, index) => {
    for (const second of threadIds.slice(index + 1))
      bump(
        opts.book,
        opts.kind,
        first,
        second,
        Math.min(members.get(first) ?? 0, members.get(second) ?? 0),
      );
  });
}

/** Link every group of threads sharing a key. Returns how many keys the fan-out cap dropped. */
function linkGroups(opts: LinkOptions): number {
  let dropped = 0;
  for (const [key, members] of opts.groups) {
    if (members.size < 2) continue;
    if (opts.capped && members.size > FANOUT_CAP) dropped++;
    else linkMembers(opts, key, members);
  }
  return dropped;
}

function touchGroups(rows: TouchRow[], known: Set<string>) {
  const file: Groups = new Map();
  const brain: Groups = new Map();
  for (const row of rows) {
    if (!known.has(row.thread)) continue;
    if (row.kind === "file") addTo(file, row.key, row.thread, row.ts);
    else if (row.kind === "brain_r" || row.kind === "brain_w")
      addTo(brain, row.key, row.thread, row.ts);
  }
  return { file, brain };
}

function directEdges(input: GraphInput, known: Set<string>, book: EdgeBook) {
  for (const row of input.touches)
    if (row.kind === "peer" && known.has(row.thread) && known.has(row.key))
      bump(book, "peer", row.key, row.thread, row.ts);
  for (const thread of input.threads)
    if (thread.forkedFrom && known.has(thread.forkedFrom))
      bump(book, "fork", thread.forkedFrom, thread.id, thread.createdAt ?? thread.updatedAt);
}

function issueGroups(input: GraphInput): Groups {
  const groups: Groups = new Map();
  for (const thread of input.threads) {
    const run = thread.issueRun;
    if (!run) continue;
    addTo(groups, `${run.repo}#${run.number}`, thread.id, thread.updatedAt);
    if (run.pr) addTo(groups, `${run.repo}#${run.pr}`, thread.id, thread.updatedAt);
  }
  for (const row of input.prs ?? []) addTo(groups, `${row.repo}#${row.number}`, row.thread, 0);
  return groups;
}

function hubGroups(input: GraphInput) {
  const repo: Groups = new Map();
  const schedule: Groups = new Map();
  for (const thread of input.threads) {
    const key = input.repos?.get(thread.cwd);
    if (key) addTo(repo, key, thread.id, thread.updatedAt);
    if (thread.schedule) addTo(schedule, thread.schedule.task, thread.id, thread.updatedAt);
  }
  return { repo, schedule };
}

/** Build the graph. Edges are computed over all threads, then kept when they touch a node inside the window. */
export function buildThreadGraph(input: GraphInput): ThreadGraph {
  const now = input.now ?? Date.now();
  const known = new Set(input.threads.map((thread) => thread.id));
  const book: EdgeBook = new Map();
  const hubs: GraphHub[] = [];
  directEdges(input, known, book);
  const { file, brain } = touchGroups(input.touches, known);
  const hubby = hubGroups(input);
  let keys = 0;
  keys += linkGroups({ groups: file, kind: "file", book, hubs, capped: true });
  keys += linkGroups({ groups: brain, kind: "brain", book, hubs, capped: true });
  linkGroups({ groups: issueGroups(input), kind: "issue", book, hubs });
  linkGroups({ groups: hubby.repo, kind: "repo", book, hubs, toHub: true });
  linkGroups({ groups: hubby.schedule, kind: "schedule", book, hubs, toHub: true });

  const since = input.since ?? 0;
  const inWindow = input.threads
    .filter((thread) => thread.updatedAt >= since)
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
  const kept = inWindow.slice(0, NODE_CAP);
  const ids = new Set(kept.map((thread) => thread.id));
  const wanted = (kind: string) => !input.kinds || input.kinds.has(kind);
  const edgeName = (edge: GraphEdge) => `${edge.kind}${edge.a}${edge.b}`;
  const edges = [...book.values()]
    .filter((edge) => wanted(edge.kind) && (ids.has(edge.a) || ids.has(edge.b)))
    .sort((left, right) => right.last - left.last || edgeName(left).localeCompare(edgeName(right)));
  const hubsKept = hubs.filter(
    (hub) => wanted(hub.kind) && hub.threads.some((threadId) => ids.has(threadId)),
  );
  return {
    nodes: kept.map(nodeOf),
    hubs: hubsKept,
    edges,
    cursor: now - CURSOR_OVERLAP_MS,
    dropped: { keys, nodes: inWindow.length - kept.length },
  };
}

// Repo of a working folder: the main checkout when cwd is a linked worktree, so a worktree and its repo share one hub.
const repoCache = new Map<string, Promise<string | undefined>>();
async function repoOf(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await run(
      "git",
      ["-C", cwd, "rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", timeout: 5000 },
    );
    const [top, common] = String(stdout).trim().split("\n");
    if (common && path.basename(common) === ".git") return path.dirname(common);
    return top || undefined;
  } catch {
    return undefined;
  }
}

/** cwd -> repo root for every folder given; cached per process (folders rarely move between repos), failures map to undefined. */
export async function repoKeys(cwds: Iterable<string>): Promise<Map<string, string | undefined>> {
  const out = new Map<string, string | undefined>();
  await Promise.all(
    [...new Set(cwds)].map(async (cwd) => {
      let pending = repoCache.get(cwd);
      if (!pending) {
        pending = repoOf(cwd);
        repoCache.set(cwd, pending);
      }
      out.set(cwd, await pending);
    }),
  );
  return out;
}

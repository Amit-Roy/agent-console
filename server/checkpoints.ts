// Shadow-git checkpoints: one bare repo per working folder snapshots the folder's files so
// a thread can be rewound. The user's own .git (HEAD, index, refs) is never written.
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./auth.ts";
import { sensitive } from "./files.ts";

export type CheckpointKind = "turn_start" | "tool" | "turn_end" | "pre_rewind";
export type FileChange = { p: string; s: "A" | "M" | "D"; a: number; d: number };
export type Checkpoint = {
  seq: number;
  kind: CheckpointKind;
  toolUseId?: string;
  commit: string;
  head: string | null;
  files: FileChange[];
  skipped?: string[];
};
export type CheckpointInfo = Omit<Checkpoint, "files" | "skipped"> & { ts: number };
export type SnapshotArgs = {
  cwd: string;
  threadId: string;
  kind: CheckpointKind;
  toolUseId?: string;
  dataDir?: string;
};
export type SnapshotResult = Checkpoint | null | { status: "too_big" };

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES = 50_000;
export const MAX_DIFF_BYTES = 1 << 20;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const HASH = /^[0-9a-f]{40}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const IDENTITY = {
  GIT_AUTHOR_NAME: "agent-console",
  GIT_AUTHOR_EMAIL: "checkpoints@agent-console.local",
  GIT_COMMITTER_NAME: "agent-console",
  GIT_COMMITTER_EMAIL: "checkpoints@agent-console.local",
};

type GitOptions = { index?: string; input?: string; env?: Record<string, string> };
type Folder = { cwd: string; shadow: string };

const queues = new Map<string, Promise<unknown>>();

// Serialize work per folder: concurrent git runs on one index would corrupt it.
function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(work, work);
  const tail = run.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

function runGit(args: string[], options: GitOptions, cwd?: string): Promise<Buffer> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[name];
  Object.assign(env, IDENTITY, options.env);
  if (options.index) env.GIT_INDEX_FILE = options.index;
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      { cwd, env, encoding: "buffer", maxBuffer: 256 << 20 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`git ${args[0]} failed: ${String(stderr).slice(0, 300)}`));
        else resolve(stdout);
      },
    );
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.input ?? "");
  });
}

async function git(folder: Folder, args: string[], options: GitOptions = {}): Promise<string> {
  const base = [
    `--git-dir=${folder.shadow}`,
    `--work-tree=${folder.cwd}`,
    "-c",
    "core.quotepath=off",
  ];
  const out = await runGit([...base, ...args], options, folder.cwd);
  return out.toString("utf8");
}

function checkId(threadId: string) {
  if (!SAFE_ID.test(threadId)) throw new Error("Invalid thread id.");
}

function checkCommit(commit: string) {
  if (!HASH.test(commit)) throw new Error("Invalid commit id.");
}

async function openFolder(cwd: string, dataDir: string): Promise<Folder> {
  const real = await fs.promises.realpath(cwd);
  const name = crypto.createHash("sha1").update(real).digest("hex");
  const root = path.join(dataDir, "checkpoints");
  await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
  const shadow = path.join(root, `${name}.git`);
  const folder = { cwd: real, shadow };
  if (!fs.existsSync(path.join(shadow, "HEAD"))) await initShadow(folder);
  return folder;
}

async function initShadow(folder: Folder) {
  await fs.promises.mkdir(folder.shadow, { recursive: true, mode: 0o700 });
  await runGit(["init", "--bare", "-q", folder.shadow], {});
  await fs.promises.chmod(folder.shadow, 0o700);
  await git(folder, ["config", "core.bare", "false"]);
  await git(folder, ["config", "gc.auto", "0"]);
  const info = path.join(folder.shadow, "info");
  await fs.promises.mkdir(info, { recursive: true });
  await fs.promises.writeFile(path.join(info, "exclude"), ".git\nnode_modules\n");
}

function indexOf(folder: Folder, threadId: string) {
  return path.join(folder.shadow, `index-${threadId}`);
}

function splitZ(text: string): string[] {
  return text.split("\0").filter(Boolean);
}

function isSensitive(rel: string) {
  return sensitive(path.join(path.sep, rel));
}

// Files that must stay out of the snapshot: credentials and files over the size cap.
async function leftOut(folder: Folder, index: string) {
  const out = await git(folder, ["ls-files", "-o", "-m", "-z", "--exclude-standard"], { index });
  const secret: string[] = [];
  const big: string[] = [];
  for (const rel of new Set(splitZ(out))) {
    if (isSensitive(rel)) secret.push(rel);
    else if (await tooLarge(path.join(folder.cwd, rel))) big.push(rel);
  }
  return { secret, big };
}

async function tooLarge(file: string) {
  try {
    const info = await fs.promises.lstat(file);
    return info.isFile() && info.size > MAX_FILE_BYTES;
  } catch {
    return false;
  }
}

async function countFiles(folder: Folder, index: string) {
  const out = await git(folder, ["ls-files", "-c", "-o", "-z", "--exclude-standard"], { index });
  return splitZ(out).length;
}

async function stageAll(folder: Folder, index: string, excluded: string[]) {
  const specs = [".", ...excluded.map((rel) => `:(exclude,literal)${rel}`)];
  const input = specs.map((spec) => `${spec}\0`).join("");
  await git(folder, ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], {
    index,
    input,
  });
}

type Ref = { seq: number; commit: string; name: string };

async function threadRefs(folder: Folder, threadId: string): Promise<Ref[]> {
  const out = await git(folder, [
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    `refs/ac/${threadId}/`,
  ]);
  const refs = out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, commit] = line.split(" ");
      return { name, commit, seq: Number(name.split("/").pop()) };
    });
  return refs.sort((left, right) => left.seq - right.seq);
}

function parseNameStatus(text: string): Map<string, FileChange["s"]> {
  const parts = splitZ(text);
  const map = new Map<string, FileChange["s"]>();
  for (let cursor = 0; cursor + 1 < parts.length; cursor += 2) {
    const code = parts[cursor][0];
    map.set(parts[cursor + 1], code === "A" ? "A" : code === "D" ? "D" : "M");
  }
  return map;
}

function parseNumstat(text: string): Map<string, [number, number]> {
  const map = new Map<string, [number, number]>();
  for (const entry of splitZ(text)) {
    const [add, del, ...rest] = entry.split("\t");
    map.set(rest.join("\t"), [Number(add) || 0, Number(del) || 0]);
  }
  return map;
}

async function changes(folder: Folder, base: string, commit: string): Promise<FileChange[]> {
  const common = ["diff-tree", "-r", "-z", "--no-renames", "--no-commit-id"];
  const status = parseNameStatus(await git(folder, [...common, "--name-status", base, commit]));
  const stats = parseNumstat(await git(folder, [...common, "--numstat", base, commit]));
  return [...status].map(([filePath, status]) => {
    const [added, deleted] = stats.get(filePath) ?? [0, 0];
    return { p: filePath, s: status, a: added, d: deleted };
  });
}

async function userHead(cwd: string): Promise<string | null> {
  try {
    const out = await runGit(["rev-parse", "--verify", "-q", "HEAD"], {}, cwd);
    const sha = out.toString("utf8").trim();
    return HASH.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

function message(kind: string, toolUseId: string | undefined, head: string | null) {
  return `${kind} ${toolUseId || "-"} ${head || "-"}`;
}

function parseMessage(subject: string) {
  const [kind, tool, head] = subject.split(" ");
  return {
    kind: kind as CheckpointKind,
    toolUseId: tool && tool !== "-" ? tool : undefined,
    head: head && head !== "-" ? head : null,
  };
}

async function snapshotNow(args: SnapshotArgs, folder: Folder): Promise<SnapshotResult> {
  const index = indexOf(folder, args.threadId);
  if ((await countFiles(folder, index)) > MAX_FILES) return { status: "too_big" };
  const { secret, big } = await leftOut(folder, index);
  await stageAll(folder, index, [...secret, ...big]);
  const tree = (await git(folder, ["write-tree"], { index })).trim();
  const refs = await threadRefs(folder, args.threadId);
  const prev = refs.at(-1);
  const prevTree = prev ? (await git(folder, ["rev-parse", `${prev.commit}^{tree}`])).trim() : "";
  if (prevTree === tree) return null;
  const head = await userHead(folder.cwd);
  const parents = prev ? ["-p", prev.commit] : [];
  const note = message(args.kind, args.toolUseId, head);
  const commit = (await git(folder, ["commit-tree", tree, ...parents, "-m", note])).trim();
  const seq = (prev?.seq ?? 0) + 1;
  await git(folder, ["update-ref", `refs/ac/${args.threadId}/${seq}`, commit]);
  const files = await changes(folder, prev ? prev.commit : EMPTY_TREE, commit);
  const result: Checkpoint = { seq, kind: args.kind, commit, head, files };
  if (args.toolUseId) result.toolUseId = args.toolUseId;
  if (big.length) result.skipped = big;
  return result;
}

export async function snapshot(args: SnapshotArgs): Promise<SnapshotResult> {
  checkId(args.threadId);
  const folder = await openFolder(args.cwd, args.dataDir ?? DATA_DIR);
  return serial(folder.shadow, () => snapshotNow(args, folder));
}

export async function list(
  threadId: string,
  cwd: string,
  dataDir: string = DATA_DIR,
): Promise<CheckpointInfo[]> {
  checkId(threadId);
  const folder = await openFolder(cwd, dataDir);
  const out = await git(folder, [
    "for-each-ref",
    "--format=%(refname)\t%(objectname)\t%(committerdate:unix)\t%(contents:subject)",
    `refs/ac/${threadId}/`,
  ]);
  const rows = out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, commit, stamp, subject] = line.split("\t");
      const seq = Number(name.split("/").pop());
      return { seq, commit, ts: Number(stamp), ...parseMessage(subject || "") };
    });
  return rows.sort((left, right) => left.seq - right.seq);
}

export type DiffResult = {
  files: { p: string; s: FileChange["s"] }[];
  patch: string;
  truncated: boolean;
};

export async function diff(
  cwd: string,
  commit: string,
  base: string,
  file?: string,
  dataDir: string = DATA_DIR,
): Promise<DiffResult> {
  checkCommit(commit);
  checkCommit(base);
  const folder = await openFolder(cwd, dataDir);
  const common = ["diff-tree", "-r", "--no-renames", "--no-commit-id"];
  const status = await git(folder, [...common, "-z", "--name-status", base, commit]);
  const files = [...parseNameStatus(status)]
    .filter(([filePath]) => !isSensitive(filePath) && (!file || filePath === file))
    .map(([filePath, status]) => ({ p: filePath, s: status }));
  if (!files.length) return { files, patch: "", truncated: false };
  const paths = files.map((entry) => entry.p);
  const patch = await git(folder, [
    ...common,
    "-p",
    "--no-ext-diff",
    "--no-color",
    base,
    commit,
    "--",
    ...paths.map((filePath) => `:(literal)${filePath}`),
  ]);
  const bytes = Buffer.from(patch, "utf8");
  if (bytes.length <= MAX_DIFF_BYTES) return { files, patch, truncated: false };
  return { files, patch: bytes.subarray(0, MAX_DIFF_BYTES).toString("utf8"), truncated: true };
}

export async function fileAt(
  cwd: string,
  commit: string,
  file: string,
  dataDir: string = DATA_DIR,
): Promise<Buffer | null> {
  checkCommit(commit);
  if (isSensitive(file) || file.startsWith("/") || file.split("/").includes("..")) return null;
  const folder = await openFolder(cwd, dataDir);
  try {
    const base = [`--git-dir=${folder.shadow}`, "cat-file", "blob", `${commit}:${file}`];
    return await runGit(base, {});
  } catch {
    return null;
  }
}

// Put the folder back to targetCommit: modified files revert, deleted ones return, files
// created since then go away. Ignored and never-snapshotted files are not touched.
export async function restore(
  cwd: string,
  threadId: string,
  targetCommit: string,
  dataDir: string = DATA_DIR,
): Promise<void> {
  checkId(threadId);
  checkCommit(targetCommit);
  const folder = await openFolder(cwd, dataDir);
  await serial(folder.shadow, async () => {
    const index = indexOf(folder, threadId);
    const { secret, big } = await leftOut(folder, index);
    await stageAll(folder, index, [...secret, ...big]);
    const current = (await git(folder, ["write-tree"], { index })).trim();
    const scratch = path.join(folder.shadow, `index-restore-${process.pid}-${Date.now()}`);
    try {
      await git(folder, ["read-tree", current], { index: scratch });
      await git(folder, ["restore", `--source=${targetCommit}`, "--worktree", "--", ":/"], {
        index: scratch,
      });
    } finally {
      await fs.promises.rm(scratch, { force: true });
    }
  });
}

async function shadowRepos(dataDir: string): Promise<Folder[]> {
  const root = path.join(dataDir, "checkpoints");
  const names = await fs.promises.readdir(root).catch(() => [] as string[]);
  return names
    .filter((name) => name.endsWith(".git"))
    .map((name) => ({ cwd: root, shadow: path.join(root, name) }));
}

async function dropRefs(folder: Folder, keep: (ref: string, stamp: number) => boolean) {
  const out = await git(folder, [
    "for-each-ref",
    "--format=%(refname)\t%(committerdate:unix)",
    "refs/ac/",
  ]);
  for (const line of out.split("\n").filter(Boolean)) {
    const [name, stamp] = line.split("\t");
    if (!keep(name, Number(stamp))) await git(folder, ["update-ref", "-d", name]);
  }
  await git(folder, ["gc", "-q", "--prune=now"]);
}

export async function prune(maxAgeDays = 30, dataDir: string = DATA_DIR): Promise<void> {
  const cutoff = Date.now() / 1000 - maxAgeDays * 86400;
  for (const folder of await shadowRepos(dataDir)) {
    await serial(folder.shadow, () => dropRefs(folder, (_name, stamp) => stamp >= cutoff));
  }
}

export async function deleteThread(threadId: string, dataDir: string = DATA_DIR): Promise<void> {
  checkId(threadId);
  const prefix = `refs/ac/${threadId}/`;
  for (const folder of await shadowRepos(dataDir)) {
    await serial(folder.shadow, async () => {
      await dropRefs(folder, (name) => !name.startsWith(prefix));
      await fs.promises.rm(indexOf(folder, threadId), { force: true });
    });
  }
}

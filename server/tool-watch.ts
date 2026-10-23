import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addWorktree, defaultDirs } from "./window-dispatch.ts";

// Tool-watch bridge. The VPS tool-watch publishes `latest` (fixed tool versions + unsanctioned file changes) over a
// forced-command SSH key. This module re-validates the trusted fields, files GitHub issues, and for workspace-scope
// updates makes a DETERMINISTIC patch (tool-install, tools.lock only) before a Claude reviewer looks at it.
// Untrusted text (OSV advisories) never reaches an issue, a commit or a PR: only the rendered review prompt carries it,
// wrapped by dotfiles/security/render_review.py. Everything is gated by tool-watch.json and a pinned template hash.

export const REPO = "Amit-Roy/dotfiles";
const SSH_TIMEOUT = 20_000;
const LATEST_TTL = 30_000;
const POLL_MS = 60 * 60_000;
const VERSION = /^[0-9A-Za-z.+-]{1,40}$/;
const TOOL = /^[a-z0-9-]{1,30}$/;
const OSV_ID = /^[A-Z]+-[0-9A-Za-z-]+$/;
const OSV_SOURCE = /^osv:[A-Z]+-[0-9A-Za-z-]+$/;
const URL_CHARS = /^https:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]{1,300}$/;
const PATH_OK = /^[\w./~+-]{1,200}$/;
const DIGEST = /^[0-9A-Za-z.+:_-]{1,128}$/;
const SCOPES = new Set(["workspace", "host"]);

export type ToolRecord = {
  key: string;
  tool: string;
  installed: string;
  fixed: string;
  official_url: string;
  checksum_source: string;
  osv_ids: string[];
  scope: "workspace" | "host";
  untrusted: { source: string; text: string }[];
};
export type Mismatch = { tool: string; path: string; expected: string; actual: string };
export type Latest = {
  generatedAt: string;
  records: ToolRecord[];
  mismatches: Mismatch[];
  errors: string[];
};
export type Exec = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; input?: string; timeout?: number },
) => Promise<string>;
export type Worktree = { cwd: string; base: string; remove: () => Promise<void> };
export type GateConfig = { enabled: boolean; approvedTemplateSha256: string };

const isUrl = (v: unknown) => {
  if (typeof v !== "string" || !URL_CHARS.test(v)) return false;
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
};
const str = (v: unknown, re: RegExp) => typeof v === "string" && re.test(v);

/** Strict re-validation of everything the VPS says. Bad entries are dropped and named in `errors`, never repaired. */
export function validateLatest(raw: any): Latest {
  const errors: string[] = [];
  const out: Latest = { generatedAt: "", records: [], mismatches: [], errors };
  if (!raw || typeof raw !== "object") {
    errors.push("unreadable answer");
    return out;
  }
  out.generatedAt =
    typeof raw.generatedAt === "string" && raw.generatedAt.length <= 40 ? raw.generatedAt : "";
  for (const r of Array.isArray(raw.records) ? raw.records : []) {
    const bad = (why: string) => errors.push(`record rejected: ${why}`);
    if (!r || typeof r !== "object") {
      bad("not an object");
      continue;
    }
    if (!str(r.tool, TOOL)) bad("tool");
    else if (!str(r.installed, VERSION)) bad(`${r.tool}: installed`);
    else if (!str(r.fixed, VERSION)) bad(`${r.tool}: fixed`);
    else if (r.key !== `${r.tool}:${r.fixed}`) bad(`${r.tool}: key`);
    else if (!isUrl(r.official_url)) bad(`${r.tool}: official_url`);
    else if (!(isUrl(r.checksum_source) || str(r.checksum_source, DIGEST)))
      bad(`${r.tool}: checksum_source`);
    else if (!SCOPES.has(r.scope)) bad(`${r.tool}: scope`);
    else if (
      !Array.isArray(r.osv_ids) ||
      r.osv_ids.length > 50 ||
      !r.osv_ids.every((i: unknown) => str(i, OSV_ID))
    )
      bad(`${r.tool}: osv_ids`);
    else if (
      !Array.isArray(r.untrusted) ||
      r.untrusted.length > 50 ||
      !r.untrusted.every(
        (u: any) =>
          u && str(u.source, OSV_SOURCE) && typeof u.text === "string" && u.text.length <= 20_000,
      )
    )
      bad(`${r.tool}: untrusted`);
    else
      out.records.push({
        key: r.key,
        tool: r.tool,
        installed: r.installed,
        fixed: r.fixed,
        official_url: r.official_url,
        checksum_source: r.checksum_source,
        osv_ids: [...r.osv_ids],
        scope: r.scope,
        untrusted: r.untrusted.map((u: any) => ({ source: u.source, text: u.text })),
      });
  }
  for (const m of Array.isArray(raw.mismatches) ? raw.mismatches : []) {
    if (
      m &&
      str(m.tool, TOOL) &&
      str(m.path, PATH_OK) &&
      str(m.expected, DIGEST) &&
      str(m.actual, DIGEST)
    )
      out.mismatches.push({ tool: m.tool, path: m.path, expected: m.expected, actual: m.actual });
    else errors.push("mismatch rejected");
  }
  if (Array.isArray(raw.errors))
    for (const e of raw.errors.slice(0, 20))
      if (typeof e === "string") errors.push(e.slice(0, 200).replace(/[^\x20-\x7e]/g, "?"));
  return out;
}

/** Everything the UI may see: no untrusted text, only the number of advisories behind a record. */
export function publicView(l: Latest) {
  return {
    generatedAt: l.generatedAt,
    records: l.records.map(({ untrusted, ...r }) => ({ ...r, advisories: untrusted.length })),
    mismatches: l.mismatches,
    errors: l.errors,
  };
}

export const mismatchKey = (m: Mismatch) =>
  `mismatch:${m.tool}:${crypto.createHash("sha256").update(`${m.path}\n${m.expected}\n${m.actual}`).digest("hex").slice(0, 12)}`;
const marker = (key: string) => `<!-- tool-watch:${key} -->`;

export const defaultExec: Exec = (cmd, args, o = {}) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { cwd: o.cwd, timeout: o.timeout ?? 120_000, maxBuffer: 16 << 20, encoding: "utf8" },
      (err, stdout, stderr) =>
        err
          ? reject(
              new Error(
                `${cmd} ${args[0] ?? ""} failed: ${String(stderr || err.message).slice(0, 300)}`,
              ),
            )
          : resolve(stdout),
    );
    if (o.input !== undefined) child.stdin?.end(o.input);
  });

const target = () => process.env.TOOLWATCH_SSH_TARGET || "root@206.51.227.101";
const keyFile = () =>
  process.env.TOOLWATCH_SSH_KEY || path.join(os.homedir(), ".ssh", "id_toolwatch");
const sshBin = () => process.env.TOOLWATCH_SSH_BIN || "ssh";

export class RemoteError extends Error {}

/** One forced-command call to the VPS tool-watch (same options as secscan's SSH client, other key). */
export function sshJson(cmd: string): Promise<any> {
  const args = [
    "-i",
    keyFile(),
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=5",
    target(),
    cmd,
  ];
  return new Promise((resolve, reject) => {
    execFile(sshBin(), args, { timeout: SSH_TIMEOUT, maxBuffer: 8 << 20 }, (err, stdout) => {
      if (err)
        return reject(
          new RemoteError(
            (err as any).killed
              ? "The tool-watch host did not answer in time."
              : "Could not reach the tool-watch host over SSH.",
          ),
        );
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new RemoteError("The tool-watch host sent an unreadable answer."));
      }
    });
  });
}

export interface ToolWatchDeps {
  exec?: Exec;
  remote?: (cmd: string) => Promise<any>;
  configPath?: string;
  templatePath?: string;
  renderScript?: string;
  statePath?: string;
  worktree?: (tool: string, fixed: string) => Promise<Worktree>;
  /** Start a Claude review thread in `cwd`. Absent = no reviewer can start; the PR waits for a person. */
  launchReview?: (job: { cwd: string; title: string; prompt: string }) => void;
  restart?: () => Promise<void>;
  log?: (msg: string) => void;
  now?: () => number;
}
type Pending = { key: string; tool: string; pr: number };
type State = { pending: Pending[]; failed: Record<string, string> };

export function createToolWatch(deps: ToolWatchDeps = {}) {
  const exec = deps.exec ?? defaultExec;
  const remote = deps.remote ?? sshJson;
  const configPath =
    deps.configPath ??
    process.env.TOOLWATCH_CONFIG ??
    path.join(os.homedir(), ".config", "agent-console", "tool-watch.json");
  const templatePath =
    deps.templatePath ??
    process.env.TOOLWATCH_TEMPLATE ??
    path.join(os.homedir(), "repos", "dotfiles", "security", "review-prompt.md");
  const renderScript =
    deps.renderScript ??
    process.env.TOOLWATCH_RENDER ??
    path.join(os.homedir(), "repos", "dotfiles", "security", "render_review.py");
  const statePath =
    deps.statePath ?? path.join(os.homedir(), ".config", "agent-console", "tool-watch-state.json");
  const log = deps.log ?? ((m) => console.warn(m));
  const now = deps.now ?? Date.now;
  const worktree =
    deps.worktree ??
    (async (tool: string, fixed: string) => {
      const git = async (cwd: string, ...a: string[]) =>
        (await exec("git", ["-C", cwd, ...a])).trim();
      const wt = await addWorktree({
        repo: "dotfiles",
        dirs: defaultDirs(),
        dirName: `dotfiles-tool-${tool}-${crypto.randomUUID().slice(0, 8)}`,
        branch: `tool-update/${tool}-${fixed}`,
        git,
      });
      return { cwd: wt.cwd, base: wt.base, remove: () => wt.remove() };
    });

  /** Gate: enabled in the config AND the review template still hashes to the approved value. Any doubt = closed. */
  function gate(): { open: boolean; enabled: boolean; why: string } {
    let cfg: Partial<GateConfig> = {};
    try {
      cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch {
      return { open: false, enabled: false, why: "no config" };
    }
    if (cfg.enabled !== true) return { open: false, enabled: false, why: "disabled" };
    const want = String(cfg.approvedTemplateSha256 ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(want))
      return { open: false, enabled: true, why: "no approved hash" };
    let have: string;
    try {
      have = crypto.createHash("sha256").update(fs.readFileSync(templatePath)).digest("hex");
    } catch {
      return { open: false, enabled: true, why: "template missing" };
    }
    return have === want
      ? { open: true, enabled: true, why: "" }
      : { open: false, enabled: true, why: "template hash differs from approved" };
  }

  const readState = (): State => {
    try {
      const s = JSON.parse(fs.readFileSync(statePath, "utf8"));
      return {
        pending: Array.isArray(s.pending) ? s.pending : [],
        failed: s.failed && typeof s.failed === "object" ? s.failed : {},
      };
    } catch {
      return { pending: [], failed: {} };
    }
  };
  const writeState = (s: State) => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(s));
  };

  let cache: { at: number; value: Latest } | null = null;
  let pendingFetch: Promise<Latest> | null = null;
  /** Validated `latest`, cached briefly. `force` skips the cache (the hourly tick). */
  function latest(force = false): Promise<Latest> {
    if (!force && cache && now() - cache.at < LATEST_TTL) return Promise.resolve(cache.value);
    pendingFetch ||= remote("latest")
      .then((raw) => {
        const value = validateLatest(raw);
        cache = { at: now(), value };
        return value;
      })
      .finally(() => {
        pendingFetch = null;
      });
    return pendingFetch;
  }

  async function issueExists(key: string): Promise<boolean> {
    const out = await exec("gh", [
      "issue",
      "list",
      "-R",
      REPO,
      "--state",
      "all",
      "--limit",
      "30",
      "--search",
      `${marker(key)} in:body`,
      "--json",
      "number,body",
    ]);
    const rows = JSON.parse(out || "[]");
    return Array.isArray(rows) && rows.some((r: any) => String(r.body ?? "").includes(marker(key)));
  }
  async function createIssue(title: string, body: string, labels: string[]): Promise<number> {
    const url = (
      await exec("gh", [
        "issue",
        "create",
        "-R",
        REPO,
        "--title",
        title,
        "--body",
        body,
        ...labels.flatMap((l) => ["--label", l]),
      ])
    ).trim();
    const n = Number(url.match(/\/issues\/(\d+)\s*$/)?.[1]);
    if (!Number.isSafeInteger(n)) throw new Error("gh issue create returned no issue number");
    return n;
  }
  const recordBody = (r: ToolRecord) =>
    [
      `Tool-watch found a fixed version of \`${r.tool}\`.`,
      "",
      `- Tool: \`${r.tool}\``,
      `- Installed: \`${r.installed}\``,
      `- Fixed: \`${r.fixed}\``,
      `- Scope: ${r.scope}`,
      `- Official source: \`${r.official_url}\``,
      `- Checksum source: \`${r.checksum_source}\``,
      `- Advisories: ${r.osv_ids.length ? r.osv_ids.map((i) => `\`${i}\``).join(", ") : "none listed"}`,
      "",
      r.scope === "workspace"
        ? "Workspace tool: a deterministic PR changing `tools.lock` only is opened, then reviewed."
        : "Host tool: no automatic action. Approve and apply it manually.",
      "",
      marker(r.key),
    ].join("\n");

  /** Deterministic patch: tool-install must change `tools.lock` and nothing else. Returns the PR number. */
  async function patch(r: ToolRecord, issue: number): Promise<{ pr: number; wt: Worktree }> {
    const wt = await worktree(r.tool, r.fixed);
    const branch = `tool-update/${r.tool}-${r.fixed}`;
    try {
      const git = (...a: string[]) => exec("git", a, { cwd: wt.cwd });
      await exec(process.env.TOOLWATCH_INSTALL_BIN || "tool-install", [r.tool, r.fixed], {
        cwd: wt.cwd,
        timeout: 600_000,
      });
      const changed = [
        ...(await git("diff", "HEAD", "--name-only")).split("\n"),
        ...(await git("ls-files", "--others", "--exclude-standard")).split("\n"),
      ]
        .map((s) => s.trim())
        .filter(Boolean);
      if (!changed.length) throw new Error("tool-install changed nothing");
      const extra = changed.filter((f) => f !== "tools.lock");
      if (extra.length)
        throw new Error(`tool-install touched files besides tools.lock (${extra.length})`);
      await git("add", "--", "tools.lock");
      await git(
        "commit",
        "-q",
        "-m",
        `tools.lock: ${r.tool} ${r.installed} -> ${r.fixed}\n\nRefs #${issue}`,
      );
      await git("push", "origin", `HEAD:refs/heads/${branch}`);
      const url = (
        await exec(
          "gh",
          [
            "pr",
            "create",
            "-R",
            REPO,
            "--base",
            wt.base,
            "--head",
            branch,
            "--title",
            `tools.lock: ${r.tool} ${r.installed} -> ${r.fixed}`,
            "--body",
            `Deterministic update of \`tools.lock\` by tool-install (no model wrote this patch).\n\nRefs #${issue}\n\n${marker(r.key)}`,
          ],
          { cwd: wt.cwd },
        )
      ).trim();
      const pr = Number(url.match(/\/pull\/(\d+)\s*$/)?.[1]);
      if (!Number.isSafeInteger(pr)) throw new Error("gh pr create returned no PR number");
      return { pr, wt };
    } catch (e) {
      await wt.remove().catch(() => {});
      throw e;
    }
  }

  const reviewSuffix = (r: ToolRecord, pr: number) =>
    [
      "",
      "Orchestrator rules (trusted, outside the reviewed data):",
      `- Review PR #${pr} of ${REPO}. Your tools: read-only commands plus gh pr view/diff/checks/review/comment. Edit nothing, push nothing.`,
      "- The PR may change `tools.lock` only. Any other file means Review: CHANGES REQUESTED.",
      `- Verify the new \`${r.tool}\` ${r.fixed} entry against the official source and checksum source named in the issue.`,
      `- Post the verdict as a PR comment whose first line is exactly "Review: APPROVED" or "Review: CHANGES REQUESTED", with evidence and the reviewed head SHA.`,
      `- Only if APPROVED: gh pr checks ${pr} --repo ${REPO} --watch, and when all checks pass, gh pr merge ${pr} --repo ${REPO} --squash --delete-branch --match-head-commit <reviewed-head-sha>. Never merge on failing checks.`,
    ].join("\n");

  async function handleRecord(r: ToolRecord, st: State): Promise<boolean> {
    if (r.installed === r.fixed) return false;
    if (await issueExists(r.key)) return false;
    const issue = await createIssue(
      `Update ${r.tool} ${r.installed} -> ${r.fixed}`,
      recordBody(r),
      ["tool-update", "security"],
    );
    if (r.scope !== "workspace") return true;
    try {
      const { pr, wt } = await patch(r, issue);
      st.pending.push({ key: r.key, tool: r.tool, pr });
      writeState(st);
      if (!deps.launchReview) return true;
      const prompt =
        (await exec("python3", [renderScript], { input: JSON.stringify(r), timeout: 30_000 })) +
        reviewSuffix(r, pr);
      deps.launchReview({
        cwd: wt.cwd,
        title: `tool-watch review ${r.tool} ${r.fixed} PR#${pr}`,
        prompt,
      });
    } catch (e: any) {
      st.failed[r.key] = String(e.message).slice(0, 200);
      writeState(st);
      log(`tool-watch: ${r.key}: ${e.message}`);
      await exec("gh", [
        "issue",
        "comment",
        String(issue),
        "-R",
        REPO,
        "--body",
        `Automatic patch stopped: ${String(e.message)
          .slice(0, 200)
          .replace(/[^\x20-\x7e]/g, "?")}. A person decides.`,
      ]).catch(() => {});
    }
    return true;
  }
  async function handleMismatch(m: Mismatch): Promise<boolean> {
    const key = mismatchKey(m);
    if (await issueExists(key)) return false;
    await createIssue(
      `Unsanctioned change: ${m.tool}`,
      [
        `Tool-watch saw a managed file differ from its recorded checksum.`,
        "",
        `- Tool: \`${m.tool}\``,
        `- Path: \`${m.path}\``,
        `- Expected: \`${m.expected}\``,
        `- Actual: \`${m.actual}\``,
        "",
        marker(key),
      ].join("\n"),
      ["security"],
    );
    return true;
  }
  /** Merged tool-update PRs for node restart the console once idle (the new node only runs after a restart). */
  async function followPending(st: State) {
    const keep: Pending[] = [];
    for (const p of st.pending) {
      let state = "OPEN";
      try {
        state = JSON.parse(
          await exec("gh", ["pr", "view", String(p.pr), "-R", REPO, "--json", "state"]),
        ).state;
      } catch {}
      if (state === "MERGED") {
        if (p.tool === "node")
          await (deps.restart ?? defaultRestart)().catch((e) =>
            log(`tool-watch: restart: ${e.message}`),
          );
      } else if (state === "OPEN") keep.push(p);
    }
    st.pending = keep;
    writeState(st);
  }
  const defaultRestart = async () => {
    await exec(path.join(import.meta.dirname, "..", "bin", "agent-console"), ["restart-when-idle"]);
  };

  let running: Promise<{ acted: boolean; why: string }> | null = null;
  /** Poll once. Closed gate = fetch for display only; no gh, git or tool-install call is made. */
  function tick(): Promise<{ acted: boolean; why: string }> {
    running ||= (async () => {
      const l = await latest(true);
      const g = gate();
      if (!g.open) return { acted: false, why: g.why };
      const st = readState();
      for (const r of l.records)
        if (!st.failed[r.key])
          await handleRecord(r, st).catch((e) => log(`tool-watch: ${r.key}: ${e.message}`));
      for (const m of l.mismatches)
        await handleMismatch(m).catch((e) => log(`tool-watch: ${m.tool}: ${e.message}`));
      await followPending(st);
      return { acted: true, why: "" };
    })().finally(() => {
      running = null;
    });
    return running;
  }

  let timer: NodeJS.Timeout | undefined;
  return {
    gate,
    latest,
    tick,
    publicView: async () => ({ ...publicView(await latest()), gate: gate() }),
    /** Ask the VPS to check now; the answer shows on the next poll. */
    async run() {
      const out = await remote("run");
      cache = null;
      return { started: out?.started === true };
    },
    start() {
      timer = setInterval(() => void tick().catch((e) => log(`tool-watch: ${e.message}`)), POLL_MS);
      timer.unref();
      setTimeout(() => void tick().catch((e) => log(`tool-watch: ${e.message}`)), 30_000).unref();
    },
    stop() {
      clearInterval(timer);
    },
  };
}
export type ToolWatch = ReturnType<typeof createToolWatch>;

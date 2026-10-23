import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ClaudeAccount, claudeConfigDir } from "./providers/claude-accounts.ts";

/** Estimated cache timing only; provider OAuth backends do not report expiry timestamps.
 * AGENT_CONSOLE_IDLE_COMPACT=0 disables automatic compaction.
 * AGENT_CONSOLE_IDLE_COMPACT_<PROVIDER>_TTL_MS explicitly configures an estimated TTL.
 * AGENT_CONSOLE_IDLE_COMPACT_LEAD_MS defaults to 30000; MIN_TOKENS defaults to 50000.
 * Unknown TTLs remain disabled. Claude settings follow global, project, local precedence.
 */
export interface IdleCompactionState {
  claudeAccount?: ClaudeAccount;
  provider: string;
  cwd: string;
  model?: string;
  resolvedModel?: string;
  status: string;
  sessionId?: string;
  archived?: number;
  operation?: string;
  waiting?: number;
  context?: { used?: number };
  idleCompaction?: boolean;
  lastUserActivityAt?: number;
  lastProviderActivityAt?: number;
  idleCompactionConsumedAt?: number;
}
const positive = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
export function idleCompactionPolicy(
  thread: Pick<
    IdleCompactionState,
    "provider" | "cwd" | "model" | "resolvedModel" | "claudeAccount"
  >,
  env = process.env,
  home = os.homedir(),
) {
  const leadMs = positive(env.AGENT_CONSOLE_IDLE_COMPACT_LEAD_MS) ?? 30000;
  const minTokens = positive(env.AGENT_CONSOLE_IDLE_COMPACT_MIN_TOKENS) ?? 50000;
  let ttlMs: number | undefined;
  let source: string | undefined;
  const override = env[`AGENT_CONSOLE_IDLE_COMPACT_${thread.provider.toUpperCase()}_TTL_MS`];
  if (override !== undefined) {
    ttlMs = positive(override);
    source = ttlMs ? "override" : undefined;
  } else if (thread.provider === "codex") {
    // API retention guidance is an estimate for the OAuth backend, not observed expiry.
    // CLI default is resolved by thread/start or thread/resume; never infer it from config.
    const model = thread.model === "default" ? thread.resolvedModel : thread.model;
    const match =
      /^gpt-(5(?:\.[1-9])?|6(?:\.[01])?)(?:-(?:codex|mini|nano|pro|sol|astra|luna|max))*(?:-(?:\d{8}|\d{4}-\d{2}-\d{2}))?$/.exec(
        model || "",
      );
    if (match) {
      const version = Number(match[1]);
      ttlMs = version >= 5.5 ? 30 * 60_000 : 5 * 60_000;
      source =
        version >= 5.6
          ? "openai-default-estimate"
          : version === 5.5
            ? "openai-extended-estimate"
            : "openai-in-memory-estimate";
    }
  } else if (thread.provider === "claude") {
    let ttl: unknown,
      ambiguous = false;
    const config = claudeConfigDir(thread.claudeAccount, env, home);
    let project = path.resolve(thread.cwd);
    while (!fs.existsSync(path.join(project, ".git")) && path.dirname(project) !== project)
      project = path.dirname(project);
    if (!fs.existsSync(path.join(project, ".git"))) project = thread.cwd;
    const files = [
      path.join(config, "settings.json"),
      path.join(project, ".claude", "settings.json"),
      path.join(project, ".claude", "settings.local.json"),
      "/etc/claude-code/managed-settings.json",
    ];
    // Worktrees can share local settings with their main checkout. If that changes the
    // TTL, leave timing unknown rather than infer which experimental CLI path wins.
    const gitFile = path.join(project, ".git");
    try {
      if (fs.statSync(gitFile).isFile()) {
        const gitdir = fs
          .readFileSync(gitFile, "utf8")
          .trim()
          .replace(/^gitdir:\s*/, "");
        const main = path.dirname(path.dirname(path.dirname(path.resolve(project, gitdir))));
        const local = path.join(main, ".claude", "settings.local.json");
        if (main !== project && fs.existsSync(local)) {
          const settings = JSON.parse(fs.readFileSync(local, "utf8"));
          if (Object.hasOwn(settings, "promptCacheTtl") || settings.env) ambiguous = true;
        }
      }
    } catch {}
    for (const file of files) {
      if (!fs.existsSync(file)) continue;
      try {
        const settings = JSON.parse(fs.readFileSync(file, "utf8"));
        if (Object.hasOwn(settings, "promptCacheTtl")) ttl = settings.promptCacheTtl;
        // Settings can mutate the child environment. Avoid claiming a known TTL
        // when inherited shell/settings environment precedence is ambiguous.
        if (
          [
            "FORCE_PROMPT_CACHING_5M",
            "CLAUDE_CODE_PROMPT_CACHE_TTL",
            "ENABLE_PROMPT_CACHING_1H",
          ].some((key) => Object.hasOwn(settings.env || {}, key))
        )
          ambiguous = true;
      } catch {
        ambiguous = true;
        break;
      }
    }
    if (!ambiguous) {
      const selected = ["5m", "1h"].includes(env.CLAUDE_CODE_PROMPT_CACHE_TTL || "")
        ? env.CLAUDE_CODE_PROMPT_CACHE_TTL
        : ttl;
      ttlMs =
        selected === "1h"
          ? 3600000
          : selected === "5m"
            ? 300000
            : env.ENABLE_PROMPT_CACHING_1H === "1"
              ? 3600000
              : undefined;
      if (env.FORCE_PROMPT_CACHING_5M === "1") ttlMs = 300000;
      if (ttlMs) source = "claude-settings-estimate";
    }
  }
  // An explicit Console estimate also respects the provider's forced five-minute mode.
  if (
    ttlMs != null &&
    override !== undefined &&
    thread.provider === "claude" &&
    env.FORCE_PROMPT_CACHING_5M === "1"
  )
    ttlMs = 300000;
  return {
    ttlMs: env.AGENT_CONSOLE_IDLE_COMPACT === "0" ? undefined : ttlMs,
    source: env.AGENT_CONSOLE_IDLE_COMPACT === "0" ? undefined : source,
    leadMs,
    minTokens,
  };
}
export function idleCompactionDeadline(
  t: IdleCompactionState,
  policy: ReturnType<typeof idleCompactionPolicy>,
  queued = false,
) {
  if (
    !policy.ttlMs ||
    policy.ttlMs <= policy.leadMs ||
    t.idleCompaction === false ||
    t.status !== "idle" ||
    t.archived ||
    t.operation ||
    t.waiting ||
    queued ||
    !t.sessionId
  )
    return undefined;
  if (
    !t.lastUserActivityAt ||
    !t.lastProviderActivityAt ||
    (t.idleCompactionConsumedAt ?? 0) >= t.lastUserActivityAt ||
    !Number.isFinite(t.context?.used) ||
    t.context!.used! < policy.minTokens
  )
    return undefined;
  if (t.lastProviderActivityAt < t.lastUserActivityAt) return undefined; // no successful response for this activity cycle
  return t.lastProviderActivityAt + policy.ttlMs - policy.leadMs;
}

export class IdleCompactionTimers {
  private pending = new Map<string, ReturnType<typeof setTimeout>>();
  cancel(id: string) {
    const timer = this.pending.get(id);
    if (timer) clearTimeout(timer);
    this.pending.delete(id);
  }
  schedule(id: string, deadline: number, callback: () => void) {
    this.cancel(id);
    const delay = deadline - Date.now();
    if (delay <= 0 || delay > 2147483647) return;
    const timer = setTimeout(() => {
      if (this.pending.get(id) !== timer) return;
      this.pending.delete(id);
      callback();
    }, delay);
    timer.unref();
    this.pending.set(id, timer);
  }
  shutdown() {
    for (const id of this.pending.keys()) this.cancel(id);
  }
}

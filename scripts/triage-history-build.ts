#!/usr/bin/env node
import { execFileSync } from "node:child_process";
/** Build private empirical examples from completed, commit-backed delivery runs.
 * This does not infer whole-task effort, missing tokens, child-agent usage, or active time.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAccountingRows } from "../server/accounting-repair.ts";

type Json = Record<string, any>;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;
const content = (e: Json): Json[] =>
  Array.isArray(e.message?.content)
    ? e.message.content.filter((b: unknown) => b && typeof b === "object")
    : [];
function readJsonLines(file: string): Json[] {
  if (fs.statSync(file).size > MAX_FILE_BYTES)
    throw Error(`Input exceeds ${MAX_FILE_BYTES} bytes: ${file}`);
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch {
        throw Error(`Invalid JSON at ${file}:${i + 1}`);
      }
    });
}
function git(repo: string, args: string[]) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/** Observed root-process instrumentation, not a prework complexity predictor. */
export function observedActivity(events: Json[]) {
  const calls = new Set<string>(),
    rounds = new Set<string>();
  for (const e of events) {
    if (e.type !== "assistant") continue;
    const ids = content(e)
      .filter((b) => b.type === "tool_use" && typeof b.id === "string" && b.id)
      .map((b) => b.id);
    const fresh = ids.filter((id) => !calls.has(id));
    if (!fresh.length) continue;
    for (const id of fresh) calls.add(id);
    const messageId = e.message?.id ?? e.uuid;
    rounds.add(
      typeof messageId === "string" && messageId
        ? `message:${messageId}`
        : `batch:${ids.slice().sort().join(",")}`,
    );
  }
  return { toolCalls: calls.size, toolRounds: rounds.size };
}

/** Only conversation available before the current request; never this run's results. */
export function preworkContext(events: Json[], beforeIndex: number) {
  const messages: { role: "user" | "assistant"; text: string }[] = [];
  for (const event of events.slice(0, beforeIndex)) {
    const role =
      event.type === "user_input" ? "user" : event.type === "assistant" ? "assistant" : undefined;
    if (!role) continue;
    const raw =
      role === "user"
        ? event.text
        : content(event)
            .filter((block) => block.type === "text" && typeof block.text === "string")
            .map((block) => block.text)
            .join("\n");
    if (typeof raw !== "string") continue;
    const text = raw
      .split("\n")
      .filter(
        (line) =>
          !/\bcommit(?:ted|s)?\b|\b[0-9a-f]{7,40}\b|\b(?:input|output|cache|generated|used)\s+tokens?\b|\b\d[\d,]*\s+tokens?\b/i.test(
            line,
          ),
      )
      .join("\n")
      .trim();
    if (text) messages.push({ role, text });
  }
  let remaining = 8000;
  return messages
    .slice(-4)
    .reverse()
    .map((message) => {
      const text = remaining > 0 ? message.text.slice(-remaining) : "";
      remaining -= text.length;
      return { ...message, text };
    })
    .filter((message) => message.text)
    .reverse();
}

/** Availability is a conservative training cutoff, never measured runtime. */
export function completionAvailability(
  events: Json[],
  resultIndex: number,
  thread: Json,
  startedAt: number,
) {
  const result = events[resultIndex];
  const nextInput = events.slice(resultIndex + 1).find((e) => e.type === "user_input");
  if (thread.status === "running" && !nextInput) return undefined;
  if (finite(result.ts) && result.ts >= startedAt)
    return { at: result.ts, bound: "result-timestamp", exact: true };
  if (nextInput && finite(nextInput.ts) && nextInput.ts >= startedAt)
    return { at: nextInput.ts, bound: "next-input", exact: false };
  const isFinalResult = !events.slice(resultIndex + 1).some((e) => e.type === "result");
  if (
    !nextInput &&
    isFinalResult &&
    thread.status === "idle" &&
    finite(thread.updatedAt) &&
    thread.updatedAt >= startedAt
  ) {
    return { at: thread.updatedAt, bound: "idle-thread-updatedAt", exact: false };
  }
  return undefined;
}

export function buildTriageHistory(opts: { dataDir: string; repoDir: string; repo: string }) {
  const raw = readJsonLines(path.join(opts.dataDir, "turns.jsonl"));
  const rows = normalizeAccountingRows(opts.dataDir, raw);
  const threads: Json[] = JSON.parse(
    fs.readFileSync(path.join(opts.dataDir, "threads.json"), "utf8"),
  );
  if (!Array.isArray(threads)) throw Error("Expected thread metadata array");
  const commits = git(opts.repoDir, ["rev-list", "--all"]).split("\n").filter(Boolean);
  const resolve = (prefix: string) => {
    const found = commits.filter((sha) => sha.startsWith(prefix));
    return found.length === 1 ? found[0] : undefined;
  };
  const exclusions: Record<string, number> = {};
  const exclude = (why: string) => {
    exclusions[why] = (exclusions[why] || 0) + 1;
  };
  const tasks: Json[] = [];
  const usedLedger = new Set<Json>();
  let completedSegments = 0;
  for (const thread of threads) {
    if (!/^[\w-]+$/.test(thread.id)) {
      exclude("invalidThreadId");
      continue;
    }
    const logFile = path.join(opts.dataDir, "logs", `${thread.id}.jsonl`);
    if (!fs.existsSync(logFile)) {
      exclude("missingThreadLog");
      continue;
    }
    if (/mock|test-fixture|^\/tmp\//i.test(String(thread.cwd || ""))) {
      exclude("syntheticThread");
      continue;
    }
    const ledger = rows.filter((r) => r.thread === thread.id);
    const events = readJsonLines(logFile);
    let start: Json | undefined,
      segment: Json[] = [],
      lineStart = 0;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.type === "user_input" && !start) {
        start = e;
        segment = [];
        lineStart = i + 1;
      }
      if (!start) continue;
      segment.push(e);
      if (e.type !== "result") continue;
      if (
        /^\/compact(?:\s|$)/.test(start.text || "") &&
        e.num_turns === 0 &&
        !e.is_error &&
        !segment.some((x) => x.type === "system" && x.subtype === "compact_boundary")
      )
        continue;
      const input = start;
      const eventsForRun = segment;
      start = undefined;
      segment = [];
      completedSegments++;
      if (
        input.auto ||
        input.questionAnswer ||
        /^\/(?:compact|help|clear|model|effort)\b/.test(input.text || "")
      ) {
        exclude("nonTaskInput");
        continue;
      }
      // Very short continuations do not describe the work without earlier conversation.
      if (typeof input.text !== "string" || input.text.trim().split(/\s+/).length < 6) {
        exclude("contextOnlyRequest");
        continue;
      }
      if (eventsForRun.slice(1).some((x) => x.type === "user_input")) {
        exclude("multipleRequestsInRun");
        continue;
      }
      if (!finite(input.ts)) {
        exclude("missingStartTime");
        continue;
      }
      const completion = completionAvailability(events, i, thread, input.ts);
      if (!completion) {
        exclude("missingSafeCompletionBound");
        continue;
      }
      let match: Json | undefined,
        join = "";
      const byInput = ledger.filter((r) => r.ts === input.ts);
      if (byInput.length === 1) {
        match = byInput[0];
        join = "exact-user-input-timestamp";
      }
      if (!match && typeof e.uuid === "string") {
        const exact = ledger.filter((r) => r.eventId === e.uuid);
        if (exact.length === 1) {
          match = exact[0];
          join = "exact-result-event-id";
        }
      }
      if (!match && finite(e.duration_ms)) {
        // Older live accounting starts before user_input is logged. This joins an
        // identical result measurement within one thread, never nearest timestamps.
        const exact = ledger.filter((r) => r.ms === e.duration_ms);
        if (exact.length === 1) {
          match = exact[0];
          join = "unique-thread-exact-result-duration";
        }
      }
      if (!match || usedLedger.has(match)) {
        exclude("missingOrReusedAccounting");
        continue;
      }
      // Exact duration is an identity check only when the accounting record also
      // belongs to this logged run. Allow one second for log-write ordering.
      if (!finite(match.ts) || match.ts < input.ts - 1000 || match.ts > completion.at) {
        exclude("accountingOutsideRun");
        continue;
      }
      if (match.err || e.is_error || match.unresolved || !finite(match.in) || !finite(match.out)) {
        exclude("failedOrIncompleteAccounting");
        continue;
      }
      const calls = new Map<string, Json>();
      for (const x of eventsForRun)
        if (x.type === "assistant")
          for (const b of content(x)) if (b.type === "tool_use") calls.set(b.id, b);
      const proof: { sha: string; toolUseId: string }[] = [];
      for (const x of eventsForRun)
        if (x.type === "user")
          for (const b of content(x)) {
            if (b.type !== "tool_result" || b.is_error || typeof b.content !== "string") continue;
            const call = calls.get(b.tool_use_id);
            if (!call || !/git[^\n]{0,160}\bcommit\b/.test(JSON.stringify(call.input || {})))
              continue;
            // Native git and RTK both report the newly created commit hash.
            for (const pattern of [
              /\[[^\]\n]{0,100}\b([0-9a-f]{7,40})\]/g,
              /\bok\s+([0-9a-f]{7,40})\b/g,
            ])
              for (const m of b.content.matchAll(pattern)) {
                const sha = resolve(m[1]);
                if (sha) proof.push({ sha, toolUseId: b.tool_use_id });
              }
          }
      const verified = [...new Set(proof.map((p) => p.sha))].map((sha) => {
        const [timestamp, ...title] = git(opts.repoDir, [
          "show",
          "-s",
          "--format=%ct%n%s",
          sha,
        ]).split("\n");
        return { repo: opts.repo, sha, title: title.join("\n"), at: Number(timestamp) * 1000 };
      });
      if (!verified.length) {
        exclude("noSuccessfulCommitToolProof");
        continue;
      }
      if (
        verified.some((c) => !finite(c.at) || c.at < input.ts - 1000 || c.at > completion.at + 1000)
      ) {
        exclude("commitOutsideRun");
        continue;
      }
      usedLedger.add(match);
      const activity = observedActivity(eventsForRun);
      const cacheReadTokens = finite(match.cache) && match.cache <= match.in ? match.cache : null;
      tasks.push({
        id: `${thread.id}:${input.ts}`,
        group: thread.id,
        startedAt: new Date(input.ts).toISOString(),
        completedAt: new Date(completion.at).toISOString(),
        request: input.text.slice(0, 12_000),
        provider: match.provider,
        inputTokens: match.in,
        outputTokens: match.out,
        preworkContext: preworkContext(events, lineStart - 1),
        ...activity,
        cacheReadTokens,
        nonCachedInputTokens: cacheReadTokens === null ? null : match.in - cacheReadTokens,
        commits: verified.map(({ at, ...c }) => c),
        provenance: {
          scope: "delivery-turn",
          usageScope: "direct root process; child usage unproven",
          wholeTask: false,
          log: logFile,
          lines: [lineStart, i + 1],
          ledger: path.join(opts.dataDir, "turns.jsonl"),
          ledgerStartedAt: match.ts,
          accountingJoin: join,
          commitProof: proof,
          completionBound: completion.bound,
          completionTimeExact: completion.exact,
          completionNote: completion.exact
            ? "Observed result timestamp."
            : "Completed no later than this availability bound; this is not runtime.",
          cacheReadTokens: match.cache,
          inputIncludesCache: true,
          activeMs: null,
          activityNote:
            "Root-log distinct tool_use IDs; tool rounds are distinct assistant message IDs or deduplicated tool-call batches when IDs are absent. Missing child-agent activity is not imputed. These are outcome targets, never prework predictors.",
          preworkContextNote:
            "At most four conversational user/assistant text messages before the current user input, bounded to 8000 characters. Tool/results/thinking and commit/hash/token-report lines are excluded. Current-run outcome text is never included.",
          timingNote: "Result durations are not a reliable whole-task active-time measurement.",
        },
      });
    }
  }
  tasks.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
  return {
    version: 1,
    scope: "completed-delivery-run",
    tasks,
    audit: {
      ledgerRows: rows.length,
      completedSegments,
      selectedRuns: tasks.length,
      independentGroups: new Set(tasks.map((t) => t.group)).size,
      exclusions,
      completionBounds: Object.fromEntries(
        ["result-timestamp", "next-input", "idle-thread-updatedAt"].map((kind) => [
          kind,
          tasks.filter((t) => t.provenance.completionBound === kind).length,
        ]),
      ),
      limitation:
        "Observed direct-agent delivery-run tokens only. These are not whole-task totals or independent revisions. Failed or unfinished runs are not used as successful outcomes. No missing telemetry is imputed.",
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name: string, fallback?: string) => {
    const at = args.indexOf(name);
    return at < 0 ? fallback : args[at + 1];
  };
  const output = flag("--output");
  if (!output || !path.isAbsolute(output))
    throw Error("Use --output with an absolute private JSON path");
  const result = buildTriageHistory({
    dataDir: flag("--data", path.join(os.homedir(), ".config", "agent-console"))!,
    repoDir: flag("--repo-dir", path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."))!,
    repo: flag("--repo", "Amit-Roy/agent-console")!,
  });
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  // The output contains private prompts. Refuse permissive existing parent directories.
  if ((fs.statSync(path.dirname(output)).mode & 0o077) !== 0)
    throw Error("Output parent directory must be private (0700)");
  const temporary = `${output}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(result, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, output);
  console.log(JSON.stringify(result.audit));
}

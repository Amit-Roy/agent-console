import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./auth.ts";
import { childEnv } from "./providers/env.ts";
import { syncModelQuota } from "./providers/model-rate-client.ts";
import { reconstructClaudeHistory, type UsageRepairRow } from "./usage-repair.ts";

export interface UsageWindow {
  label: string;
  used: number;
  limit: number;
  unit?: string;
  resetsAt?: number;
}
export interface ProviderUsage {
  windows: UsageWindow[];
  note?: string;
  updatedAt: number;
  spendToday?: number;
  observedAt?: number;
  usageProvider?: string;
  sourceSessionId?: string;
  sourceEventUuid?: string;
}
export function claudeWindows(ev: any): UsageWindow[] {
  const w = ev.rate_limit_info?.unifiedWindows;
  if (!w) return [];
  return [
    ["5-hour", w.five_hour],
    ["7-day", w.seven_day],
  ].flatMap(([label, x]: any[]) =>
    x && Number.isFinite(x.utilization)
      ? [
          {
            label,
            used: x.utilization * 100,
            limit: 100,
            unit: "%",
            ...(x.resetsAt || x.resets_at ? { resetsAt: (x.resetsAt || x.resets_at) * 1000 } : {}),
          },
        ]
      : [],
  );
}
export function codexWindows(r: any): UsageWindow[] {
  return [r?.primary, r?.secondary].filter(Boolean).flatMap((x) =>
    Number.isFinite(x.used_percent)
      ? [
          {
            label:
              x.window_minutes === 300
                ? "5-hour"
                : x.window_minutes === 10080
                  ? "7-day"
                  : `${x.window_minutes} min`,
            used: x.used_percent,
            limit: 100,
            unit: "%",
            resetsAt: x.resets_at * 1000,
          },
        ]
      : [],
  );
}
export function routerUsage(d: any): Omit<ProviderUsage, "updatedAt"> {
  const windows: UsageWindow[] = [];
  const free = d.free_model_daily_requests;
  if (Number.isFinite(free?.used) && free.limit > 0)
    windows.push({
      label: "Free/day",
      used: free.used,
      limit: free.limit,
      resetsAt: new Date().setUTCHours(24, 0, 0, 0),
    });
  if (Number.isFinite(d.limit) && d.limit > 0 && Number.isFinite(d.limit_remaining))
    windows.push({ label: "Budget", used: d.limit - d.limit_remaining, limit: d.limit, unit: "$" });
  return {
    windows,
    ...(Number.isFinite(d.usage_daily) ? { spendToday: d.usage_daily } : {}),
    note: windows.length
      ? undefined
      : "OpenRouter does not report a request allowance for this key.",
  };
}
/** Rows to append to the usage history: windows whose used%, limit or reset time changed since `prev`. */
export function historyRows(
  provider: string,
  prev: ProviderUsage | undefined,
  next: ProviderUsage,
) {
  return next.windows
    .filter((w) => {
      const p = prev?.windows.find((x) => x.label === w.label);
      const distinctEvent =
        !!next.sourceSessionId &&
        !!next.sourceEventUuid &&
        (next.sourceSessionId !== prev?.sourceSessionId ||
          next.sourceEventUuid !== prev?.sourceEventUuid);
      return (
        distinctEvent || !p || p.used !== w.used || p.limit !== w.limit || p.resetsAt !== w.resetsAt
      );
    })
    .map((w) => ({
      ts: next.updatedAt,
      provider,
      ...w,
      ...(next.usageProvider
        ? {
            schemaVersion: 2,
            provenance: "received",
            timestampSource: "received",
            observedAt: next.observedAt,
            usageProvider: next.usageProvider,
            ...(next.sourceSessionId && next.sourceEventUuid
              ? { sourceSessionId: next.sourceSessionId, sourceEventUuid: next.sourceEventUuid }
              : {}),
          }
        : {}),
    }));
}
const file = path.join(DATA_DIR, "usage.json");
const historyFile = path.join(DATA_DIR, "usage-history.jsonl");
const repairMarker = path.join(DATA_DIR, "usage-history.schema-v2");
function migrateUsageHistory() {
  if (fs.existsSync(repairMarker)) return;
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const historyBackup = `${historyFile}.repair-v2.original`,
    usageBackup = `${file}.repair-v2.original`;
  const initialHistory = fs.existsSync(historyFile)
    ? fs.readFileSync(historyFile)
    : Buffer.from("");
  const initialUsage = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.from("{}");
  const historySource = fs.existsSync(historyBackup)
    ? fs.readFileSync(historyBackup)
    : initialHistory;
  const usageSource = fs.existsSync(usageBackup) ? fs.readFileSync(usageBackup) : initialUsage;
  const parseRows = (buf: Buffer) =>
    buf
      .toString("utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const row = JSON.parse(line);
        if (!row || !Number.isFinite(row.ts) || typeof row.provider !== "string")
          throw Error("Malformed usage history row");
        return row as UsageRepairRow;
      });
  const sourceRows = parseRows(historySource);
  const currentRows = fs.existsSync(historyFile) ? parseRows(initialHistory) : [];
  const snapshots = JSON.parse(usageSource.toString("utf8"));
  const currentSnapshots = JSON.parse(initialUsage.toString("utf8"));
  if (
    !snapshots ||
    typeof snapshots !== "object" ||
    Array.isArray(snapshots) ||
    !currentSnapshots ||
    typeof currentSnapshots !== "object" ||
    Array.isArray(currentSnapshots)
  )
    throw Error("Malformed usage snapshot");
  const threadsFile = path.join(DATA_DIR, "threads.json");
  const threads = fs.existsSync(threadsFile)
    ? JSON.parse(fs.readFileSync(threadsFile, "utf8"))
    : [];
  if (!Array.isArray(threads)) throw Error("Malformed threads metadata");
  const logsDir = path.join(DATA_DIR, "logs"),
    logs: Record<string, any[]> = {};
  if (fs.existsSync(logsDir))
    for (const t of threads) {
      if (t?.provider !== "claude" || typeof t.id !== "string") continue;
      const logFile = path.join(logsDir, `${t.id}.jsonl`);
      if (!fs.existsSync(logFile)) continue;
      logs[t.id] = fs
        .readFileSync(logFile, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    }
  const preservedCurrentRows = currentRows.filter(
    (r) => !["claude", "claude:nefro"].includes(r.provider) || r.schemaVersion != null,
  );
  const restored = reconstructClaudeHistory({
    rows: [...sourceRows, ...preservedCurrentRows],
    logs,
    threads,
  });
  const nextUsage = {
    ...snapshots,
    ...Object.fromEntries(
      Object.entries(currentSnapshots).filter(
        ([key]) => key !== "claude" && key !== "claude:nefro",
      ),
    ),
  };
  for (const key of ["claude", "claude:nefro"]) {
    const sample = currentSnapshots[key];
    if (
      Number.isFinite(sample?.observedAt) &&
      sample?.usageProvider === key &&
      sample.observedAt >= (snapshots[key]?.observedAt ?? 0)
    )
      nextUsage[key] = sample;
  }
  for (const key of ["claude", "claude:nefro"])
    if (!Number.isFinite(nextUsage[key]?.observedAt) || nextUsage[key]?.usageProvider !== key)
      delete nextUsage[key];
  if (
    !(fs.existsSync(file) ? fs.readFileSync(file) : Buffer.from("{}")).equals(initialUsage) ||
    !(fs.existsSync(historyFile) ? fs.readFileSync(historyFile) : Buffer.from("")).equals(
      initialHistory,
    )
  )
    throw Error("Usage files changed during migration");
  const ensureBackup = (target: string, original: Buffer) => {
    if (!fs.existsSync(target)) fs.writeFileSync(target, original, { flag: "wx", mode: 0o600 });
  };
  ensureBackup(historyBackup, initialHistory);
  ensureBackup(usageBackup, initialUsage);
  const replace = (target: string, original: Buffer, body: string) => {
    if (fs.existsSync(target) && !fs.readFileSync(target).equals(original))
      throw Error("Usage files changed during migration");
    const temp = `${target}.repair-v2.tmp`;
    fs.writeFileSync(temp, body, { mode: 0o600 });
    if (fs.existsSync(target) && !fs.readFileSync(target).equals(original)) {
      fs.unlinkSync(temp);
      throw Error("Usage files changed during migration");
    }
    fs.renameSync(temp, target);
  };
  replace(
    historyFile,
    initialHistory,
    restored.rows.map((r) => JSON.stringify(r)).join("\n") + (restored.rows.length ? "\n" : ""),
  );
  replace(file, initialUsage, JSON.stringify(nextUsage));
  const markerTemp = `${repairMarker}.tmp`;
  fs.writeFileSync(markerTemp, "2\n", { mode: 0o600 });
  fs.renameSync(markerTemp, repairMarker);
}
let values: Record<string, ProviderUsage> = {};
try {
  values = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {}
/** Called only after this process has acquired the server ownership lock. */
export function repairUsageHistory(request: { pidFile?: string } = {}) {
  const pidFile = request.pidFile ?? process.env.AGENT_CONSOLE_PID_FILE;
  if (!fs.existsSync(repairMarker) && pidFile && fs.existsSync(pidFile)) {
    const ownerPid = Number(fs.readFileSync(pidFile, "utf8").trim());
    if (ownerPid !== process.pid) {
      let isAgentConsole = false;
      if (Number.isSafeInteger(ownerPid) && ownerPid > 0) {
        try {
          isAgentConsole = fs
            .readFileSync(`/proc/${ownerPid}/cmdline`)
            .includes(Buffer.from("server/index.ts"));
        } catch {}
      }
      if (isAgentConsole) throw Error("Another Agent Console server owns the data directory");
    }
  }
  migrateUsageHistory();
  try {
    values = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error("Usage snapshot could not be loaded after startup migration", { cause: error });
  }
}
let notify = (_provider: string, _usage: ProviderUsage) => {};
export const usage = {
  all: () => values,
  get: (provider: string) => values[provider],
  subscribe(fn: typeof notify) {
    notify = fn;
  },
  record(
    provider: string,
    sample: Omit<ProviderUsage, "updatedAt">,
    updatedAt = Date.now(),
    attribution?: {
      usageProvider: string;
      observedAt: number;
      sourceSessionId?: string;
      sourceEventUuid?: string;
    },
  ) {
    if (values[provider]?.updatedAt > updatedAt) return;
    const prev = values[provider];
    const rows = historyRows(provider, prev, { ...sample, ...(attribution || {}), updatedAt });
    values[provider] = { ...sample, ...(attribution || {}), updatedAt };
    // Latest-only usage.json cannot show how much of an expired window went unused; the history can.
    if (rows.length)
      try {
        fs.appendFileSync(historyFile, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", {
          mode: 0o600,
        });
      } catch {}
    fs.writeFileSync(file, JSON.stringify(values), { mode: 0o600 });
    notify(provider, values[provider]);
  },
  exhausted(provider: string) {
    return (
      values[provider]?.windows.some(
        (w) => w.used >= w.limit && (!w.resetsAt || w.resetsAt > Date.now()),
      ) ?? false
    );
  },
};
let routerRefresh: Promise<void> | undefined;
let routerCheckedAt = 0;
export function refreshRouterUsage(): Promise<void> {
  if (routerRefresh) return routerRefresh;
  if (Date.now() - routerCheckedAt < 5 * 60_000) return Promise.resolve();
  routerCheckedAt = Date.now();
  routerRefresh = readRouterUsage().finally(() => {
    routerRefresh = undefined;
  });
  return routerRefresh;
}
async function readRouterUsage() {
  if (process.env.AGENT_CONSOLE_MOCK === "1") return;
  const key = childEnv().OPENROUTER_API_KEY;
  if (!key) return;
  try {
    const r = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const data = ((await r.json()) as any).data;
      usage.record("pi", routerUsage(data));
      // The queue enforces OpenRouter's own free-tier daily count, not just what this Console sent.
      const free = data?.free_model_daily_requests;
      if (Number.isFinite(free?.used) && free.limit > 0)
        syncModelQuota({ used: free.used, limit: free.limit });
    }
  } catch {} // retain the last successful sample, with its timestamp
}

// Codex only reports quota while a turn runs; ask a short-lived app-server for the current figures instead.
export function readCodexUsage(): Promise<void> {
  if (process.env.AGENT_CONSOLE_MOCK === "1") return Promise.resolve();
  return new Promise((resolve) => {
    let out = "",
      done = false;
    const p = spawn(
      "codex",
      ["app-server", "-c", "analytics.enabled=false", "-c", "feedback.enabled=false"],
      { env: childEnv(), stdio: ["pipe", "pipe", "ignore"] },
    );
    const end = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      p.kill();
      resolve();
    };
    const timer = setTimeout(end, 10_000);
    const write = (o: object) => p.stdin.write(JSON.stringify(o) + "\n");
    p.on("error", end);
    p.on("exit", end);
    p.stdin.on("error", () => {});
    p.stdout.on("data", (d) => {
      out += d;
      for (let i; (i = out.indexOf("\n")) >= 0; ) {
        const line = out.slice(0, i);
        out = out.slice(i + 1);
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id === 1) {
          write({ method: "initialized", params: {} });
          write({ id: 2, method: "account/rateLimits/read" });
        } else if (m.id === 2) {
          const r = m.result?.rateLimits;
          const norm = (w: any) =>
            w && {
              used_percent: w.usedPercent,
              window_minutes: w.windowDurationMins,
              resets_at: w.resetsAt,
            };
          const windows = codexWindows({
            primary: norm(r?.primary),
            secondary: norm(r?.secondary),
          });
          if (windows.length) usage.record("codex", { windows });
          end();
        }
      }
    });
    write({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "agent_console", title: "Agent Console", version: "1.0.0" } },
    });
  });
}
export async function refreshUsage() {
  routerCheckedAt = 0;
  await Promise.all([readCodexUsage(), refreshRouterUsage()]);
}

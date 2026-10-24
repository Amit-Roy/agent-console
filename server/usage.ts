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
export interface UsageBalance {
  currency: "USD" | "CNY";
  total: number;
  granted: number;
  toppedUp: number;
}
export interface ProviderUsage {
  balances?: UsageBalance[];
  available?: boolean;
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
function deepseekAmount(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)))
    return;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
function deepseekBalance(item: any): UsageBalance | undefined {
  if (!item || typeof item !== "object") return;
  const { currency, total_balance, granted_balance, topped_up_balance } = item;
  if (currency !== "USD" && currency !== "CNY") return;
  const total = deepseekAmount(total_balance),
    granted = deepseekAmount(granted_balance),
    toppedUp = deepseekAmount(topped_up_balance);
  if (total === undefined || granted === undefined || toppedUp === undefined) return;
  return { currency, total, granted, toppedUp };
}
/** Invalid responses leave the previous account balance intact. */
export function deepseekUsage(body: unknown): Omit<ProviderUsage, "updatedAt"> | undefined {
  if (!body || typeof body !== "object") return;
  const payload = body as Record<string, unknown>;
  if (
    typeof payload.is_available !== "boolean" ||
    !Array.isArray(payload.balance_infos) ||
    !payload.balance_infos.length
  )
    return;
  const balances: UsageBalance[] = [];
  for (const item of payload.balance_infos) {
    const balance = deepseekBalance(item);
    if (!balance) return;
    balances.push(balance);
  }
  return { windows: [], balances, available: payload.is_available };
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
function parseUsageRows(buffer: Buffer) {
  return buffer
    .toString("utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const row = JSON.parse(line);
      if (!row || !Number.isFinite(row.ts) || typeof row.provider !== "string")
        throw Error("Malformed usage history row");
      return row as UsageRepairRow;
    });
}
function isSnapshotObject(value: unknown) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function readClaudeThreadLogs(threads: any[]) {
  const logsDir = path.join(DATA_DIR, "logs"),
    logs: Record<string, any[]> = {};
  if (!fs.existsSync(logsDir)) return logs;
  for (const thread of threads) {
    if (thread?.provider !== "claude" || typeof thread.id !== "string") continue;
    const logFile = path.join(logsDir, `${thread.id}.jsonl`);
    if (!fs.existsSync(logFile)) continue;
    logs[thread.id] = fs
      .readFileSync(logFile, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
  return logs;
}
function mergeClaudeSnapshots(snapshots: any, currentSnapshots: any) {
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
  return nextUsage;
}
function ensureMigrationBackup(target: string, original: Buffer) {
  if (!fs.existsSync(target)) fs.writeFileSync(target, original, { flag: "wx", mode: 0o600 });
}
function replaceMigrated(target: string, original: Buffer, body: string) {
  if (fs.existsSync(target) && !fs.readFileSync(target).equals(original))
    throw Error("Usage files changed during migration");
  const temp = `${target}.repair-v2.tmp`;
  fs.writeFileSync(temp, body, { mode: 0o600 });
  if (fs.existsSync(target) && !fs.readFileSync(target).equals(original)) {
    fs.unlinkSync(temp);
    throw Error("Usage files changed during migration");
  }
  fs.renameSync(temp, target);
}
function readFileOr(target: string, fallback: Buffer) {
  return fs.existsSync(target) ? fs.readFileSync(target) : fallback;
}
function migrateUsageHistory() {
  if (fs.existsSync(repairMarker)) return;
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const historyBackup = `${historyFile}.repair-v2.original`,
    usageBackup = `${file}.repair-v2.original`;
  const initialHistory = readFileOr(historyFile, Buffer.from(""));
  const initialUsage = readFileOr(file, Buffer.from("{}"));
  const historySource = readFileOr(historyBackup, initialHistory);
  const usageSource = readFileOr(usageBackup, initialUsage);
  const sourceRows = parseUsageRows(historySource);
  const currentRows = fs.existsSync(historyFile) ? parseUsageRows(initialHistory) : [];
  const snapshots = JSON.parse(usageSource.toString("utf8"));
  const currentSnapshots = JSON.parse(initialUsage.toString("utf8"));
  if (!isSnapshotObject(snapshots) || !isSnapshotObject(currentSnapshots))
    throw Error("Malformed usage snapshot");
  const threadsFile = path.join(DATA_DIR, "threads.json");
  const threads = fs.existsSync(threadsFile)
    ? JSON.parse(fs.readFileSync(threadsFile, "utf8"))
    : [];
  if (!Array.isArray(threads)) throw Error("Malformed threads metadata");
  const logs = readClaudeThreadLogs(threads);
  const preservedCurrentRows = currentRows.filter(
    (row) => !["claude", "claude:nefro"].includes(row.provider) || row.schemaVersion != null,
  );
  const restored = reconstructClaudeHistory({
    rows: [...sourceRows, ...preservedCurrentRows],
    logs,
    threads,
  });
  const nextUsage = mergeClaudeSnapshots(snapshots, currentSnapshots);
  if (
    !readFileOr(file, Buffer.from("{}")).equals(initialUsage) ||
    !readFileOr(historyFile, Buffer.from("")).equals(initialHistory)
  )
    throw Error("Usage files changed during migration");
  ensureMigrationBackup(historyBackup, initialHistory);
  ensureMigrationBackup(usageBackup, initialUsage);
  replaceMigrated(
    historyFile,
    initialHistory,
    restored.rows.map((row) => JSON.stringify(row)).join("\n") + (restored.rows.length ? "\n" : ""),
  );
  replaceMigrated(file, initialUsage, JSON.stringify(nextUsage));
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

let deepseekRefresh: Promise<void> | undefined;
let deepseekCheckedAt = 0;
export function refreshDeepSeekUsage(): Promise<void> {
  if (deepseekRefresh) return deepseekRefresh;
  if (Date.now() - deepseekCheckedAt < 5 * 60_000) return Promise.resolve();
  deepseekCheckedAt = Date.now();
  deepseekRefresh = readDeepSeekUsage().finally(() => {
    deepseekRefresh = undefined;
  });
  return deepseekRefresh;
}
async function readDeepSeekUsage() {
  if (process.env.AGENT_CONSOLE_MOCK === "1") return;
  const env = childEnv();
  const key = env.DEEPSEEK_API_KEY || env.DEEPAEEK_API_KEY;
  if (!key) return;
  try {
    const response = await fetch("https://api.deepseek.com/user/balance", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return;
    const sample = deepseekUsage(await response.json());
    if (sample) usage.record("pi:deepseek", sample);
  } catch {} // retain the last successful sample, with its timestamp
}

function normalizeCodexWindow(window: any) {
  return (
    window && {
      used_percent: window.usedPercent,
      window_minutes: window.windowDurationMins,
      resets_at: window.resetsAt,
    }
  );
}
type CodexProbe = { send: (payload: object) => void; finish: () => void };
function handleCodexMessage(probe: CodexProbe, line: string) {
  let message: any;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === 1) {
    probe.send({ method: "initialized", params: {} });
    probe.send({ id: 2, method: "account/rateLimits/read" });
  } else if (message.id === 2) {
    const limits = message.result?.rateLimits;
    const windows = codexWindows({
      primary: normalizeCodexWindow(limits?.primary),
      secondary: normalizeCodexWindow(limits?.secondary),
    });
    if (windows.length) usage.record("codex", { windows });
    probe.finish();
  }
}
// Codex only reports quota while a turn runs; ask a short-lived app-server for the current figures instead.
export function readCodexUsage(): Promise<void> {
  if (process.env.AGENT_CONSOLE_MOCK === "1") return Promise.resolve();
  return new Promise((resolve) => {
    let buffered = "",
      done = false;
    const child = spawn(
      "codex",
      ["app-server", "-c", "analytics.enabled=false", "-c", "feedback.enabled=false"],
      { env: childEnv(), stdio: ["pipe", "pipe", "ignore"] },
    );
    const end = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve();
    };
    const timer = setTimeout(end, 10_000);
    const write = (payload: object) => child.stdin.write(JSON.stringify(payload) + "\n");
    const probe: CodexProbe = { send: write, finish: end };
    child.on("error", end);
    child.on("exit", end);
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      for (let index: number; (index = buffered.indexOf("\n")) >= 0; ) {
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 1);
        handleCodexMessage(probe, line);
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
  deepseekCheckedAt = 0;
  await Promise.all([readCodexUsage(), refreshRouterUsage(), refreshDeepSeekUsage()]);
}

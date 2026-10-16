import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./auth.ts";
import { childEnv } from "./providers/env.ts";

export interface UsageWindow { label: string; used: number; limit: number; unit?: string; resetsAt?: number }
export interface ProviderUsage { windows: UsageWindow[]; note?: string; updatedAt: number; spendToday?: number }
export function claudeWindows(ev: any): UsageWindow[] {
  const w = ev.rate_limit_info?.unifiedWindows;
  if (!w) return [];
  return [["5-hour", w.five_hour], ["7-day", w.seven_day]].flatMap(([label, x]: any[]) => x && Number.isFinite(x.utilization) ? [{ label, used: x.utilization * 100, limit: 100, unit: "%", ...((x.resetsAt || x.resets_at) ? { resetsAt: (x.resetsAt || x.resets_at) * 1000 } : {}) }] : []);
}
export function codexWindows(r: any): UsageWindow[] {
  return [r?.primary, r?.secondary].filter(Boolean).flatMap(x => Number.isFinite(x.used_percent) ? [{ label: x.window_minutes === 300 ? "5-hour" : x.window_minutes === 10080 ? "7-day" : `${x.window_minutes} min`, used: x.used_percent, limit: 100, unit: "%", resetsAt: x.resets_at * 1000 }] : []);
}
export function routerUsage(d: any): Omit<ProviderUsage, "updatedAt"> {
  const windows: UsageWindow[] = [];
  const free = d.free_model_daily_requests;
  if (Number.isFinite(free?.used) && free.limit > 0) windows.push({ label: "Free/day", used: free.used, limit: free.limit, resetsAt: new Date().setUTCHours(24, 0, 0, 0) });
  if (Number.isFinite(d.limit) && d.limit > 0 && Number.isFinite(d.limit_remaining)) windows.push({ label: "Budget", used: d.limit - d.limit_remaining, limit: d.limit, unit: "$" });
  return { windows, ...(Number.isFinite(d.usage_daily) ? { spendToday: d.usage_daily } : {}), note: windows.length ? undefined : "OpenRouter does not report a request allowance for this key." };
}
const file = path.join(DATA_DIR, "usage.json");
let values: Record<string, ProviderUsage> = {};
try { values = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
let notify = (_provider: string, _usage: ProviderUsage) => {};
export const usage = {
  all: () => values,
  get: (provider: string) => values[provider],
  subscribe(fn: typeof notify) { notify = fn; },
  record(provider: string, sample: Omit<ProviderUsage, "updatedAt">, updatedAt = Date.now()) {
    if (values[provider]?.updatedAt > updatedAt) return;
    values[provider] = { ...sample, updatedAt };
    fs.writeFileSync(file, JSON.stringify(values), { mode: 0o600 });
    notify(provider, values[provider]);
  },
  exhausted(provider: string) {
    return values[provider]?.windows.some(w => w.used >= w.limit && (!w.resetsAt || w.resetsAt > Date.now())) ?? false;
  },
};
let routerRefresh: Promise<void> | undefined;
let routerCheckedAt = 0;
export function refreshRouterUsage(): Promise<void> {
  if (routerRefresh) return routerRefresh;
  if (Date.now() - routerCheckedAt < 5 * 60_000) return Promise.resolve();
  routerCheckedAt = Date.now();
  routerRefresh = readRouterUsage().finally(() => { routerRefresh = undefined; });
  return routerRefresh;
}
async function readRouterUsage() {
  if (process.env.AGENT_CONSOLE_MOCK === "1") return;
  const key = childEnv().OPENROUTER_API_KEY;
  if (!key) return;
  try {
    const r = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
    if (r.ok) usage.record("pi", routerUsage((await r.json() as any).data));
  } catch {} // retain the last successful sample, with its timestamp
}

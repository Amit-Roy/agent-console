import fs from "node:fs";
import path from "node:path";
import type { ProviderUsage } from "./usage.ts";

const accounts = [
  { key: "claude", label: "Claude · Sunny" },
  { key: "claude:nefro", label: "Claude · Nefro" },
  { key: "codex", label: "Codex" },
];
const nonnegative = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

export function validateSubscriptionFees(input: unknown): Record<string, number> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Enter a monthly fee for all three subscriptions.");
  const fees = input as Record<string, unknown>;
  if (Object.keys(fees).length !== accounts.length || !accounts.every(a => { const n = fees[a.key]; return nonnegative(n) && n <= 100_000; })) {
    throw new Error("Each monthly fee must be a number from 0 to 100,000 USD.");
  }
  return Object.fromEntries(accounts.map(a => [a.key, fees[a.key] as number]));
}

export function subscriptionView(fees: unknown, usage: Record<string, ProviderUsage>, now = Date.now()) {
  let saved: Record<string, number> | null = null;
  try { saved = validateSubscriptionFees(fees); } catch {}
  const plans = accounts.map(account => {
    const sample = usage[account.key];
    const updatedAt = nonnegative(sample?.updatedAt) && sample.updatedAt > 0 ? sample.updatedAt : null;
    const windows = (sample?.windows ?? []).flatMap(w => {
      if (!["5-hour", "7-day"].includes(w.label) || (w.unit && w.unit !== "%") || !nonnegative(w.used) || !nonnegative(w.limit) || !w.limit) return [];
      const resetsAt = nonnegative(w.resetsAt) && w.resetsAt! > 0 ? w.resetsAt! : null;
      const usedPercent = w.used / w.limit * 100;
      return [{ label: w.label, usedPercent, remainingPercent: Math.max(0, 100 - usedPercent), resetsAt,
        stale: updatedAt === null || now - updatedAt > 30 * 60_000 || updatedAt > now + 60_000 || resetsAt === null || resetsAt <= now }];
    });
    return { ...account, monthly: saved?.[account.key] ?? null, updatedAt, windows };
  });
  return { configured: saved !== null, plans, totalMonthly: saved ? Object.values(saved).reduce((sum, n) => sum + n, 0) : null,
    asOf: now, capacityStatus: "unknown", note: "Quota snapshots do not establish sustainable productive hours or how much work needs API access. Expired or old samples remain stale; they are not assumed to reset to 100%. Model availability must be checked in each subscription." };
}

export function createBenchmarkSubscriptions(dataDir: string) {
  const file = path.join(dataDir, "benchmark-subscriptions.json");
  const read = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
  return {
    view(usage: Record<string, ProviderUsage>, now = Date.now()) { return subscriptionView(read()?.fees, usage, now); },
    save(fees: unknown) {
      const valid = validateSubscriptionFees(fees);
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const temp = file + ".tmp";
      fs.writeFileSync(temp, JSON.stringify({ fees: valid }), { mode: 0o600 }); fs.renameSync(temp, file);
    },
  };
}

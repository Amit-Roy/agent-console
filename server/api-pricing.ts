import type { ModelUsage } from "./accounting.ts";

export const pricing = {
  currency: "USD",
  verifiedAt: "2026-10-17",
  sources: [
    { name: "OpenAI API pricing", url: "https://developers.openai.com/api/docs/pricing" },
    { name: "Anthropic API pricing", url: "https://platform.claude.com/docs/en/about-claude/pricing" },
    { name: "DeepSeek API pricing", url: "https://api-docs.deepseek.com/quick_start/pricing" },
  ],
  assumptions: [
    "Public API list-price estimate, not a subscription charge or invoice.",
    "Standard short-context rates; aggregate turn usage cannot establish individual request context tiers.",
    "Cache writes assume the five-minute cache lifetime.",
    "Codex fresh input is priced as regular input when cache-write telemetry is absent.",
    "Haiku uses the short-prompt rate; prompts over 100,000 tokens can cost five times more.",
    "Reasoning tokens are included in output and are not charged twice.",
    "Excludes server-side tool fees, taxes, regional uplifts and premium processing modes.",
    "Unrecognized models or incomplete token categories remain unpriced.",
    "DeepSeek peak/off-peak pricing: peak rates shown; off-peak is half price (01:00-04:00 and 06:00-10:00 UTC, Mon-Fri, excl. Chinese holidays).",
  ],
};

// USD per million tokens: fresh input, cache read, cache write, output.
export const rates: Record<string, readonly [number, number, number, number]> = {
  "gpt-5.5": [2, 0.10, 2.50, 10],
  "gpt-5.6": [2, 0.10, 2.50, 10],
  "gpt-6": [2, 0.10, 2.50, 10],
  "gpt-6.0": [2, 0.10, 2.50, 10],
  "gpt-6.1": [2, 0.10, 2.50, 10],
  "gpt-6.1-sol": [2, 0.10, 2.50, 10],
  "gpt-6-astra": [10, 1, 12.50, 50],
  "gpt-6-luna": [0.10, 0.01, 0.125, 0.50],
  "claude-opus-5-5": [4, 0.20, 5, 20],
  "claude-sonnet-5-5": [2, 0.10, 2.50, 10],
  "claude-haiku-5-5": [0.10, 0.01, 0.125, 0.50],
  // DeepSeek V4.1 Flash 1017 (model ID: deepseek-flash) - peak rates
  "deepseek-flash": [0.30, 0.006, 0.0, 1.20],
  // DeepSeek V4 Pro 0813 (model ID: deepseek-v4-pro) - peak rates
  "deepseek-v4-pro": [1.32, 0.044, 0.0, 3.96],
  // DeepSeek V3 (model ID: deepseek-chat) - historical
  "deepseek-chat": [0.27, 0.07, 0.0, 1.10],
  // DeepSeek R1 (model ID: deepseek-reasoner) - historical
  "deepseek-reasoner": [0.55, 0.14, 0.0, 2.19],
};
const measured = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
function modelRate(model: string) {
  if (typeof model !== "string") return undefined;
  const lower = model.trim().toLowerCase();
  const candidates = new Set<string>();
  const withDashes = lower.replace(/[:_\s]+/g, "-");
  for (const key of [lower, withDashes, withDashes.replace(/\./g, "-"), withDashes.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, "")]) {
    candidates.add(key);
    if (key.startsWith("gpt-")) {
      candidates.add(key.replace(/-(\d)(?=-)/g, ".$1"));
      candidates.add(key.replace(/-(\d+)(?=-|$)/g, ".$1"));
    }
  }
  for (const key of candidates) {
    if (rates[key]) return rates[key];
  }
  const family = lower.match(/^gpt[-_.:]*([56])(?:[-_.:]*(\d+))?(?:[-_.:]*(?:codex|mini|nano|pro|sol|max))*$/);
  if (family) {
    const key = family[1] === "5" ? "gpt-5.5" : "gpt-6.1";
    if (rates[key]) return rates[key];
  }
  // DeepSeek model ID normalization
  if (lower.startsWith("deepseek-flash") || lower === "deepseek-v4.1-flash" || lower === "deepseek-v4.1-flash-1017") return rates["deepseek-flash"];
  if (lower.startsWith("deepseek-v4-pro") || lower === "deepseek-v4-pro-0813") return rates["deepseek-v4-pro"];
  if (lower.startsWith("deepseek-chat") || lower.startsWith("deepseek-v3")) return rates["deepseek-chat"];
  if (lower.startsWith("deepseek-reasoner") || lower.startsWith("deepseek-r1")) return rates["deepseek-reasoner"];
  return undefined;
}

type PricedModel = ModelUsage & { providerCost?: number };
interface PriceableTurn { accounting?: number; provider: string; cost?: number; providerCost?: number; models?: ModelUsage[] }

/** Estimate API spend from disjoint per-model counters while retaining provider telemetry. */
export function apiPricedTurn<T extends PriceableTurn>(row: T): T & { providerCost?: number; models?: PricedModel[] } {
  const providerCost = Object.hasOwn(row, "providerCost") ? row.providerCost : row.cost;
  if (row.accounting !== 2 || !row.models?.length) return { ...row, providerCost, cost: undefined };
  const models = row.models.map(model => {
    const rate = modelRate(model.model);
    // Codex reports regular input and cache reads, without cache-write counters.
    const write = model.cacheWrite ?? (row.provider === "codex" ? 0 : undefined);
    const values = [model.fresh, model.cacheRead, write, model.output];
    const cost = rate && values.every(measured)
      ? values.reduce((sum: number, value, index) => sum + value! * rate[index], 0) / 1_000_000
      : undefined;
    return { ...model, providerCost: Object.hasOwn(model, "providerCost") ? (model as PricedModel).providerCost : model.cost, cost };
  });
  const cost = models.every(model => measured(model.cost)) ? models.reduce((sum, model) => sum + model.cost!, 0) : undefined;
  return { ...row, providerCost, models, cost };
}

/** DeepSeek cost projection based on current token usage. */
export interface DeepSeekProjection {
  dailyInputTokens: number;
  dailyOutputTokens: number;
  dailyCacheReadTokens: number;
  dailyCostUsd: number;
  monthlyCostUsd: number;
  model: string;
  modelLabel: string;
  rates: { input: number; cacheRead: number; output: number };
  assumptions: string[];
}

/**
 * Calculate DeepSeek cost projection from aggregated token totals and day count.
 */
export function calculateDeepSeekProjection(
  totalInput: number,
  totalOutput: number,
  totalCacheRead: number,
  daysInRange: number,
  modelId: "deepseek-flash" | "deepseek-v4-pro" = "deepseek-flash"
): DeepSeekProjection {
  const rate = rates[modelId];
  if (!rate) throw new Error(`Unknown DeepSeek model: ${modelId}`);
  const [inputRate, cacheReadRate, , outputRate] = rate;

  const dailyInput = totalInput / Math.max(1, daysInRange);
  const dailyOutput = totalOutput / Math.max(1, daysInRange);
  const dailyCacheRead = totalCacheRead / Math.max(1, daysInRange);
  const dailyFreshInput = Math.max(0, dailyInput - dailyCacheRead);

  const dailyCost = (
    (dailyFreshInput * inputRate) +
    (dailyCacheRead * cacheReadRate) +
    (dailyOutput * outputRate)
  ) / 1_000_000;

  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const monthlyCost = dailyCost * daysInMonth;

  return {
    dailyInputTokens: Math.round(dailyInput),
    dailyOutputTokens: Math.round(dailyOutput),
    dailyCacheReadTokens: Math.round(dailyCacheRead),
    dailyCostUsd: Number(dailyCost.toFixed(4)),
    monthlyCostUsd: Number(monthlyCost.toFixed(2)),
    model: modelId,
    modelLabel: modelId === "deepseek-flash" ? "DeepSeek V4.1 Flash" : "DeepSeek V4 Pro",
    rates: { input: inputRate, cacheRead: cacheReadRate, output: outputRate },
    assumptions: [
      `Peak pricing (${inputRate}/${cacheReadRate}/${outputRate} per 1M tokens input/cache/output). Off-peak is 50%.`,
      "Projects current daily token rate across all days in the month (idle-hour extrapolation).",
      "Assumes same cache-hit ratio as current period.",
      "Excludes taxes, retries, and reasoning-token expansion.",
    ],
  };
}
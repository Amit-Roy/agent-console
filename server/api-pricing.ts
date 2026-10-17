import type { ModelUsage } from "./accounting.ts";

export const pricing = {
  currency: "USD",
  verifiedAt: "2026-10-17",
  sources: [
    { name: "OpenAI API pricing", url: "https://developers.openai.com/api/docs/pricing" },
    { name: "Anthropic API pricing", url: "https://platform.claude.com/docs/en/about-claude/pricing" },
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
  ],
};

// USD per million tokens: fresh input, cache read, cache write, output.
const rates: Record<string, readonly [number, number, number, number]> = {
  "gpt-6.1-sol": [2, 0.10, 2.50, 10],
  "gpt-6-astra": [10, 1, 12.50, 50],
  "gpt-6-luna": [0.10, 0.01, 0.125, 0.50],
  "claude-opus-5-5": [4, 0.20, 5, 20],
  "claude-sonnet-5-5": [2, 0.10, 2.50, 10],
  "claude-haiku-5-5": [0.10, 0.01, 0.125, 0.50],
};
const measured = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
function modelRate(model: string) {
  // Only exact public IDs and their dated snapshots; no selected-model/default guessing.
  return typeof model === "string" ? rates[model] || rates[model.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, "")] : undefined;
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

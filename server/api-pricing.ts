import type { ModelUsage } from "./accounting.ts";

export const pricing = {
  currency: "USD",
  verifiedAt: "2026-10-23",
  sources: [
    { name: "OpenAI API pricing", url: "https://developers.openai.com/api/docs/pricing" },
    {
      name: "Anthropic API pricing",
      url: "https://platform.claude.com/docs/en/about-claude/pricing",
    },
    {
      name: "DeepSeek API pricing",
      url: "https://api-docs.deepseek.com/quick_start/pricing",
    },
  ],
  assumptions: [
    "Public API list-price estimate, not a subscription charge or invoice.",
    "Standard short-context rates; aggregate turn usage cannot establish individual request context tiers.",
    "Cache writes assume the five-minute cache lifetime.",
    "Codex fresh input is priced as regular input when cache-write telemetry is absent.",
    "Haiku uses the short-prompt rate; prompts over 100,000 tokens can cost five times more.",
    "Reasoning tokens are included in output and are not charged twice.",
    "DeepSeek uses peak-hour rates; off-peak input and output are half price.",
    "Excludes server-side tool fees, taxes, regional uplifts and premium processing modes.",
    "Unrecognized models or incomplete token categories remain unpriced.",
  ],
};

// USD per million tokens: fresh input, cache read, cache write, output.
export const rates: Record<string, readonly [number, number, number, number]> = {
  "gpt-5.5": [2, 0.1, 2.5, 10],
  "gpt-5.6": [2, 0.1, 2.5, 10],
  "gpt-6": [2, 0.1, 2.5, 10],
  "gpt-6.0": [2, 0.1, 2.5, 10],
  "gpt-6.1": [2, 0.1, 2.5, 10],
  "gpt-6.1-sol": [2, 0.1, 2.5, 10],
  "gpt-6-astra": [10, 1, 12.5, 50],
  "gpt-6-luna": [0.1, 0.01, 0.125, 0.5],
  "claude-opus-5-5": [4, 0.2, 5, 20],
  "claude-sonnet-5-5": [2, 0.1, 2.5, 10],
  "claude-haiku-5-5": [0.1, 0.01, 0.125, 0.5],
  "deepseek-flash": [0.3, 0.006, 0.3, 1.2],
  "deepseek-v4-flash": [0.3, 0.006, 0.3, 1.2],
  "deepseek-v4-flash-vision-exp": [0.3, 0.006, 0.3, 1.2],
  "deepseek-v4-pro": [1.32, 0.044, 1.32, 3.96],
};
const measured = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
function modelRate(model: string) {
  if (typeof model !== "string") return undefined;
  const lower = model.trim().toLowerCase();
  const candidates = new Set<string>();
  const withDashes = lower.replace(/[:_\s]+/g, "-");
  for (const key of [
    lower,
    withDashes,
    withDashes.replace(/\./g, "-"),
    withDashes.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, ""),
  ]) {
    candidates.add(key);
    const slash = key.lastIndexOf("/");
    if (slash >= 0) candidates.add(key.slice(slash + 1));
    if (key.startsWith("gpt-")) {
      candidates.add(key.replace(/-(\d)(?=-)/g, ".$1"));
      candidates.add(key.replace(/-(\d+)(?=-|$)/g, ".$1"));
    }
  }
  for (const key of candidates) {
    if (rates[key]) return rates[key];
  }
  const family = lower.match(
    /^gpt[-_.:]*([56])(?:[-_.:]*(\d+))?(?:[-_.:]*(?:codex|mini|nano|pro|sol|max))*$/,
  );
  if (family) {
    const key = family[1] === "5" ? "gpt-5.5" : "gpt-6.1";
    if (rates[key]) return rates[key];
  }
  return undefined;
}

type PricedModel = ModelUsage & { providerCost?: number };
interface PriceableTurn {
  accounting?: number;
  provider: string;
  cost?: number;
  providerCost?: number;
  models?: ModelUsage[];
}

/** Estimate API spend from disjoint per-model counters while retaining provider telemetry. */
export function apiPricedTurn<T extends PriceableTurn>(
  row: T,
): T & { providerCost?: number; models?: PricedModel[] } {
  const providerCost = Object.hasOwn(row, "providerCost") ? row.providerCost : row.cost;
  if (row.accounting !== 2 || !row.models?.length) return { ...row, providerCost, cost: undefined };
  const models = row.models.map((model) => {
    const rate = modelRate(model.model);
    // Codex reports regular input and cache reads, without cache-write counters.
    const write = model.cacheWrite ?? (row.provider === "codex" ? 0 : undefined);
    const values = [model.fresh, model.cacheRead, write, model.output];
    const cost =
      rate && values.every(measured)
        ? values.reduce((sum: number, value, index) => sum + value! * rate[index], 0) / 1_000_000
        : undefined;
    return {
      ...model,
      providerCost: Object.hasOwn(model, "providerCost")
        ? (model as PricedModel).providerCost
        : model.cost,
      cost,
    };
  });
  const cost = models.every((model) => measured(model.cost))
    ? models.reduce((sum, model) => sum + model.cost!, 0)
    : undefined;
  return { ...row, providerCost, models, cost };
}

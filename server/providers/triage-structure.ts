import type { EffortQuantiles, EffortQuote } from "./triage-effort.ts";

export interface StructureFlags {
  hasFilePath: boolean;
  hasExpectedOutput: boolean;
  hasAcceptanceCheck: boolean;
}
export interface StructureQuote {
  flags: StructureFlags;
  /** Recommended token budget after pricing missing structure; null when no token total exists. */
  budget: number | null;
  /** The first missing item, re-priced as if present. Null when nothing is missing or priced. */
  counterfactual: { flag: keyof StructureFlags; label: string; budget: number } | null;
  /** Largest positive pricing contribution, in plain words. */
  costDriver: string | null;
}

/** Ordered by how cheaply a requester can add the item. */
const FLAGS: { flag: keyof StructureFlags; label: string }[] = [
  { flag: "hasFilePath", label: "a file path" },
  { flag: "hasExpectedOutput", label: "the expected output" },
  { flag: "hasAcceptanceCheck", label: "an acceptance check" },
];
const DRIVER_LABELS: Record<string, string> = {
  requestSize: "request length",
  requestLines: "number of lines",
  requestReferences: "number of files, links and code references",
  requestActions: "number of requested actions",
  breadth: "breadth of components",
  complexity: "implementation complexity",
  uncertainty: "uncertainty about the cause",
  risk: "risk",
};

/** Deterministic checks on the initial request; never model-written. */
export function requestStructure(text: string): StructureFlags {
  return {
    hasFilePath:
      /(?:^|[\s`(])(?:~|\.{1,2})\/?[\w.-]+\/[\w.-]+/.test(text) ||
      /\b[\w-]+\.(?:ts|tsx|js|mjs|jsx|py|json|md|css|html|sh|ya?ml)\b/i.test(text),
    hasExpectedOutput:
      /\b(expected(?:\s+output)?|output\s*:|should (?:show|display|return|print|see|be)|must (?:show|display|return)|result(?:s)? in)(?!\w)/i.test(
        text,
      ),
    hasAcceptanceCheck:
      /\b(accept(?:ance)?|verify|done when|passes?|check that|test(?:s)? (?:pass|cover))\b/i.test(
        text,
      ),
  };
}

const MISSING_RESERVE_STEPS = FLAGS.length;
/** Every missing item moves the budget one third of the way from P80 to P95. */
const priceMissing = (total: EffortQuantiles, missing: number): number =>
  Math.round(total.p80 + ((total.p95 - total.p80) * missing) / MISSING_RESERVE_STEPS);

export function quoteStructure(text: string, price: EffortQuote): StructureQuote {
  const flags = requestStructure(text);
  const missing = FLAGS.filter(({ flag }) => !flags[flag]);
  const driver = price.contributions
    .filter((item) => item.logWork > 0)
    .sort((a, b) => b.logWork - a.logWork)[0];
  const costDriver = driver ? (DRIVER_LABELS[driver.feature] ?? null) : null;
  if (!price.total) return { flags, budget: null, counterfactual: null, costDriver };
  // Already routed to the P95 reserve: missing structure cannot add more.
  if (price.recommendedBudget === "p95")
    return { flags, budget: price.total.p95, counterfactual: null, costDriver };
  const first = missing[0];
  return {
    flags,
    budget: priceMissing(price.total, missing.length),
    counterfactual: first
      ? {
          flag: first.flag,
          label: first.label,
          budget: priceMissing(price.total, missing.length - 1),
        }
      : null,
    costDriver,
  };
}

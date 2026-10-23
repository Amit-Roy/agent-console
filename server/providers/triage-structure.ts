import type { EffortQuantiles, EffortQuote } from "./triage-effort.ts";

export interface StructureFlags {
  hasFilePath: boolean;
  hasExpectedOutput: boolean;
  hasAcceptanceCheck: boolean;
  /** True when at least one flag was inferred from repository context (e.g., expected output from workflow description). */
  inferredFromRepo: boolean;
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
export function requestStructure(text: string, repoContext?: string): StructureFlags {
  const hasFilePath =
    /(?:^|[\s`(])(?:~|\.{0,2})\/?[\w.-]+\/[\w.-]+/.test(text) ||
    /\b[\w-]+\.(?:ts|tsx|js|mjs|jsx|py|json|md|css|html|sh|ya?ml)\b/i.test(text);
  let hasExpectedOutput =
    /\b(expected|should (?:show|display|return|print|see|be)|must (?:show|display|return)|result(?:s)? in|output)\b/i.test(
      text,
    );
  const hasAcceptanceCheck =
    /\b(accept(?:ance)?|verify|done when|passes?|check that|test(?:s)? (?:pass|cover))\b/i.test(
      text,
    );
  let inferredFromRepo = false;
  // Infer hasExpectedOutput from repository context when not present in request text.
  // Never infer hasFilePath from repository context.
  if (!hasExpectedOutput && repoContext) {
    const expectedOutputPattern =
      /\b(expected output|shows? (?:the )?(?:expected|result)|output (?:is|shows?|display)|see (?:the )?(?:result|output)|preview (?:shows?|displays?))\b/i;
    if (expectedOutputPattern.test(repoContext)) {
      hasExpectedOutput = true;
      inferredFromRepo = true;
    }
  }
  return { hasFilePath, hasExpectedOutput, hasAcceptanceCheck, inferredFromRepo };
}

const MISSING_RESERVE_STEPS = FLAGS.length;
/** Every missing item moves the budget one third of the way from P80 to P95. */
const priceMissing = (total: EffortQuantiles, missing: number): number =>
  Math.round(total.p80 + ((total.p95 - total.p80) * missing) / MISSING_RESERVE_STEPS);

export function quoteStructure(text: string, price: EffortQuote, repoContext?: string): StructureQuote {
  const flags = requestStructure(text, repoContext);
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
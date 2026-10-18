// Scenario math only. These estimates do not predict subscription allowance charges.
export function forecastContext({ context, maxContext = Infinity, retained = 0.2, added = 2000,
  requests = 20, ttlMs = 0, ageMs = Infinity, resumeMs = 0, gapMs = 60000, rate }) {
  if (!Number.isFinite(context) || context <= 0) return null;
  retained = Math.min(1, Math.max(0.01, retained));
  added = Math.min(20000, Math.max(100, added));
  requests = Math.min(50, Math.max(1, requests));
  const summary = Math.ceil(context * retained);
  const priced = Array.isArray(rate) && rate.length === 4 && rate.every(n => Number.isFinite(n) && n >= 0);
  const warmNow = ttlMs > 0 && ageMs < ttlMs;
  const charge = (cached, fresh, output = 0) => priced ? (cached * rate[1] + fresh * rate[2] + output * rate[3]) / 1e6 : null;
  // Read the existing context and generate a summary. The rewritten prefix starts cold.
  const compactCost = charge(warmNow ? context : 0, warmNow ? 0 : context, summary);
  let keepCost = 0, reducedCost = compactCost;
  let keepTokens = 0, reducedTokens = context + summary;
  let keepContext = context, reducedContext = summary;
  let breakEven = null;
  const points = [{ added: 0, keepCost: priced ? 0 : null, compactCost, keepTokens: 0, compactTokens: reducedTokens }];
  for (let i = 1; i <= requests; i++) {
    // Stop both paths at the original window limit: native auto-compaction would change this comparison.
    if (keepContext + added > maxContext) break;
    const keepWarm = ttlMs > 0 && (i === 1 ? ageMs + resumeMs < ttlMs : gapMs < ttlMs);
    const reducedWarm = ttlMs > 0 && i > 1 && gapMs < ttlMs;
    const keepInput = keepContext + added, reducedInput = reducedContext + added;
    if (priced) {
      keepCost += charge(keepWarm ? keepContext : 0, keepWarm ? added : keepInput);
      reducedCost += charge(reducedWarm ? reducedContext : 0, reducedWarm ? added : reducedInput);
    }
    keepTokens += keepInput; reducedTokens += reducedInput;
    keepContext = keepInput; reducedContext = reducedInput;
    points.push({ added: i * added, keepCost: priced ? keepCost : null, compactCost: reducedCost,
      keepTokens, compactTokens: reducedTokens });
    if (priced && breakEven == null && reducedCost <= keepCost) breakEven = i * added;
  }
  return { points, summary, compactCost, breakEven, priced, warmNow,
    warmResume: ttlMs > 0 && ageMs + resumeMs < ttlMs,
    windowLimited: points.length < requests + 1 };
}

export function forecastModel(thread, rates = {}) {
  const selected = thread.model;
  const observed = thread.provider === "codex" ? thread.resolvedModel
    : thread.resolvedModel || thread.lastRun?.timing?.model || thread.lastRun?.model;
  // Never use the previous model's price after a selection change.
  const candidates = [selected];
  if (selected === "default" || (thread.provider === "claude" && ["sonnet", "opus", "haiku"].includes(selected)
      && observed?.startsWith(`claude-${selected}-`))) candidates.push(observed);
  for (const model of candidates) {
    if (typeof model !== "string") continue;
    const canonical = model.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, "");
    if (rates[canonical]) return { model, rate: rates[canonical] };
  }
  return { model: selected === "default" ? observed || selected : selected, rate: undefined };
}

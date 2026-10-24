// Scenario math only. These estimates do not predict subscription allowance charges.
function clampNumber(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function chargeFor(plan, cached, fresh, output = 0) {
  const { rate } = plan;
  return plan.priced ? (cached * rate[1] + fresh * rate[2] + output * rate[3]) / 1e6 : null;
}

// One more request: both the kept and the compacted path grow by `added` tokens.
function advanceForecast(plan, sim, step) {
  const { added, ttlMs, ageMs, resumeMs, gapMs, priced } = plan;
  const keepWarm = ttlMs > 0 && (step === 1 ? ageMs + resumeMs < ttlMs : gapMs < ttlMs);
  const reducedWarm = ttlMs > 0 && step > 1 && gapMs < ttlMs;
  const keepInput = sim.keepContext + added,
    reducedInput = sim.reducedContext + added;
  if (priced) {
    sim.keepCost += chargeFor(plan, keepWarm ? sim.keepContext : 0, keepWarm ? added : keepInput);
    sim.reducedCost += chargeFor(
      plan,
      reducedWarm ? sim.reducedContext : 0,
      reducedWarm ? added : reducedInput,
    );
  }
  sim.keepTokens += keepInput;
  sim.reducedTokens += reducedInput;
  sim.keepContext = keepInput;
  sim.reducedContext = reducedInput;
  sim.points.push({
    added: step * added,
    keepCost: priced ? sim.keepCost : null,
    compactCost: sim.reducedCost,
    keepTokens: sim.keepTokens,
    compactTokens: sim.reducedTokens,
  });
  if (priced && sim.breakEven == null && sim.reducedCost <= sim.keepCost)
    sim.breakEven = step * added;
}

export function forecastContext({
  context,
  maxContext = Infinity,
  retained = 0.2,
  added = 2000,
  requests = 20,
  ttlMs = 0,
  ageMs = Infinity,
  resumeMs = 0,
  gapMs = 60000,
  rate,
}) {
  if (!Number.isFinite(context) || context <= 0) return null;
  retained = clampNumber(retained, 0.01, 1);
  added = clampNumber(added, 100, 20000);
  requests = clampNumber(requests, 1, 50);
  const summary = Math.ceil(context * retained);
  const priced =
    Array.isArray(rate) && rate.length === 4 && rate.every((n) => Number.isFinite(n) && n >= 0);
  const warmNow = ttlMs > 0 && ageMs < ttlMs;
  const plan = { rate, priced, added, ttlMs, ageMs, resumeMs, gapMs };
  // Read the existing context and generate a summary. The rewritten prefix starts cold.
  const compactCost = chargeFor(plan, warmNow ? context : 0, warmNow ? 0 : context, summary);
  const sim = {
    keepCost: 0,
    reducedCost: compactCost,
    keepTokens: 0,
    reducedTokens: context + summary,
    keepContext: context,
    reducedContext: summary,
    breakEven: null,
    points: [],
  };
  sim.points.push({
    added: 0,
    keepCost: priced ? 0 : null,
    compactCost,
    keepTokens: 0,
    compactTokens: sim.reducedTokens,
  });
  for (let step = 1; step <= requests; step++) {
    // Stop both paths at the original window limit: native auto-compaction would change this comparison.
    if (sim.keepContext + added > maxContext) break;
    advanceForecast(plan, sim, step);
  }
  return {
    points: sim.points,
    summary,
    compactCost,
    breakEven: sim.breakEven,
    priced,
    warmNow,
    warmResume: ttlMs > 0 && ageMs + resumeMs < ttlMs,
    windowLimited: sim.points.length < requests + 1,
  };
}

function buildRecommendation(fields) {
  return {
    action: "unknown",
    afterRequests: null,
    atContextTokens: null,
    afterAddedTokens: null,
    cost: null,
    savings: null,
    baselineCost: null,
    horizonRequests: 0,
    reason: "unavailable",
    ...fields,
  };
}

function tokenCharge(rate, tokens, cached, output = 0) {
  return (tokens * rate[cached ? 1 : 2] + output * rate[3]) / 1e6;
}

// Total cost of finishing the workload when one compaction happens after `afterRequests` requests.
function costWithCompactionAfter(params, afterRequests) {
  const { context, retained, added, horizonRequests, ttlMs, ageMs, resumeMs, gapMs, rate } = params;
  let size = context,
    cost = 0;
  let rewritten = false;
  for (let step = 0; step <= horizonRequests; step++) {
    if (step === afterRequests) {
      const summary = Math.ceil(size * retained);
      // After a request, its entire input has just been cached. Compacting now
      // instead uses the existing prefix's age, before the modeled resume delay.
      const warm = ttlMs > 0 && (step > 0 || ageMs < ttlMs);
      cost += tokenCharge(rate, size, warm, summary);
      size = summary;
      rewritten = true;
    }
    if (step === horizonRequests) break;
    const warm = !rewritten && ttlMs > 0 && (step === 0 ? ageMs + resumeMs < ttlMs : gapMs < ttlMs);
    cost += tokenCharge(rate, size, warm) + tokenCharge(rate, added, false);
    size += added;
    rewritten = false;
  }
  return cost;
}

// Compare one compaction now or immediately after each future request against no
// compaction. Every candidate completes the same work within the original window.
export function recommendCompaction(scenario) {
  const forecast = forecastContext(scenario);
  const horizonRequests = forecast ? forecast.points.length - 1 : 0;
  const unknown = buildRecommendation({ horizonRequests });
  if (!forecast?.priced || !horizonRequests) return unknown;
  const { context, ttlMs = 0, ageMs = Infinity, resumeMs = 0, gapMs = 60000, rate } = scenario;
  const added = Math.min(20000, Math.max(100, scenario.added ?? 2000));
  const retained = Math.min(1, Math.max(0.01, scenario.retained ?? 0.2));
  if (![added, retained].every(Number.isFinite)) return unknown;
  const baselineCost = forecast.points.at(-1).keepCost;
  const params = { context, retained, added, horizonRequests, ttlMs, ageMs, resumeMs, gapMs, rate };
  let best = buildRecommendation({
    action: "continue",
    cost: baselineCost,
    savings: 0,
    baselineCost,
    horizonRequests,
    reason: "no-savings",
  });
  for (let afterRequests = 0; afterRequests < horizonRequests; afterRequests++) {
    const cost = costWithCompactionAfter(params, afterRequests);
    if (cost < best.cost - 1e-12)
      best = buildRecommendation({
        action: afterRequests ? "wait" : "now",
        afterRequests,
        atContextTokens: context + afterRequests * added,
        afterAddedTokens: afterRequests * added,
        cost,
        savings: baselineCost - cost,
        baselineCost,
        horizonRequests,
        reason: afterRequests ? "after-request" : "before-resume",
      });
  }
  return best;
}

function rateKeyVariants(lower) {
  const variants = new Set();
  const keys = [
    lower,
    lower.replace(/[:_\s]+/g, "-"),
    lower.replace(/\./g, "-"),
    lower.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, ""),
  ];
  for (const key of keys) {
    variants.add(key);
    const slash = key.lastIndexOf("/");
    if (slash >= 0) variants.add(key.slice(slash + 1));
    if (key.startsWith("gpt-")) {
      variants.add(key.replace(/-(\d)(?=-)/g, ".$1"));
      variants.add(key.replace(/-(\d+)(?=-|$)/g, ".$1"));
    }
  }
  return variants;
}

function familyRate(rates, lower) {
  const family = lower.match(
    /^gpt[-_.:]*([56])(?:[-_.:]*(\d+))?(?:[-_.:]*(?:codex|mini|nano|pro|sol|astra|luna|max))*$/,
  );
  if (!family) return undefined;
  const key = family[1] === "5" ? "gpt-5.5" : "gpt-6.1";
  return rates[key] || undefined;
}

function canonicalRate(rates, model) {
  if (typeof model !== "string") return undefined;
  const lower = model.trim().toLowerCase();
  for (const key of rateKeyVariants(lower)) {
    if (rates[key]) return rates[key];
  }
  return familyRate(rates, lower);
}

function observedModel(thread) {
  if (thread.provider === "codex") return thread.resolvedModel;
  return thread.resolvedModel || thread.lastRun?.timing?.model || thread.lastRun?.model;
}

export function forecastModel(thread, rates = {}) {
  const selected = thread.model;
  const observed = observedModel(thread);
  // Never use the previous model's price after a selection change.
  const candidates = [selected];
  if (
    selected === "default" ||
    (thread.provider === "claude" &&
      ["sonnet", "opus", "haiku"].includes(selected) &&
      observed?.startsWith(`claude-${selected}-`))
  )
    candidates.push(observed);
  for (const model of candidates) {
    const rate = canonicalRate(rates, model);
    if (rate) return { model, rate };
  }
  return { model: selected === "default" ? observed || selected : selected, rate: undefined };
}

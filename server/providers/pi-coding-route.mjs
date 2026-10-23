// Pi retries only the failed model request. Completed tool calls remain in the
// transcript, so changing the physical model here never restarts the issue run.
export const CODING_ROUTE = "agent-console/auto-coding";
// Direct NIM models in preference order; nemotron-3-super is gone: NVIDIA returns 404 "Function not found" for it.
export const DIRECT_CODING_MODELS = Object.freeze([
  "nvidia/nemotron-3-ultra-550b-a55b",
  "nvidia/nemotron-3.5-super-vl-120b-a12b",
  "nvidia/nemotron-3.5-lightning-30b-a3b",
]);
export const DIRECT_CODING = DIRECT_CODING_MODELS[0];
export const ROUTER_CODING = "nvidia/nemotron-3-super-120b-a12b:free";

export function transientProviderError(message) {
  return /(?:\b429\b|\b503\b|rate[ _-]?limit|too many requests|service unavailable|temporarily unavailable|provider[ _-]?overloaded)/i.test(
    String(message ?? ""),
  );
}

// A NIM function can be withdrawn for one account while the catalog still lists it.
export function missingProviderModel(message) {
  return /(?:\b404\b|function '[^']*': not found|model not found)/i.test(String(message ?? ""));
}

export function exhaustedProviderQuota(message) {
  return /(?:daily[ _-]?quota|free[ _-]?models[ _-]?per[ _-]?day|MODEL_PROVIDER_QUOTA_EXHAUSTED)/i.test(
    String(message ?? ""),
  );
}

export function routeCodingRequest(request, ctx) {
  const available = ctx.modelRegistry.getAvailable();
  const find = (provider, id) =>
    available.find((model) => model.provider === provider && model.id === id);
  const key = (model) => `${model.provider}/${model.id}`;
  // Every approved model the credentials expose, best first: the direct NIM models, then the OpenRouter free model.
  const chain = [
    ...DIRECT_CODING_MODELS.map((id) => find("nvidia", id)),
    find("openrouter", ROUTER_CODING),
  ].filter(Boolean);
  const approved = (model) => !!model && chain.some((m) => key(m) === key(model));
  const failed = request.reason === "retry" ? request.failed : undefined;
  // Pi persists route state on the session branch. Track failed models only within
  // one retry sequence so failing models cannot bounce indefinitely.
  const retryProviders =
    request.reason === "retry" ? [...(request.state?.retryProviders ?? [])] : [];
  const error = failed?.message?.errorMessage;
  const canFallback =
    approved(failed?.model) &&
    ((failed.model.provider === "nvidia" &&
      (transientProviderError(error) || missingProviderModel(error))) ||
      (failed.model.provider === "openrouter" && exhaustedProviderQuota(error)));
  if (canFallback && !retryProviders.includes(key(failed.model)))
    retryProviders.push(key(failed.model));
  // Every new request starts at the top of the chain; only a retry stays on its failed model.
  const sticky = failed?.model;
  let model = approved(sticky) ? find(sticky.provider, sticky.id) : undefined;
  if (canFallback) model = chain.find((m) => !retryProviders.includes(key(m))) ?? model;
  model ??= chain[0];
  if (!model)
    throw new Error("Pi automation is blocked: no approved coding provider is authenticated.");
  return { model, thinkingLevel: request.thinkingLevel ?? "off", state: { retryProviders } };
}

export default function codingRoute(pi) {
  pi.registerVirtualModel({
    provider: "agent-console",
    id: "auto-coding",
    name: "Auto coding (free providers)",
    thinkingLevels: ["off", "minimal", "low", "medium", "high"],
    input: ["text"],
    route: routeCodingRequest,
  });
}

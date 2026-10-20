// Pi retries only the failed model request. Completed tool calls remain in the
// transcript, so changing the physical model here never restarts the issue run.
export const CODING_ROUTE = "agent-console/auto-coding";
export const DIRECT_CODING = "nvidia/nemotron-3-super-120b-a12b";
export const ROUTER_CODING = "nvidia/nemotron-3-super-120b-a12b:free";

export function transientProviderError(message) {
  return /(?:\b429\b|\b503\b|rate[ _-]?limit|too many requests|service unavailable|temporarily unavailable|provider[ _-]?overloaded)/i.test(String(message ?? ""));
}

export function exhaustedProviderQuota(message) {
  return /(?:daily[ _-]?quota|free[ _-]?models[ _-]?per[ _-]?day|MODEL_PROVIDER_QUOTA_EXHAUSTED)/i.test(String(message ?? ""));
}

export function routeCodingRequest(request, ctx) {
  const available = ctx.modelRegistry.getAvailable();
  const find = (provider, id) => available.find(model => model.provider === provider && model.id === id);
  const direct = find("nvidia", DIRECT_CODING);
  const router = find("openrouter", ROUTER_CODING);
  const approved = model => model?.provider === "nvidia" && model.id === DIRECT_CODING ||
    model?.provider === "openrouter" && model.id === ROUTER_CODING;
  const failed = request.reason === "retry" ? request.failed : undefined;
  // Pi persists route state on the session branch. Track failures only within
  // one retry sequence so two failing providers cannot bounce indefinitely.
  const retryProviders = request.reason === "retry" ? [...(request.state?.retryProviders ?? [])] : [];
  const exhaustedProviders = request.reason === "user" ? [] : [...(request.state?.exhaustedProviders ?? [])];
  const error = failed?.message?.errorMessage;
  const canFallback = approved(failed?.model) && (failed.model.provider === "nvidia" && transientProviderError(error) ||
    failed.model.provider === "openrouter" && exhaustedProviderQuota(error));
  if (approved(failed?.model) && canFallback) {
    if (!retryProviders.includes(failed.model.provider)) retryProviders.push(failed.model.provider);
    if (exhaustedProviderQuota(error) && !exhaustedProviders.includes(failed.model.provider)) exhaustedProviders.push(failed.model.provider);
  }
  const sticky = failed?.model ?? request.previous?.model;
  const resetExhausted = request.reason === "user" && request.state?.exhaustedProviders?.includes(sticky?.provider);
  let model = approved(sticky) && !resetExhausted ? find(sticky.provider, sticky.id) : undefined;
  if (canFallback) {
    const alternative = failed.model.provider === "nvidia" ? router : direct;
    if (alternative && !retryProviders.includes(alternative.provider)) model = alternative;
  }
  model ??= direct ?? router;
  if (!model) throw new Error("Pi automation is blocked: no approved coding provider is authenticated.");
  return { model, thinkingLevel: request.thinkingLevel ?? "off", state: { retryProviders, exhaustedProviders } };
}

export default function codingRoute(pi) {
  pi.registerVirtualModel({
    provider: "agent-console", id: "auto-coding", name: "Auto coding (free providers)",
    thinkingLevels: ["off", "minimal", "low", "medium", "high"], input: ["text"],
    route: routeCodingRequest,
  });
}

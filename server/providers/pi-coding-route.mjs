// Pi retries only the failed model request. Completed tool calls remain in the
// transcript, so changing the physical model here never restarts the issue run.
export const CODING_ROUTE = "agent-console/auto-coding";
export const DIRECT_CODING = "nvidia/nemotron-3-super-120b-a12b";
export const ROUTER_CODING = "nvidia/nemotron-3-super-120b-a12b:free";

export function transientProviderError(message) {
  return /(?:\b429\b|\b503\b|rate[ _-]?limit|too many requests|service unavailable|temporarily unavailable|provider[ _-]?overloaded)/i.test(String(message ?? ""));
}

export function routeCodingRequest(request, ctx) {
  const available = ctx.modelRegistry.getAvailable();
  const find = (provider, id) => available.find(model => model.provider === provider && model.id === id);
  const direct = find("nvidia", DIRECT_CODING);
  const router = find("openrouter", ROUTER_CODING);
  const approved = model => model?.provider === "nvidia" && model.id === DIRECT_CODING ||
    model?.provider === "openrouter" && model.id === ROUTER_CODING;
  const failed = request.reason === "retry" ? request.failed : undefined;
  let model;
  if (failed?.model?.provider === "nvidia" && failed.model.id === DIRECT_CODING &&
      transientProviderError(failed.message?.errorMessage) && router) {
    model = router;
  } else {
    // Preserve the actual successful provider through tool follow-ups and later
    // prompts. Do not bounce back to a throttled NVIDIA key after each turn.
    const sticky = failed?.model ?? request.previous?.model;
    model = approved(sticky) ? find(sticky.provider, sticky.id) : undefined;
    model ??= direct ?? router;
  }
  if (!model) throw new Error("Pi automation is blocked: no approved coding provider is authenticated.");
  return { model, thinkingLevel: request.thinkingLevel ?? "off" };
}

export default function codingRoute(pi) {
  pi.registerVirtualModel({
    provider: "agent-console", id: "auto-coding", name: "Auto coding (free providers)",
    thinkingLevels: ["off", "minimal", "low", "medium", "high"], input: ["text"],
    route: routeCodingRequest,
  });
}

import assert from "node:assert/strict";
import codingRoute, { DIRECT_CODING, DIRECT_CODING_MODELS, ROUTER_CODING, routeCodingRequest } from "../server/providers/pi-coding-route.mjs";

const direct = { provider: "nvidia", id: DIRECT_CODING };
const router = { provider: "openrouter", id: ROUTER_CODING };
const paid = { provider: "openrouter", id: "nvidia/nemotron-3-super-120b-a12b" };
const vision = { provider: "nvidia", id: "meta/llama-3.2-11b-vision-instruct" };
const context = (models = [direct, router, paid, vision]) => ({ modelRegistry: { getAvailable: () => models } });
const request = { reason: "user", thinkingLevel: "low" };
assert.equal(routeCodingRequest(request, context()).model, direct);
assert.equal(routeCodingRequest(request, context([router])).model, router);
assert.throws(() => routeCodingRequest(request, context([paid, vision])), /no approved coding provider/);

// Pi owns transcript replay. Routing only returns a physical model; it cannot
// submit prompts or execute any tool, and it preserves the transcript unchanged.
const messages = Object.freeze([
  Object.freeze({ role: "user", content: "Complete the task" }),
  Object.freeze({ role: "assistant", content: Object.freeze([{ type: "toolCall", id: "done", name: "write" }]) }),
  Object.freeze({ role: "toolResult", toolCallId: "done", content: "Already written" }),
]);
for (const errorMessage of ["429 Too Many Requests", 'HTTP 503 {"title":"Service Unavailable"}', "rate_limit_exceeded"]) {
  const failed = { model: direct, message: { stopReason: "error", errorMessage } };
  const retry = Object.freeze({ ...request, reason: "retry", failed, messages });
  assert.equal(routeCodingRequest(retry, context()).model, router);
  assert.equal(retry.messages, messages);
}
for (const errorMessage of ["401 Unauthorized", "403 Forbidden", "Invalid tool schema", "context length exceeded"]) {
  assert.equal(routeCodingRequest({ ...request, reason: "retry", failed: { model: direct, message: { errorMessage } } }, context()).model, direct);
}
assert.equal(routeCodingRequest({ ...request, reason: "retry", failed: { model: direct, message: { errorMessage: "429" } } }, context([direct, paid])).model, direct);
for (const reason of ["user", "continuation", "direct"]) {
  assert.equal(routeCodingRequest({ ...request, reason, previous: { model: router }, messages }, context()).model, direct);
}
assert.equal(routeCodingRequest({ ...request, reason: "retry", failed: { model: router, message: { errorMessage: "429" } } }, context()).model, router);
assert.equal(routeCodingRequest({ ...request, previous: { model: router } }, context([router])).model, router);

// OpenRouter daily limits recover through the same approved NVIDIA model.
for (const errorMessage of ["daily-quota exhausted", "Rate limit exceeded: free-models-per-day.", "MODEL_PROVIDER_QUOTA_EXHAUSTED"]) {
  const retry = { ...request, reason: "retry", failed: { model: router, message: { errorMessage } }, messages };
  const recovered = routeCodingRequest(retry, context());
  assert.equal(recovered.model, direct);
  assert.equal(retry.messages, messages);
  assert.equal(routeCodingRequest(retry, context([router, paid])).model, router, "no paid fallback");
  const next = routeCodingRequest({ ...request, previous: { model: router }, state: recovered.state }, context());
  assert.equal(next.model, direct, "a new prompt drops the exhausted provider's previous success");
  assert.deepEqual(next.state.retryProviders, []);
}
const firstFallback = routeCodingRequest({ ...request, reason: "retry", failed: { model: direct, message: { errorMessage: "429" } } }, context());
const exhaustedFallback = routeCodingRequest({ ...request, reason: "retry", state: firstFallback.state, failed: { model: router, message: { errorMessage: "free-models-per-day" } } }, context());
assert.equal(exhaustedFallback.model, router, "do not bounce to a provider already failed in this retry sequence");
const reverseFallback = routeCodingRequest({ ...request, reason: "retry", failed: { model: router, message: { errorMessage: "daily-quota" } } }, context());
assert.equal(routeCodingRequest({ ...request, reason: "retry", state: reverseFallback.state, failed: { model: direct, message: { errorMessage: "503" } } }, context()).model, direct, "do not bounce back to an exhausted router");
assert.equal(routeCodingRequest({ ...request, reason: "continuation", state: firstFallback.state, previous: { model: router } }, context()).state.retryProviders.length, 0, "successful continuation resets retry sequence");

// Several NIM models: a withdrawn (404) or rate-limited one moves to the next NIM model before OpenRouter.
const [ultra, superVl, lightning] = DIRECT_CODING_MODELS.map(id => ({ provider: "nvidia", id }));
const all = context([ultra, superVl, lightning, router]);
assert.equal(routeCodingRequest(request, all).model, ultra);
const gone = routeCodingRequest({ ...request, reason: "retry", failed: { model: ultra, message: { errorMessage: "404 {\"detail\":\"Function 'x': Not found for account 'y'\"}" } } }, all);
assert.equal(gone.model, superVl, "a withdrawn NIM model falls through to the next NIM model");
const busy = routeCodingRequest({ ...request, reason: "retry", state: gone.state, failed: { model: superVl, message: { errorMessage: "429" } } }, all);
assert.equal(busy.model, lightning);
const last = routeCodingRequest({ ...request, reason: "retry", state: busy.state, failed: { model: lightning, message: { errorMessage: "503" } } }, all);
assert.equal(last.model, router, "OpenRouter free only after every NIM model failed");
assert.equal(routeCodingRequest({ ...request, reason: "retry", state: last.state, failed: { model: router, message: { errorMessage: "daily-quota" } } }, all).model, router, "never bounces once the whole chain failed");
assert.equal(routeCodingRequest(request, context([superVl, router])).model, superVl);

let definition: any;
codingRoute({ registerVirtualModel: (value: any) => { definition = value; } });
assert.equal(`${definition.provider}/${definition.id}`, "agent-console/auto-coding");
assert.equal(definition.route, routeCodingRequest);
assert.deepEqual(definition.input, ["text"]);
console.log("pi-coding-route: exact free-provider routing and transcript preservation passed");

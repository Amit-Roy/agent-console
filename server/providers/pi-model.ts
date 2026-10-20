// Unattended coding uses exact, reviewed model IDs. Catalog ordering must never
// promote a vision/chat model into an automation worker.
// Direct NIM first, in preference order; nemotron-3-super is dropped: NVIDIA returns 404 "Function not found" for it (2026-10-20).
export const AUTOMATION_PI_MODELS: readonly string[] = Object.freeze([
  "nvidia/nvidia/nemotron-3-ultra-550b-a55b",
  "nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b",
  "nvidia/nvidia/nemotron-3.5-lightning-30b-a3b",
  "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
]);

export function isAutomationPiModel(model: string): boolean {
  return AUTOMATION_PI_MODELS.includes(model);
}

/** Resolve an approved coding model that is actually in the current Pi catalog. */
export function selectAutomationPiModel(models: readonly string[], override?: string): string {
  if (override !== undefined) {
    if (!isAutomationPiModel(override)) {
      throw new Error(`Pi automation model is not approved for unattended coding: ${override}`);
    }
    if (!models.includes(override)) {
      throw new Error(`Pi automation model is unavailable: ${override}`);
    }
    return override;
  }
  const selected = AUTOMATION_PI_MODELS.find((model) => models.includes(model));
  if (!selected) {
    throw new Error("Pi automation is blocked: no approved coding model is available. Configure an NVIDIA NIM Nemotron model or the OpenRouter free Nemotron.");
  }
  return selected;
}

/** Manual sessions retain their full picker, including deliberate non-coding choices. */
export function defaultPiModel(models: readonly string[]): string {
  return AUTOMATION_PI_MODELS.find((model) => models.includes(model)) ?? models[0] ?? "";
}

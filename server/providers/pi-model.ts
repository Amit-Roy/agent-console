// Unattended coding uses exact, reviewed model IDs. Catalog ordering must never
// promote a vision/chat model into an automation worker.
export const AUTOMATION_PI_MODELS: readonly string[] = Object.freeze([
  "nvidia/nvidia/nemotron-3-super-120b-a12b",
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
    throw new Error("Pi automation is blocked: no approved coding model is available. Configure NVIDIA Nemotron Super or its OpenRouter free model.");
  }
  return selected;
}

/** Manual sessions retain their full picker, including deliberate non-coding choices. */
export function defaultPiModel(models: readonly string[]): string {
  return AUTOMATION_PI_MODELS.find((model) => models.includes(model)) ?? models[0] ?? "";
}

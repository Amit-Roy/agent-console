// Strict detection of "you hit your usage limit" turn endings. Kept apart from the broad QUOTA_ERROR in
// threads.ts so a transient 429 or rate-limit blip never shows as a usage stop.
export interface UsageStopHit {
  text: string;
  resetsAt?: number;
}

const HIT_LIMIT = /hit your (?:\w+ )?limit/i;
const LEGACY_LIMIT = /Claude AI usage limit reached\|(\d+)/;

export function detectUsageStop(
  provider: string,
  ev: any,
  failure?: string,
  code?: string,
): UsageStopHit | undefined {
  const parts = [ev?.error?.message ?? ev?.error, ev?.result, failure].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  const text = parts.join("\n");
  const legacy = LEGACY_LIMIT.exec(text);
  if (legacy) return { text: parts[0] ?? text, resetsAt: Number(legacy[1]) * 1000 };
  const hit =
    ev?.api_error === "usage_limit_reached" ||
    code === "usageLimitExceeded" ||
    HIT_LIMIT.test(text);
  if (!hit) return undefined;
  const shown =
    parts.find((part) => HIT_LIMIT.test(part)) ?? parts[0] ?? `${provider} usage limit reached`;
  return { text: shown };
}

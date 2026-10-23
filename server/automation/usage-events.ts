import type { ProviderUsage } from "../usage.ts";
import type { EventLog } from "./events.ts";

/** Quota readings arrive with every turn; the usage step records at most one summary per provider every 10 minutes. */
export function usageEvents(events: EventLog, now: () => number = Date.now, everyMs = 10 * 60_000) {
  const last = new Map<string, number>();
  return (provider: string, u: ProviderUsage) => {
    if (now() - (last.get(provider) ?? 0) < everyMs) return;
    const parts = u.windows
      .filter((w) => w.unit === "%" || w.label === "5-hour" || w.label === "7-day")
      .map((w) => `${w.label} ${Math.round(w.used)}%`);
    if (!parts.length) return;
    last.set(provider, now());
    events.record({
      step: "usage",
      kind: "info",
      ref: provider,
      msg: `${provider}: ${parts.join(", ")}`,
    });
  };
}

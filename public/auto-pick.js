// Auto choice for a new thread. Five-hour subscription windows reset whether or not they were used, so prefer the window
// that would waste the most allowance per remaining minute: 40% left with 30 min to go beats 60% left with 2 hours.
export const AUTO_ROUTES = [
  { key: "claude", provider: "claude", account: "primary", model: "sonnet", effort: "medium" },
  {
    key: "claude:secondary",
    provider: "claude",
    account: "secondary",
    model: "sonnet",
    effort: "medium",
  },
  { key: "codex", provider: "codex", model: "gpt-6.1-sol", effort: "medium" },
];
const FIVE_HOURS_MIN = 300;
const MIN_LEFT = 5; // percent: below this a window cannot carry a useful turn
const MIN_MINUTES = 5; // keep a window about to reset from dominating the ratio

function window(u, label, now) {
  const w = u?.windows?.find((x) => x.label === label);
  if (!w || !(w.limit > 0)) return undefined;
  // A reset that has passed means the allowance is full again until the next sample arrives.
  if (w.resetsAt && w.resetsAt <= now) return { left: 100 };
  return { left: Math.max(0, 100 - (w.used / w.limit) * 100), resetsAt: w.resetsAt };
}

/** Every route with its five-hour standing; `usable(route)` says whether the agent, account and model are available. */
export function autoCandidates(usage, now, usable = () => true) {
  return AUTO_ROUTES.map((route) => {
    const five = window(usage?.[route.key], "5-hour", now),
      week = window(usage?.[route.key], "7-day", now);
    const left = five?.left ?? 100,
      minutes = five?.resetsAt ? (five.resetsAt - now) / 60_000 : FIVE_HOURS_MIN;
    const blocked = !usable(route)
      ? "unavailable"
      : left < MIN_LEFT
        ? "5-hour allowance used up"
        : week && week.left < MIN_LEFT
          ? "7-day allowance used up"
          : undefined;
    return {
      route,
      left,
      resetsAt: five?.resetsAt,
      known: !!five,
      blocked,
      rate: left / Math.max(MIN_MINUTES, minutes),
    };
  });
}

/** Best usable candidate, or undefined when none can take a thread. */
export function autoPick(candidates) {
  return candidates.filter((c) => !c.blocked).sort((a, b) => b.rate - a.rate || b.left - a.left)[0];
}

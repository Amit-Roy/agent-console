import assert from "node:assert/strict";
import { type RouteRequest, route } from "../server/automation/router.ts";

const now = 1_800_000_000_000,
  MIN = 60_000;
const win = (used: number, endsInMin = 120, week = 10) => ({
  windows: [
    { label: "5-hour", used, limit: 100, resetsAt: now + endsInMin * MIN },
    { label: "7-day", used: week, limit: 100, resetsAt: now + 3 * 86_400_000 },
  ],
  updatedAt: now,
});
const req = (over: Partial<RouteRequest> = {}): RouteRequest => ({
  role: "work",
  effort: "deep",
  usage: { claude: win(20), codex: win(20) },
  active: [],
  now,
  ...over,
});
const pick = (over?: Partial<RouteRequest>) => {
  const r = route(req(over));
  return r.decision === "route"
    ? `${r.route!.provider}/${r.route!.model}/${r.route!.effort}`
    : r.decision;
};

// --- who does the work -------------------------------------------------------------------------------------
assert.equal(pick({ effort: "trivial" }), "pi/default/default");
assert.equal(
  pick({ effort: "bau", flags: { bauOnPi: true } }),
  "pi/default/default",
  "BAU runs on Pi once the flag is on",
);
assert.match(
  pick({ effort: "bau", premium: true, flags: { bauOnPi: true } }),
  /^(claude\/sonnet|codex\/gpt-6.1-sol)\/low$/,
  "a premium slot runs BAU at low effort, off Pi",
);
assert.notEqual(
  pick({ effort: "trivial", premium: true }).split("/")[0],
  "pi",
  "a premium slot keeps Trivial off Pi",
);
assert.match(
  pick({ effort: "bau" }),
  /^(claude\/sonnet\/medium|codex\/gpt-6\.1-sol\/low)$/,
  "BAU keeps the old premium route until the flag is on",
);
assert.match(pick({ effort: "deep" }), /^(claude\/opus\/medium|codex\/gpt-6\.1-sol\/high)$/);

// --- Deep: premium only, by headroom, load and expiry ---------------------------------------------------------
assert.equal(
  pick({ usage: { claude: win(80), codex: win(20) } }),
  "codex/gpt-6.1-sol/high",
  "more headroom wins",
);
assert.equal(pick({ usage: { claude: win(20), codex: win(80) } }), "claude/opus/medium");
assert.equal(
  pick({
    usage: { claude: win(50), codex: win(50) },
    active: [{ provider: "claude", role: "work" }],
  }),
  "codex/gpt-6.1-sol/high",
  "an active task counts against a provider",
);
assert.equal(
  pick({ usage: { claude: win(50, 20), codex: win(50, 200) } }),
  "claude/opus/medium",
  "equal headroom: use the window that ends first",
);
assert.equal(
  pick({ usage: { claude: win(100), codex: win(30) } }),
  "codex/gpt-6.1-sol/high",
  "an exhausted provider is never chosen",
);
assert.equal(
  pick({ usage: { claude: win(20, 120, 100), codex: win(60) } }),
  "codex/gpt-6.1-sol/high",
  "a full 7-day window counts even when the 5-hour one is empty",
);
assert.equal(
  pick({ usage: { claude: win(100), codex: win(100) } }),
  "defer",
  "Deep waits; it never drops to a cheaper model",
);
const all = route(req({ usage: { claude: win(100), codex: win(100) }, effort: "deep" }));
assert.match(all.why, /no premium provider has room/i);
assert.deepEqual(all.alternatives, []);
// a window that already reset is a window with nothing used yet in it, but we have not seen it: unknown, not zero
assert.equal(
  pick({
    usage: {
      claude: {
        windows: [{ label: "5-hour", used: 99, limit: 100, resetsAt: now - 1 }],
        updatedAt: now - 9e6,
      },
      codex: win(55),
    },
  }),
  "codex/gpt-6.1-sol/high",
  "stale reading is never preferred over a known-good provider",
);
assert.equal(pick({ usage: { codex: win(95) } }), "claude/opus/medium", "unknown beats known-low");
assert.equal(
  pick({ usage: {} }),
  "claude/opus/medium",
  "nothing known: neutral, ordered by the standing preference",
);

// --- review: Trivial and BAU only, by the same rules ---------------------------------------------------------------
assert.equal(pick({ role: "review", effort: "trivial" }), "claude/sonnet/medium");
assert.equal(
  pick({ role: "review", effort: "bau", usage: { claude: win(90), codex: win(20) } }),
  "codex/gpt-6.1-sol/low",
);
assert.equal(pick({ role: "review", effort: "deep" }), "skip", "Deep PRs get no second reviewer");
assert.equal(
  pick({ role: "review", effort: "bau", usage: { claude: win(100), codex: win(100) } }),
  "defer",
);
// --- debug may use Pi when premium is busy -------------------------------------------------------------------------
assert.equal(
  pick({ role: "debug", usage: { claude: win(100), codex: win(100) } }),
  "pi/default/default",
);
assert.match(
  pick({ role: "debug", effort: "bau" }),
  /^(claude\/sonnet\/medium|codex\/gpt-6\.1-sol\/medium)$/,
);
assert.equal(
  pick({
    role: "debug",
    effort: "bau",
    active: [
      { provider: "claude", role: "debug" },
      { provider: "codex", role: "work" },
      { provider: "codex", role: "work" },
    ],
    usage: { claude: win(95), codex: win(95) },
  }),
  "pi/default/default",
);

// --- Pi has its own capacity: a concurrency cap and recent failures -------------------------------
const pi = (used: number) => ({
  windows: [{ label: "Free/day", used, limit: 1000, resetsAt: now + 3 * 3600_000 }],
  updatedAt: now,
});
assert.equal(
  pick({ effort: "trivial", usage: { pi: pi(1009) } }),
  "pi/default/default",
  "OpenRouter free cap spent: direct NVIDIA still runs",
);
assert.equal(
  pick({
    effort: "trivial",
    usage: { pi: pi(10) },
    active: [
      { provider: "pi", role: "work" },
      { provider: "pi", role: "work" },
      { provider: "pi", role: "work" },
    ],
  }),
  "defer",
  "three Pi tasks at once is the cap",
);
assert.equal(
  pick({ effort: "trivial", usage: {}, failures: { pi: 5 } }),
  "defer",
  "Pi has been failing: wait",
);
assert.equal(pick({ effort: "trivial", usage: {}, failures: { pi: 1 } }), "pi/default/default");

// --- contract: response carries the reasoning; unknown request fields and missing optionals are fine ---------------
assert.equal(
  pick({ effort: "deep", exclude: [{ provider: "codex", model: "gpt-6.1-sol" }] } as any).split(
    "/",
  )[0],
  "claude",
  "infrastructure escalation excludes the failed model",
);
assert.equal(
  pick({
    effort: "deep",
    exclude: [
      { provider: "codex", model: "gpt-6.1-sol" },
      { provider: "claude", model: "opus" },
    ],
  } as any),
  "defer",
  "no approved alternative waits without selecting Pi",
);
const r = route({ ...req(), extra: "ignored" } as any);
assert.equal(r.v, 1);
assert.ok(r.why.length > 0);
assert.equal(r.alternatives.length, 1, "the runner-up is reported");
assert.ok(r.alternatives[0].score <= (r as any).score);
assert.throws(() => route({ ...req(), v: 2 } as any), /unsupported/i);
assert.throws(() => route({ ...req(), role: "nope" } as any), /unknown role/i);
// the request is not changed
const frozen = Object.freeze(req({ active: Object.freeze([]) as any }));
assert.doesNotThrow(() => route(frozen));
console.log(
  "PASS router: roles and efforts, headroom/load/expiry scoring, exhausted and unknown usage, Pi capacity, deferral, versioned contract",
);

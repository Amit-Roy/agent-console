import assert from "node:assert/strict";
import { autoCandidates, autoPick } from "../public/auto-pick.js";

const now = Date.UTC(2026, 9, 20, 12);
const min = 60_000;
const sample = (used: number, resetsIn?: number, week = 10) => ({
  updatedAt: now,
  windows: [
    {
      label: "5-hour",
      used,
      limit: 100,
      unit: "%",
      ...(resetsIn != null ? { resetsAt: now + resetsIn * min } : {}),
    },
    { label: "7-day", used: week, limit: 100, unit: "%" },
  ],
});
const key = (usage: any, usable?: (r: any) => boolean) =>
  autoPick(autoCandidates(usage, now, usable))?.route.key;

// The example from the request: 40% left in 30 min beats 60% left in 2 hours.
assert.equal(
  key({ claude: sample(60, 30), "claude:secondary": sample(40, 120), codex: sample(10, 290) }),
  "claude",
);
assert.equal(
  key({ claude: sample(40, 120), "claude:secondary": sample(60, 30), codex: sample(10, 290) }),
  "claude:secondary",
);
// Codex wins when its window is the one about to expire.
assert.equal(
  key({ claude: sample(20, 200), "claude:secondary": sample(20, 200), codex: sample(50, 20) }),
  "codex",
);
// An exhausted five-hour or seven-day window is never picked, however soon it resets.
assert.equal(
  key({ claude: sample(98, 2), "claude:secondary": sample(50, 200), codex: sample(50, 250) }),
  "claude:secondary",
);
assert.equal(
  key({ claude: sample(10, 10, 99), "claude:secondary": sample(50, 200), codex: sample(50, 250) }),
  "claude:secondary",
);
// A passed reset counts as a full window.
const passed = autoCandidates({ claude: sample(100, -5) }, now).find(
  (c) => c.route.key === "claude",
)!;
assert.equal(passed.left, 100);
assert.equal(passed.blocked, undefined);
// Unavailable routes (signed-out account, missing model) are skipped.
assert.equal(
  key(
    { claude: sample(60, 30), "claude:secondary": sample(40, 120), codex: sample(10, 290) },
    (r) => r.key !== "claude",
  ),
  "claude:secondary",
);
assert.equal(
  key({}, () => false),
  undefined,
);
// Unknown usage is treated as a fresh window and still reported as unknown.
const fresh = autoCandidates({}, now);
assert.ok(fresh.every((c) => !c.known && c.left === 100));
console.log("auto-pick: ok");

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEventLog } from "../server/automation/events.ts";
import {
  inHours,
  localMinutes,
  needsOpen,
  loadOpenerConfig,
  createOpener,
  OPENER_ROUTES,
} from "../server/window-opener.ts";

const IST = "Asia/Kolkata";
const at = (iso: string) => Date.parse(iso); // all fixtures in UTC; IST = UTC+5:30
// 2026-10-20 23:30 IST = 18:00 UTC
const night = at("2026-10-20T18:00:00Z"),
  noon = at("2026-10-20T06:30:00Z"); // noon = 12:00 IST
assert.equal(localMinutes(night, IST), 23 * 60 + 30);
const hours = { from: "23:00", to: "07:00", tz: IST };
assert.equal(inHours(night, hours), true, "overnight range, before midnight");
assert.equal(
  inHours(at("2026-10-20T22:00:00Z"), hours),
  true,
  "overnight range, after midnight (03:30 IST)",
);
assert.equal(inHours(noon, hours), false);
assert.equal(
  inHours(at("2026-10-20T01:30:00Z"), hours),
  false,
  "07:00 IST is the first closed minute",
);
assert.equal(inHours(noon, { from: "09:00", to: "17:00", tz: IST }), true, "same-day range");
assert.equal(
  inHours(noon, { from: "09:00", to: "09:00", tz: IST }),
  true,
  "equal bounds mean all day",
);

for (let hour = 0; hour < 24; hour++) {
  assert.equal(
    inHours(noon + hour * 3_600_000, { from: "00:00", to: "00:00", tz: IST }),
    true,
    `all-day includes hour ${hour}`,
  );
}

const w = (resetsAt: number) => ({
  windows: [{ label: "5-hour", used: 5, limit: 100, resetsAt }],
  updatedAt: 0,
});
assert.equal(needsOpen(undefined, night), true, "never seen");
assert.equal(needsOpen(w(night - 1), night), true, "window already reset");
assert.equal(needsOpen(w(night + 60_000), night), false);
// Codex reports an idle account as 0% used with a reset five hours after the reading; that window has not started.
const idle = (readAt: number, used = 0) => ({
  windows: [{ label: "5-hour", used, limit: 100, resetsAt: readAt + 300 * 60_000 + 1_400 }],
  updatedAt: readAt,
});
assert.equal(
  needsOpen(idle(night), night),
  true,
  "0% used and a reset a full 5h after the reading: not started",
);
assert.equal(
  needsOpen(
    {
      windows: [{ label: "5-hour", used: 0, limit: 100, resetsAt: night + 285 * 60_000 }],
      updatedAt: night,
    },
    night,
  ),
  false,
  "0% used but the reset is 4h45 away: started 15 min ago",
);
assert.equal(needsOpen(idle(night, 3), night), false, "any use means a real window");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-opener-"));
const cfg = path.join(dir, "window-dispatch.json");
try {
  assert.equal(loadOpenerConfig(cfg).enabled, false);
  fs.writeFileSync(
    cfg,
    JSON.stringify({
      opener: { enabled: true, from: "25:00", providers: ["claude", "evil"], tz: "Nowhere/Land" },
    }),
  );
  const c = loadOpenerConfig(cfg);
  assert.equal(c.from, "00:00", "bad time falls back");
  assert.deepEqual(c.providers, ["claude"], "unknown providers dropped");
  assert.equal(c.tz, IST);
  assert.equal(c.dryRun, true);

  assert.equal(inHours(noon, loadOpenerConfig(cfg)), true, "default opens during daytime");
  assert.equal(inHours(night, loadOpenerConfig(cfg)), true, "default opens during nighttime");

  let t = night;
  const opened: string[] = [];
  let usage: any = {};
  let refreshed = 0;
  const o = createOpener({
    usage: () => usage,
    refresh: async () => {
      refreshed++;
    },
    open: (p) => {
      opened.push(p);
    },
    dir,
    now: () => t,
  });
  fs.writeFileSync(
    cfg,
    JSON.stringify({ opener: { enabled: true, dryRun: false, providers: ["claude", "codex"] } }),
  );
  assert.deepEqual(await o.tick(), ["claude", "codex"]);
  assert.deepEqual(opened, ["claude", "codex"]);
  assert.equal(refreshed, 1);
  t += 5 * 60_000;
  assert.deepEqual(await o.tick(), [], "not twice in ten minutes even if usage has not caught up");
  t += 10 * 60_000;
  usage = { claude: w(t + 3_600_000) };
  assert.deepEqual(await o.tick(), ["codex"], "claude has a live window now; codex still does not");
  t = noon + 24 * 3_600_000;
  assert.deepEqual(await o.tick(), ["claude", "codex"], "default opens during daytime too");
  const rows = fs
    .readFileSync(path.join(dir, "window-opener.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.deepEqual(rows[0], {
    ts: night,
    dryRun: false,
    provider: "claude",
    ...OPENER_ROUTES.claude,
  });

  // each ready Claude account has its own window; Nefro opens on its own key and account
  {
    fs.rmSync(path.join(dir, "window-opener.jsonl"), { force: true });
    fs.writeFileSync(
      cfg,
      JSON.stringify({ opener: { enabled: true, dryRun: false, providers: ["claude"] } }),
    );
    const calls: any[] = [];
    let u3: any = { claude: w(t + 3_600_000) };
    const o3 = createOpener({
      usage: () => u3,
      claudeAccounts: () => ["sunny", "nefro"],
      open: (p, _r, a) => {
        calls.push([p, a]);
      },
      dir,
      now: () => t,
    });
    t = night;
    assert.deepEqual(await o3.tick(), ["claude:nefro"], "sunny live, nefro idle");
    assert.deepEqual(calls, [["claude", "nefro"]]);
    const row = JSON.parse(
      fs.readFileSync(path.join(dir, "window-opener.jsonl"), "utf8").trim().split("\n")[0],
    );
    assert.equal(row.account, "nefro");
    t += 5 * 60_000;
    u3 = {};
    assert.deepEqual(await o3.tick(), ["claude"], "nefro gap holds; sunny now idle");
    const o4 = createOpener({
      usage: () => ({}),
      claudeAccounts: () => ["sunny"],
      open: () => {},
      dir,
      now: () => t,
    });
    assert.deepEqual(
      await o4.tick(),
      [],
      "unsigned account is skipped; ledger gap holds for sunny",
    );
  }

  // dry run logs once per gap and opens nothing
  fs.rmSync(path.join(dir, "window-opener.jsonl"));
  opened.length = 0;
  usage = {};
  fs.writeFileSync(cfg, JSON.stringify({ opener: { enabled: true, providers: ["codex"] } }));
  const d = createOpener({
    usage: () => usage,
    open: (p) => {
      opened.push(p);
    },
    dir,
    now: () => t,
  });
  t = night;
  assert.deepEqual(await d.tick(), ["codex"]);
  t += 5 * 60_000;
  assert.deepEqual(await d.tick(), []);
  assert.deepEqual(opened, []);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, "window-opener.jsonl"), "utf8")).dryRun,
    true,
  );

  // a failed open is logged and may be retried on the next tick
  fs.rmSync(path.join(dir, "window-opener.jsonl"));
  fs.writeFileSync(
    cfg,
    JSON.stringify({ opener: { enabled: true, dryRun: false, providers: ["codex"] } }),
  );
  let fail = true;
  const f = createOpener({
    usage: () => ({}),
    open: () => {
      if (fail) throw new Error("down");
    },
    dir,
    now: () => t,
  });
  t = night;
  assert.deepEqual(await f.tick(), []);
  fail = false;
  t += 60_000;
  assert.deepEqual(await f.tick(), ["codex"]);
  assert.match(fs.readFileSync(path.join(dir, "window-opener.jsonl"), "utf8"), /"error":"down"/);

  // every tick leaves a trace saying what happened and why: the dashboard's only view of an idle opener
  {
    const ev = createEventLog({ file: path.join(dir, "ev.jsonl"), now: () => t });
    fs.rmSync(path.join(dir, "window-opener.jsonl"), { force: true });
    fs.writeFileSync(
      cfg,
      JSON.stringify({
        opener: { enabled: true, dryRun: false, providers: ["claude"], from: "23:00", to: "07:00" },
      }),
    );
    const msgs = () => ev.read({ step: "opener" }).events.map((e) => `${e.kind}:${e.msg}`);
    let usage2: any = {};
    let boom = false;
    const o2 = createOpener({
      usage: () => usage2,
      open: () => {
        if (boom) throw new Error("spawn failed");
      },
      dir,
      now: () => t,
      events: ev,
    });
    t = noon;
    await o2.tick();
    assert.match(msgs()[0], /^info:nothing to do: outside 23:00–07:00/);
    t = night;
    await o2.tick();
    assert.ok(
      msgs().some((m) => m === "ok:opened claude"),
      "opening is recorded",
    );
    t += 20 * 60_000;
    usage2 = { claude: w(t + 3_600_000) };
    await o2.tick();
    assert.match(msgs()[0], /^info:nothing to do: every window is live/);
    usage2 = {};
    boom = true;
    t += 20 * 60_000;
    await o2.tick();
    assert.ok(
      msgs().some((m) => /^fail:claude: spawn failed/.test(m)),
      "a failed open is a failure on the dashboard",
    );
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(
  "PASS window opener: all-day defaults, custom overnight hours, live-window check, ten-minute gap, config validation, dry run, failed open",
);

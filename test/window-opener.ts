import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inHours, localMinutes, needsOpen, loadOpenerConfig, createOpener, OPENER_ROUTES } from "../server/window-opener.ts";

const IST = "Asia/Kolkata";
const at = (iso: string) => Date.parse(iso); // all fixtures in UTC; IST = UTC+5:30
// 2026-10-20 23:30 IST = 18:00 UTC
const night = at("2026-10-20T18:00:00Z"), noon = at("2026-10-20T06:30:00Z"); // noon = 12:00 IST
assert.equal(localMinutes(night, IST), 23 * 60 + 30);
const hours = { from: "23:00", to: "07:00", tz: IST };
assert.equal(inHours(night, hours), true, "overnight range, before midnight");
assert.equal(inHours(at("2026-10-20T22:00:00Z"), hours), true, "overnight range, after midnight (03:30 IST)");
assert.equal(inHours(noon, hours), false);
assert.equal(inHours(at("2026-10-20T01:30:00Z"), hours), false, "07:00 IST is the first closed minute");
assert.equal(inHours(noon, { from: "09:00", to: "17:00", tz: IST }), true, "same-day range");
assert.equal(inHours(noon, { from: "09:00", to: "09:00", tz: IST }), false, "empty range");

const w = (resetsAt: number) => ({ windows: [{ label: "5-hour", used: 5, limit: 100, resetsAt }], updatedAt: 0 });
assert.equal(needsOpen(undefined, night), true, "never seen");
assert.equal(needsOpen(w(night - 1), night), true, "window already reset");
assert.equal(needsOpen(w(night + 60_000), night), false);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-opener-"));
const cfg = path.join(dir, "window-dispatch.json");
try {
  assert.equal(loadOpenerConfig(cfg).enabled, false);
  fs.writeFileSync(cfg, JSON.stringify({ opener: { enabled: true, from: "25:00", providers: ["claude", "evil"], tz: "Nowhere/Land" } }));
  const c = loadOpenerConfig(cfg);
  assert.equal(c.from, "23:00", "bad time falls back"); assert.deepEqual(c.providers, ["claude"], "unknown providers dropped"); assert.equal(c.tz, IST); assert.equal(c.dryRun, true);

  let t = night; const opened: string[] = []; let usage: any = {}; let refreshed = 0;
  const o = createOpener({ usage: () => usage, refresh: async () => { refreshed++; }, open: p => { opened.push(p); }, dir, now: () => t });
  fs.writeFileSync(cfg, JSON.stringify({ opener: { enabled: true, dryRun: false, providers: ["claude", "codex"] } }));
  assert.deepEqual(await o.tick(), ["claude", "codex"]); assert.deepEqual(opened, ["claude", "codex"]); assert.equal(refreshed, 1);
  t += 5 * 60_000;
  assert.deepEqual(await o.tick(), [], "not twice in ten minutes even if usage has not caught up");
  t += 10 * 60_000; usage = { claude: w(t + 3_600_000) };
  assert.deepEqual(await o.tick(), ["codex"], "claude has a live window now; codex still does not");
  t = noon;
  assert.deepEqual(await o.tick(), [], "outside the hours nothing is opened");
  const rows = fs.readFileSync(path.join(dir, "window-opener.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
  assert.deepEqual(rows[0], { ts: night, dryRun: false, provider: "claude", ...OPENER_ROUTES.claude });

  // dry run logs once per gap and opens nothing
  fs.rmSync(path.join(dir, "window-opener.jsonl")); opened.length = 0; usage = {};
  fs.writeFileSync(cfg, JSON.stringify({ opener: { enabled: true, providers: ["codex"] } }));
  const d = createOpener({ usage: () => usage, open: p => { opened.push(p); }, dir, now: () => t });
  t = night; assert.deepEqual(await d.tick(), ["codex"]); t += 5 * 60_000; assert.deepEqual(await d.tick(), []);
  assert.deepEqual(opened, []); assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "window-opener.jsonl"), "utf8")).dryRun, true);

  // a failed open is logged and may be retried on the next tick
  fs.rmSync(path.join(dir, "window-opener.jsonl"));
  fs.writeFileSync(cfg, JSON.stringify({ opener: { enabled: true, dryRun: false, providers: ["codex"] } }));
  let fail = true;
  const f = createOpener({ usage: () => ({}), open: () => { if (fail) throw new Error("down"); }, dir, now: () => t });
  t = night; assert.deepEqual(await f.tick(), []); fail = false; t += 60_000; assert.deepEqual(await f.tick(), ["codex"]);
  assert.match(fs.readFileSync(path.join(dir, "window-opener.jsonl"), "utf8"), /"error":"down"/);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log("PASS window opener: overnight hours, live-window check, ten-minute gap, config validation, dry run, failed open");

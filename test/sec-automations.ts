// Security automations: status parsing, colours (green, amber, red), SSH failure and the 60 s cache, plus the HTTP route.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import {
  bridgeRow,
  CACHE_MS,
  createSecAutomations,
  evaluate,
  parseStatus,
  STALE_MS,
} from "../server/sec-automations.ts";
import { mountSecurity } from "../server/security.ts";
import { createToolWatch } from "../server/tool-watch.ts";
import { AMBER, BRIDGE, GREEN, NOW, RED, status } from "./sec-automations-mock.ts";

const tones = (v: { rows: { id: string; tone: string }[] }) =>
  Object.fromEntries(v.rows.map((r) => [r.id, r.tone]));
let clock = NOW;
function make(answers: (() => unknown)[], bridge = BRIDGE) {
  let calls = 0;
  const sa = createSecAutomations({
    fetchStatus: async () => {
      const a = answers[Math.min(calls++, answers.length - 1)]!();
      if (a instanceof Error) throw a;
      return a;
    },
    bridge: () => bridge,
    now: () => clock,
  });
  return { sa, calls: () => calls };
}

// green: every unit succeeded and has a next run; the bridge row sits after tool-watch
{
  clock = NOW;
  const { sa } = make([() => GREEN]);
  const v = await sa.view();
  assert.equal(v.reachable, true);
  assert.equal(v.summary.tone, "ok");
  assert.deepEqual(
    v.rows.map((r) => r.id),
    [
      "secscan",
      "tool-watch",
      "tool-patch",
      "falco-alert",
      "crashes",
      "osv",
      "opencve-sync",
      "opencve-digest",
      "opencve-webhook",
      "opencve-backup",
      "heartbeat",
    ],
  );
  assert.ok(
    v.rows.every((r) => r.tone === "ok"),
    JSON.stringify(tones(v)),
  );
  assert.equal(v.rows[0]!.runnable, "quick-scan");
  assert.equal(v.rows[1]!.runnable, "tool-watch");
  assert.equal(
    v.rows.find((r) => r.id === "opencve-sync")!.link,
    "https://vps.example.ts.net:8443",
  );
}

// amber: more than 1.5 periods since the last run
{
  const { sa } = make([() => AMBER]);
  const v = await sa.view();
  assert.equal(tones(v)["tool-watch"], "warn");
  assert.equal(v.rows.find((r) => r.id === "tool-watch")!.label, "Overdue");
  assert.equal(v.summary.tone, "warn");
  assert.equal(v.summary.warn, 1);
  // exactly 1.5 periods is still fine
  const edge = evaluate(
    parseStatus(status({ osv: { lastRun: NOW - 36 * 3600_000 } })).find((u) => u.id === "osv")!,
    NOW,
  );
  assert.equal(edge.tone, "ok");
}

// red: a failed last run or an inactive unit beats overdue; the summary counts them
{
  const { sa } = make([() => RED]);
  const v = await sa.view();
  const t = tones(v);
  assert.equal(t["opencve-backup"], "bad");
  assert.equal(t.heartbeat, "bad");
  assert.equal(t["tool-watch"], "warn");
  assert.equal(v.summary.tone, "bad");
  assert.equal(v.summary.bad, 2);
  assert.match(v.rows.find((r) => r.id === "heartbeat")!.detail!, /falco-alert inactive/);
  const inactive = evaluate(
    parseStatus(status({ osv: { ok: false, active: "inactive" } })).find((u) => u.id === "osv")!,
    NOW,
  );
  assert.equal(inactive.label, "Inactive");
}

// no run yet is neutral, a stopped timer with a past run is not green, a running unit is ok
{
  const f = (id: string, over: Record<string, unknown>) =>
    evaluate(parseStatus(status({ [id]: over })).find((u) => u.id === id)!, NOW);
  assert.equal(f("opencve-digest", { lastRun: null }).tone, "idle");
  assert.equal(f("osv", { next: null }).tone, "warn");
  assert.equal(f("secscan", { running: true, lastRun: NOW - 99 * 86400_000 }).label, "Running");
}

// patch bridge rows
{
  assert.equal(bridgeRow(BRIDGE, NOW).tone, "ok");
  assert.match(bridgeRow(BRIDGE, NOW).detail!, /1 open, 3 merged, 1 rejected, 0 failed/);
  assert.equal(bridgeRow({ ...BRIDGE, failed: 2 }, NOW).tone, "bad");
  assert.equal(bridgeRow({ ...BRIDGE, lastTick: { at: NOW - 3 * 3600_000 } }, NOW).tone, "warn");
  assert.equal(
    bridgeRow({ ...BRIDGE, lastTick: { at: NOW - 1000, error: "ssh down" } }, NOW).tone,
    "bad",
  );
  assert.equal(bridgeRow({ ...BRIDGE, enabled: false }, NOW).tone, "idle");
}

// SSH failure: nothing cached = red status row; cached = stale answer for 10 min, then red again
{
  clock = NOW;
  const boom = () => new Error("Could not reach the scan host over SSH.");
  const cold = make([boom]);
  const v = await cold.sa.view();
  assert.equal(v.reachable, false);
  assert.equal(v.rows[0]!.id, "status-host");
  assert.equal(v.rows[0]!.tone, "bad");
  assert.equal(v.summary.tone, "bad");
  assert.ok(
    v.rows.some((r) => r.id === "tool-patch"),
    "bridge row survives an SSH failure",
  );

  const warm = make([() => GREEN, boom]);
  await warm.sa.view();
  clock = NOW + CACHE_MS + 1;
  const stale = await warm.sa.view();
  assert.equal(stale.stale, true);
  assert.equal(stale.reachable, true);
  assert.equal(warm.calls(), 2);
  clock = NOW + STALE_MS + 1;
  assert.equal((await warm.sa.view()).reachable, false);
}

// cache: one SSH call per 60 s, invalidate() forces a new one
{
  clock = NOW;
  const c = make([() => GREEN]);
  await c.sa.view();
  clock = NOW + CACHE_MS - 1;
  await Promise.all([c.sa.view(), c.sa.view()]);
  assert.equal(c.calls(), 1);
  c.sa.invalidate();
  await c.sa.view();
  assert.equal(c.calls(), 2);
  clock = NOW + 2 * CACHE_MS;
  await c.sa.view();
  assert.equal(c.calls(), 3);
}

// validation: hostile or malformed answers are cut down, not repaired
{
  assert.throws(() => parseStatus({}), /unreadable/);
  assert.throws(() => parseStatus(null), /unreadable/);
  const u = parseStatus({
    units: [
      { id: "Bad Id!", name: "x" },
      {
        id: "ok-1",
        name: "a\u0007b",
        link: "javascript:alert(1)",
        runnable: "rm -rf /",
        periodSec: -4,
        ok: "yes",
      },
    ],
  });
  assert.equal(u.length, 1);
  assert.equal(u[0]!.link, "/security");
  assert.equal(u[0]!.runnable, null);
  assert.equal(u[0]!.name, "a?b");
  assert.equal(u[0]!.periodSec, 86400);
  assert.equal(u[0]!.ok, false);
}

// bridgeView: no state file = no poll yet, nothing failed
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-auto-"));
  const tw = createToolWatch({
    statePath: path.join(dir, "state.json"),
    configPath: path.join(dir, "cfg.json"),
    remote: async () => ({}),
  });
  assert.deepEqual(tw.bridgeView(), {
    enabled: false,
    lastTick: null,
    open: 0,
    merged: 0,
    rejected: 0,
    failed: 0,
  });
  fs.writeFileSync(
    path.join(dir, "state.json"),
    JSON.stringify({
      pending: [{ key: "a", tool: "uv", pr: 4 }],
      failed: { b: "x" },
      done: [],
      merged: 2,
      rejected: 1,
      lastTick: { at: 5 },
    }),
  );
  assert.deepEqual(tw.bridgeView(), {
    enabled: false,
    lastTick: { at: 5 },
    open: 1,
    merged: 2,
    rejected: 1,
    failed: 1,
  });
}

// HTTP route over a fake ssh: uses the status key, only the word `status`, 502 on SSH failure, run invalidates the cache
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-auto-ssh-"));
  const log = path.join(dir, "calls.log");
  const fake = path.join(dir, "ssh");
  fs.writeFileSync(
    fake,
    `#!/bin/sh
for a; do last="$a"; done
echo "$@" >> "${log}"
case "$last" in
  status) cat <<'J'
${JSON.stringify(GREEN)}
J
  ;;
  "run quick") echo '{"started":true,"mode":"quick"}' ;;
  *) echo boom >&2; exit 255 ;;
esac
`,
    { mode: 0o755 },
  );
  process.env.SECSCAN_SSH_BIN = fake;
  process.env.SECSCAN_SSH_TARGET = "scan@test.invalid";
  process.env.SECSCAN_SSH_KEY = "/tmp/no-such-scan-key";
  process.env.SECSTATUS_SSH_KEY = "/tmp/no-such-status-key";
  const app = express();
  mountSecurity(app, (req, res, next) =>
    req.headers.origin && new URL(String(req.headers.origin)).host !== req.headers.host
      ? void res.status(403).json({ error: "cross-site" })
      : next(),
  );
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    let r = await fetch(`${base}/api/security/automations`);
    const j: any = await r.json();
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(j.rows.length, 11);
    assert.ok(j.rows.some((x: any) => x.id === "secscan"));
    const calls = () => fs.readFileSync(log, "utf8").trim().split("\n");
    assert.match(calls()[0]!, /no-such-status-key/);
    assert.match(calls()[0]!, / status$/);
    await fetch(`${base}/api/security/automations`);
    assert.equal(calls().length, 1, "second page load served from the 60 s cache");
    r = await fetch(`${base}/api/security/run?mode=quick`, {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    assert.equal(r.status, 403);
    r = await fetch(`${base}/api/security/run?mode=quick`, { method: "POST" });
    assert.equal(r.status, 200);
    await fetch(`${base}/api/security/automations`);
    assert.equal(
      calls().filter((c) => c.endsWith(" status")).length,
      2,
      "run now refreshes the rows",
    );
  } finally {
    server.close();
  }
}
console.log("sec-automations: ok");

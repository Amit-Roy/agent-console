// Security API: forced-command SSH client, caching, validation. A fake ssh binary stands in for the scan host.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import { mountSecurity } from "../server/security.ts";
import { HISTORY, LATEST, LOG_ID, LOG_LINES, logPage } from "./security-mock.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secscan-"));
const log = path.join(dir, "calls.log");
const fake = path.join(dir, "ssh");
fs.writeFileSync(
  fake,
  `#!/bin/sh
for a; do last="$a"; done
echo "$@" >> "${log}"
case "$last" in
  latest) cat <<'J'
${JSON.stringify(LATEST)}
J
  ;;
  history) cat <<'J'
${JSON.stringify(HISTORY)}
J
  ;;
  "get 20261022T231500Z") cat <<'J'
${JSON.stringify(LATEST)}
J
  ;;
  "get "*) echo '{}' ;;
  "log ${LOG_ID} "*) after="\${last##* }"; echo '${JSON.stringify(logPage(0))}' | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")),a=Number(process.argv[1]);d.from=Math.min(a,d.total);d.lines=d.lines.slice(a);console.log(JSON.stringify(d))' "$after" ;;
  "log "*) echo '{"error":"not found"}'; exit 1 ;;
  status) echo '{"running":true,"startedAt":"2026-10-23T01:00:00Z","currentTool":"trivy"}' ;;
  "run quick") echo '{"started":true,"mode":"quick"}' ;;
  "run full") echo '{"started":true,"mode":"full"}' ;;
  *) echo boom >&2; exit 255 ;;
esac
`,
  { mode: 0o755 },
);
process.env.SECSCAN_SSH_BIN = fake;
process.env.SECSCAN_SSH_TARGET = "scan@test.invalid";
process.env.SECSCAN_SSH_KEY = "/tmp/no-such-key";

const app = express();
mountSecurity(app, (req, res, next) =>
  req.headers.origin && new URL(String(req.headers.origin)).host !== req.headers.host
    ? void res.status(403).json({ error: "cross-site" })
    : next(),
);
const server = http.createServer(app).listen(0);
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []);
try {
  let r = await fetch(`${base}/api/security/latest`);
  let j: any = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.result.id, LATEST.id);
  await fetch(`${base}/api/security/latest`);
  assert.equal(calls().filter((c) => c.endsWith(" latest")).length, 1, "latest cached for 30 s");
  assert.match(
    calls()[0],
    /-i \/tmp\/no-such-key -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=5 scan@test\.invalid latest/,
  );

  j = await (await fetch(`${base}/api/security/history`)).json();
  assert.equal(j.scans.length, HISTORY.length);
  j = await (await fetch(`${base}/api/security/status`)).json();
  assert.deepEqual([j.running, j.currentTool], [true, "trivy"]);

  r = await fetch(`${base}/api/security/scans/20261022T231500Z`);
  assert.equal(r.status, 200);
  assert.equal(
    (await fetch(`${base}/api/security/scans/20269999T000000Z`)).status,
    404,
    "unknown id is 404",
  );
  const before = calls().length;
  assert.equal(
    (await fetch(`${base}/api/security/scans/${encodeURIComponent("1; rm -rf /")}`)).status,
    400,
    "bad id never reaches ssh",
  );
  assert.equal(calls().length, before);

  j = await (await fetch(`${base}/api/security/scans/${LOG_ID}/log`)).json();
  assert.deepEqual([j.from, j.total, j.lines.length], [0, LOG_LINES.length, LOG_LINES.length]);
  r = await fetch(`${base}/api/security/scans/${LOG_ID}/log?after=4`);
  j = await r.json();
  assert.deepEqual(
    [r.headers.get("cache-control"), j.from, j.lines],
    ["no-store", 4, LOG_LINES.slice(4)],
    "log honours after",
  );
  assert.equal(
    (await fetch(`${base}/api/security/scans/20260101T000000Z/log`)).status,
    404,
    "unknown log is 404",
  );
  const beforeLog = calls().length;
  for (const bad of [
    `${encodeURIComponent("1; rm -rf /")}/log`,
    "abc/log",
    `${LOG_ID}/log?after=x`,
    `${LOG_ID}/log?after=-1`,
    `${LOG_ID}/log?after=1;id`,
  ]) {
    assert.equal(
      (await fetch(`${base}/api/security/scans/${bad}`)).status,
      400,
      `bad log request ${bad}`,
    );
  }
  assert.equal(calls().length, beforeLog, "bad log requests never reach ssh");

  assert.equal(
    (
      await fetch(`${base}/api/security/run`, {
        method: "POST",
        headers: { origin: "https://evil.example" },
      })
    ).status,
    403,
    "run refuses cross-site",
  );
  r = await fetch(`${base}/api/security/run`, { method: "POST" });
  assert.deepEqual(await r.json(), { started: true, mode: "full" });
  assert.ok(calls().at(-1)?.endsWith(" run full"), "default mode is full");
  r = await fetch(`${base}/api/security/run?mode=quick`, { method: "POST" });
  assert.deepEqual(await r.json(), { started: true, mode: "quick" });
  assert.ok(calls().at(-1)?.endsWith(" run quick"), "quick passes through");
  const beforeRun = calls().length;
  for (const bad of ["slow", "quick;id", "", "quick&mode=full"])
    assert.equal(
      (await fetch(`${base}/api/security/run?mode=${encodeURIComponent(bad)}`, { method: "POST" }))
        .status,
      400,
      `bad mode ${bad}`,
    );
  assert.equal(
    (await fetch(`${base}/api/security/run?mode=quick&mode=full`, { method: "POST" })).status,
    400,
    "repeated mode",
  );
  assert.equal(calls().length, beforeRun, "bad modes never reach ssh");
  await fetch(`${base}/api/security/latest`);
  assert.equal(
    calls().filter((c) => c.endsWith(" latest")).length,
    2,
    "run drops the latest cache",
  );

  process.env.SECSCAN_SSH_BIN = path.join(dir, "missing-ssh");
  r = await fetch(`${base}/api/security/history`);
  j = await r.json();
  assert.equal(r.status, 502);
  assert.match(j.error, /Could not reach the scan host/);
  console.log("PASS  security api");
} finally {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

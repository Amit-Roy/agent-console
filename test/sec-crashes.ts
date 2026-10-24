// Crash log parser, second redaction pass and the 10 s coalescing cache. No network.
import assert from "node:assert/strict";
import { createSecCrashes, parseCrashes, redact } from "../server/sec-crashes.ts";

const NOW = Date.UTC(2026, 9, 23, 15, 30, 0);
const crash = (over: Record<string, unknown> = {}) => ({
  at: NOW - 60_000,
  pid: 4242,
  uid: 1000,
  signal: "SIGSEGV",
  exe: "/usr/bin/node",
  comm: "node",
  scope: "host",
  cmdline: "node server.js",
  frames: ["#0 0x1 in foo ()", "#1 0x2 in bar ()"],
  ...over,
});
const answer = (crashes: unknown[], over: Record<string, unknown> = {}) => ({
  generatedAt: NOW,
  total: crashes.length,
  crashes,
  ...over,
});

// valid entry passes through
const ok = parseCrashes(answer([crash()]));
assert.equal(ok.crashes.length, 1);
assert.equal(ok.crashes[0].comm, "node");
assert.equal(ok.total, 1);

// bad entries are dropped, good ones kept
const mixed = parseCrashes(
  answer([
    crash({ pid: "1" }),
    crash({ at: -5 }),
    crash({ signal: "sigsegv; rm" }),
    null,
    "x",
    crash({ uid: 1.5 }),
    crash({ comm: "good" }),
  ]),
);
assert.deepEqual(
  mixed.crashes.map((c) => c.comm),
  ["good"],
);

// caps
const many = parseCrashes(
  answer(
    Array.from({ length: 50 }, () => crash()),
    { total: 50 },
  ),
);
assert.equal(many.crashes.length, 20);
assert.equal(many.total, 50, "total keeps the real count");
const long = parseCrashes(
  answer([
    crash({
      cmdline: "a b ".repeat(300),
      frames: Array.from({ length: 12 }, () => "f ".repeat(200)),
    }),
  ]),
);
assert.ok(long.crashes[0].cmdline.length <= 300);
assert.equal(long.crashes[0].frames.length, 8);
assert.ok(long.crashes[0].frames.every((f) => f.length <= 160));

// printable ASCII only
const ascii = parseCrashes(answer([crash({ cmdline: "x\u0000\u001b[31méy" })]));
assert.match(ascii.crashes[0].cmdline, /^[\x20-\x7e]*$/);

// unreadable answer and {error}
for (const bad of [null, undefined, "x", {}, { crashes: "no" }])
  assert.throws(() => parseCrashes(bad), /unreadable/);
assert.throws(() => parseCrashes({ error: "journal unavailable" }), /journal unavailable/);

// each redaction rule
const hidden: [string, string][] = [
  ["--api-token=abc123", "abc123"],
  ["--password hunter2", "hunter2"],
  ["MY_SECRET=topsecretvalue", "topsecretvalue"],
  ["AUTH_COOKIE=zzz", "zzz"],
  ["https://user:pw0rd@example.com/x", "pw0rd"],
  ["Authorization: Basic dXNlcjpwdw", "dXNlcjpwdw"],
  ["curl -H Bearer abcdef123", "abcdef123"],
  ["ghp_abcdefghijklmnop1234", "ghp_abcdefghijklmnop1234"],
  ["github_pat_11ABCDEFG0abcdefghij", "github_pat_11ABCDEFG0abcdefghij"],
  ["sk-abcdefghijklmnop1234", "sk-abcdefghijklmnop1234"],
  ["xoxb-1234567890-abcdef", "xoxb-1234567890-abcdef"],
  ["AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"],
  ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_nature", "eyJhbGciOiJIUzI1NiJ9"],
  ["A".repeat(32), "A".repeat(32)],
];
for (const [input, secret] of hidden) {
  const out = redact(input);
  assert.ok(!out.includes(secret), `${input} -> ${out}`);
  assert.match(out, /\[redacted\]/);
}
assert.equal(
  redact("node server.js --port 8080"),
  "node server.js --port 8080",
  "plain text stays",
);
// redaction applies to every text field of a parsed entry
const dirty = parseCrashes(
  answer([crash({ cmdline: "app --token=abc", frames: ["at ghp_abcdefghijklmnop1234"] })]),
);
assert.ok(!dirty.crashes[0].cmdline.includes("abc"));
assert.ok(!dirty.crashes[0].frames[0].includes("ghp_"));

// 10 s cache with one shared in-flight request
let calls = 0;
let clock = NOW;
let release!: () => void;
const gate = new Promise<void>((r) => (release = r));
const crashes = createSecCrashes({
  fetch: async () => {
    calls++;
    await gate;
    return answer([crash()]);
  },
  now: () => clock,
});
const both = Promise.all([crashes.view(), crashes.view()]);
release();
const [a, b] = await both;
assert.equal(calls, 1, "concurrent callers share one request");
assert.equal(a, b);
clock += 9_000;
await crashes.view();
assert.equal(calls, 1, "cached inside 10 s");
clock += 2_000;
await crashes.view();
assert.equal(calls, 2, "refetched after 10 s");

// a failed fetch is not cached and clears the in-flight slot
let fail = true;
const flaky = createSecCrashes({
  fetch: async () => (fail ? { error: "nope" } : answer([])),
  now: () => clock,
});
await assert.rejects(() => flaky.view(), /nope/);
fail = false;
assert.equal((await flaky.view()).crashes.length, 0);
console.log("sec-crashes: ok");

// Offline integration: isolated account/session fixtures and a recording CLI, never real prompts.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "ac-accounts-integration-"));
const before = { ...process.env };
const data = path.join(home, "data"),
  bin = path.join(home, "bin"),
  capture = path.join(home, "capture.json");
for (const dir of [data, bin, path.join(home, ".claude"), path.join(home, ".claude-secondary")])
  fs.mkdirSync(dir, { recursive: true });
const secondary = path.join(home, ".claude-secondary");
fs.writeFileSync(
  path.join(secondary, ".credentials.json"),
  JSON.stringify({ claudeAiOauth: { accessToken: "offline-fixture" } }),
);
fs.writeFileSync(
  path.join(secondary, ".claude.json"),
  JSON.stringify({ oauthAccount: { emailAddress: "secondary@example.com" } }),
);
fs.writeFileSync(
  path.join(bin, "claude"),
  `#!${process.execPath}\nimport fs from 'node:fs';fs.writeFileSync(process.env.CAPTURE,JSON.stringify({args:process.argv.slice(2),dir:process.env.CLAUDE_CONFIG_DIR,leaked:['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','CLAUDECODE'].filter(k=>process.env[k])}));\n`,
  { mode: 0o700 },
);
Object.assign(process.env, {
  HOME: home,
  AGENT_CONSOLE_DATA: data,
  AGENT_CONSOLE_BRAIN: path.join(home, "absent-brain"),
  AGENT_CONSOLE_LABELS: "0",
  AGENT_CONSOLE_MOCK: "1",
  AGENT_CONSOLE_WARM_MAX: "0",
  PATH: bin + path.delimiter + process.env.PATH,
  CAPTURE: capture,
  ANTHROPIC_API_KEY: "fixture",
  ANTHROPIC_AUTH_TOKEN: "fixture",
  CLAUDE_CODE_OAUTH_TOKEN: "fixture",
  CLAUDECODE: "fixture",
});
delete process.env.CLAUDE_CONFIG_DIR;
const row = (id: string, claudeAccount?: string) => ({
  id,
  provider: "claude",
  claudeAccount,
  title: id,
  model: "sonnet",
  mode: "acceptEdits",
  cwd: home,
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  cost: 0,
});
fs.writeFileSync(
  path.join(data, "threads.json"),
  JSON.stringify([
    row("invalid", "unknown"),
    row("legacy"),
    row("persisted-secondary", "secondary"),
  ]),
);
const { Threads } = await import("../server/threads.ts");
const { claude } = await import("../server/providers/claude.ts");
const { PROVIDERS } = await import("../server/providers/index.ts");
const { contextAllocation } = await import("../server/context-allocation.ts");
const { usage } = await import("../server/usage.ts");
const threads = new Threads(() => {});
try {
  assert.equal(threads.get("invalid"), undefined);
  assert.equal(
    threads.get("legacy")?.claudeAccount,
    "primary",
    "An invalid row cannot hide following legacy threads.",
  );
  assert.equal(threads.get("persisted-secondary")?.claudeAccount, "secondary");
  const primary = threads.create({ cwd: home, title: "Primary fixture" });
  const second = threads.create({
    cwd: home,
    claudeAccount: "secondary",
    title: "Secondary fixture",
  });
  assert.equal(primary.claudeAccount, "primary");
  second.sessionId = "private-secondary-session";
  assert.throws(() => threads.update(second.id, { claudeAccount: "primary" }), /original account/);
  assert.equal(second.claudeAccount, "secondary");
  const fork = threads.fork(second.id);
  assert.equal(fork.claudeAccount, "secondary");
  assert.equal(fork.forkFrom, second.sessionId);
  assert.throws(() => threads.update(fork.id, { claudeAccount: "primary" }), /original account/);
  const crossed = threads.fork(second.id, undefined, false, {
    claudeAccount: "primary",
    mode: "plan",
  });
  assert.equal(crossed.claudeAccount, "primary", "A fork can move to another account.");
  assert.equal(
    crossed.forkFrom,
    undefined,
    "Another account cannot resume this account's native session.",
  );
  assert.equal(crossed.mode, "plan");
  threads.remove(crossed.id);
  assert.throws(
    () => threads.create({ cwd: home, claudeAccount: "../primary" }),
    /Unknown Claude account/,
  );
  for (const t of [primary, second, fork]) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Recording CLI did not exit.")), 5000);
      claude.start(t, {
        event: () => {},
        commands: () => {},
        exited: (info) => {
          clearTimeout(timer);
          info.code === 0 ? resolve() : reject(Error(info.stderr));
        },
      });
    });
    const call = JSON.parse(fs.readFileSync(capture, "utf8"));
    assert.equal(call.dir, t.claudeAccount === "secondary" ? secondary : undefined);
    assert.deepEqual(call.leaked, []);
    const resume = call.args.indexOf("--resume");
    assert.equal(resume >= 0, t !== primary);
    if (resume >= 0) assert.equal(call.args[resume + 1], second.sessionId);
    assert.equal(call.args.includes("--fork-session"), t === fork);
  }
  const contexts = new Map<string, any>();
  PROVIDERS.set("claude", {
    ...claude,
    start(t, ctx) {
      contexts.set(t.id, ctx);
      return { alive: true, send() {}, abort() {}, kill() {} };
    },
  });
  threads.send(primary.id, "Offline fixture.");
  threads.send(second.id, "Offline fixture.");
  for (const [t, utilization] of [
    [primary, 0.2],
    [second, 0.8],
  ] as const)
    contexts.get(t.id).event({
      type: "rate_limit_event",
      rate_limit_info: { unifiedWindows: { five_hour: { utilization } } },
    });
  assert.equal(usage.get("claude")?.windows[0].used, 20);
  assert.equal(usage.get("claude:secondary")?.windows[0].used, 80);
  for (const [account, text] of [
    ["primary", "abcd"],
    ["secondary", "abcd".repeat(12)],
  ] as const) {
    const project = path.join(
      home,
      account === "primary" ? ".claude" : ".claude-secondary",
      "projects",
      "fixture",
    );
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(
      path.join(project, "same-session.jsonl"),
      [
        {
          type: "api-request-blob",
          hash: "blob",
          message: { role: "user", content: [{ type: "text", text }] },
        },
        { type: "api-request", id: "request", keep: 0, tail: ["blob"] },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n"),
    );
  }
  const allocations = [];
  for (const account of ["primary", "secondary"])
    allocations.push(
      await contextAllocation({
        ...primary,
        claudeAccount: account,
        sessionId: "same-session",
        context: { used: 100, max: 1000 },
      } as any),
    );
  assert.equal(allocations[0].categories.find((c) => c.id === "messages")?.tokens, 1);
  assert.equal(
    allocations[1].categories.find((c) => c.id === "messages")?.tokens,
    12,
    "Same session ID resolves within each account, including cached paths.",
  );
  console.log(
    "PASS account integration: persisted migration, native fork/resume isolation, spawn auth, separate quota, profile-specific context",
  );
} finally {
  threads.shutdown();
  for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
  Object.assign(process.env, before);
  fs.rmSync(home, { recursive: true, force: true });
}

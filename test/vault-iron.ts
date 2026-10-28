// Vault + iron: managed keys go to iron over a stub ssh and the env file only ever holds the proxy token.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-iron-"));
const conf = path.join(dir, ".config", "agent-console");
fs.mkdirSync(conf, { recursive: true });
process.env.VAULT_HOME = dir;
process.env.STUB_DIR = dir;
process.env.VAULT_IRON_SSH = path.join(import.meta.dirname, "vault-iron-stub.sh");

// stub that also speaks provider-add and ca-pem (the shared sh stub predates them)
const PEM = "-----BEGIN CERTIFICATE-----\nTUlJRkFLRQ==\n-----END CERTIFICATE-----";
const addStub = path.join(dir, "stub-add.mjs");
fs.writeFileSync(
  addStub,
  `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const d = process.env.STUB_DIR, [verb, name] = process.argv.slice(2);
if (fs.existsSync(path.join(d, "down"))) process.exit(255);
fs.appendFileSync(path.join(d, "argv.log"), process.argv.slice(2).join(" ") + "\\n");
const stdin = () => fs.readFileSync(0, "utf8");
const token = fs.readFileSync(path.join(d, "token"), "utf8").trim();
if (verb === "set" && fs.existsSync(path.join(d, "failset"))) process.exit(1);
if (verb === "status") process.stdout.write(fs.readFileSync(path.join(d, "status")));
else if (verb === "token") console.log(token);
else if (verb === "ca-pem") console.log(fs.readFileSync(path.join(d, "ca.pem"), "utf8").trim());
else if (verb === "set") { fs.writeFileSync(path.join(d, "stdin.log"), stdin()); console.log("ok " + name); }
else if (verb === "provider-add") {
  if (fs.existsSync(path.join(d, "failadd"))) process.exit(1);
  const raw = stdin();
  fs.writeFileSync(path.join(d, "stdin-add.log"), raw);
  const spec = JSON.parse(raw);
  const row = { name: spec.name, envVars: spec.envVars, set: false, tokenSha: crypto.createHash("sha256").update(token).digest("hex"),
    hosts: spec.rules.map((r) => r.host), paths: spec.rules.flatMap((r) => r.paths), header: spec.header };
  fs.appendFileSync(path.join(d, "status"), JSON.stringify(row) + "\\n");
  console.log("ok " + spec.name);
} else process.exit(2);
`,
  { mode: 0o755 },
);
fs.writeFileSync(path.join(dir, "ca.pem"), PEM + "\n");
const pin = path.join(dir, "pin.sh");
fs.writeFileSync(pin, `#!/bin/sh\necho pinned >> "${dir}/pin.log"\n`, {
  mode: 0o755,
});
process.env.VAULT_EGRESS_PIN = pin;

// doctor and backup stubs: counters and failure switches live in the temp dir
const doctorStub = path.join(dir, "doctor-stub.sh");
fs.writeFileSync(
  doctorStub,
  `#!/bin/sh
d="${dir}"
n=$(cat "$d/doctor.count" 2>/dev/null || echo 0); echo $((n+1)) > "$d/doctor.count"
echo '{"check":"ssh","result":"pass"}'
echo '{"check":"service","result":"pass"}'
echo '{"check":"listener","result":"pass"}'
echo '{"check":"token","result":"pass"}'
if [ -e "$d/live-fail" ]; then echo "{\\"check\\":\\"live\\",\\"result\\":\\"fail\\",\\"http\\":\\"$(cat "$d/live-fail")\\"}"; exit 0; fi
echo '{"check":"live","result":"pass"}'
`,
  { mode: 0o755 },
);
const backupStub = path.join(dir, "backup-stub.sh");
fs.writeFileSync(
  backupStub,
  `#!/bin/sh
d="${dir}"
n=$(cat "$d/backup.count" 2>/dev/null || echo 0); echo $((n+1)) > "$d/backup.count"
echo "stub log text that must never be streamed"
[ -e "$d/slow" ] && sleep 1
for s in backup_fetch drive_upload drive_verify drive_prune backup; do
  echo "{\\"step\\":\\"$s\\",\\"state\\":\\"running\\"}"
  echo "{\\"step\\":\\"$s\\",\\"state\\":\\"ok\\"}"
done
`,
  { mode: 0o755 },
);
process.env.VAULT_DOCTOR_BIN = doctorStub;
process.env.VAULT_BACKUP_CMD = backupStub;

const sha = (v: string) => crypto.createHash("sha256").update(v).digest("hex");
const TOKEN = "proxy-token-FAKE-0123456789abcdef";
const REALKEY = "sk-real-FAKE-secret-value-9876543210";
const OTHER = "plain-other-value-FAKE-1234";
const envFile = path.join(conf, "env");
const text = () => fs.readFileSync(envFile, "utf8");
const rd = (n: string) =>
  fs.existsSync(path.join(dir, n)) ? fs.readFileSync(path.join(dir, n), "utf8") : "";
const status = (tokenSha: string) =>
  fs.writeFileSync(
    path.join(dir, "status"),
    JSON.stringify({
      name: "deepseek",
      envVars: ["DEEPSEEK_API_KEY", "DEEPAEEK_API_KEY", "DEEPSEEK_NEFRO_DEV"],
      set: true,
      mtime: "2026-10-26T00:00:00Z",
      tokenSha,
    }) + "\n",
  );
fs.writeFileSync(path.join(dir, "token"), TOKEN + "\n");
status(sha(TOKEN));
fs.writeFileSync(
  path.join(conf, "vault-sources.json"),
  JSON.stringify({
    sources: [{ type: "env", path: "~/.config/agent-console/env" }],
  }),
);
const initial = `DEEPSEEK_API_KEY=${REALKEY}\nDEEPAEEK_API_KEY=old-alias-FAKE-value-1\nDEEPSEEK_NEFRO_DEV=old-alias-FAKE-value-2\nOPENAI_API_KEY=${OTHER}\n`;
fs.writeFileSync(envFile, initial, { mode: 0o600 });

const { sources, listVault, checkValue, setSecret, deleteSecret, addIronProvider } = await import(
  "../server/vault.ts"
);
const { resumeJob } = await import("../server/vault-save-job.ts");
const { ironForget, ironStatus, ironProviderAdd, ironCaPem } = await import(
  "../server/vault-iron.ts"
);
const id = sources()[0].id;
const entries = async () => (await listVault()).sources[0].entries as any[];
const proxyOf = async (k: string) => (await entries()).find((e) => e.key === k)?.proxy;

try {
  // classification before: managed keys hold a real key
  assert.ok(await ironStatus());
  assert.equal(await proxyOf("DEEPSEEK_API_KEY"), "real-key");
  assert.equal(
    await proxyOf("DEEPSEEK_NEFRO_DEV"),
    "real-key",
    "managed alias shows despite a non-secret name",
  );
  assert.equal(await proxyOf("OPENAI_API_KEY"), "unproxied");
  assert.ok(!JSON.stringify(await listVault()).includes(REALKEY), "list carries no values");

  // token pasted as a value is refused
  assert.throws(() => checkValue(TOKEN), /proxy token/);
  assert.equal(checkValue(OTHER), OTHER);

  // managed set: value on stdin only, file holds the token in both aliases
  const res = await setSecret(id, "DEEPSEEK_API_KEY", REALKEY);
  assert.equal((res as any).proxied, true);
  assert.ok(!JSON.stringify(res).includes(REALKEY), "response has no value");
  assert.equal(rd("stdin.log"), REALKEY);
  assert.ok(!rd("argv.log").includes(REALKEY), "argv has no value");
  assert.match(rd("argv.log"), /^set deepseek$/m);
  assert.ok(!text().includes(REALKEY));
  assert.match(text(), new RegExp(`^DEEPSEEK_API_KEY=${TOKEN}$`, "m"));
  assert.match(text(), new RegExp(`^DEEPAEEK_API_KEY=${TOKEN}$`, "m"));
  assert.match(text(), new RegExp(`^OPENAI_API_KEY=${OTHER}$`, "m"));
  assert.equal(await proxyOf("DEEPSEEK_API_KEY"), "proxied");

  // already a token: file untouched
  const before = fs.statSync(envFile).mtimeMs,
    body = text();
  await setSecret(id, "DEEPAEEK_API_KEY", REALKEY);
  assert.equal(text(), body);
  assert.equal(fs.statSync(envFile).mtimeMs, before);

  // delete of a managed key is refused
  await assert.rejects(deleteSecret(id, "DEEPSEEK_API_KEY"), /use iron off/);
  assert.equal(text(), body);

  // iron unreachable: 502, file byte-identical, no plaintext fallback
  fs.writeFileSync(envFile, initial, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "down"), "");
  ironForget();
  for (const key of ["DEEPSEEK_API_KEY", "OPENROUTER_API_KEY"]) {
    await assert.rejects(
      setSecret(id, key, REALKEY),
      (e: any) => e.status === 502 && /iron unreachable/.test(e.message),
    );
    assert.equal(text(), initial);
  }
  await assert.rejects(deleteSecret(id, "DEEPSEEK_API_KEY"), /use iron off/);
  fs.rmSync(path.join(dir, "down"));
  ironForget();

  // unmanaged key keeps today's behaviour
  const r2 = await setSecret(id, "OPENAI_API_KEY", "new-plain-FAKE-value-5555");
  assert.equal((r2 as any).proxied, undefined);
  assert.match(text(), /^OPENAI_API_KEY=new-plain-FAKE-value-5555$/m);
  assert.ok(!rd("argv.log").includes("OPENAI"), "unmanaged key never goes to iron");
  await deleteSecret(id, "OPENAI_API_KEY");
  assert.ok(!text().includes("OPENAI_API_KEY"));

  // ---- add a provider: spec on stdin only, token in every alias, nothing real on disk
  process.env.VAULT_IRON_SSH = addStub;
  ironForget();
  const spec = {
    name: "CLOUDFLARE_API_TOKEN",
    envVars: ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN"],
    rules: [{ host: "api.cloudflare.com", paths: ["/client/v4/*"] }],
    header: "Authorization",
    prefix: "cf-px-",
  };
  const CF = "cf-real-FAKE-secret-4242424242";
  fs.writeFileSync(envFile, initial, { mode: 0o600 });
  const argvBefore = rd("argv.log");

  // invalid specs and values never reach ssh
  for (const bad of [
    { ...spec, rules: [{ host: "evil.nefro.dev", paths: ["/a"] }] },
    { ...spec, name: "lower" },
    { ...spec, envVars: ["DEEPSEEK_API_KEY"] },
    { ...spec, rules: [{ host: "api.cloudflare.com", paths: ["/*"] }] },
    null,
  ])
    await assert.rejects(addIronProvider(bad, CF), (e: any) => e.status === 400);
  await assert.rejects(addIronProvider(spec, TOKEN), (e: any) => e.status === 400);
  assert.equal(
    rd("argv.log")
      .slice(argvBefore.length)
      .replace(/^status\n/gm, ""),
    "",
    "only status reads reached ssh",
  );

  // iron refuses the provider: no env change, no value sent
  fs.writeFileSync(path.join(dir, "failadd"), "");
  await assert.rejects(addIronProvider(spec, CF), (e: any) => e.status === 502);
  fs.rmSync(path.join(dir, "failadd"));
  assert.equal(text(), initial);
  assert.ok(!rd("argv.log").includes(CF));

  const added = await addIronProvider(spec, CF);
  assert.deepEqual((added as any).hosts, ["api.cloudflare.com"]);
  assert.deepEqual((added as any).warnings, []);
  assert.ok(!JSON.stringify(added).includes(CF));
  assert.deepEqual(JSON.parse(rd("stdin-add.log")), spec, "spec arrives on stdin");
  assert.ok(!rd("argv.log").includes("cf-px-"), "spec is not in argv");
  assert.match(rd("argv.log"), /^provider-add CLOUDFLARE_API_TOKEN$/m);
  assert.equal(rd("stdin.log"), CF);
  assert.ok(!text().includes(CF));
  assert.match(text(), new RegExp(`^CLOUDFLARE_API_TOKEN=${TOKEN}$`, "m"));
  assert.match(text(), new RegExp(`^CF_API_TOKEN=${TOKEN}$`, "m"));
  assert.equal(
    fs.readFileSync(path.join(conf, "egress-hosts.txt"), "utf8"),
    "api.cloudflare.com\n",
  );
  const caFile = path.join(conf, "egress-ca.pem");
  assert.equal(fs.readFileSync(caFile, "utf8"), PEM + "\n");
  assert.equal(fs.statSync(caFile).mode & 0o777, 0o644);
  assert.match(rd("pin.log"), /pinned/);
  const audit = fs.readFileSync(path.join(conf, "vault-audit.jsonl"), "utf8");
  assert.match(audit, /add-provider/);
  assert.match(audit, /api\.cloudflare\.com/);
  assert.ok(!audit.includes(CF));

  // already managed now: a second add is a clash; status carries the new fields
  await assert.rejects(addIronProvider(spec, CF), (e: any) => e.status === 400);
  ironForget();
  assert.deepEqual((await ironStatus())?.get("CF_API_TOKEN")?.hosts, ["api.cloudflare.com"]);
  assert.equal((await ironStatus())?.get("CF_API_TOKEN")?.header, "Authorization");
  assert.equal(await ironCaPem(), PEM + "\n");

  // egress failure is a warning, not a rollback
  process.env.VAULT_EGRESS_PIN = "/bin/false";
  fs.rmSync(path.join(dir, "ca.pem"));
  const spec2 = {
    ...spec,
    name: "OTHER_PROVIDER_KEY",
    envVars: ["OTHER_PROVIDER_KEY"],
  };
  const w = await addIronProvider(spec2, CF);
  assert.equal((w as any).warnings.length, 2);
  assert.match(text(), new RegExp(`^OTHER_PROVIDER_KEY=${TOKEN}$`, "m"));
  assert.equal(await ironProviderAdd({ ...spec2, name: "bad name" }), false);

  // ---- live save steps (NDJSON contract): env points the stubs at the temp dir
  const count = (name: string) => Number(rd(name) || 0);
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const untilTrue = async (test: () => boolean) => {
    for (let i = 0; i < 150 && !test(); i++) await sleep(20);
    assert.ok(test(), "condition reached in time");
  };
  const collect = (start: (sink: (msg: any) => void) => Promise<unknown>) =>
    new Promise<any[]>((resolve, reject) => {
      const msgs: any[] = [];
      start((msg) => {
        msgs.push(msg);
        if (msg.t === "done" || msg.t === "error") resolve(msgs);
      }).catch(reject);
    });
  const shape = (msgs: any[]) => msgs.map((m) => (m.id ? `${m.t}:${m.id}` : m.t)).join(" ");
  const BACKUP_ALL = "backup_fetch drive_upload drive_verify drive_prune";
  const streamed: any[] = [];
  const snapshots: any[] = [];
  const snap = async () => {
    const job = (await listVault()).ironJob;
    snapshots.push(job);
    return job as any;
  };
  fs.writeFileSync(envFile, initial, { mode: 0o600 });
  process.env.VAULT_IRON_SSH = path.join(import.meta.dirname, "vault-iron-stub.sh");
  ironForget();
  const replace = (sink: (msg: any) => void) =>
    setSecret(id, "DEEPSEEK_API_KEY", REALKEY, undefined, sink);

  // happy path: plan first, then each step once, done last
  assert.equal((await listVault()).ironJob, null);
  const happy = await collect(replace);
  streamed.push(...happy);
  assert.equal(happy[0].t, "plan");
  assert.deepEqual(
    happy[0].steps.map((x: any) => x.id),
    ["set", "proxy", "check", ...BACKUP_ALL.split(" ")],
  );
  assert.ok(happy.every((m) => typeof m.at === "number"));
  const steps = (ids: string) =>
    ids
      .split(" ")
      .map((x) => `step:${x} ok:${x}`)
      .join(" ");
  assert.equal(shape(happy), `plan ${steps(`set proxy check ${BACKUP_ALL}`)} done`);
  assert.deepEqual(happy.at(-1), { t: "done", ok: true, restartNeeded: true, at: happy.at(-1).at });
  assert.equal(count("backup.count"), 1);
  assert.equal((await snap()).ok, true);

  // failed check: no backup ran, snapshot shows the failed step with a table error
  fs.writeFileSync(path.join(dir, "live-fail"), "401");
  const bad = await collect(replace);
  streamed.push(...bad);
  assert.equal(shape(bad), "plan step:set ok:set step:proxy ok:proxy step:check fail:check done");
  assert.equal(bad.find((m) => m.t === "fail").error, "Provider rejected the key (HTTP 401)");
  assert.deepEqual({ ok: bad.at(-1).ok, retry: bad.at(-1).retry }, { ok: false, retry: "verify" });
  assert.equal(count("backup.count"), 1, "backup never ran after a failed check");
  const failedJob = await snap();
  assert.equal(failedJob.steps.find((x: any) => x.id === "check").state, "fail");
  assert.equal(failedJob.retry, "verify");

  // retry resumes after the set step: iron is not called again, backup runs once
  fs.rmSync(path.join(dir, "live-fail"));
  const setsBefore = (rd("argv.log").match(/^set /gm) ?? []).length;
  const resumed = await collect(async (sink) => assert.equal(resumeJob(sink), "started"));
  streamed.push(...resumed);
  assert.equal(
    shape(resumed),
    `plan ok:set step:proxy ok:proxy step:check ok:check ${steps(BACKUP_ALL)} done`,
  );
  assert.equal((rd("argv.log").match(/^set /gm) ?? []).length, setsBefore);
  assert.equal(count("backup.count"), 2);
  assert.equal(
    resumeJob(() => {}),
    "none",
    "nothing left to retry after success",
  );

  // failed set stops everything and asks for a new save
  fs.writeFileSync(path.join(dir, "failset"), "");
  const doctorRuns = count("doctor.count");
  const noSet = await collect(replace);
  streamed.push(...noSet);
  assert.equal(shape(noSet), "plan step:set fail:set done");
  assert.deepEqual({ ok: noSet.at(-1).ok, retry: noSet.at(-1).retry }, { ok: false, retry: "set" });
  assert.equal(noSet[2].error, "iron set failed");
  assert.equal(count("doctor.count"), doctorRuns);
  assert.equal(count("backup.count"), 2);
  assert.equal(
    resumeJob(() => {}),
    "none",
    "a failed set cannot be resumed",
  );
  fs.rmSync(path.join(dir, "failset"));

  // second save while one runs: 409; the first job survives a client that vanished
  fs.writeFileSync(path.join(dir, "slow"), "");
  let seen = 0;
  const first = replace(() => {
    seen++;
    if (seen > 3) throw new Error("client gone");
  });
  await untilTrue(() => seen > 3);
  await assert.rejects(
    setSecret(id, "DEEPSEEK_API_KEY", REALKEY, undefined, () => {}),
    (e: any) => e.status === 409 && e.message === "Another key save is still running.",
  );
  await assert.rejects(
    addIronProvider(
      { ...spec, name: "BUSY_KEY_TOKEN", envVars: ["BUSY_KEY_TOKEN"] },
      CF,
      undefined,
      () => {},
    ),
    (e: any) => e.status === 409,
  );
  await first;
  await untilTrue(() => count("backup.count") === 3);
  let finalJob: any;
  for (let i = 0; i < 100; i++) {
    finalJob = await snap();
    if (!finalJob.running) break;
    await sleep(30);
  }
  assert.equal(finalJob.ok, true, "job finished without its client");
  fs.rmSync(path.join(dir, "slow"));

  // add key with iron: provider, set, pins stream first; egress failure is a warning
  const spec3 = { ...spec, name: "STREAMED_KEY_TOKEN", envVars: ["STREAMED_KEY_TOKEN"] };
  process.env.VAULT_IRON_SSH = addStub;
  ironForget();
  const addMsgs = await collect((sink) => addIronProvider(spec3, CF, undefined, sink));
  streamed.push(...addMsgs);
  assert.deepEqual(addMsgs[0].steps.map((x: any) => x.id).slice(0, 5), [
    "provider",
    "set",
    "pins",
    "proxy",
    "check",
  ]);
  assert.equal(shape(addMsgs), `plan ${steps(`provider set pins proxy check ${BACKUP_ALL}`)} done`);
  assert.equal(addMsgs.at(-1).warnings.length, 2);
  assert.equal(count("backup.count"), 4);

  // JSON path (no progress): no job, backup stays debounced
  process.env.VAULT_IRON_SSH = path.join(import.meta.dirname, "vault-iron-stub.sh");
  process.env.VAULT_BACKUP_DEBOUNCE_MS = "300";
  ironForget();
  const beforeJson = count("backup.count");
  const jsonRes = await setSecret(id, "DEEPSEEK_API_KEY", REALKEY);
  assert.equal((jsonRes as any).proxied, true);
  assert.equal(count("backup.count"), beforeJson, "not backed up at once");
  await untilTrue(() => count("backup.count") === beforeJson + 1);

  // no value anywhere a client or a log could see it
  const stateDir = path.join(dir, ".local", "state", "agent-console");
  const sinks = [
    JSON.stringify(streamed),
    JSON.stringify(snapshots),
    fs.readFileSync(path.join(conf, "vault-audit.jsonl"), "utf8"),
    fs.readFileSync(path.join(stateDir, "iron-backup.log"), "utf8"),
  ].join("\n");
  for (const secret of [REALKEY, CF]) assert.ok(!sinks.includes(secret), "no value leaked");
  assert.ok(
    !JSON.stringify([streamed, snapshots]).includes("stub log text"),
    "command output is never streamed",
  );
  assert.ok(streamed.length > 40);
  console.log("PASS  vault iron");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

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
      envVars: ["DEEPSEEK_API_KEY", "DEEPAEEK_API_KEY"],
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
const initial = `DEEPSEEK_API_KEY=${REALKEY}\nDEEPAEEK_API_KEY=old-alias-FAKE-value-1\nOPENAI_API_KEY=${OTHER}\n`;
fs.writeFileSync(envFile, initial, { mode: 0o600 });

const { sources, listVault, checkValue, setSecret, deleteSecret, addIronProvider } = await import(
  "../server/vault.ts"
);
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
  console.log("PASS  vault iron");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

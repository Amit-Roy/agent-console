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
  JSON.stringify({ sources: [{ type: "env", path: "~/.config/agent-console/env" }] }),
);
const initial = `DEEPSEEK_API_KEY=${REALKEY}\nDEEPAEEK_API_KEY=old-alias-FAKE-value-1\nOPENAI_API_KEY=${OTHER}\n`;
fs.writeFileSync(envFile, initial, { mode: 0o600 });

const { sources, listVault, checkValue, setSecret, deleteSecret } = await import(
  "../server/vault.ts"
);
const { ironForget, ironStatus } = await import("../server/vault-iron.ts");
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
  console.log("PASS  vault iron");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

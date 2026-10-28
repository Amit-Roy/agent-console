// Vault doctor: contract parsing, per-check failures, junk and timeout handling, no stub text leaks.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-doctor-"));
const out = path.join(dir, "out");
const argvFile = path.join(dir, "argv");
process.env.VAULT_DOCTOR_BIN = path.resolve("test/vault-doctor-stub.sh");
process.env.STUB_OUT = out;
process.env.STUB_ARGV = argvFile;
const { providerCheck } = await import("../server/vault-doctor.ts");

const row = (check: string, result: string, http?: string) =>
  JSON.stringify({ check, result, ...(http ? { http } : {}) });
const run = async (lines: string[], exit = 0) => {
  fs.writeFileSync(out, `${lines.join("\n")}\n`);
  process.env.STUB_EXIT = String(exit);
  return providerCheck("openai");
};
const pass = ["ssh", "service", "listener", "token", "live"].map((id) => row(id, "pass"));
const swap = (id: string, line: string) => pass.map((l) => (l.includes(`"${id}"`) ? line : l));

try {
  assert.deepEqual(await run(pass), { proxy: { ok: true }, check: { ok: true } });
  assert.equal(fs.readFileSync(argvFile, "utf8").trim(), "doctor --only openai --json");

  for (const id of ["ssh", "service", "listener"]) {
    const res = await run(swap(id, row(id, "fail")), 1);
    assert.deepEqual(res.proxy, { ok: false, code: id });
  }
  assert.deepEqual((await run(swap("token", row("token", "fail")), 1)).check, {
    ok: false,
    code: "token",
  });
  assert.deepEqual((await run(swap("live", row("live", "fail", "401")), 1)).check, {
    ok: false,
    code: "live",
    http: "401",
  });
  assert.deepEqual((await run(swap("live", row("live", "fail", "none")), 1)).check, {
    ok: false,
    code: "live",
    http: "none",
  });
  const badHttp = await run(swap("live", row("live", "fail", "4x1; rm")), 1);
  assert.deepEqual(badHttp.check, { ok: false, code: "live" });
  assert.deepEqual((await run(swap("live", row("live", "skip")))).check, { skip: true });

  // junk output: failure, and none of the stub text appears in the result
  const secret = "STUB-SECRET-TEXT";
  const junk = await run([secret, "{not json", row("bogus", "pass"), row("ssh", "maybe")]);
  assert.equal(junk.proxy.ok, false);
  assert.equal("ok" in junk.check && junk.check.ok, false);
  assert.ok(!JSON.stringify(junk).includes(secret));
  const mixed = await run([secret, ...pass]);
  assert.deepEqual(mixed, { proxy: { ok: true }, check: { ok: true } });

  // invalid name never spawns
  fs.rmSync(argvFile, { force: true });
  const bad = await providerCheck("bad name; id");
  assert.equal(bad.proxy.ok, false);
  assert.ok(!fs.existsSync(argvFile));

  // timeout
  process.env.VAULT_DOCTOR_TIMEOUT_MS = "200";
  process.env.STUB_SLEEP = "30";
  const slow = await run(pass);
  assert.equal(slow.proxy.ok, false);
  assert.equal("ok" in slow.check && slow.check.ok, false);
  console.log("vault-doctor ok");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}

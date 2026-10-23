// Vault API: env/single/github sources, write-only lists, passkey step-up, viewable rows + alert. Temp dirs and fake values only.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import express from "express";
import { isoCBOR, isoBase64URL } from "@simplewebauthn/server/helpers";
import { mountVault } from "../server/vault.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
const conf = path.join(dir, ".config", "agent-console");
fs.mkdirSync(conf, { recursive: true });
fs.mkdirSync(path.join(dir, ".config", "agentmail"), { recursive: true });
fs.mkdirSync(path.join(dir, ".aws"), { recursive: true });
process.env.VAULT_HOME = dir;

const REAL = "sk-test-0123456789abcdefghijklmnopqrstuvwxyz";   // 44 chars, fake
const SHORT = "fake-short-1";
const NEWV = "fake-replacement-value-AAAA1111BBBB2222";
const GHV = "fake-gh-secret-value-ZZZZ9999";
const DECOY_ID = "AKIAFAKEDECOY000001", DECOY_SECRET = "fakeDecoySecretKey/0123456789abcdefABCDEF";

const envFile = path.join(conf, "env");
fs.writeFileSync(envFile, `# agent console env\nexport OPENAI_API_KEY="${REAL}"\n\nPLAIN_KEY=${SHORT}  # inline note\nQUOTED='single q'\n# trailing comment\n`, { mode: 0o600 });
const keyFile = path.join(conf, "tool.key");
fs.writeFileSync(keyFile, "fake-single-file-value\n", { mode: 0o600 });
fs.writeFileSync(path.join(dir, ".aws", "credentials"), `[default]\naws_access_key_id = OTHER\n\n[backup-admin]\naws_access_key_id = ${DECOY_ID}\naws_secret_access_key = ${DECOY_SECRET}\nregion = us-east-1\n`, { mode: 0o600 });
fs.writeFileSync(path.join(conf, "vault-sources.json"), JSON.stringify({
  sources: [{ type: "env", path: "~/.config/agent-console/env" }, { type: "single", path: "~/.config/agent-console/*.key" }, { type: "github", repo: "acme/widgets" }, { type: "decoy", path: "~/.aws/credentials", profile: "backup-admin" }],
}));
fs.writeFileSync(path.join(dir, ".config", "agentmail", "env"), "AGENTMAIL_API_KEY=fake-mail-key\nAGENTMAIL_INBOX=box@example.test\n");

// fake gh: records argv and stdin
const ghLog = path.join(dir, "gh.log"), ghIn = path.join(dir, "gh.stdin");
const fakeGh = path.join(dir, "gh");
fs.writeFileSync(fakeGh, `#!/bin/sh
echo "$@" >> "${ghLog}"
cat > "${ghIn}"
case "$1 $2" in
  "secret list") echo '[{"name":"DEPLOY_TOKEN","updatedAt":"2026-10-20T10:00:00Z"}]' ;;
  *) ;;
esac
`, { mode: 0o755 });
process.env.VAULT_GH_BIN = fakeGh;

// fake mail API
const mails: any[] = [];
let onMail: (() => void) | null = null;
const mailSrv = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { mails.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) }); res.end("{}"); onMail?.(); });
}).listen(0);
process.env.VAULT_ALERT_BASE = `http://127.0.0.1:${(mailSrv.address() as any).port}`;
const nextMail = () => new Promise<any>((resolve, reject) => { const t = setTimeout(() => reject(new Error("no mail")), 3000); onMail = () => { clearTimeout(t); resolve(mails[mails.length - 1]); }; });

const sameOrigin: express.RequestHandler = (req, res, next) => {
  try { if (new URL(String(req.headers.origin)).host === req.headers.host) return next(); } catch {}
  res.status(403).json({ error: "Cross-site request refused." });
};
const app = express();
const hooks = mountVault(app, sameOrigin);
const server = http.createServer(app).listen(0);
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const api = async (method: string, p: string, body?: unknown, cookie = "", origin = base) => {
  const r = await fetch(`${base}/api/vault${p}`, { method, headers: { origin, cookie, "content-type": "application/json", "user-agent": "vault-test/1.0" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return {}; } })(), cookie: (r.headers.getSetCookie?.()[0] || "").split(";")[0] };
};

// software passkey (ES256, "none" attestation)
const kp = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = kp.publicKey.export({ format: "jwk" }) as any;
const credId = crypto.randomBytes(16);
const rpHash = crypto.createHash("sha256").update("127.0.0.1").digest();
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
let counter = 0;
const clientData = (type: string, challenge: string) => Buffer.from(JSON.stringify({ type, challenge, origin: base }));
const register = (options: any) => {
  const cose = Buffer.from(isoCBOR.encode(new Map<any, any>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]])));
  const authData = Buffer.concat([rpHash, Buffer.from([0x45]), u32(0), Buffer.alloc(16), Buffer.from([0, credId.length]), credId, cose]);
  const att = Buffer.from(isoCBOR.encode(new Map<any, any>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]])));
  return { id: isoBase64URL.fromBuffer(credId), rawId: isoBase64URL.fromBuffer(credId), type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: clientData("webauthn.create", options.challenge).toString("base64url"), attestationObject: att.toString("base64url"), transports: ["internal"] } };
};
const assertion = (options: any, goodSig = true) => {
  const cd = clientData("webauthn.get", options.challenge);
  const authData = Buffer.concat([rpHash, Buffer.from([0x05]), u32(++counter)]);
  const signed = Buffer.concat([authData, crypto.createHash("sha256").update(cd).digest()]);
  const sig = goodSig ? crypto.sign("sha256", signed, kp.privateKey) : crypto.sign("sha256", Buffer.from("other"), kp.privateKey);
  return { id: isoBase64URL.fromBuffer(credId), rawId: isoBase64URL.fromBuffer(credId), type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: cd.toString("base64url"), authenticatorData: authData.toString("base64url"), signature: sig.toString("base64url") } };
};
const stepUp = async (goodSig = true) => {
  const o = await api("POST", "/stepup/options");
  assert.equal(o.status, 200);
  return api("POST", "/stepup/verify", { cid: o.json.cid, response: assertion(o.json.options, goodSig) });
};

const list = async () => (await api("GET", "")).json.sources as any[];
const text = (f: string) => fs.readFileSync(f, "utf8");
try {
  // ---- no grant, no write
  let r = await api("PUT", `/${"x".repeat(12)}/OPENAI_API_KEY`, { value: "v" });
  assert.equal(r.status, 401); assert.equal(r.json.stepUp, true, "write without a grant is 401 stepUp");
  r = await api("DELETE", `/${"x".repeat(12)}/OPENAI_API_KEY`);
  assert.equal(r.status, 401, "delete without a grant is 401");

  // ---- list: metadata only, never a value
  r = await api("GET", "");
  const srcs = r.json.sources as any[];
  assert.deepEqual(srcs.map((s) => s.label), ["agent-console/env", "agent-console/tool.key", "GitHub · acme/widgets", "AWS · backup-admin"]);
  const envSrc = srcs[0];
  const oai = envSrc.entries.find((e: any) => e.key === "OPENAI_API_KEY");
  assert.equal(oai.length, REAL.length); assert.equal(oai.hint, REAL.slice(-4)); assert.equal(oai.hash.length, 8);
  assert.equal(envSrc.entries.find((e: any) => e.key === "PLAIN_KEY").hint, null, "no hint under 24 chars");
  assert.equal(envSrc.entries.find((e: any) => e.key === "PLAIN_KEY").length, SHORT.length, "inline comment excluded from the value");
  assert.equal(envSrc.entries.find((e: any) => e.key === "QUOTED").length, "single q".length);
  for (const secret of [REAL, SHORT, "fake-single-file-value", DECOY_SECRET, DECOY_ID]) {
    assert.ok(!r.text.includes(secret), `list never carries ${secret.slice(0, 8)}`);
  }
  const ghSrc = srcs[2];
  assert.deepEqual(ghSrc.entries.map((e: any) => e.key), ["DEPLOY_TOKEN"]);
  assert.ok(!/decoy|canary/i.test(r.text), "API never names the viewable group");

  // ---- sameOrigin
  r = await api("PUT", `/${envSrc.id}/OPENAI_API_KEY`, { value: NEWV }, "", "https://evil.example");
  assert.equal(r.status, 403, "PUT refuses cross-site");
  assert.equal((await api("DELETE", `/${envSrc.id}/OPENAI_API_KEY`, undefined, "", "https://evil.example")).status, 403, "DELETE refuses cross-site");
  assert.equal((await api("POST", "/stepup/options", undefined, "", "https://evil.example")).status, 403);

  // ---- enrollment needs the one-time code
  assert.equal((await api("GET", "/passkeys")).json.enrolled, 0);
  const codeFile = path.join(conf, "vault-enroll-code");
  assert.equal(fs.statSync(codeFile).mode & 0o777, 0o600, "enrollment code file is 0600");
  assert.equal((await api("POST", "/stepup/options")).status, 409, "no passkey yet");
  const badFirst = nextMail();
  r = await api("POST", "/passkeys/register/options", {});
  assert.equal(r.status, 403, "enrollment without the code is rejected");
  r = await api("POST", "/passkeys/register/options", { code: "00000000" });
  assert.equal(r.status, 403, "wrong code is rejected");
  const failMail = await badFirst;
  assert.equal(failMail.body.subject, "[Agent Console] vault passkey failed");
  const code = text(codeFile).trim();
  r = await api("POST", "/passkeys/register/options", { code });
  assert.equal(r.status, 200);
  const reg = await api("POST", "/passkeys/register/verify", { cid: r.json.cid, response: register(r.json.options), name: "Test phone" });
  assert.equal(reg.status, 200, reg.text); assert.ok(reg.cookie.startsWith("vault_grant="), "enrollment opens a grant");
  assert.ok(!fs.existsSync(codeFile), "code is spent");
  const reuse = await api("POST", "/passkeys/register/verify", { cid: r.json.cid, response: register(r.json.options) });
  assert.equal(reuse.status, 400, "challenge cannot be reused");
  assert.equal(fs.statSync(path.join(conf, "vault-passkeys.json")).mode & 0o777, 0o600);
  assert.ok(!text(path.join(conf, "vault-passkeys.json")).includes(jwk.d || "nope"));
  let pks = (await api("GET", "/passkeys")).json;
  assert.deepEqual([pks.enrolled, pks.passkeys[0].name, pks.passkeys[0].lastUsedAt], [1, "Test phone", null]);
  assert.equal((await api("POST", "/passkeys/register/options", {})).status, 401, "another passkey needs an assertion");

  // ---- step-up: failed assertion alerts (rate limited), good one grants
  hooks.resetAlertLimit();
  const m1 = nextMail();
  assert.equal((await stepUp(false)).status, 401, "bad signature rejected");
  assert.equal((await m1).body.subject, "[Agent Console] vault passkey failed");
  const n = mails.length;
  assert.equal((await stepUp(false)).status, 401);
  await new Promise((res) => setTimeout(res, 150));
  assert.equal(mails.length, n, "failed-assertion alerts: at most 1 per 10 minutes");
  const o = await api("POST", "/stepup/options");
  const good = assertion(o.json.options);
  assert.equal((await api("POST", "/stepup/verify", { cid: o.json.cid, response: good })).status, 200);
  assert.equal((await api("POST", "/stepup/verify", { cid: o.json.cid, response: assertion(o.json.options) })).status, 400, "assertion challenge is single-use");
  let g = await stepUp();
  assert.equal(g.status, 200); let grant = g.cookie;
  assert.equal(JSON.parse(text(path.join(conf, "vault-passkeys.json"))).credentials[0].counter, counter, "counter stored");

  // ---- env round trip
  r = await api("PUT", `/${envSrc.id}/OPENAI_API_KEY`, { value: NEWV }, grant);
  assert.equal(r.status, 200, r.text); assert.equal(r.json.restartNeeded, true, "agent-console's own env asks for a restart");
  assert.equal(text(envFile), `# agent console env\nexport OPENAI_API_KEY="${NEWV}"\n\nPLAIN_KEY=${SHORT}  # inline note\nQUOTED='single q'\n# trailing comment\n`, "comments, order, export and quotes preserved");
  assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(conf).filter((f) => f.includes(".vault-")), [], "no temp files left");
  r = await api("PUT", `/${envSrc.id}/PLAIN_KEY`, { value: "has space & #hash" }, grant);
  assert.match(text(envFile), /^PLAIN_KEY="has space & #hash"  # inline note$/m);
  r = await api("PUT", `/${envSrc.id}/QUOTED`, { value: "x" }, grant);
  assert.match(text(envFile), /^QUOTED='x'$/m);
  r = await api("PUT", `/${envSrc.id}/BRAND_NEW`, { value: "abc" }, grant);
  assert.ok(text(envFile).endsWith("# trailing comment\nBRAND_NEW=abc\n"), "new key appended");
  assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
  for (const [k, v] of [["OPENAI_API_KEY", "a\nb"], ["OPENAI_API_KEY", "a\0b"], ["OPENAI_API_KEY", "a".repeat(8193)], ["lower", "x"], ["1BAD", "x"], ["A-B", "x"], ["OPENAI_API_KEY", ""]] as const) {
    assert.equal((await api("PUT", `/${envSrc.id}/${k}`, { value: v }, grant)).status, 400, `rejects ${JSON.stringify(k)} / ${v.length} chars`);
  }
  assert.equal((await api("PUT", `/${envSrc.id}/OPENAI_API_KEY`, "{bad", grant)).status, 400);
  assert.ok(!text(envFile).includes("a\nb"));

  // ---- expired grant
  hooks.expireGrants();
  r = await api("PUT", `/${envSrc.id}/BRAND_NEW`, { value: "zzz" }, grant);
  assert.equal(r.status, 401, "expired grant is rejected");
  grant = (await stepUp()).cookie;

  // ---- delete is single-use
  r = await api("DELETE", `/${envSrc.id}/BRAND_NEW`, undefined, grant);
  assert.equal(r.status, 200); assert.ok(!text(envFile).includes("BRAND_NEW"));
  assert.equal((await api("DELETE", `/${envSrc.id}/PLAIN_KEY`, undefined, grant)).status, 401, "a delete grant cannot be reused");
  grant = (await stepUp()).cookie;
  assert.equal((await api("DELETE", `/${envSrc.id}/NOPE_KEY`, undefined, grant)).status, 404);

  // ---- single-value file
  const keySrc = srcs[1];
  grant = (await stepUp()).cookie;
  r = await api("PUT", `/${keySrc.id}/tool.key`, { value: NEWV }, grant);
  assert.equal(r.status, 200); assert.equal(text(keyFile), NEWV + "\n"); assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.equal(r.json.restartNeeded, undefined);
  assert.equal((await api("PUT", `/${keySrc.id}/OTHER`, { value: "x" }, grant)).status, 400, "single file holds one value");

  // ---- github: value on stdin, never argv
  r = await api("PUT", `/${ghSrc.id}/DEPLOY_TOKEN`, { value: GHV }, grant);
  assert.equal(r.status, 200, r.text);
  assert.equal(text(ghIn), GHV, "value arrived on stdin");
  assert.ok(!text(ghLog).includes(GHV), "value never in argv");
  assert.match(text(ghLog), /secret set DEPLOY_TOKEN -R acme\/widgets/);
  grant = (await stepUp()).cookie;
  assert.equal((await api("DELETE", `/${ghSrc.id}/DEPLOY_TOKEN`, undefined, grant)).status, 200);
  assert.match(text(ghLog), /secret delete DEPLOY_TOKEN -R acme\/widgets/);

  // ---- viewable group: reveal without a grant, alert has no value, no edits
  const vSrc = srcs[3];
  assert.equal(vSrc.canAdd, false);
  assert.ok(vSrc.entries.every((e: any) => e.viewable && !e.editable));
  const rev = nextMail();
  r = await api("POST", `/${vSrc.id}/aws_secret_access_key/reveal`);
  assert.equal(r.status, 200); assert.equal(r.json.value, DECOY_SECRET, "viewable rows reveal without a grant");
  const mail = await rev;
  assert.equal(mail.url, "/v0/inboxes/box%40example.test/messages/send"); assert.equal(mail.auth, "Bearer fake-mail-key");
  assert.equal(mail.body.subject, "[Agent Console] ALERT: vault decoy revealed");
  assert.deepEqual([mail.body.to, mail.body.cc], [["sunny.amit.roy@gmail.com"], ["nefro.amit.roy@gmail.com"]]);
  assert.match(mail.body.text, /Time: .*\nClient IP: .*\nUser-agent: vault-test\/1\.0\nKey: aws_secret_access_key/);
  assert.ok(!JSON.stringify(mail).includes(DECOY_SECRET) && !JSON.stringify(mail).includes(DECOY_ID), "alert never includes the value");
  assert.equal((await api("POST", `/${vSrc.id}/aws_missing/reveal`)).status, 404);
  assert.equal((await api("POST", `/${envSrc.id}/OPENAI_API_KEY/reveal`)).status, 403, "real rows never reveal");
  assert.equal((await api("POST", `/${ghSrc.id}/DEPLOY_TOKEN/reveal`)).status, 403);
  grant = (await stepUp()).cookie;
  assert.equal((await api("PUT", `/${vSrc.id}/aws_secret_access_key`, { value: "x" }, grant)).status, 403, "no replace");
  grant = (await stepUp()).cookie;
  assert.equal((await api("DELETE", `/${vSrc.id}/aws_secret_access_key`, undefined, grant)).status, 403, "no delete");
  assert.ok(text(path.join(dir, ".aws", "credentials")).includes(DECOY_SECRET));

  // ---- audit log: no values
  const audit = text(path.join(conf, "vault-audit.jsonl"));
  const lines = audit.trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.action === "set" && l.key === "OPENAI_API_KEY") && lines.some((l) => l.action === "reveal"));
  assert.ok(lines.every((l) => l.ts && l.action && "source" in l && "key" in l));
  for (const v of [REAL, NEWV, GHV, DECOY_SECRET]) assert.ok(!audit.includes(v), "audit has no values");
  assert.equal(fs.statSync(path.join(conf, "vault-audit.jsonl")).mode & 0o777, 0o600);

  // ---- passkey management needs an assertion; remove last passkey
  grant = (await stepUp()).cookie;
  pks = (await api("GET", "/passkeys")).json;
  assert.ok(pks.passkeys[0].lastUsedAt, "last used recorded");
  assert.equal((await api("DELETE", `/passkeys/${pks.passkeys[0].id}`)).status, 401, "removing a passkey needs an assertion");
  assert.equal((await api("DELETE", `/passkeys/${pks.passkeys[0].id}`, undefined, grant)).status, 200);
  assert.equal((await api("GET", "/passkeys")).json.enrolled, 0);
  console.log("PASS  vault api");
} finally {
  server.close(); mailSrv.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

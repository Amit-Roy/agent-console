// Vault API: env/single/github sources, write-only lists, passkey step-up, viewable rows + alert. Temp dirs and fake values only.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";
import express from "express";
import { mountVault } from "../server/vault.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
const conf = path.join(dir, ".config", "agent-console");
fs.mkdirSync(conf, { recursive: true });
fs.mkdirSync(path.join(dir, ".config", "agentmail"), { recursive: true });
fs.mkdirSync(path.join(dir, ".aws"), { recursive: true });
process.env.VAULT_HOME = dir;
process.env.VAULT_IRON_SSH = "/bin/false"; // never reach a real iron host from tests

const REAL = "sk-test-0123456789abcdefghijklmnopqrstuvwxyz"; // 44 chars, fake
const SHORT = "fake-short-1";
const NEWV = "fake-replacement-value-AAAA1111BBBB2222";
const GHV = "fake-gh-secret-value-ZZZZ9999";
const DECOY_ID = "AKIAFAKEDECOY000001",
  DECOY_SECRET = "fakeDecoySecretKey/0123456789abcdefABCDEF";

const envFile = path.join(conf, "env");
fs.writeFileSync(
  envFile,
  `# agent console env\nexport OPENAI_API_KEY="${REAL}"\n\nPLAIN_KEY=${SHORT}  # inline note\nQUOTED_SECRET='single q'\nDO_NOT_TRACK=1\nFEATURE_ENABLED=true\n# trailing comment\n`,
  { mode: 0o600 },
);
const keyFile = path.join(conf, "tool.key");
fs.writeFileSync(keyFile, "fake-single-file-value\n", { mode: 0o600 });
fs.writeFileSync(
  path.join(dir, ".aws", "credentials"),
  `[default]\naws_access_key_id = OTHER\n\n[backup-admin]\naws_access_key_id = ${DECOY_ID}\naws_secret_access_key = ${DECOY_SECRET}\nregion = us-east-1\n`,
  { mode: 0o600 },
);
fs.writeFileSync(
  path.join(conf, "vault-sources.json"),
  JSON.stringify({
    sources: [
      { type: "env", path: "~/.config/agent-console/env" },
      { type: "single", path: "~/.config/agent-console/*.key" },
      { type: "github", repo: "acme/widgets" },
    ],
  }),
);
const sourcesFile = path.join(conf, "vault-sources.json");
fs.mkdirSync(path.join(dir, "proj"));
fs.writeFileSync(
  path.join(dir, ".config", "agentmail", "env"),
  "AGENTMAIL_API_KEY=fake-mail-key\nAGENTMAIL_INBOX=box@example.test\n",
);

// fake gh: records argv and stdin
const ghLog = path.join(dir, "gh.log"),
  ghIn = path.join(dir, "gh.stdin");
const fakeGh = path.join(dir, "gh");
fs.writeFileSync(
  fakeGh,
  `#!/bin/sh
echo "$@" >> "${ghLog}"
cat > "${ghIn}"
case "$1 $2" in
  "secret list") echo '[{"name":"DEPLOY_TOKEN","updatedAt":"2026-10-20T10:00:00Z"}]' ;;
  "repo view") if [ "$3" = "acme/missing" ]; then exit 1; fi ;;
  *) ;;
esac
`,
  { mode: 0o755 },
);
process.env.VAULT_GH_BIN = fakeGh;

// fake mail API
const mails: any[] = [];
let onMail: (() => void) | null = null;
const mailSrv = http
  .createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      mails.push({
        url: req.url,
        auth: req.headers.authorization,
        body: JSON.parse(b),
      });
      res.end("{}");
      onMail?.();
    });
  })
  .listen(0);
process.env.VAULT_ALERT_BASE = `http://127.0.0.1:${(mailSrv.address() as any).port}`;
const nextMail = () =>
  new Promise<any>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no mail")), 3000);
    onMail = () => {
      clearTimeout(t);
      resolve(mails[mails.length - 1]);
    };
  });

const sameOrigin: express.RequestHandler = (req, res, next) => {
  try {
    if (new URL(String(req.headers.origin)).host === req.headers.host) return next();
  } catch {}
  res.status(403).json({ error: "Cross-site request refused." });
};
const app = express();
const hooks = mountVault(app, sameOrigin);
const server = http.createServer(app).listen(0);
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const api = async (method: string, p: string, body?: unknown, cookie = "", origin = base) => {
  const r = await fetch(`${base}/api/vault${p}`, {
    method,
    headers: {
      origin,
      cookie,
      "content-type": "application/json",
      "user-agent": "vault-test/1.0",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return {
    status: r.status,
    text,
    json: (() => {
      try {
        return JSON.parse(text);
      } catch {
        return {};
      }
    })(),
    cookie: (r.headers.getSetCookie?.()[0] || "").split(";")[0],
  };
};

// software passkey (ES256, "none" attestation)
const kp = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = kp.publicKey.export({ format: "jwk" }) as any;
const credId = crypto.randomBytes(16);
const rpHash = crypto.createHash("sha256").update("127.0.0.1").digest();
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
let counter = 0;
const clientData = (type: string, challenge: string) =>
  Buffer.from(JSON.stringify({ type, challenge, origin: base }));
const register = (
  options: any,
  o: { attachment?: string; transports?: string[]; flags?: number } = {},
) => {
  const cose = Buffer.from(
    isoCBOR.encode(
      new Map<any, any>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x, "base64url")],
        [-3, Buffer.from(jwk.y, "base64url")],
      ]),
    ),
  );
  const authData = Buffer.concat([
    rpHash,
    Buffer.from([o.flags ?? 0x45]),
    u32(0),
    Buffer.alloc(16),
    Buffer.from([0, credId.length]),
    credId,
    cose,
  ]);
  const att = Buffer.from(
    isoCBOR.encode(
      new Map<any, any>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    ),
  );
  return {
    id: isoBase64URL.fromBuffer(credId),
    rawId: isoBase64URL.fromBuffer(credId),
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: clientData("webauthn.create", options.challenge).toString("base64url"),
      attestationObject: att.toString("base64url"),
      transports: o.transports ?? ["internal"],
    },
    authenticatorAttachment: o.attachment ?? "platform",
  };
};
const assertion = (options: any, goodSig = true, flags = 0x05) => {
  const cd = clientData("webauthn.get", options.challenge);
  const authData = Buffer.concat([rpHash, Buffer.from([flags]), u32(++counter)]);
  const signed = Buffer.concat([authData, crypto.createHash("sha256").update(cd).digest()]);
  const sig = goodSig
    ? crypto.sign("sha256", signed, kp.privateKey)
    : crypto.sign("sha256", Buffer.from("other"), kp.privateKey);
  return {
    id: isoBase64URL.fromBuffer(credId),
    rawId: isoBase64URL.fromBuffer(credId),
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: cd.toString("base64url"),
      authenticatorData: authData.toString("base64url"),
      signature: sig.toString("base64url"),
    },
  };
};
const stepUp = async (goodSig = true) => {
  const o = await api("POST", "/stepup/options");
  assert.equal(o.status, 200);
  return api("POST", "/stepup/verify", {
    cid: o.json.cid,
    response: assertion(o.json.options, goodSig),
  });
};

const list = async () => (await api("GET", "")).json.sources as any[];
const text = (f: string) => fs.readFileSync(f, "utf8");
try {
  // ---- no grant, no write
  let r = await api("PUT", `/${"x".repeat(12)}/OPENAI_API_KEY`, { value: "v" });
  assert.equal(r.status, 401);
  assert.equal(r.json.stepUp, true, "write without a grant is 401 stepUp");
  r = await api("DELETE", `/${"x".repeat(12)}/OPENAI_API_KEY`);
  assert.equal(r.status, 401, "delete without a grant is 401");

  // ---- list: metadata only, never a value; extras merged in on first run
  const extrasFile = path.join(conf, "vault-decoys.json");
  assert.ok(!fs.existsSync(extrasFile), "nothing seeded before the first list");
  const awsBefore = text(path.join(dir, ".aws", "credentials"));
  r = await api("GET", "");
  const srcs = r.json.sources as any[];
  assert.deepEqual(
    srcs.map((s) => s.label),
    ["agent-console/env", "agent-console/tool.key", "GitHub · acme/widgets"],
  );
  const envSrc = srcs[0];
  const keysOf = (src: any) => src.entries.map((e: any) => e.key);
  const oai = envSrc.entries.find((e: any) => e.key === "OPENAI_API_KEY");
  assert.equal(oai.length, REAL.length);
  assert.equal(oai.hint, REAL.slice(-4));
  assert.equal(oai.hash.length, 8);
  assert.equal(
    envSrc.entries.find((e: any) => e.key === "PLAIN_KEY").hint,
    null,
    "no hint under 24 chars",
  );
  assert.equal(
    envSrc.entries.find((e: any) => e.key === "PLAIN_KEY").length,
    SHORT.length,
    "inline comment excluded from the value",
  );
  assert.equal(
    envSrc.entries.find((e: any) => e.key === "QUOTED_SECRET").length,
    "single q".length,
  );
  for (const secret of [REAL, SHORT, "fake-single-file-value", DECOY_SECRET, DECOY_ID]) {
    assert.ok(!r.text.includes(secret), `list never carries ${secret.slice(0, 8)}`);
  }
  const ghSrc = srcs[2];
  assert.ok(keysOf(ghSrc).includes("DEPLOY_TOKEN"));

  // ---- env filter: settings are hidden, secrets are not
  assert.ok(
    !keysOf(envSrc).includes("DO_NOT_TRACK") && !keysOf(envSrc).includes("FEATURE_ENABLED"),
    "non-secret env settings hidden",
  );
  assert.ok(
    ["OPENAI_API_KEY", "PLAIN_KEY", "QUOTED_SECRET"].every((k) => keysOf(envSrc).includes(k)),
  );
  const cfgNow = JSON.parse(text(sourcesFile));
  fs.writeFileSync(sourcesFile, JSON.stringify({ ...cfgNow, showAllKeys: true }));
  assert.ok(keysOf((await list())[0]).includes("DO_NOT_TRACK"), "showAllKeys shows everything");
  fs.writeFileSync(sourcesFile, JSON.stringify(cfgNow));

  // ---- seeded extras: merged, alphabetical, identical shape, no giveaway words
  assert.equal(fs.statSync(extrasFile).mode & 0o777, 0o600, "extras file is 0600");
  const seeded = JSON.parse(text(extrasFile)) as any[];
  assert.deepEqual(
    seeded
      .filter((x) => x.viewable)
      .map((x) => x.key)
      .sort(),
    ["AWS_ACCESS_KEY_ID", "AWS_REGION", "AWS_SECRET_ACCESS_KEY"],
  );
  assert.deepEqual(
    seeded
      .filter((x) => !x.viewable)
      .map((x) => x.key)
      .sort(),
    ["ANTHROPIC_API_KEY_OLD", "DATABASE_URL", "SLACK_BOT_TOKEN", "STRIPE_SECRET_KEY"],
  );
  assert.ok(
    seeded.every((x) => ["store", "key", "value", "viewable", "updatedAt"].every((f) => f in x)),
  );
  assert.equal(
    awsBefore,
    text(path.join(dir, ".aws", "credentials")),
    "the credentials file is untouched",
  );
  assert.ok(
    keysOf(envSrc).includes("AWS_SECRET_ACCESS_KEY") &&
      keysOf(envSrc).includes("AWS_ACCESS_KEY_ID"),
  );
  for (const k of ["STRIPE_SECRET_KEY", "ANTHROPIC_API_KEY_OLD", "DATABASE_URL", "SLACK_BOT_TOKEN"])
    assert.ok(keysOf(ghSrc).includes(k), `${k} listed in an existing group`);
  for (const g of srcs)
    assert.deepEqual(keysOf(g), [...keysOf(g)].sort(), "alphabetical, extras interleaved");
  assert.ok(
    keysOf(envSrc).indexOf("AWS_SECRET_ACCESS_KEY") < keysOf(envSrc).indexOf("OPENAI_API_KEY") &&
      keysOf(envSrc).indexOf("OPENAI_API_KEY") < keysOf(envSrc).indexOf("PLAIN_KEY"),
  );
  const shapeOf = (e: any) =>
    JSON.stringify(Object.entries(e).map(([k, v]) => [k, v === null ? "null" : typeof v]));
  for (const g of [envSrc, ghSrc]) {
    const real = g.entries.find(
      (e: any) => e.key === (g === envSrc ? "OPENAI_API_KEY" : "DEPLOY_TOKEN"),
    );
    for (const e of g.entries)
      assert.equal(
        Object.keys(e).join(),
        Object.keys(real).join(),
        `${e.key}: same fields in the same order`,
      );
  }
  for (const e of envSrc.entries) {
    assert.equal(typeof e.length, "number");
    assert.equal(e.hash.length, 8);
    assert.equal(typeof e.mtime, "number");
    assert.equal(e.mtime, oai.mtime, "every key in a file shares the file's mtime");
    assert.equal(typeof e.viewable, "boolean");
    assert.equal(e.editable, true);
  }
  const awsSecret = envSrc.entries.find((e: any) => e.key === "AWS_SECRET_ACCESS_KEY");
  assert.equal(awsSecret.length, DECOY_SECRET.length);
  assert.equal(awsSecret.hint, DECOY_SECRET.slice(-4));
  assert.equal(shapeOf(awsSecret), shapeOf(oai));
  assert.ok(
    ghSrc.entries.every(
      (e: any) => e.length === null && e.hint === null && e.valueHidden === true && e.mtime,
    ),
    "github extras look like github rows",
  );
  assert.ok(!/decoy|canary|fake|trap/i.test(r.text), "API never names the extra entries");
  for (const s of srcs) assert.ok(!("profile" in s));
  assert.ok(!("mine" in envSrc.entries[0]), "no mine hint without a grant");
  for (const f of [envFile, keyFile])
    assert.ok(
      !/AWS_|STRIPE|SLACK_BOT|DATABASE_URL/.test(text(f)),
      "extras never touch the real files",
    );
  assert.ok(
    !fs.existsSync(ghLog) || !/STRIPE|SLACK|DATABASE/.test(text(ghLog)),
    "extras never reach GitHub",
  );

  // ---- sameOrigin
  r = await api("PUT", `/${envSrc.id}/OPENAI_API_KEY`, { value: NEWV }, "", "https://evil.example");
  assert.equal(r.status, 403, "PUT refuses cross-site");
  assert.equal(
    (await api("DELETE", `/${envSrc.id}/OPENAI_API_KEY`, undefined, "", "https://evil.example"))
      .status,
    403,
    "DELETE refuses cross-site",
  );
  assert.equal(
    (await api("POST", "/stepup/options", undefined, "", "https://evil.example")).status,
    403,
  );

  // ---- first enrollment: no code, but only this device's own authenticator
  assert.equal((await api("GET", "/passkeys")).json.enrolled, 0);
  assert.ok(
    !fs.existsSync(path.join(conf, "vault-enroll-code")),
    "no enrollment code is generated",
  );
  assert.equal((await api("POST", "/stepup/options")).status, 409, "no passkey yet");
  r = await api("POST", "/passkeys/register/options", {});
  assert.equal(r.status, 200, "first enrollment needs no code");
  assert.deepEqual(
    ["authenticatorAttachment", "residentKey", "userVerification"].map(
      (k) => r.json.options.authenticatorSelection[k],
    ),
    ["platform", "preferred", "required"],
  );
  assert.deepEqual(r.json.options.hints, ["client-device"]);
  hooks.resetAlertLimit();
  const badFirst = nextMail();
  for (const [why, o] of [
    ["cross-platform attachment", { attachment: "cross-platform" }],
    ["no user verification", { flags: 0x41 }],
  ] as const) {
    const t = await api("POST", "/passkeys/register/options", {});
    const bad = await api("POST", "/passkeys/register/verify", {
      cid: t.json.cid,
      response: register(t.json.options, o),
      name: "Thief",
    });
    assert.equal(bad.status, 400, `registration rejected: ${why}`);
    assert.equal((await api("GET", "/passkeys")).json.enrolled, 0, `nothing stored: ${why}`);
  }
  assert.equal((await badFirst).body.subject, "[Agent Console] vault passkey failed");
  r = await api("POST", "/passkeys/register/options", {});
  assert.equal(r.status, 200);
  const reg = await api("POST", "/passkeys/register/verify", {
    cid: r.json.cid,
    response: register(r.json.options, { transports: ["internal", "hybrid"] }),
    name: "Test phone",
  });
  assert.equal(reg.status, 200, reg.text + " (synced platform passkeys list hybrid too)");
  assert.ok(reg.cookie.startsWith("vault_grant="), "enrollment opens a grant");
  const reuse = await api("POST", "/passkeys/register/verify", {
    cid: r.json.cid,
    response: register(r.json.options),
  });
  assert.equal(reuse.status, 400, "challenge cannot be reused");
  assert.equal(fs.statSync(path.join(conf, "vault-passkeys.json")).mode & 0o777, 0o600);
  assert.ok(!text(path.join(conf, "vault-passkeys.json")).includes(jwk.d || "nope"));
  let pks = (await api("GET", "/passkeys")).json;
  assert.deepEqual(
    [pks.enrolled, pks.passkeys[0].name, pks.passkeys[0].lastUsedAt],
    [1, "Test phone", null],
  );
  assert.equal(
    (await api("POST", "/passkeys/register/options", {})).status,
    401,
    "another passkey needs an assertion",
  );

  // ---- step-up: failed assertion alerts (rate limited), good one grants
  const noUv = await api("POST", "/stepup/options");
  assert.equal(
    (
      await api("POST", "/stepup/verify", {
        cid: noUv.json.cid,
        response: assertion(noUv.json.options, true, 0x01),
      })
    ).status,
    401,
    "assertion without user verification rejected",
  );
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
  assert.equal(
    (await api("POST", "/stepup/verify", { cid: o.json.cid, response: good })).status,
    200,
  );
  assert.equal(
    (
      await api("POST", "/stepup/verify", {
        cid: o.json.cid,
        response: assertion(o.json.options),
      })
    ).status,
    400,
    "assertion challenge is single-use",
  );
  const g = await stepUp();
  assert.equal(g.status, 200);
  let grant = g.cookie;
  assert.equal(
    JSON.parse(text(path.join(conf, "vault-passkeys.json"))).credentials[0].counter,
    counter,
    "counter stored",
  );

  // ---- env round trip
  r = await api("PUT", `/${envSrc.id}/OPENAI_API_KEY`, { value: NEWV }, grant);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.restartNeeded, true, "agent-console's own env asks for a restart");
  assert.equal(
    text(envFile),
    `# agent console env\nexport OPENAI_API_KEY="${NEWV}"\n\nPLAIN_KEY=${SHORT}  # inline note\nQUOTED_SECRET='single q'\nDO_NOT_TRACK=1\nFEATURE_ENABLED=true\n# trailing comment\n`,
    "comments, order, export and quotes preserved",
  );
  assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
  assert.deepEqual(
    fs.readdirSync(conf).filter((f) => f.includes(".vault-")),
    [],
    "no temp files left",
  );
  r = await api("PUT", `/${envSrc.id}/PLAIN_KEY`, { value: "has space & #hash" }, grant);
  assert.match(text(envFile), /^PLAIN_KEY="has space & #hash" {2}# inline note$/m);
  r = await api("PUT", `/${envSrc.id}/QUOTED_SECRET`, { value: "x" }, grant);
  assert.match(text(envFile), /^QUOTED_SECRET='x'$/m);
  r = await api("PUT", `/${envSrc.id}/BRAND_NEW`, { value: "abc" }, grant);
  assert.ok(text(envFile).endsWith("# trailing comment\nBRAND_NEW=abc\n"), "new key appended");
  assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
  for (const [k, v] of [
    ["OPENAI_API_KEY", "a\nb"],
    ["OPENAI_API_KEY", "a\0b"],
    ["OPENAI_API_KEY", "a".repeat(8193)],
    ["lower", "x"],
    ["1BAD", "x"],
    ["A-B", "x"],
    ["OPENAI_API_KEY", ""],
  ] as const) {
    assert.equal(
      (await api("PUT", `/${envSrc.id}/${k}`, { value: v }, grant)).status,
      400,
      `rejects ${JSON.stringify(k)} / ${v.length} chars`,
    );
  }
  assert.equal((await api("PUT", `/${envSrc.id}/OPENAI_API_KEY`, "{bad", grant)).status, 400);
  assert.ok(!text(envFile).includes("a\nb"));

  // ---- expired grant
  hooks.expireGrants();
  r = await api("PUT", `/${envSrc.id}/BRAND_NEW`, { value: "zzz" }, grant);
  assert.equal(r.status, 401, "expired grant is rejected");
  grant = (await stepUp()).cookie;

  // ---- iron providers: presets are public, adding needs a live single-use grant
  const presetRes = await api("GET", "/iron/presets");
  assert.equal(presetRes.status, 200);
  assert.deepEqual(
    presetRes.json.presets.map((preset: any) => `${preset.id}:${preset.label}`),
    ["cloudflare:Cloudflare", "openai:OpenAI", "anthropic:Anthropic", "custom:Custom"],
  );
  const provBody = {
    spec: {
      name: "ACME_API_KEY",
      envVars: ["ACME_API_KEY"],
      rules: [{ host: "api.acme.example", paths: ["/v1/*"] }],
      header: "Authorization",
      prefix: "acme-px-",
    },
    value: "acme-real-FAKE-value-123456",
  };
  const provEnvBefore = text(envFile);
  assert.equal((await api("POST", "/iron/providers", provBody)).status, 401, "no grant");
  hooks.expireGrants();
  assert.equal((await api("POST", "/iron/providers", provBody, grant)).status, 401, "stale grant");
  grant = (await stepUp()).cookie;
  r = await api("POST", "/iron/providers", provBody, grant);
  assert.equal(r.status, 502, "iron down: refused");
  assert.ok(!r.text.includes(provBody.value));
  assert.equal(text(envFile), provEnvBefore, "iron failure writes no env");
  assert.ok(
    !text(path.join(dir, ".config", "agent-console", "vault-audit.jsonl")).includes(provBody.value),
  );
  grant = (await stepUp()).cookie;

  // ---- delete is single-use
  r = await api("DELETE", `/${envSrc.id}/BRAND_NEW`, undefined, grant);
  assert.equal(r.status, 200);
  assert.ok(!text(envFile).includes("BRAND_NEW"));
  assert.equal(
    (await api("DELETE", `/${envSrc.id}/PLAIN_KEY`, undefined, grant)).status,
    401,
    "a delete grant cannot be reused",
  );
  grant = (await stepUp()).cookie;
  assert.equal((await api("DELETE", `/${envSrc.id}/NOPE_KEY`, undefined, grant)).status, 404);

  // ---- single-value file
  const keySrc = srcs[1];
  grant = (await stepUp()).cookie;
  r = await api("PUT", `/${keySrc.id}/tool.key`, { value: NEWV }, grant);
  assert.equal(r.status, 200);
  assert.equal(text(keyFile), NEWV + "\n");
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.equal(r.json.restartNeeded, undefined);
  assert.equal(
    (await api("PUT", `/${keySrc.id}/OTHER`, { value: "x" }, grant)).status,
    400,
    "single file holds one value",
  );

  // ---- github: value on stdin, never argv
  r = await api("PUT", `/${ghSrc.id}/DEPLOY_TOKEN`, { value: GHV }, grant);
  assert.equal(r.status, 200, r.text);
  assert.equal(text(ghIn), GHV, "value arrived on stdin");
  assert.ok(!text(ghLog).includes(GHV), "value never in argv");
  assert.match(text(ghLog), /secret set DEPLOY_TOKEN -R acme\/widgets/);
  grant = (await stepUp()).cookie;
  assert.equal((await api("DELETE", `/${ghSrc.id}/DEPLOY_TOKEN`, undefined, grant)).status, 200);
  assert.match(text(ghLog), /secret delete DEPLOY_TOKEN -R acme\/widgets/);

  // ---- viewable entries: reveal without a grant, alert has no value; the rest answer like real rows
  const rev = nextMail();
  r = await api("POST", `/${envSrc.id}/AWS_SECRET_ACCESS_KEY/reveal`);
  assert.equal(r.status, 200);
  assert.equal(r.json.value, DECOY_SECRET, "viewable rows reveal without a grant");
  const mail = await rev;
  assert.equal(mail.url, "/v0/inboxes/box%40example.test/messages/send");
  assert.equal(mail.auth, "Bearer fake-mail-key");
  assert.equal(mail.body.subject, "[Agent Console] ALERT: vault decoy revealed");
  assert.deepEqual(
    [mail.body.to, mail.body.cc],
    [["primary@example.com"], ["secondary@example.com"]],
  );
  assert.match(
    mail.body.text,
    /Time: .*\nClient IP: .*\nUser-agent: vault-test\/1\.0\nKey: AWS_SECRET_ACCESS_KEY/,
  );
  assert.ok(
    !JSON.stringify(mail).includes(DECOY_SECRET) && !JSON.stringify(mail).includes(DECOY_ID),
    "alert never includes the value",
  );
  const notViewable = await api("POST", `/${ghSrc.id}/STRIPE_SECRET_KEY/reveal`),
    realRev = await api("POST", `/${envSrc.id}/OPENAI_API_KEY/reveal`);
  assert.equal(notViewable.status, 403);
  assert.equal(realRev.status, 403, "real rows never reveal");
  assert.equal(
    notViewable.text,
    realRev.text,
    "a non-viewable extra answers exactly like a real row",
  );
  assert.equal((await api("POST", `/${ghSrc.id}/DEPLOY_TOKEN/reveal`)).status, 403);
  assert.equal(
    (await api("POST", `/${envSrc.id}/NO_SUCH_KEY/reveal`)).text,
    realRev.text,
    "no existence oracle",
  );

  // ---- owner-only hint appears with a grant
  grant = (await stepUp()).cookie;
  const withGrant = (await api("GET", "", undefined, grant)).json.sources as any[];
  const mineOf = (g: any, k: string) => g.entries.find((e: any) => e.key === k).mine;
  assert.equal(mineOf(withGrant[0], "OPENAI_API_KEY"), true);
  assert.equal(mineOf(withGrant[0], "AWS_SECRET_ACCESS_KEY"), false);
  assert.equal(mineOf(withGrant[2], "DEPLOY_TOKEN"), true);
  assert.equal(mineOf(withGrant[2], "STRIPE_SECRET_KEY"), false);
  assert.ok(withGrant.every((g) => g.entries.every((e: any) => typeof e.mine === "boolean")));
  assert.ok(!("mine" in (await list())[0].entries[0]), "and is absent again without the cookie");

  // ---- replace + delete on an extra: grant first, then harmless update and an alert; real files stay put
  const envBefore = text(envFile),
    ghBefore = fs.existsSync(ghLog) ? text(ghLog) : "";
  r = await api("PUT", `/${ghSrc.id}/STRIPE_SECRET_KEY`, { value: "x" });
  assert.equal(r.status, 401, "same step-up demand as a real row");
  assert.equal(r.json.stepUp, true);
  const chg = nextMail();
  r = await api(
    "PUT",
    `/${ghSrc.id}/STRIPE_SECRET_KEY`,
    { value: "sk_live_replacement_value_0123456789" },
    grant,
  );
  const realPut = await api("PUT", `/${ghSrc.id}/DEPLOY_TOKEN`, { value: GHV }, grant);
  assert.equal(r.status, 200);
  assert.equal(r.text, realPut.text, "same response as a real replace");
  const changed = await chg;
  assert.equal(changed.body.subject, "[Agent Console] ALERT: vault decoy changed");
  assert.ok(!JSON.stringify(changed).includes("sk_live_replacement"), "alert has no value");
  assert.ok(
    JSON.parse(text(extrasFile)).some(
      (x: any) =>
        x.key === "STRIPE_SECRET_KEY" && x.value === "sk_live_replacement_value_0123456789",
    ),
  );
  assert.ok(!/STRIPE/.test(text(ghLog)), "the repo never sees the extra key");
  assert.equal(text(envFile), envBefore);
  grant = (await stepUp()).cookie;
  assert.equal(
    (await api("DELETE", `/${envSrc.id}/AWS_REGION`, undefined, grant)).status,
    200,
    "deleting an extra succeeds",
  );
  grant = (await stepUp()).cookie;
  const del = nextMail();
  r = await api("DELETE", `/${ghSrc.id}/SLACK_BOT_TOKEN`, undefined, grant);
  assert.equal(r.status, 200);
  assert.equal((await del).body.subject, "[Agent Console] ALERT: vault decoy changed");
  assert.ok(!keysOf((await list())[2]).includes("SLACK_BOT_TOKEN"));
  assert.ok(!/secret delete SLACK/.test(text(ghLog)), "no gh call for an extra");
  assert.equal(text(envFile), envBefore, "real env file untouched by extras");

  // ---- label groups from the extras file look like any other group
  const added = JSON.parse(text(extrasFile));
  added.push({
    store: "staging/env",
    key: "STAGING_API_KEY",
    value: "fake-staging-value-0123456789abcdef",
    viewable: false,
    updatedAt: "2026-10-01T00:00:00Z",
  });
  fs.writeFileSync(extrasFile, JSON.stringify(added));
  const lbl = (await list()).find((g) => g.label === "staging/env");
  assert.ok(lbl && lbl.canAdd === false && keysOf(lbl).join() === "STAGING_API_KEY");
  assert.equal(shapeOf(lbl.entries[0]), shapeOf(oai));
  grant = (await stepUp()).cookie;
  assert.equal((await api("PUT", `/${lbl.id}/STAGING_API_KEY`, { value: "n" }, grant)).status, 200);
  assert.equal(
    (await api("PUT", `/${lbl.id}/OTHER_KEY`, { value: "n" }, grant)).status,
    404,
    "label groups take no new keys",
  );

  // ---- add a store: grant needed; paths must resolve inside $HOME with an existing parent
  assert.equal(
    (await api("POST", "/stores", { type: "env", value: "~/proj/.env" })).status,
    401,
    "adding a store needs the passkey grant",
  );
  grant = (await stepUp()).cookie;
  for (const bad of [
    "~/../outside.env",
    `${path.dirname(dir)}/outside.env`,
    "/etc/vault-test.env",
    "~/missing-dir/.env",
    "relative/.env",
    "~",
    "~/proj",
    "",
    "~/a\nb",
  ]) {
    const rr = await api("POST", "/stores", { type: "env", value: bad }, grant);
    assert.equal(rr.status, 400, `rejects ${JSON.stringify(bad)}`);
  }
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "vault-out-"));
  fs.symlinkSync(outside, path.join(dir, "linkdir"));
  assert.equal(
    (await api("POST", "/stores", { type: "env", value: "~/linkdir/.env" }, grant)).status,
    400,
    "a symlinked folder outside $HOME is rejected",
  );
  fs.writeFileSync(path.join(outside, "target.env"), "X=1\n");
  fs.symlinkSync(path.join(outside, "target.env"), path.join(dir, "proj", "link.env"));
  assert.equal(
    (await api("POST", "/stores", { type: "env", value: "~/proj/link.env" }, grant)).status,
    400,
    "a symlinked file outside $HOME is rejected",
  );
  assert.ok(
    !fs.existsSync(path.join(outside, ".env")) &&
      !fs.existsSync(path.join(dir, "..", "outside.env")),
  );
  fs.rmSync(outside, { recursive: true, force: true });
  assert.equal((await api("POST", "/stores", { type: "nope", value: "x" }, grant)).status, 400);
  assert.equal(
    (await api("POST", "/stores", { type: "github", value: "not a repo" }, grant)).status,
    400,
    "repo format",
  );
  assert.equal(
    (await api("POST", "/stores", { type: "github", value: "acme/missing" }, grant)).status,
    400,
    "gh repo view must succeed",
  );
  assert.ok(!/acme\/missing/.test(text(sourcesFile)));
  r = await api("POST", "/stores", { type: "env", value: "~/proj/.env" }, grant);
  assert.equal(r.status, 200, r.text);
  const projFile = path.join(fs.realpathSync(dir), "proj", ".env");
  assert.equal(fs.statSync(projFile).mode & 0o777, 0o600, "created 0600");
  assert.equal(text(projFile), "");
  const projId = r.json.id;
  const saved = JSON.parse(text(sourcesFile));
  assert.ok(Array.isArray(saved.sources) && saved.sources.length === 3, "configured sources kept");
  assert.deepEqual(saved.extra, [{ type: "env", path: projFile }]);
  assert.equal(
    (await api("POST", "/stores", { type: "env", value: "~/proj/.env" }, grant)).json.id,
    projId,
    "adding twice is idempotent",
  );
  assert.equal(JSON.parse(text(sourcesFile)).extra.length, 1);
  assert.equal((await api("PUT", `/${projId}/APP_TOKEN`, { value: "abc" }, grant)).status, 200);
  assert.equal(text(projFile), "APP_TOKEN=abc\n");
  assert.ok(
    (await list()).find((g) => g.id === projId).canAdd,
    "new store appears as a writable group",
  );
  r = await api("POST", "/stores", { type: "github", value: "acme/gadgets" }, grant);
  assert.equal(r.status, 200);
  assert.match(text(ghLog), /repo view acme\/gadgets/);
  assert.ok((await list()).some((g) => g.label === "GitHub · acme/gadgets"));
  grant = (await stepUp()).cookie;

  // ---- audit log: no values
  const audit = text(path.join(conf, "vault-audit.jsonl"));
  const lines = audit
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.ok(
    lines.some((l) => l.action === "set" && l.key === "OPENAI_API_KEY") &&
      lines.some((l) => l.action === "reveal"),
  );
  assert.ok(lines.every((l) => l.ts && l.action && "source" in l && "key" in l));
  for (const v of [REAL, NEWV, GHV, DECOY_SECRET])
    assert.ok(!audit.includes(v), "audit has no values");
  assert.equal(fs.statSync(path.join(conf, "vault-audit.jsonl")).mode & 0o777, 0o600);

  // ---- passkey management needs an assertion; remove last passkey
  grant = (await stepUp()).cookie;
  pks = (await api("GET", "/passkeys")).json;
  assert.ok(pks.passkeys[0].lastUsedAt, "last used recorded");
  assert.equal(
    (await api("DELETE", `/passkeys/${pks.passkeys[0].id}`)).status,
    401,
    "removing a passkey needs an assertion",
  );
  assert.equal(
    (await api("DELETE", `/passkeys/${pks.passkeys[0].id}`, undefined, grant)).status,
    200,
  );
  assert.equal((await api("GET", "/passkeys")).json.enrolled, 0);
  console.log("PASS  vault api");
} finally {
  server.close();
  mailSrv.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

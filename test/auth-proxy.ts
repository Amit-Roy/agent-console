// Coder SSO needs the proxy secret header when AGENT_CONSOLE_PROXY_SECRET_SHA256 is set; host-only otherwise.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_CONSOLE_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "auth-proxy-"));
process.env.AGENT_CONSOLE_PUBLIC_HOST = "console.example.test";
const secret = "test-proxy-secret";
const HOST = "console.example.test";
const PROXY_HEADER = "x-agent-console-proxy";

process.env.AGENT_CONSOLE_PROXY_SECRET_SHA256 = crypto
  .createHash("sha256")
  .update(secret)
  .digest("hex");
const proofOn = await import("../server/auth.ts?proof=on");
assert.equal(proofOn.PROXY_PROOF_ON, true);
assert.equal(
  proofOn.authed({ headers: { host: HOST, [PROXY_HEADER]: secret } }),
  true,
  "host + correct header",
);
assert.equal(proofOn.authed({ headers: { host: HOST } }), false, "host alone");
assert.equal(
  proofOn.authed({ headers: { host: HOST, [PROXY_HEADER]: "wrong" } }),
  false,
  "wrong header",
);
assert.equal(
  proofOn.authed({ headers: { host: HOST, [PROXY_HEADER]: [secret] } }),
  false,
  "array header",
);
assert.equal(
  proofOn.authed({ headers: { host: "evil.test", [PROXY_HEADER]: secret } }),
  false,
  "wrong host",
);

delete process.env.AGENT_CONSOLE_PROXY_SECRET_SHA256;
const proofOff = await import("../server/auth.ts?proof=proofOff");
assert.equal(proofOff.PROXY_PROOF_ON, false);
assert.equal(proofOff.authed({ headers: { host: HOST } }), true, "unset hash keeps host-only");
console.log("auth-proxy ok");

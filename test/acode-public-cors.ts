// Opt-in check through the real HTTPS proxy, including browser-enforced CORS.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const endpoint = process.env.ACODE_PUBLIC_TEST_URL;
assert.ok(endpoint?.startsWith("https://"), "Set ACODE_PUBLIC_TEST_URL to the dedicated bridge HTTPS origin.");
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.route("https://localhost/acode-debug", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Acode CORS test</title>" }));
  await page.goto("https://localhost/acode-debug");
  const result = await page.evaluate(async endpoint => {
    const response = await fetch(endpoint + "/api/acode/exchange", {
      method: "POST", credentials: "omit", redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket: "invalid-public-cors-probe" }),
    });
    return { status: response.status, body: await response.json() };
  }, endpoint);
  assert.equal(result.status, 401, "Acode can read bridge errors after a real browser preflight.");
  assert.match(result.body.error, /ticket/i);
  for (const origin of ["https://localhost", "null"]) {
    const preflight = await fetch(endpoint + "/api/acode/file", { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "authorization,content-type" } });
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
    assert.match(preflight.headers.get("access-control-allow-headers") || "", /authorization/i);
    assert.match(preflight.headers.get("access-control-allow-methods") || "", /PUT/);
  }
  const denied = await fetch(endpoint + "/api/acode/exchange", { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } });
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
  console.log("PASS public Acode CORS: browser preflight and POST, null origin, bearer preflight, hostile origin denied.");
} finally { await browser.close(); }

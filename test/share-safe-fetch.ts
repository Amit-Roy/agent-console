import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

const { safeFetch, assertPublicHost, isPublicAddress, BlockedAddressError, validateUrl } =
  await import("../server/share/safe-fetch.ts");

const blocked = (error: unknown) => error instanceof BlockedAddressError;

// ---- address classification
for (const address of [
  "127.0.0.1",
  "10.1.2.3",
  "172.16.0.1",
  "192.168.1.1",
  "100.64.0.1",
  "169.254.169.254",
  "0.0.0.0",
  "224.0.0.1",
  "255.255.255.255",
  "::1",
  "::",
  "fe80::1",
  "fc00::1",
  "fd12:3456::1",
  "ff02::1",
  "::ffff:10.0.0.1",
  "::ffff:127.0.0.1",
  "2002:c0a8:0101::1",
  "2001:0:4136:e378::1",
  "64:ff9b::a00:1",
])
  assert.equal(isPublicAddress(address), false, address);
for (const address of ["93.184.215.14", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])
  assert.equal(isPublicAddress(address), true, address);

// ---- URL-level rejections (no network)
for (const url of [
  "http://127.0.0.1/",
  "http://[::1]/",
  "http://[::ffff:10.0.0.1]/",
  "http://169.254.169.254/latest/meta-data/",
  "http://10.0.0.5/",
  "http://100.64.1.1/",
  "http://0x7f.1/",
  "http://2130706433/",
  "ftp://example.com/",
  "file:///etc/passwd",
  "https://example.com:8443/",
  "https://user:pass@example.com/",
])
  await assert.rejects(safeFetch(url), blocked, url);
await assert.rejects(safeFetch("http://localhost/"), blocked, "localhost resolves to loopback");
await assert.rejects(assertPublicHost("http://localhost/"), blocked);
await assert.rejects(assertPublicHost("http://127.0.0.1/"), blocked);
assert.equal(validateUrl("https://example.com/a").hostname, "example.com");

// ---- local server: the real guard rejects it outright
const hits: string[] = [];
const server = http.createServer((req, res) => {
  hits.push(req.url ?? "");
  const port = (server.address() as AddressInfo).port;
  if (req.url === "/to-localhost") {
    res.writeHead(302, { location: `http://localhost:${port}/secret` });
  } else if (req.url === "/to-literal") {
    res.writeHead(302, { location: `http://127.0.0.1:${port}/secret` });
  } else if (req.url?.startsWith("/loop")) {
    const step = Number(req.url.slice(5) || 0);
    res.writeHead(302, { location: `/loop${step + 1}` });
  } else if (req.url === "/big") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("x".repeat(4096));
    return;
  } else {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`ok ${req.headers.host}`);
    return;
  }
  res.end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.2", resolve));
const port = String((server.address() as AddressInfo).port);
await assert.rejects(safeFetch(`http://127.0.0.2:${port}/`), blocked, "local server and odd port");

// Test hooks: treat only 127.0.0.2 as "public", allow the test port, and stub DNS.
const lookups: string[] = [];
let rebindCount = 0;
const testHooks = {
  ports: [port],
  isAllowed: (address: string) => address === "127.0.0.2",
  resolve: async (hostname: string) => {
    lookups.push(hostname);
    if (hostname === "rebind.test") {
      rebindCount++;
      return rebindCount === 1
        ? [{ address: "127.0.0.2", family: 4 }]
        : [{ address: "127.0.0.1", family: 4 }];
    }
    if (hostname === "mixed.test")
      return [
        { address: "127.0.0.2", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ];
    if (hostname === "public.test") return [{ address: "127.0.0.2", family: 4 }];
    return [{ address: "127.0.0.1", family: 4 }];
  },
};

const okResponse = await safeFetch(`http://public.test:${port}/`, { testHooks });
assert.equal(okResponse.status, 200);
assert.equal(okResponse.body.toString(), `ok public.test:${port}`, "Host header keeps the name");

// redirect from the "public" server to localhost and to a loopback literal: each hop re-validated
await assert.rejects(safeFetch(`http://public.test:${port}/to-localhost`, { testHooks }), blocked);
await assert.rejects(safeFetch(`http://public.test:${port}/to-literal`, { testHooks }), blocked);
assert.ok(!hits.includes("/secret"), "redirect target never reached");
await assert.rejects(
  safeFetch(`http://public.test:${port}/loop0`, { testHooks }),
  /redirects too many times/,
);
assert.equal(
  hits.filter((hit) => hit.startsWith("/loop")).length,
  6,
  "initial request plus 5 redirects",
);

// byte cap enforced while streaming
await assert.rejects(
  safeFetch(`http://public.test:${port}/big`, { testHooks, maxBytes: 1000 }),
  /too large/,
);

// any private answer in the set rejects the host
await assert.rejects(safeFetch(`http://mixed.test:${port}/`, { testHooks }), blocked);

// DNS rebinding: first answer public, later answers private; the guard resolves once and dials the vetted IP
rebindCount = 0;
const before = lookups.length;
const rebound = await safeFetch(`http://rebind.test:${port}/`, { testHooks });
assert.equal(rebound.status, 200);
assert.equal(lookups.length - before, 1, "exactly one resolution per connection");
rebindCount = 1;
await assert.rejects(
  safeFetch(`http://rebind.test:${port}/`, { testHooks }),
  blocked,
  "second answer rejected",
);

// timeout
const slow = http.createServer(() => {});
await new Promise<void>((resolve) => slow.listen(0, "127.0.0.2", resolve));
const slowPort = String((slow.address() as AddressInfo).port);
await assert.rejects(
  safeFetch(`http://public.test:${slowPort}/`, {
    testHooks: { ...testHooks, ports: [slowPort] },
    timeoutMs: 300,
  }),
  /took too long/,
);
slow.closeAllConnections();
slow.close();
server.close();

// ---- live public URL
const live = await safeFetch("https://example.com/", { accept: "text/html" });
assert.equal(live.status, 200);
assert.match(live.body.toString(), /Example Domain/);
console.log("share-safe-fetch ok");

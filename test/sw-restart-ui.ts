// While the server restarts, the Coder proxy answers page loads with 502. The service worker must show a retry page
// that reloads by itself once the server answers again, and must leave healthy page loads alone.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { chromium } from "playwright";

const sw = fs.readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
let mode: "up" | "502" | "refuse" = "up";
const server = http.createServer((req, res) => {
  if (req.url === "/sw.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(sw);
  if (mode === "refuse") return req.socket.destroy();
  if (mode === "502") return res.writeHead(502, { "content-type": "text/plain" }).end("Bad Gateway");
  res.writeHead(200, { "content-type": "text/html" }).end(`<title>app</title><p id="app">live</p>
<script>navigator.serviceWorker.register("/sw.js")</script>`);
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://localhost:${(server.address() as any).port}/`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(url);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), true, "Service worker controls the page");
  assert.equal(await page.textContent("#app"), "live", "Healthy loads pass through");

  for (const down of ["502", "refuse"] as const) {
    mode = down;
    await page.reload();
    await page.waitForSelector("text=Agent Console is restarting");
    mode = "up";
    await page.waitForSelector("#app", { timeout: 5000 });
    assert.equal(await page.textContent("#app"), "live", `Retry page reloads after ${down}`);
  }
  console.log("Service worker restart retry checks passed.");
} finally {
  await browser.close();
  server.close();
}

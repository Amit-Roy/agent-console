import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { chromium } from "playwright";
import { createDoctor } from "../server/doctor.ts";

// Exercise the real Doctor service and UI with an isolated stale-session fixture.
const out = process.env.OUT || "/tmp/doctor-evidence";
fs.mkdirSync(out, { recursive: true });
let stale = 1;
let repairCalls = 0;
const service = createDoctor({
  routingHealth: () => ({ idle: stale, active: 0, silent: 0 }),
  repairRouting: () => { repairCalls++; const fixed = stale; stale = 0; return { fixed, deferred: 0 }; },
  repairStaleTurns: () => 0,
} as any, {
  proxy: { probe: async () => ({ enabled: false, running: false, reachable: false }) } as any,
  accountReady: () => true,
  executable: () => true,
  codexAuthReady: () => true,
  codexHelperReady: () => true,
  upstream: async () => "reachable",
});
const app = express();
app.get("/api/doctor", async (_req, res) => res.json(await service.inspect()));
app.post("/api/doctor", async (_req, res) => res.json(await service.repair()));
app.get("/doctor", (_req, res) => res.sendFile("doctor.html", { root: path.resolve("public") }));
app.use(express.static(path.resolve("public")));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();
try {
  for (const [name, viewport, colorScheme] of [
    ["desktop-light", { width: 1280, height: 900 }, "light"],
    ["phone-dark", { width: 390, height: 844 }, "dark"],
  ] as const) {
    stale = 1;
    const context = await browser.newContext({ viewport, colorScheme, recordVideo: { dir: path.join(out, "videos"), size: viewport } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${base}/doctor`);
    await page.getByRole("heading", { name: "Your setup needs attention" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Repair setup" }).isEnabled(), true);
    assert.match(await page.locator("#doctor-checks").innerText(), /1 idle/);
    await page.screenshot({ path: path.join(out, `doctor-${name}-before.png`), fullPage: true });
    await page.getByRole("button", { name: "Repair setup" }).click();
    await page.getByRole("heading", { name: "Your setup is ready" }).waitFor();
    assert.match(await page.locator("#doctor-repair-results").innerText(), /Recycled 1 idle/);
    assert.equal(await page.getByRole("button", { name: "Repair setup" }).isDisabled(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(out, `doctor-${name}-after.png`), fullPage: true });
    await page.getByRole("button", { name: "Check again" }).click();
    await page.waitForFunction(() => document.getElementById("doctor-checks")?.getAttribute("aria-busy") === "false");
    assert.equal(stale, 0);
    assert.deepEqual(errors, []);
    const video = page.video();
    await context.close();
    if (video) fs.copyFileSync(await video.path(), path.join(out, `doctor-${name}.webm`));
    console.log(`PASS ${name}: stale connection diagnosis, repair, recheck, no overflow or browser errors`);
  }
  assert.equal(repairCalls, 2, "Each repair action ran once.");
} finally {
  await browser.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

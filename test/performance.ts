// Against a mock scratch server seeded with real history; never sends a model prompt.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { WebSocket } from "ws";
import { makeToken } from "../server/auth.ts";
const base = process.env.BASE || "http://127.0.0.1:7071";
const token = makeToken();
const ws = new WebSocket(base.replace("http", "ws") + "/ws", {
  headers: { origin: base, cookie: `ac_session=${token}` },
});
const inbox: any[] = [];
ws.on("message", (d) => inbox.push(JSON.parse(String(d))));
async function wait(pred: (m: any) => boolean) {
  for (let i = 0; i < 200; i++) {
    const at = inbox.findIndex(pred);
    if (at >= 0) return inbox.splice(at, 1)[0];
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Timed out waiting for WS reply");
}
const hello = await wait((m) => m.t === "hello");
const browser = await chromium.launch();
let created: string | undefined;
try {
  const p = hello.providers.find((p: any) => p.id === "codex");
  // a pinned model: switching it to "CLI default" must reset effort (default itself also lists shared efforts)
  const model = p.models.find(
    (m: string) => m !== "default" && p.modelDetails?.[m]?.efforts.includes("high"),
  );
  if (model && p.ok) {
    ws.send(
      JSON.stringify({
        t: "create",
        provider: "codex",
        cwd: hello.dirs[0],
        model,
        effort: "high",
        title: "Settings verification",
      }),
    );
    const result = await wait((m) => m.t === "created");
    created = result.thread.id;
    assert.equal(result.thread.effort, "high");
    ws.send(JSON.stringify({ t: "update", thread: created, effort: "impossible" }));
    assert.match((await wait((m) => m.t === "error")).message, /Unsupported effort/);
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    await ctx.addCookies([{ name: "ac_session", value: token, url: base }]);
    const page = await ctx.newPage();
    await page.goto(base);
    await page.waitForFunction(() =>
      document.querySelector("#effort")?.textContent?.includes("High"),
    );
    assert.equal(
      await page.locator("#model").getAttribute("aria-label"),
      `Model: ${p.modelDetails[model].label}`,
    );
    await page.locator("#effort").click();
    await page.getByRole("option", { name: "Effort · Low", exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector("#effort")?.textContent?.includes("Low"),
    );
    const layout = await page.evaluate(() => {
      const t = document.querySelector(".toolbar")!;
      const s = document.querySelector("#send")!.getBoundingClientRect();
      return { width: innerWidth, right: s.right, overflow: t.scrollWidth - t.clientWidth };
    });
    console.log("Codex mobile toolbar", layout);
    assert.ok(
      layout.right <= layout.width && layout.overflow < 3,
      "Codex chips fit the mobile toolbar",
    );
    await page.reload();
    await page.waitForFunction(() =>
      document.querySelector("#effort")?.textContent?.includes("Low"),
    );
    await page.locator("#model").click();
    await page.getByRole("option", { name: /^CLI default/ }).click();
    await page.waitForFunction(
      () =>
        document.querySelector("#model")?.textContent?.includes("CLI default") &&
        document.querySelector("#effort")?.textContent?.includes("default"),
    );
    await page.locator("#menu").click();
    await page.locator("#new").click();
    await page.locator("#d-prov").click();
    await page.getByRole("option", { name: "Codex", exact: true }).click();
    assert.equal(await page.locator("#effort-field").isVisible(), true);
    await page.locator("#d-model").click();
    await page.getByRole("option").filter({ hasText: p.modelDetails[model].label }).click();
    await page.locator("#d-effort").click();
    assert.ok(await page.getByRole("option", { name: "Effort · High", exact: true }).count());
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    console.log(
      "PASS Codex composer/dialog model and effort menus, persisted selection, model-change effort reset, unsupported effort rejection",
    );
    await ctx.close();
  }
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addCookies([{ name: "ac_session", value: token, url: base }]);
  const page = await ctx.newPage();
  await page.goto(base);
  await page.waitForFunction(() => !!(window as any).agentConsoleMetrics);
  const rows = page.locator("#threads li");
  const samples = [];
  for (let i = 0; i < Math.min(5, await rows.count()); i++) {
    await page.evaluate(() => {
      (window as any).agentConsoleMetrics = null;
    });
    await rows.nth(i).click();
    await page.waitForFunction(
      () =>
        !!(window as any).agentConsoleMetrics ||
        document.querySelector("#diagnostics")?.textContent?.startsWith("Opened from cache"),
    );
    samples.push(
      await page.evaluate(
        () =>
          (window as any).agentConsoleMetrics ||
          document.querySelector("#diagnostics")?.textContent,
      ),
    );
  }
  await rows.nth(0).click();
  assert.match(await page.locator("#diagnostics").textContent(), /from cache/);
  console.log("History timings", JSON.stringify(samples));
  console.log("Cached switch", await page.locator("#diagnostics").textContent());
  await ctx.close();
} finally {
  if (created) ws.send(JSON.stringify({ t: "delete", thread: created }));
  ws.close();
  await browser.close();
}

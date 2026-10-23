// Isolated static app and synthetic provider messages; no live data or provider turns.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";

const root = path.resolve(process.env.APP_ROOT || process.cwd(), "public");
const types: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff2": "font/woff2",
};
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  const vendor = {
    "/vendor/marked.js": "marked/lib/marked.esm.js",
    "/vendor/purify.js": "dompurify/dist/purify.es.mjs",
  }[pathname];
  const file = vendor
    ? path.resolve(root, "../node_modules", vendor)
    : path.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!vendor && !file.startsWith(`${root}/`)) return void res.writeHead(404).end();
  try {
    const body = fs.readFileSync(file);
    res.writeHead(200, {
      "content-type": vendor
        ? "text/javascript"
        : types[path.extname(file)] || "application/octet-stream",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const browser = await chromium.launch();
const now = Date.now();
const mkThread = (id: string, provider: string, model: string, used: number) => ({
  id,
  provider,
  model,
  title: `${id} fixture`,
  cwd: "/tmp",
  status: "idle",
  mode: "bypassPermissions",
  effort: "medium",
  createdAt: now,
  updatedAt: now,
  context: { used, max: 100000, source: "fixture" },
});
const modes = ["default", "bypassPermissions"];
const pi = {
  id: "pi",
  label: "Pi",
  ok: true,
  models: ["openrouter/test/model"],
  defaultModel: "openrouter/test/model",
  modes,
  defaultMode: "bypassPermissions",
  modelDetails: { "openrouter/test/model": { label: "Test model", efforts: ["medium", "high"] } },
};
const deepseekPi = {
  ...pi,
  models: [...pi.models, "deepseek/deepseek-v4-pro", "deepseek/deepseek-flash"],
};
const providers = [
  {
    id: "claude",
    label: "Claude",
    ok: true,
    models: ["sonnet"],
    defaultModel: "sonnet",
    modelDetails: { sonnet: { efforts: ["medium", "high"] } },
    modes,
    defaultMode: "default",
    accounts: [
      { id: "sunny", label: "Sunny", ready: true },
      { id: "nefro", label: "Nefro", ready: true },
    ],
  },
  pi,
  {
    id: "codex",
    label: "Codex",
    ok: true,
    models: ["gpt-6.1-sol"],
    defaultModel: "gpt-6.1-sol",
    modes,
    defaultMode: "default",
  },
];
const threads = [
  mkThread("claude", "claude", "sonnet", 1000),
  mkThread("openrouter", "pi", "openrouter/test/model", 12000),
  mkThread("deepseek", "pi", "deepseek/deepseek-v4-pro", 34000),
  mkThread("codex", "codex", "gpt-6.1-sol", 56000),
];
const balances = {
  updatedAt: now,
  available: true,
  windows: [],
  balances: [
    { currency: "USD", total: 12.5, granted: 2, toppedUp: 10.5 },
    { currency: "CNY", total: 0, granted: 0, toppedUp: 0 },
  ],
};
try {
  for (const width of [1280, 390]) {
    const ctx = await browser.newContext({
      viewport: { width, height: 900 },
      colorScheme: "dark",
      recordVideo: { dir: "/tmp/ac-deepseek-videos", size: { width, height: 900 } },
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(10000);
    const errors: string[] = [],
      sent: any[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let client: any;
    await page.routeWebSocket(/\/ws$/, (socket) => {
      client = socket;
      socket.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        sent.push(message);
        if (message.t === "open")
          socket.send(
            JSON.stringify({
              t: "history",
              thread: message.thread,
              request: message.request,
              events: [],
              start: 0,
              end: 0,
              total: 0,
            }),
          );
      });
      socket.send(
        JSON.stringify({
          t: "hello",
          providers,
          threads,
          dirs: ["/tmp"],
          tasks: [],
          commands: {},
          usage: {
            claude: {
              updatedAt: now,
              windows: [{ label: "5-hour", used: 100, limit: 100, unit: "%" }],
            },
            pi: { updatedAt: now, windows: [{ label: "Free/day", used: 40, limit: 50 }] },
            codex: {
              updatedAt: now,
              windows: [{ label: "5-hour", used: 15, limit: 100, unit: "%" }],
            },
          },
        }),
      );
    });
    await page.goto(base);
    await page.waitForSelector("#usage-provider", { state: "attached" });
    if (width === 390) await page.locator("#menu").click();
    const selector = page.locator("#usage-provider");
    const ensureNav = async () => {
      if (width === 390 && (await page.locator("#menu").getAttribute("aria-expanded")) !== "true")
        await page.locator("#menu").click();
    };
    const selectUsage = async (label: string) => {
      await ensureNav();
      await selector.click();
      await page
        .getByRole("listbox", { name: "Usage account", exact: true })
        .getByRole("option", { name: label, exact: true })
        .click();
    };
    const color = async () =>
      page
        .locator("#usage .bar i")
        .first()
        .evaluate((e) => getComputedStyle(e).backgroundColor);
    await selectUsage("Claude · Sunny");
    const red = await color();
    await selectUsage("Codex");
    const green = await color();
    await selectUsage("OpenRouter");
    const amber = await color();
    assert.equal(new Set([red, green, amber]).size, 3);
    assert.match(await page.locator("#usage").innerText(), /40 \/ 50/);
    await page.locator("#input").fill("Draft preserved during catalog refresh");
    await page.locator("#new").click();
    const dialog = page.locator("#dlg");
    await dialog.waitFor();
    await page.locator("#d-prov").click();
    await page.getByRole("option", { name: "Pi", exact: true }).click();
    await page.locator("#d-effort").click();
    await page.getByRole("option", { name: "Effort · High", exact: true }).click();
    const before = await page.locator("#d-model, #d-effort, #d-mode").allTextContents();
    client.send(
      JSON.stringify({
        t: "providers",
        providers: providers.map((p) => (p.id === "pi" ? deepseekPi : p)),
      }),
    );
    await page.locator("#d-model").click();
    await page.getByRole("option", { name: "deepseek-v4-pro", exact: false }).waitFor();
    await page.screenshot({ path: `/tmp/ac-deepseek-models-${width}.png` });
    await page.keyboard.press("Escape");
    assert.deepEqual(
      await page.locator("#d-model, #d-effort, #d-mode").allTextContents(),
      before,
      "catalog refresh preserves model, effort, and permission selections",
    );
    assert.equal(
      await page.locator("#input").innerText(),
      "Draft preserved during catalog refresh",
    );
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await ensureNav();
    await page.locator("#input").fill("");
    assert.equal(
      await selector.innerText(),
      "OpenRouter",
      "catalog refresh preserves selected usage account",
    );
    await selector.click();
    assert.deepEqual(
      await page
        .getByRole("listbox", { name: "Usage account", exact: true })
        .locator(".m-label")
        .allTextContents(),
      ["Claude · Sunny", "Claude · Nefro", "OpenRouter", "DeepSeek", "Codex"],
    );
    await page.keyboard.press("Escape");
    await selectUsage("DeepSeek");
    assert.match(await page.locator("#usage").innerText(), /DeepSeek balance not loaded yet/);
    client.send(JSON.stringify({ t: "usage", provider: "pi:deepseek", usage: balances }));
    await page.getByText("USD 12.50 total balance", { exact: true }).waitFor();
    const text = await page.locator("#usage").innerText();
    assert.match(text, /USD 2.00 granted · USD 10.50 topped up/);
    assert.match(text, /CNY 0.00 total balance/);
    assert.equal(
      await page.locator("#usage-panel > .u").count(),
      0,
      "balance has no allowance meters",
    );
    assert.equal(
      await page.locator("#usage .u-ctx [role=meter]").getAttribute("aria-valuenow"),
      "34000",
      "DeepSeek account uses DeepSeek thread context",
    );
    await page.screenshot({ path: `/tmp/ac-deepseek-usage-${width}.png` });
    await selectUsage("OpenRouter");
    assert.equal(
      await page.locator("#usage .u-ctx [role=meter]").getAttribute("aria-valuenow"),
      "12000",
    );
    const selectorNode = await selector.elementHandle();
    await selector.click();
    const menuNode = await page
      .getByRole("listbox", { name: "Usage account", exact: true })
      .elementHandle();
    client.send(
      JSON.stringify({ t: "thread", thread: { ...threads[3], title: "Codex background update" } }),
    );
    await page.getByText("Codex background update", { exact: true }).waitFor();
    assert.ok(await selectorNode!.evaluate((e) => e.isConnected));
    assert.ok(await menuNode!.evaluate((e) => e.isConnected));
    await page.keyboard.press("Escape");
    client.send(
      JSON.stringify({
        t: "usage",
        provider: "pi:deepseek",
        usage: { ...balances, updatedAt: now + 60000 },
      }),
    );
    await selectUsage("DeepSeek");
    await page.locator("#usage .usage-stamp").waitFor();
    assert.equal(
      await page.locator("#usage .usage-stamp").getAttribute("title"),
      `Updated ${new Date(now + 60000).toLocaleString()}`,
    );
    await selectUsage("OpenRouter");
    client.send(JSON.stringify({ t: "usage", provider: "pi:deepseek", usage: balances }));
    client.send(
      JSON.stringify({ t: "thread", thread: { ...threads[3], title: "Balance update delivered" } }),
    );
    await page.getByText("Balance update delivered", { exact: true }).waitFor();
    assert.equal(
      await selector.innerText(),
      "OpenRouter",
      "balance updates never steal selected account",
    );
    await selectUsage("DeepSeek");
    client.send(JSON.stringify({ t: "providers", providers }));
    await page.locator("#new").click();
    await page.locator("#d-prov").click();
    await page.getByRole("option", { name: "Pi", exact: true }).click();
    await page.locator("#d-model").click();
    assert.equal(
      await page.getByRole("option", { name: "deepseek-v4-pro", exact: false }).count(),
      0,
    );
    await page.keyboard.press("Escape");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await ensureNav();
    assert.equal(
      await selector.innerText(),
      "DeepSeek",
      "saved balance retains tab when catalog lacks models",
    );
    await selectUsage("OpenRouter");
    await selector.press("ArrowDown");
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    assert.equal(await selector.innerText(), "Codex");
    await page
      .locator("#threads li", { has: page.locator(".t", { hasText: "deepseek fixture" }) })
      .first()
      .click();
    if (width === 390) await page.locator("#menu").click();
    assert.equal(
      await selector.innerText(),
      "DeepSeek",
      "opening DeepSeek thread selects its account",
    );
    await page.locator("#usage-ctx-info").click();
    await page.getByRole("dialog").waitFor();
    assert.match(await page.getByRole("dialog").innerText(), /Context: continue or compact\?/);
    await page.keyboard.press("Escape");
    await page
      .locator("#threads li", { has: page.locator(".t", { hasText: "claude fixture" }) })
      .first()
      .click();
    client.send(JSON.stringify({ t: "thread", thread: { ...threads[0], status: "running" } }));
    await page.locator("#stop").waitFor();
    for (const id of ["effort", "model", "mode"])
      assert.equal(
        await page.locator(`#${id}`).isVisible(),
        true,
        `${id} stays visible during a run`,
      );
    assert.equal(await page.locator("#send").isVisible(), false);
    await page.locator("#input").fill("queued follow-up");
    assert.equal(await page.locator("#send").isVisible(), true);
    assert.equal(await page.locator("#stop").isVisible(), false);
    await page.locator("#input").fill("");
    assert.ok(
      await page.evaluate(() => {
        const toolbar = document.querySelector(".toolbar")!;
        return (
          toolbar.scrollWidth <= toolbar.clientWidth + 1 &&
          [...toolbar.querySelectorAll("button")].every((b) => {
            const r = b.getBoundingClientRect();
            return !r.width || r.right <= innerWidth;
          })
        );
      }),
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    assert.deepEqual(errors, []);
    assert.equal(
      sent.some((m) => ["prompt", "create", "submit"].includes(m.t)),
      false,
    );
    console.log(
      `PASS ${width}px DeepSeek models, balance, catalog refresh, selection, context, no overflow`,
    );
    await ctx.close();
  }
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// Codemap dashboard (/maps) in real Chromium: add form, cards, drill navigation, arch.js wires, phone/desktop layout.
// public/ is served statically on a loopback port and /api/maps* is mocked with page.route, so no server or login is needed.
// Run: node test/codemap-ui.ts   (screenshots in /tmp/cm-t7)
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium, type Page } from "playwright";

const PUBLIC = path.join(import.meta.dirname, "..", "public");
const OUT = process.env.OUT || "/tmp/cm-t7";
fs.mkdirSync(OUT, { recursive: true });
let failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${extra}`);
  if (!ok) failed++;
};
const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://x").pathname;
  const rel = url === "/maps" ? "maps.html" : url.slice(1);
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
  res.end(fs.readFileSync(file));
});
await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
const BASE = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const now = Date.now();
const MAPS = [
  {
    slug: "agent-console",
    label: "agent-console",
    source: { kind: "local", ref: "~/repos/agent-console" },
    status: "ready",
    files: 412,
    modules: 9,
    loc: 61234,
    commit: "abc1234",
    described: true,
    updatedAt: now - 3_600_000,
  },
  {
    slug: "octo-cat",
    label: "octo/cat",
    source: { kind: "github", ref: "octo/cat" },
    status: "scanning",
    updatedAt: now - 5000,
  },
  {
    slug: "broken",
    label: "broken",
    source: { kind: "github", ref: "octo/broken" },
    status: "failed",
    error: "clone failed: repository not found",
    updatedAt: now - 86_400_000,
  },
];
const node = (id: string, label: string, icon: string, desc: string) => ({ id, label, icon, desc });
const SPEC = {
  title: "agent-console",
  subtitle: "9 modules",
  direction: "row",
  items: [
    {
      group: "Server",
      id: "g-server",
      items: [
        node("n-core", "Core", "server", "Sessions and routing"),
        node("n-api", "HTTP API", "globe", "Routes and auth"),
        node("n-store", "Store", "database", "SQLite state"),
      ],
    },
    {
      group: "Client",
      id: "g-client",
      items: [
        node("n-ui", "Web UI", "layout", "Chat and dashboards"),
        node("n-sw", "Service worker", "zap", "Offline and push"),
      ],
    },
  ],
  edges: [
    { from: "n-ui", to: "n-api", label: "fetch" },
    { from: "n-api", to: "n-core" },
    { from: "n-core", to: "n-store" },
    { from: "n-sw", to: "n-ui" },
  ],
};
const DRILL = { "n-core": "server.core", "n-api": "server.api", "n-ui": "client.ui" };
const VIEW = {
  spec: SPEC,
  drill: DRILL,
  crumbs: [{ id: null, label: "agent-console" }],
  details: {
    title: "agent-console",
    summary: "A self-hosted console for coding agents.",
    files: Array.from({ length: 12 }, (_, i) => ({ path: `server/file${i}.ts`, loc: 100 + i })),
  },
  flows: [{ id: "chat", title: "Chat turn" }],
};
const MODULE_VIEW = {
  ...VIEW,
  crumbs: [
    { id: null, label: "agent-console" },
    { id: "server.core", label: "Core" },
  ],
  details: {
    title: "Core",
    summary: "Sessions and routing.",
    files: [{ path: "server/core.ts", loc: 900 }],
  },
};

async function mockApi(page: Page, posts: string[]) {
  await page.route("**/api/maps**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (req.method() === "POST" && url.pathname === "/api/maps") {
      posts.push(req.postData() || "");
      return json(202, { slug: "new-one", status: "queued" });
    }
    if (req.method() === "POST") {
      posts.push(`${url.pathname} ${req.postData() || ""}`);
      return json(202, { ok: true });
    }
    if (url.pathname === "/api/maps") return json(200, { maps: MAPS });
    const nodeId = url.searchParams.get("node");
    return json(200, nodeId ? MODULE_VIEW : VIEW);
  });
}

async function overflow(page: Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}
async function smallTargets(page: Page) {
  return page.evaluate(() => {
    const sel =
      "#mp a, #mp button, #mp input, #mp summary, .dh a, .dh button, .diagram [role=button]";
    return [...document.querySelectorAll<HTMLElement>(sel)]
      .filter((e) => e.offsetParent !== null)
      .map((e) => ({ el: e, box: e.getBoundingClientRect() }))
      .filter(({ box }) => box.height < 43.5 || box.width < 43.5)
      .map(
        ({ el, box }) =>
          `${el.tagName}.${el.className}:${Math.round(box.width)}x${Math.round(box.height)}`,
      );
  });
}
const wires = (page: Page) => page.locator(".diagram .arch svg path").count();

const browser = await chromium.launch();
for (const [name, viewport, scheme] of [
  ["phone-light", { width: 390, height: 844 }, "light"],
  ["desktop-dark", { width: 1280, height: 900 }, "dark"],
] as const) {
  const ctx = await browser.newContext({
    viewport,
    colorScheme: scheme,
    hasTouch: name.startsWith("phone"),
  });
  const page = await ctx.newPage();
  const posts: string[] = [];
  const external: string[] = [];
  const errors: string[] = [];
  page.on("request", (req) => {
    const url = req.url();
    if (!/^(data:|blob:|about:)/.test(url) && !url.startsWith(BASE)) external.push(url);
  });
  page.on("pageerror", (err) => errors.push(String(err)));
  page.on("dialog", (dialog) => dialog.dismiss());
  await mockApi(page, posts);

  await page.goto(`${BASE}/maps#add`);
  await page.waitForSelector(".mp-card");
  check(`${name}: 3 cards`, (await page.locator(".mp-card").count()) === 3);
  check(
    `${name}: add input focused`,
    await page.evaluate(() => document.activeElement?.id === "source"),
  );
  const text = (await page.locator("#cards").textContent()) || "";
  check(
    `${name}: card facts`,
    /Local/.test(text) &&
      /GitHub/.test(text) &&
      /412 files/.test(text) &&
      /AI described/.test(text) &&
      /repository not found/.test(text),
  );
  check(`${name}: spinner while running`, (await page.locator(".chip .spin").count()) === 1);
  check(`${name}: dashboard no h-overflow`, (await overflow(page)) <= 0);
  check(
    `${name}: dashboard touch targets`,
    (await smallTargets(page)).length === 0,
    (await smallTargets(page)).join(" "),
  );
  if (name === "phone-light")
    await page.screenshot({ path: `${OUT}/dash-phone-light.png`, fullPage: true });

  await page.fill("#source", "~/repos/demo");
  await page.click("#addBtn");
  await page.waitForTimeout(200);
  check(
    `${name}: add posts source`,
    posts.some((body) => body.includes('"source":"~/repos/demo"')),
    posts.join("|"),
  );
  await page.click('.mp-card[data-slug="agent-console"] .mp-actions .danger');
  await page.waitForTimeout(100);
  check(
    `${name}: delete asks confirm (dismissed, no request)`,
    !posts.some((body) => body.includes("DELETE")),
  );

  await page.click('.mp-card[data-slug="agent-console"] a.mp-name');
  await page.waitForSelector('.diagram [data-id][role="button"]');
  check(`${name}: overview hash`, new URL(page.url()).hash === "#/agent-console");
  await page
    .waitForFunction(() => document.querySelectorAll(".diagram .arch svg path").length > 0, null, {
      timeout: 15000,
    })
    .catch(() => {});
  check(`${name}: wires drawn`, (await wires(page)) >= 4, String(await wires(page)));
  check(
    `${name}: drillable roles`,
    (await page.locator('.diagram [data-id][role="button"][tabindex="0"]').count()) === 3,
  );
  check(`${name}: flow tabs`, (await page.locator("#tabs a").count()) === 2);
  check(
    `${name}: long file list collapsed`,
    (await page.locator("#details details").count()) === 1,
  );
  check(`${name}: map no h-overflow`, (await overflow(page)) <= 0);
  check(
    `${name}: map touch targets`,
    (await smallTargets(page)).length === 0,
    (await smallTargets(page)).join(" "),
  );
  const scrolls = await page.evaluate(() => {
    const box = document.querySelector<HTMLElement>(".diagram");
    return !!box && getComputedStyle(box).overflowX === "auto";
  });
  check(`${name}: diagram scrolls inside container`, scrolls);
  await page.evaluate(() => {
    const box = document.getElementById("toast");
    if (box) box.hidden = true;
  });
  await page.screenshot({ path: `${OUT}/map-${name}.png`, fullPage: true });

  await page.click('.diagram [data-id="n-core"]');
  await page.waitForFunction(() => location.hash === "#/agent-console/server.core");
  check(`${name}: click drills`, true);
  await page.waitForSelector(".crumbs a");
  check(
    `${name}: crumbs show path`,
    ((await page.locator("#crumbs").textContent()) || "").includes("Core"),
  );
  await page.goBack();
  await page.waitForSelector('.diagram [data-id="n-api"][role="button"]');
  await page.focus('.diagram [data-id="n-api"]');
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => location.hash === "#/agent-console/server.api");
  check(`${name}: Enter drills`, true);

  await page.goto(`${BASE}/maps#/agent-console/flow/chat`);
  await page.waitForSelector('#tabs a[aria-selected="true"]');
  check(
    `${name}: flow tab selected`,
    ((await page.locator('#tabs a[aria-selected="true"]').textContent()) || "") === "Chat turn",
  );
  check(`${name}: no page errors`, errors.length === 0, errors.join("|"));
  check(`${name}: zero external requests`, external.length === 0, external.join(" "));
  await ctx.close();
}
await browser.close();
server.close();
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);

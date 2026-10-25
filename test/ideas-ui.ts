// App ideas page in real Chromium: list from index.md, add an idea through the form (committed to git), open its markdown,
// 44px touch targets, no horizontal overflow on a phone, first-party only. Needs a scratch server whose AGENT_CONSOLE_IDEAS
// points under the temp dir (refuses to write to a real ideas repo).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { chromium } from "playwright";
import { makeToken } from "../server/auth.ts";

const BASE = process.env.BASE || "http://127.0.0.1:7071";
const OUT = process.env.OUT || "/tmp";
let failed = 0;
const check = (n: string, ok: boolean, x = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${n} ${x}`);
  if (!ok) failed++;
};
const cookie = `ac_session=${makeToken()}`;
const { dir } = await (await fetch(`${BASE}/api/ideas`, { headers: { cookie } })).json();
if (!String(dir).startsWith(os.tmpdir())) {
  console.log(`refusing: ideas repo ${dir} is not under ${os.tmpdir()}`);
  process.exit(1);
}
const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();

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
  await ctx.addCookies([{ name: "ac_session", value: makeToken(), url: BASE }]);
  const page = await ctx.newPage();
  const errors: string[] = [],
    external: string[] = [];
  page.on(
    "console",
    (m) =>
      m.type() === "error" &&
      !/status of 409/.test(m.text()) /* the duplicate check below */ &&
      errors.push(m.text()),
  );
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("request", (r) => {
    const u = r.url();
    if (!/^(data:|blob:|about:)/.test(u) && !u.startsWith(BASE)) external.push(u);
  });
  await page.goto(`${BASE}/ideas`);
  await page.waitForFunction(
    () => document.getElementById("im")!.getAttribute("aria-busy") === "false",
  );
  const before = await page.locator("#list li").count();

  // add through the form: the list grows, and one commit holds index.md and the new file
  const idea = `Cloud Diary ${name}`,
    slug = `cloud-diary-${name}`;
  await page.click("#add");
  check(`${name}: New idea opens the form`, await page.locator("#form").isVisible());
  await page.fill("#name", idea);
  await page.fill("#line", "Photo log of interesting clouds");
  await page.click("#save");
  await page.waitForFunction((n) => document.querySelectorAll("#list li").length === n, before + 1);
  check(
    `${name}: added idea shows in the list`,
    (await page.locator("#list li").last().innerText()).includes(idea),
  );
  check(`${name}: form closes after adding`, await page.locator("#form").isHidden());
  check(
    `${name}: toast names the commit`,
    /Committed [0-9a-f]{7}/.test(await page.locator("#toast").innerText()),
  );
  check(
    `${name}: index.md has the entry`,
    fs
      .readFileSync(`${dir}/index.md`, "utf8")
      .includes(`- [${idea}](${slug}.md) — Photo log of interesting clouds`),
  );
  check(
    `${name}: commit holds index.md and ${slug}.md`,
    git("log", "-1", "--format=%s") === `Add idea: ${idea}` &&
      git("show", "--name-only", "--format=", "HEAD").split("\n").sort().join() ===
        ["index.md", `${slug}.md`].sort().join(),
  );

  // a duplicate is refused in the form, not silently dropped
  await page.click("#add");
  await page.fill("#name", idea);
  await page.fill("#line", "again");
  await page.click("#save");
  await page.waitForSelector("#formErr:not([hidden])");
  check(
    `${name}: duplicate name explains itself`,
    /already exists/.test(await page.locator("#formErr").innerText()),
  );
  await page.click("#cancel");

  // touch targets and layout on the list
  const small = await page.evaluate(() =>
    [...document.querySelectorAll("a, button, input")]
      .filter((e) => (e as HTMLElement).offsetParent)
      .map((e) => {
        const r = e.getBoundingClientRect();
        return { id: e.id || e.textContent!.trim().slice(0, 20), h: r.height, w: r.width };
      })
      .filter((r) => r.h < 44 || r.w < 44),
  );
  check(
    `${name}: every visible control is at least 44px`,
    small.length === 0,
    JSON.stringify(small),
  );
  check(
    `${name}: no horizontal overflow`,
    !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)),
  );
  await page.screenshot({ path: `${OUT}/ideas-${name}-list.png`, fullPage: true });

  // open the idea: its markdown renders, back returns to the list
  await page.click(`#list a[href="#/${slug}"]`);
  await page.waitForSelector("#detail h2");
  check(
    `${name}: idea opens its markdown`,
    (await page.locator("#detail h1").innerText()) === idea &&
      (await page.locator("#detail h2").allInnerTexts()).join() ===
        "Features,Implementation,Others",
  );
  check(
    `${name}: header names the idea`,
    (await page.locator("#title").innerText()) === idea &&
      (await page.locator("#backLabel").innerText()) === "Ideas",
  );
  await page.screenshot({ path: `${OUT}/ideas-${name}-detail.png`, fullPage: true });

  // plus button adds a bullet under the chosen section; the page re-renders and git holds one commit
  check(
    `${name}: plus button shows on the idea, New idea hides`,
    (await page.locator("#addBullet").isVisible()) && (await page.locator("#add").isHidden()),
  );
  await page.click("#addBullet");
  await page.locator(".seg label", { hasText: "Implementation" }).click();
  await page.fill("#bullet", "SQLite + cron");
  await page.screenshot({ path: `${OUT}/ideas-${name}-bullet-form.png`, fullPage: true });
  await page.click("#bulletSave");
  await page.waitForSelector("#detail li");
  check(
    `${name}: bullet renders in the body`,
    (await page.locator("#detail li").first().innerText()) === "SQLite + cron",
  );
  check(`${name}: bullet form closes`, await page.locator("#bulletForm").isHidden());
  check(
    `${name}: bullet commit`,
    git("log", "-1", "--format=%s") === `Add implementation bullet: ${idea}` &&
      /## Implementation\n\n- SQLite \+ cron\n\n## Others/.test(
        fs.readFileSync(`${dir}/${slug}.md`, "utf8"),
      ),
  );
  await page.screenshot({ path: `${OUT}/ideas-${name}-detail-bullet.png`, fullPage: true });
  await page.click("#back");
  await page.waitForSelector("#listView:not([hidden])");
  check(
    `${name}: back returns to the list`,
    (await page.locator("#title").innerText()) === "App ideas" &&
      (await page.locator("#add").isVisible()),
  );
  check(
    `${name}: no console errors, first-party only`,
    errors.length === 0 && external.length === 0,
    errors.concat(external).join(" | ").slice(0, 200),
  );
  await ctx.close();
}
const cross = await fetch(`${BASE}/api/ideas`, {
  method: "POST",
  headers: { cookie, origin: "https://evil.example", "content-type": "application/json" },
  body: JSON.stringify({ name: "x", line: "y" }),
});
check("api: cross-site add is refused", cross.status === 403);
const missing = await fetch(`${BASE}/api/ideas/nope`, { headers: { cookie } });
check("api: unknown idea is 404", missing.status === 404);

// ---- Brain screen (/brain): stubbed API, list renders, filters/search work, graph loads lazily and toggles, sheet opens ----
const brainGraph = {
  v: 1,
  generatedAt: "2026-10-24T00:00:00.000Z",
  pages: [
    {
      slug: "agent-console",
      layer: "wiki",
      type: "project",
      description: "Personal agent PWA",
      updated: "2026-10-24",
      tags: ["pwa", "agents"],
      links: ["agent-console-ui"],
      path: "wiki/agent-console.md",
    },
    {
      slug: "agent-console-ui",
      layer: "wiki",
      type: "project",
      description: "UI topics",
      updated: "2026-10-20",
      tags: ["pwa"],
      links: [],
      path: "wiki/agent-console-ui.md",
    },
    {
      slug: "nightly-run",
      layer: "ops",
      type: "ops",
      description: "Nightly maintenance log",
      updated: "2026-10-22",
      tags: ["agents"],
      links: [],
      path: "ops/nightly-run.md",
    },
  ],
  tags: [
    { name: "pwa", description: "Progressive web apps", aliases: [], count: 2 },
    { name: "agents", description: "Coding agents", aliases: ["agent"], count: 2 },
  ],
  edges: [
    { source: "page:agent-console", target: "tag:pwa", kind: "tag" },
    { source: "page:agent-console", target: "tag:agents", kind: "tag" },
    { source: "page:agent-console-ui", target: "tag:pwa", kind: "tag" },
    { source: "page:nightly-run", target: "tag:agents", kind: "tag" },
    { source: "page:agent-console", target: "page:agent-console-ui", kind: "link" },
  ],
};
async function stubBrain(page: import("playwright").Page, searched: string[], old = false) {
  await page.route("**/api/brain/**", async (route) => {
    const url = new URL(route.request().url());
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (old) return json(503, { error: "brain CLI lacks graph support" });
    if (url.pathname === "/api/brain/graph") return json(200, brainGraph);
    if (url.pathname === "/api/brain/search") {
      searched.push(url.searchParams.get("q") || "");
      return json(200, [
        {
          path: "wiki/agent-console-ui.md",
          slug: "agent-console-ui",
          layer: "wiki",
          score: 3,
          snippet: "matched the stub snippet",
        },
      ]);
    }
    const slug = url.pathname.split("/").pop();
    return json(200, {
      slug,
      layer: "wiki",
      markdown: `# ${slug}\n\nStub body with [[nightly-run]].`,
    });
  });
}
for (const [name, viewport, scheme] of [
  ["phone", { width: 390, height: 844 }, "light"],
  ["desktop", { width: 1280, height: 800 }, "dark"],
] as const) {
  const ctx = await browser.newContext({
    viewport,
    colorScheme: scheme,
    hasTouch: name === "phone",
  });
  await ctx.addCookies([{ name: "ac_session", value: makeToken(), url: BASE }]);
  const page = await ctx.newPage();
  const errors: string[] = [],
    requests: string[] = [],
    searched: string[] = [];
  page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
  page.on("pageerror", (failure) => errors.push(String(failure)));
  page.on("request", (request) => requests.push(request.url()));
  await stubBrain(page, searched);
  await page.goto(`${BASE}/brain`);
  await page.waitForFunction(
    () => document.getElementById("bm")!.getAttribute("aria-busy") === "false",
  );
  const rows = () => page.locator("#pageList li .n").allInnerTexts();
  const phone = name === "phone";
  if (phone) {
    check(
      `brain ${name}: List is the default view`,
      (await page.locator("#viewList").getAttribute("aria-pressed")) === "true",
    );
  } else await page.click("#viewList");
  check(
    `brain ${name}: list shows pages by updated desc`,
    (await rows()).join() === "agent-console,nightly-run,agent-console-ui",
    (await rows()).join(),
  );
  if (phone)
    check(
      `brain ${name}: graph library not fetched while list is shown`,
      !requests.some((url) => url.includes("cytoscape")),
    );
  await page.screenshot({ path: `${OUT}/brain-${name}-list.png`, fullPage: true });

  await page.fill("#q", "nightly");
  check(
    `brain ${name}: text search filters the list`,
    (await rows()).join() === "nightly-run",
    (await rows()).join(),
  );
  await page.fill("#q", "");
  await page.click("#tagFilter");
  await page.locator('.menu [data-value="pwa"]').click();
  check(
    `brain ${name}: tag menu filters pages`,
    (await rows()).join() === "agent-console,agent-console-ui",
    (await rows()).join(),
  );
  await page.click("#tagFilter");
  check(
    `brain ${name}: menu exposes selected tags`,
    (await page.locator('.menu [data-value="pwa"]').getAttribute("aria-selected")) === "true" &&
      (await page.locator(".menu").getAttribute("aria-multiselectable")) === "true",
  );
  await page.locator('.menu [data-value="agents"]').click();
  check(`brain ${name}: multiple tags use AND matching`, (await rows()).join() === "agent-console");
  await page.click("#tagFilter");
  await page.keyboard.press("Escape");
  check(
    `brain ${name}: Escape closes menu and returns focus`,
    (await page.locator(".menu").count()) === 0 &&
      (await page.locator("#tagFilter").evaluate((node) => node === document.activeElement)),
  );
  await page.click("#tagFilter");
  await page.locator('.menu [data-value="null"]').click();
  check(
    `brain ${name}: Clear tags restores all pages`,
    (await rows()).length === 3 &&
      (await page.locator("#tagFilterLabel").innerText()) === "All tags",
  );
  await page.fill("#q", "ui topics");
  await page.press("#q", "Enter");
  await page.waitForSelector("#pageList .snip");
  check(
    `brain ${name}: Enter asks the server and shows the snippet`,
    searched[0] === "ui topics" &&
      /stub snippet/.test(await page.locator("#pageList .snip").innerText()),
  );
  await page.fill("#q", "");

  await page.click("#tabTags");
  check(
    `brain ${name}: tags tab lists tags with counts`,
    (await page.locator("#tagList li").allInnerTexts()).every((text) => /2 pages/.test(text)) &&
      (await page.locator("#tagList li").count()) === 2,
  );
  await page.click("#tabPages");

  await page.locator("#pageList a", { hasText: "agent-console-ui" }).first().click();
  await page.waitForSelector("#sheetBody h1");
  check(
    `brain ${name}: page sheet renders markdown`,
    (await page.locator("#sheetBody h1").innerText()) === "agent-console-ui" &&
      (await page.locator("#sheetTitle").innerText()) === "agent-console-ui",
  );
  check(
    `brain ${name}: sheet links [[wiki]] pages`,
    (await page.locator('#sheetBody .prose a[href="#/page/nightly-run"]').count()) === 1,
  );
  const related = await page.locator("#sheetBody section li .n").allInnerTexts();
  check(
    `brain ${name}: related via tags ranked`,
    related.join() === "agent-console",
    related.join(),
  );
  await page.screenshot({ path: `${OUT}/brain-${name}-sheet.png` });
  await page.click("#sheetClose");
  check(`brain ${name}: sheet closes`, await page.locator("#sheet").isHidden());

  await page.click("#viewGraph");
  await page.waitForFunction(() => document.getElementById("cy")!.dataset.nodes);
  const counts = () =>
    page.evaluate(() => ({
      n: document.getElementById("cy")!.dataset.nodes,
      e: document.getElementById("cy")!.dataset.edges,
    }));
  check(
    `brain ${name}: graph loads cytoscape lazily with 3 pages + 2 tags`,
    requests.some((url) => url.includes("/vendor/cytoscape")) &&
      (await counts()).n === "5" &&
      (await counts()).e === "4",
    JSON.stringify(await counts()),
  );
  check(
    `brain ${name}: legend identifies node categories and connections`,
    (await page.locator(".graph-legend li").count()) === 5,
  );
  const phoneWidth = await page.evaluate(() => innerWidth < 600);
  check(
    `brain ${name}: legend starts ${phoneWidth ? "collapsed" : "open"}`,
    (await page.locator("#legendToggle").getAttribute("aria-expanded")) === String(!phoneWidth) &&
      (await page.locator("#legendBody").isVisible()) === !phoneWidth,
  );
  if (phoneWidth) {
    await page.click("#legendToggle");
    check(
      `brain ${name}: legend button opens the legend`,
      (await page.locator("#legendToggle").getAttribute("aria-expanded")) === "true" &&
        (await page.locator("#legendBody").isVisible()),
    );
    await page.click("#legendToggle");
  }
  check(
    `brain ${name}: graph controls float over the canvas and stay 44px`,
    await page.evaluate(() => {
      const wrap = document.querySelector(".graph-wrap")!.getBoundingClientRect();
      const toolbar = document.querySelector(".graph-toolbar")!;
      const inside = (box: DOMRect) => box.left >= wrap.left && box.right <= wrap.right;
      return (
        inside(toolbar.getBoundingClientRect()) &&
        ["zoomOut", "zoomIn", "fitGraph", "linksToggle"].every((buttonId) => {
          const box = document.getElementById(buttonId)!.getBoundingClientRect();
          return box.width >= 44 && box.height >= 44 && inside(box);
        })
      );
    }),
  );
  const graphBefore = await page.evaluate(() => {
    const graph = (document.getElementById("cy") as any).__cy;
    return {
      zoom: graph.zoom(),
      positions: graph.nodes().map((node: any) => node.position()),
      uniform: graph.nodes().every((node: any) => node.width() === 24 && node.height() === 24),
      shapes: graph.nodes().map((node: any) => node.style("shape")),
    };
  });
  check(
    `brain ${name}: nodes have equal size and distinct category shapes`,
    graphBefore.uniform &&
      ["ellipse", "diamond", "round-rectangle"].every((shape) =>
        graphBefore.shapes.includes(shape),
      ),
  );
  await page.click("#zoomIn");
  check(
    `brain ${name}: zoom in increases viewport scale`,
    (await page.evaluate(() => (document.getElementById("cy") as any).__cy.zoom())) >
      graphBefore.zoom,
  );
  await page.click("#zoomOut");
  await page.click("#fitGraph");
  check(
    `brain ${name}: viewport controls preserve node positions`,
    JSON.stringify(
      await page.evaluate(() =>
        (document.getElementById("cy") as any).__cy.nodes().map((node: any) => node.position()),
      ),
    ) === JSON.stringify(graphBefore.positions),
  );
  check(
    `brain ${name}: fit keeps nodes clear of the floating toolbar`,
    await page.evaluate(() => {
      const graph = (document.getElementById("cy") as any).__cy;
      const canvas = document.getElementById("cy")?.getBoundingClientRect();
      const tools = document.querySelector(".graph-toolbar")?.getBoundingClientRect();
      if (!canvas || !tools) return false;
      return graph.nodes().renderedBoundingBox().y1 + canvas.top >= tools.bottom;
    }),
  );
  await page.click("#linksToggle");
  await page.waitForFunction(() => document.getElementById("cy")!.dataset.edges === "5");
  check(`brain ${name}: Links toggle adds the page-page edge`, (await counts()).e === "5");
  await page.click("#linksToggle");
  await page.waitForFunction(() => document.getElementById("cy")!.dataset.edges === "4");
  const tap = await page.evaluate(() => {
    const cyEl = document.getElementById("cy") as any;
    const node = cyEl.__cy.getElementById("tag:pwa");
    const box = cyEl.getBoundingClientRect();
    return { x: box.left + node.renderedPosition("x"), y: box.top + node.renderedPosition("y") };
  });
  await page.mouse.click(tap.x, tap.y);
  await page.waitForSelector("#sheet:not([hidden])");
  check(
    `brain ${name}: tapping a tag node opens its sheet`,
    (await page.locator("#sheetTitle").innerText()) === "pwa" &&
      (await page.locator("#sheetBody li").count()) === 2,
  );
  await page.screenshot({ path: `${OUT}/brain-${name}-graph.png` });
  await page.click("#sheetClose");
  check(
    `brain ${name}: no horizontal overflow`,
    !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)),
  );
  const small = await page.evaluate(() =>
    [...document.querySelectorAll("a, button, input")]
      .filter((node) => (node as HTMLElement).offsetParent)
      .map((node) => {
        const box = node.getBoundingClientRect();
        return { id: node.id || node.textContent!.trim().slice(0, 20), h: box.height };
      })
      .filter((box) => box.h < 44),
  );
  check(
    `brain ${name}: visible controls are at least 44px tall`,
    small.length === 0,
    JSON.stringify(small),
  );
  check(
    `brain ${name}: no console errors, first-party only`,
    errors.length === 0 &&
      requests.every((url) => /^(data:|blob:|about:)/.test(url) || url.startsWith(BASE)),
    errors.join(" | ").slice(0, 200),
  );
  await ctx.close();
}
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addCookies([{ name: "ac_session", value: makeToken(), url: BASE }]);
  const page = await ctx.newPage();
  await stubBrain(page, [], true);
  await page.goto(`${BASE}/brain`);
  await page.waitForFunction(
    () => document.getElementById("bm")!.getAttribute("aria-busy") === "false",
  );
  check(
    "brain: an old CLI shows the 503 message",
    /lacks graph support/.test(await page.locator("#status").innerText()),
  );
  await ctx.close();
}
await browser.close();
if (failed) {
  console.log(`\n${failed} FAILED`);
  process.exit(1);
}
console.log("\nall ideas checks passed");

// Thread graph page and API on a scratch server (#421): auth, builder output over seeded threads and logs, then the page in real Chromium
// (graph counts, tap sheet, phone cluster list, 44px targets). Screenshots go to OUT (default /tmp/w421/graph-shots).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ac-thread-graph-"));
const data = path.join(scratch, "data");
const OUT = process.env.OUT || "/tmp/w421/graph-shots";
fs.mkdirSync(path.join(data, "logs"), { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const now = Date.now();
const thread = (id: string, provider: string, extra: object = {}) => ({
  id,
  provider,
  title: `Thread ${id}`,
  cwd: scratch,
  mode: "default",
  model: "mock",
  status: "idle",
  cost: 0,
  createdAt: now - 60_000,
  updatedAt: now - 1000,
  ...extra,
});
const use = (name: string, input: object) =>
  JSON.stringify({
    ts: now - 5000,
    type: "assistant",
    message: { content: [{ type: "tool_use", id: name, name, input }] },
  });
const seeded = [
  thread("aaaa", "claude", { status: "running" }),
  thread("bbbb", "codex", { forkedFrom: "aaaa", waiting: 1 }),
  thread("cccc", "pi"),
  thread("dddd", "claude", { archived: now - 500 }),
  thread("eeee", "codex", { updatedAt: now - 30 * 86400e3 }),
];
fs.writeFileSync(path.join(data, "threads.json"), JSON.stringify(seeded));
const shared = path.join(scratch, "shared.ts");
for (const id of ["aaaa", "cccc"])
  fs.writeFileSync(
    path.join(data, "logs", `${id}.jsonl`),
    `${use("Read", { file_path: shared })}\n`,
  );
fs.writeFileSync(
  path.join(data, "logs", "bbbb.jsonl"),
  `${JSON.stringify({ ts: now - 4000, type: "user_input", text: "hi", sourceThread: { id: "cccc", title: "c", provider: "pi" } })}\n`,
);

const listener = net.createServer();
await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = (listener.address() as net.AddressInfo).port;
await new Promise<void>((resolve) => listener.close(() => resolve()));
const origin = `http://127.0.0.1:${port}`;
const password = randomBytes(24).toString("base64url");
const child = spawn(process.execPath, ["server/index.ts"], {
  cwd: repo,
  env: {
    ...process.env,
    PORT: String(port),
    AGENT_CONSOLE_DATA: data,
    AGENT_CONSOLE_RUN: path.join(scratch, "run"),
    AGENT_CONSOLE_MOCK: "1",
    AGENT_CONSOLE_AUTH: "password",
    AGENT_CONSOLE_PASSWORD: password,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stderr.on("data", (chunk) => process.env.BG_DEBUG && process.stderr.write(chunk));
let failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${extra}`);
  if (!ok) failed++;
};
try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Scratch server startup timed out.")), 30_000);
    child.once("exit", (code) => reject(new Error(`Scratch server exited: ${code}`)));
    let output = "";
    child.stdout.on("data", (chunk) => {
      output = (output + chunk.toString()).slice(-2048);
      if (output.includes("agent-console listening on")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  const login = await fetch(`${origin}/login`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const get = (route: string, withCookie = true) =>
    fetch(origin + route, { headers: withCookie ? { Cookie: cookie } : {} });

  assert.equal((await get("/api/thread-graph", false)).status, 401);
  assert.equal((await get("/graph", false)).status === 200, false, "page needs login");
  let body: any = {};
  for (let attempt = 0; attempt < 20; attempt++) {
    const reply = await get("/api/thread-graph");
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get("cache-control"), "no-store");
    body = await reply.json();
    if (!body.syncing && body.edges.some((edge: any) => edge.kind === "file")) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const kinds = body.edges.map((edge: any) => edge.kind);
  assert.ok(
    kinds.includes("fork") && kinds.includes("file") && kinds.includes("peer"),
    kinds.join(),
  );
  assert.equal(body.nodes.length, 5);
  assert.equal(
    (await (await get(`/api/thread-graph?since=${now - 86400e3}`)).json()).nodes.length,
    4,
    "window drops the old thread",
  );
  check("api: auth, no-store, fork/file/peer edges, window", true);

  const browser = await chromium.launch();
  const host = new URL(origin).hostname;
  const open = async (
    name: string,
    viewport: { width: number; height: number },
    phone: boolean,
  ) => {
    const ctx = await browser.newContext({
      viewport,
      hasTouch: phone,
      colorScheme: phone ? "light" : "dark",
    });
    await ctx.addCookies([
      {
        name: "__Host-ac_session",
        value: cookie.split("=")[1],
        domain: host,
        path: "/",
        secure: true,
      },
    ]);
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => {
      errors.push(String(error));
      if (process.env.BG_DEBUG) console.log("pageerror", String(error));
    });
    page.on(
      "console",
      (m) => process.env.BG_DEBUG && console.log("console", m.type(), m.text().slice(0, 200)),
    );
    await page.goto(`${origin}/graph`);
    await page.waitForSelector("#clusters section", { state: "attached" });
    return { page, errors, name, ctx };
  };

  const desktop = await open("desktop", { width: 1280, height: 900 }, false);
  await desktop.page.waitForSelector("#cy[data-nodes]");
  const dims = async () =>
    desktop.page.evaluate(() => ({
      nodes: Number(document.getElementById("cy")!.dataset.nodes),
      edges: Number(document.getElementById("cy")!.dataset.edges),
    }));
  await desktop.page.waitForFunction(
    () => Number(document.getElementById("cy")!.dataset.edges) > 0,
  );
  const counts = await dims();
  check(
    "desktop graph draws threads (archived and 30d-old hidden/in window)",
    counts.nodes >= 3 && counts.edges >= 2,
    JSON.stringify(counts),
  );
  const where = await desktop.page.evaluate(() => {
    const cy = (document.getElementById("cy") as any).__cy;
    const node = cy.getElementById("aaaa");
    const spot = node.renderedPosition();
    const box = document.getElementById("cy")!.getBoundingClientRect();
    return { x: box.left + spot.x, y: box.top + spot.y };
  });
  await desktop.page.mouse.click(where.x, where.y);
  await desktop.page.waitForSelector("#sheet:not([hidden])");
  const link = await desktop.page.getAttribute("#sheetBody a.open", "href");
  check("tap opens sheet with Open thread link", link === "/#thread=aaaa", String(link));
  check(
    "sheet lists shared keys",
    (await desktop.page.textContent("#sheetBody"))!.includes("file:"),
  );
  const clear = await desktop.page.evaluate(() => {
    const cy = (document.getElementById("cy") as any).__cy;
    const sheetLeft = document.getElementById("sheet")!.getBoundingClientRect().left;
    const box = document.getElementById("cy")!.getBoundingClientRect();
    const right = Math.max(
      ...cy.nodes().map((node: any) => box.left + node.renderedBoundingBox().x2),
    );
    return { right, sheetLeft, font: cy.zoom() * 12 };
  });
  check("no node under the open sheet", clear.right <= clear.sheetLeft, JSON.stringify(clear));
  check("labels stay at 14px or smaller at fit zoom", clear.font <= 14, String(clear.font));
  const moved = await desktop.page.evaluate(() => {
    const spot = (document.getElementById("cy") as any).__cy
      .getElementById("bbbb")
      .renderedPosition();
    const box = document.getElementById("cy")!.getBoundingClientRect();
    return { x: box.left + spot.x, y: box.top + spot.y };
  });
  await desktop.page.mouse.move(moved.x, moved.y);
  await desktop.page.waitForSelector("#tip:not([hidden])");
  await desktop.page.screenshot({ path: path.join(OUT, "graph-desktop.png") });
  await desktop.page.click("#fProvider");
  await desktop.page.selectOption("#fProvider", "pi");
  await desktop.page.waitForFunction(
    () => Number(document.getElementById("cy")!.dataset.nodes) < 3,
  );
  check("provider filter narrows the graph", (await dims()).nodes < counts.nodes);
  check("no page errors (desktop)", desktop.errors.length === 0, desktop.errors.join("; "));

  const phone = await open("phone", { width: 390, height: 844 }, true);
  const shown = await phone.page.evaluate(() => ({
    list: !(document.getElementById("listView") as HTMLElement).hidden,
    clusters: document.getElementById("clusters")!.dataset.clusters,
    small: [
      ...document.querySelectorAll("#viewToggle button, .filters select, #clusters a.row"),
    ].filter((node) => node.getBoundingClientRect().height < 43.5).length,
    overflow: document.documentElement.scrollWidth > innerWidth,
  }));
  check(
    "phone defaults to the cluster list",
    shown.list && Number(shown.clusters) >= 1,
    JSON.stringify(shown),
  );
  check("phone targets are at least 44px", shown.small === 0, String(shown.small));
  check("phone has no horizontal overflow", !shown.overflow);
  await phone.page.screenshot({ path: path.join(OUT, "graph-phone-clusters.png") });
  await phone.page.click("#viewGraph");
  await phone.page.waitForFunction(() => Number(document.getElementById("cy")!.dataset.nodes) > 0);
  await phone.page.screenshot({ path: path.join(OUT, "graph-phone-graph.png") });
  check("no page errors (phone)", phone.errors.length === 0, phone.errors.join("; "));
  await browser.close();
} finally {
  child.removeAllListeners("exit");
  child.kill();
  await once(child, "exit");
  fs.rmSync(scratch, { recursive: true, force: true });
}
if (failed) process.exit(1);
console.log("PASS thread-graph-ui");

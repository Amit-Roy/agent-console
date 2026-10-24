// Security automations on the /automation page and the sidebar shield, in real Chromium: desktop and phone, light and dark.
// Scratch server on a free port (mock providers); /api/security/* is mocked in the page, so no SSH and no VPS.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createSecAutomations } from "../server/sec-automations.ts";
import { AMBER, BRIDGE, GREEN, NOW, RED } from "./sec-automations-mock.ts";

const OUT = process.env.OUT || "/tmp";
fs.mkdirSync(OUT, { recursive: true });
const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-sec-auto-ui-"));
const port = await new Promise<number>((resolve) => {
  const s = net.createServer().listen(0, () => {
    const p = (s.address() as net.AddressInfo).port;
    s.close(() => resolve(p));
  });
});
const base = `http://127.0.0.1:${port}`;
process.env.AGENT_CONSOLE_DATA = data;
const { makeToken } = await import("../server/auth.ts");
const server = spawn(process.execPath, ["server/index.ts"], {
  env: {
    ...process.env,
    PORT: String(port),
    AGENT_CONSOLE_MOCK: "1",
    AGENT_CONSOLE_RUN: path.join(data, "run"),
    AGENT_CONSOLE_WARM_MAX: "0",
    AGENT_CONSOLE_BRAIN: path.join(data, "no-brain"),
  },
  stdio: "ignore",
});
// the same view the server builds, from the mock VPS answers, frozen at NOW
const view = (answer: unknown) =>
  createSecAutomations({
    fetchStatus: async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    },
    bridge: () => BRIDGE,
    now: () => NOW,
  }).view();
const VIEWS = {
  green: await view(GREEN),
  amber: await view(AMBER),
  red: await view(RED),
  down: await view(new Error("Could not reach the scan host over SSH.")),
};
const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});
let failed = 0;
const check = (n: string, ok: boolean, x = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${n} ${x}`);
  if (!ok) failed++;
};
const cookie = { name: "ac_session", value: makeToken(), url: base };
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base)).status < 500) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch();
  for (const [name, viewport, scheme] of [
    ["desktop-light", { width: 1280, height: 900 }, "light"],
    ["desktop-dark", { width: 1280, height: 900 }, "dark"],
    ["phone-light", { width: 390, height: 844 }, "light"],
    ["phone-dark", { width: 390, height: 844 }, "dark"],
  ] as const) {
    const ctx = await browser.newContext({
      viewport,
      colorScheme: scheme,
      isMobile: name.startsWith("phone"),
      hasTouch: name.startsWith("phone"),
    });
    await ctx.addCookies([cookie]);
    const page = await ctx.newPage();
    let current: keyof typeof VIEWS = "red";
    const posts: string[] = [];
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on(
      "console",
      (m) =>
        m.type() === "error" && !/status of (404|50\d)/.test(m.text()) && errors.push(m.text()),
    );
    await page.route("**/api/security/automations", (r) => r.fulfill(json(VIEWS[current])));
    await page.route("**/api/security/tools", (r) =>
      r.fulfill(json({ records: [], mismatches: [], errors: [], enabled: true })),
    );
    await page.route("**/api/security/run?mode=quick", (r) => {
      posts.push(`${r.request().method()} quick`);
      return r.fulfill(json({ started: true, mode: "quick" }));
    });
    await page.route("**/api/security/tools/run", (r) => {
      posts.push(`${r.request().method()} tool-watch`);
      return r.fulfill(json({ started: true }));
    });

    await page.goto(`${base}/automation#cve`);
    await page.waitForSelector("#sec-rows .sec-row");
    const openWf = async (id: string) => {
      if (name.startsWith("phone")) {
        await page.click("#wf-select");
        await page.click(`.menu [data-value="${id}"]`);
      } else await page.click(`[data-wf="${id}"]`);
    };
    const rows = page.locator("#sec-rows .sec-row");
    check(`${name}: CVE workflow lists its real units`, (await rows.count()) === 6);
    check(
      `${name}: CVE architecture steps`,
      (await page.locator('[data-pipeline="cve"] [data-step]').count()) === 6,
    );
    check(
      `${name}: failing chip for this workflow`,
      (await page.locator("#sec-summary").innerText()) === "1 failing",
    );
    check(`${name}: red row`, (await page.locator(".sec-row.bad").count()) === 1);
    check(`${name}: amber row`, (await page.locator(".sec-row.warn").count()) === 1);
    check(
      `${name}: OpenCVE path is drawn, not summarised`,
      /OpenCVE sync[\s\S]*Webhook receiver[\s\S]*Tool watch[\s\S]*Patch bridge[\s\S]*Daily digest[\s\S]*Phone alert/.test(
        await page.locator('[data-pipeline="cve"]').innerText(),
      ),
    );
    check(
      `${name}: OpenCVE link`,
      /^https:\/\//.test(
        (await page.locator('[data-sec="opencve-backup"] a').getAttribute("href")) ?? "",
      ),
    );
    check(`${name}: one run button here`, (await page.locator(".run-now").count()) === 1);
    check(`${name}: shared rows list`, (await page.locator("ul.rows#sec-rows").count()) === 1);
    await openWf("deadman");
    await page.waitForSelector('[data-sec="heartbeat"]');
    check(
      `${name}: failure reason visible in the dead-man workflow`,
      (await page.locator('[data-sec="heartbeat"]').innerText()).includes("falco-alert inactive"),
    );
    await openWf("scans");
    await page.waitForSelector('[data-sec="secscan"]');
    const first = await page.locator('[data-sec="secscan"]').innerText();
    check(
      `${name}: schedule, last and next`,
      /Saturday 23:15 UTC/.test(first) && /Last run/.test(first) && /Next/.test(first),
      first.replace(/\n/g, " | "),
    );
    check(
      `${name}: Security link`,
      (await page.locator('[data-sec="secscan"] a').getAttribute("href")) === "/security",
    );
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    check(`${name}: no horizontal overflow`, overflow <= 0, String(overflow));
    await page.locator("#sec-auto").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${OUT}/sec-automations-${name}-red.png` });

    await page.locator(".run-now").first().click();
    await page.waitForFunction(
      () => !(document.querySelector(".run-now") as HTMLButtonElement | null)?.disabled,
    );
    await openWf("cve");
    await page.waitForSelector('[data-sec="tool-watch"]');
    await page.locator(".run-now").first().click();
    await page.waitForFunction(
      () => !(document.querySelector(".run-now") as HTMLButtonElement | null)?.disabled,
    );
    check(
      `${name}: run now posts`,
      posts.includes("POST quick") && posts.includes("POST tool-watch"),
      posts.join(),
    );
    await openWf("other");
    check(`${name}: other triggers list`, (await page.locator("ul#triggers").count()) === 1);

    current = "green";
    await openWf("cve");
    await page.waitForSelector("#sec-rows .sec-row");
    await page.reload();
    await page.waitForSelector("#sec-rows .sec-row");
    check(
      `${name}: green summary`,
      (await page.locator("#sec-summary").innerText()) === "All OK" &&
        (await page.locator(".sec-row.bad, .sec-row.warn").count()) === 0,
      `${await page.locator("#sec-summary").innerText()} / ${await page.locator(".sec-row").count()} rows`,
    );
    await page.locator("#sec-auto").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${OUT}/sec-automations-${name}-green.png` });

    current = "amber";
    await openWf("cve");
    await page.waitForSelector("#sec-rows .sec-row");
    await page.reload();
    await page.waitForSelector("#sec-rows .sec-row");
    check(
      `${name}: amber summary`,
      (await page.locator("#sec-summary").innerText()) === "1 overdue",
      await page.locator("#sec-summary").innerText(),
    );

    current = "down";
    await openWf("cve");
    await page.waitForSelector("#sec-rows .sec-row");
    await page.reload();
    await page.waitForSelector("#sec-rows .sec-row");
    check(
      `${name}: SSH failure row`,
      (await page.locator('[data-sec="status-host"].bad').count()) === 1 &&
        (await page.locator("#sec-summary").innerText()) === "1 failing",
      `${await page.locator("#sec-summary").innerText()} / ${await page.locator(".sec-row").count()} rows`,
    );
    await page.locator("#sec-auto").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${OUT}/sec-automations-${name}-down.png` });

    // sidebar shield: red when any automation is red, green otherwise
    for (const [v, tone] of [
      ["red", "bad"],
      ["green", "ok"],
      ["down", "bad"],
    ] as const) {
      current = v;
      await page.goto(base);
      await page
        .waitForFunction((t) => document.getElementById("sec-status")?.dataset.tone === t, tone, {
          timeout: 5000,
        })
        .catch(() => {});
      check(
        `${name}: shield ${v} -> ${tone}`,
        (await page.locator("#sec-status").getAttribute("data-tone")) === tone,
      );
    }
    check(`${name}: no console errors`, errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}
if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("sec-automations-ui: ok");

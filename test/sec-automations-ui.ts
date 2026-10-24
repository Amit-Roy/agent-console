// Security automations on the /automation page and the sidebar shield, in real Chromium: desktop and phone, light and dark.
// Scratch server on a free port (mock providers); /api/security/* is mocked in the page, so no SSH and no VPS.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createSecAutomations } from "../server/sec-automations.ts";
import { parseCrashes } from "../server/sec-crashes.ts";
import { AMBER, BRIDGE, CRASHES, GREEN, NOW, RED } from "./sec-automations-mock.ts";

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
// the page gets what the route would send: the mock VPS answer after the server's own parse and redaction
const CRASH_VIEW = parseCrashes(CRASHES);
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

// The crash log dialog on the runtime workflow, on its own page so page.clock can drive the 10 s auto-refresh.
async function crashLog(
  ctx: Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>["newContext"]>>,
  name: string,
) {
  const page = await ctx.newPage();
  const errors: string[] = [];
  let fetches = 0;
  let mode: "list" | "empty" | "fail" = "list";
  const debugBodies: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.clock.install({ time: NOW });
  await page.route("**/api/security/automations", (r) => r.fulfill(json(VIEWS.green)));
  await page.route("**/api/security/tools", (r) =>
    r.fulfill(json({ records: [], mismatches: [], errors: [], enabled: true })),
  );
  await page.route("**/api/security/crashes", (r) => {
    fetches++;
    if (mode === "fail")
      return r.fulfill(json({ error: "The scan host did not answer in time." }, 502));
    return r.fulfill(
      json(mode === "empty" ? { ...CRASH_VIEW, total: 0, crashes: [] } : CRASH_VIEW),
    );
  });
  await page.route("**/api/automation/debug", (r) => {
    debugBodies.push(r.request().postData() ?? "");
    return r.fulfill(json({ v: 1, thread: "T-crash" }));
  });
  await page.goto(`${base}/automation#runtime`);
  await page.waitForSelector('[data-sec="crashes"]');
  check(
    `${name}: Log button only on the crashes row`,
    (await page.locator(".crash-log-btn").count()) === 1 &&
      (await page.locator('[data-sec="crashes"] .crash-log-btn').count()) === 1,
  );
  const trigger = page.locator(".crash-log-btn");
  await trigger.click();
  const dialog = page.locator("dialog#sec-crash-log");
  await dialog.locator(".crash-card").first().waitFor();
  check(
    `${name}: crash dialog title`,
    /Process crashes · last 24 h/.test(await dialog.locator("h2").innerText()),
  );
  check(`${name}: two crash cards`, (await dialog.locator(".crash-card").count()) === 2);
  const summary = await dialog.locator(".crash-card summary").first().innerText();
  check(
    `${name}: summary has signal, comm and scope`,
    /SIGSEGV/.test(summary) && /node/.test(summary) && /workspace 0123456789ab/.test(summary),
    summary,
  );
  await dialog.locator(".crash-card summary").first().click();
  await dialog.locator(".crash-card").nth(1).locator("summary").click();
  const text = await dialog.innerText();
  check(
    `${name}: secrets are redacted`,
    !/hunter2secret|ghp_abcdef/.test(text) && /\[redacted\]/.test(text),
  );
  check(
    `${name}: frames in a pre`,
    (await dialog.locator("pre").first().innerText()).includes("uv_run"),
  );
  check(`${name}: missing stack trace says so`, /No stack trace recorded/.test(text));
  check(
    `${name}: updated stamp`,
    /Updated \d\d:\d\d:\d\d/.test(await dialog.locator(".crash-updated").innerText()),
  );
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(`${name}: crash dialog no horizontal overflow`, wide <= 0, String(wide));
  await page.screenshot({ path: `${OUT}/sec-crash-log-${name}.png` });

  const before = fetches;
  const expectSoon = async (ok: () => boolean) => {
    for (let tries = 0; tries < 40 && !ok(); tries++) await page.waitForTimeout(50);
  };
  await dialog.getByRole("button", { name: "Refresh" }).click();
  await expectSoon(() => fetches === before + 1);
  check(`${name}: Refresh refetches`, fetches === before + 1, `${before} -> ${fetches}`);
  await page.clock.runFor(10_000);
  await page.waitForTimeout(150);
  check(`${name}: 10 s auto-refresh`, fetches === before + 2, `${fetches}`);

  mode = "empty";
  await dialog.getByRole("button", { name: "Refresh" }).click();
  await dialog.getByText("No crashes in the last 24 h").waitFor();
  await page.screenshot({ path: `${OUT}/sec-crash-log-${name}-empty.png` });
  mode = "fail";
  await dialog.getByRole("button", { name: "Refresh" }).click();
  await dialog.locator(".job-debug-error").waitFor();
  const retry = dialog.getByRole("button", { name: "Retry" });
  check(`${name}: error state with Retry`, (await retry.count()) === 1);
  mode = "list";
  await retry.click();
  await dialog.locator(".crash-card").first().waitFor();

  await dialog.getByRole("button", { name: "Investigate with agent" }).click();
  await page.waitForURL(/#thread=T-crash/);
  check(
    `${name}: investigate posts focus crashes`,
    debugBodies.length === 1 && JSON.parse(debugBodies[0]).focus === "crashes",
    debugBodies.join(),
  );
  await page.goto(`${base}/automation#runtime`);
  await page.waitForSelector('[data-sec="crashes"]');

  await page.locator(".crash-log-btn").click();
  await dialog.locator(".crash-card").first().waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  check(
    `${name}: Escape returns focus`,
    await page.evaluate(() => document.activeElement?.classList.contains("crash-log-btn")),
  );
  const closed = fetches;
  await page.clock.runFor(30_000);
  await page.waitForTimeout(150);
  check(`${name}: no auto-refresh after close`, fetches === closed, `${closed} -> ${fetches}`);
  await page.locator(".crash-log-btn").click();
  await dialog.locator(".crash-card").first().waitFor();
  await dialog.getByRole("button", { name: "Close" }).click();
  await dialog.waitFor({ state: "detached" });
  check(
    `${name}: Close returns focus`,
    await page.evaluate(() => document.activeElement?.classList.contains("crash-log-btn")),
  );
  check(`${name}: crash log no page errors`, errors.length === 0, errors.join(" | "));
  await page.close();
}

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
    await crashLog(ctx, name);
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

// Security page: real browser, phone + desktop, mocked /api/security, no console errors, first-party only.
import { chromium } from "playwright";
import { makeToken } from "../server/auth.ts";
import { HISTORY, LATEST, LOG_ID, LOG_LINES, QUICK } from "./security-mock.ts";

const BASE = process.env.BASE || "http://127.0.0.1:7070";
const OUT = process.env.OUT || "/tmp";
let failed = 0;
const check = (n: string, ok: boolean, x = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${n} ${x}`);
  if (!ok) failed++;
};
const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});
const browser = await chromium.launch();
// the page scrolls inside #hm, so a full-page capture shows only the viewport: take the top and the bottom
async function shoot(page: any, name: string) {
  await page.evaluate(() => {
    document.getElementById("hm")!.scrollTop = 0;
  });
  await page.screenshot({ path: `${OUT}/security-${name}.png` });
  await page.evaluate(() => {
    const m = document.getElementById("hm")!;
    m.scrollTop = m.scrollHeight;
  });
  await page.screenshot({ path: `${OUT}/security-${name}-end.png` });
}

async function open(
  viewport: { width: number; height: number },
  scheme: "light" | "dark",
  routes: Record<string, (n: number, url: URL) => unknown>,
) {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme });
  await ctx.addCookies([{ name: "ac_session", value: makeToken(), url: BASE }]);
  const page = await ctx.newPage();
  const errors: string[] = [],
    external: string[] = [],
    hits: Record<string, number> = {};
  page.on(
    "console",
    (m) => m.type() === "error" && !/status of (404|50\d)/.test(m.text()) && errors.push(m.text()),
  );
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("request", (r) => {
    const u = r.url();
    if (!/^(data:|blob:|about:)/.test(u) && !u.startsWith(BASE)) external.push(u);
  });
  await page.route("**/api/security/**", (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname
      .replace("/api/security/", "")
      .replace(/^scans\/[^/]+\/log$/, "log")
      .replace(/^scans\/.*/, "scans");
    hits[p] = (hits[p] || 0) + 1;
    const f = routes[p];
    if (!f) return route.fulfill(json({ error: "unmocked" }, 500));
    const body = f(hits[p], url) as any;
    return route.fulfill(json(body, body?.__status || 200));
  });
  return { ctx, page, errors, external, hits };
}
const runModes: string[] = [];
const findings = {
  latest: () => ({ result: LATEST }),
  history: () => ({ scans: HISTORY }),
  status: () => ({ running: false, startedAt: null, currentTool: null }),
  scans: () => LATEST,
  run: (_n, url) => {
    runModes.push(url.searchParams.get("mode") || "");
    return { started: true, mode: url.searchParams.get("mode") };
  },
};

for (const [name, viewport, scheme] of [
  ["desktop-light", { width: 1280, height: 900 }, "light"],
  ["phone-dark", { width: 390, height: 844 }, "dark"],
  ["phone-light", { width: 390, height: 844 }, "light"],
  ["desktop-dark", { width: 1280, height: 900 }, "dark"],
] as const) {
  const { ctx, page, errors, external } = await open(viewport, scheme, findings);
  await page.goto(`${BASE}/security`);
  await page.waitForSelector(".tool");
  check(`${name}: verdict`, (await page.locator("#verdict h2").innerText()).includes("Findings"));
  check(
    `${name}: readout`,
    (await page.locator(".readout dd").allInnerTexts()).join(",") === "1,3,1,3,1",
    (await page.locator(".readout dd").allInnerTexts()).join(","),
  );
  check(
    `${name}: fixable sub-line`,
    (await page.locator(".readout .fixable").allInnerTexts()).join(",") === "1 fixable,1 fixable",
    (await page.locator(".readout .fixable").allInnerTexts()).join(","),
  );
  check(
    `${name}: target fixable chip`,
    (await page.locator("#trivy .chip.fix").allInnerTexts()).join(",") === "2 fixable",
  );
  check(`${name}: four tool cards`, (await page.locator(".tool").count()) === 4);
  check(
    `${name}: infected file listed`,
    (await page.locator("#findings").innerText()).includes("Win.Trojan.Agent-1234"),
  );
  check(
    `${name}: falco groups by rule`,
    (await page.locator("#falco-rows .hrow.tgt").count()) === 2,
  );
  await page.locator("#falco-rows .hrow.tgt", { hasText: "Terminal shell" }).click();
  check(`${name}: falco group expands`, (await page.locator("#falco-rows .vuln").count()) === 2);
  check(`${name}: open ports`, (await page.locator("#port-rows .port").count()) === 3);
  check(
    `${name}: only exposed ports counted`,
    (await page.locator("#port-count").textContent())?.startsWith("1") &&
      (await page.locator("#port-rows .port", { hasText: /internal only/i }).count()) === 2,
  );
  check(`${name}: history strip`, (await page.locator("#strip .tick").count()) === HISTORY.length);
  const t = page.locator("#trivy .hrow.tgt").first();
  await t.click();
  check(
    `${name}: target expands`,
    (await t.getAttribute("aria-expanded")) === "true" &&
      (await page.locator("#trivy .vuln").count()) === 3,
  );
  await page.check("#fixed-only");
  check(`${name}: fix-available filter`, (await page.locator("#trivy .vuln").count()) === 2);
  await page.uncheck("#fixed-only");
  await page.locator("#strip .tick").first().click();
  check(
    `${name}: history tick loads scan`,
    (await page.locator("#strip .tick[aria-current]").count()) === 1,
  );
  check(
    `${name}: no horizontal overflow`,
    !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)),
  );
  await shoot(page, name);
  check(
    `${name}: no console errors, first-party only`,
    errors.length === 0 && external.length === 0,
    errors.concat(external).join(" | ").slice(0, 200),
  );
  await ctx.close();
}

// run flow: button -> running banner with current tool -> status polling -> finished -> refresh
{
  const phases = [{ running: true, startedAt: new Date().toISOString(), currentTool: "clamav" }];
  const { ctx, page, errors, hits } = await open({ width: 390, height: 844 }, "light", {
    ...findings,
    status: (n) => (n >= 3 ? { running: false, startedAt: null, currentTool: null } : phases[0]),
  });
  await page.goto(`${BASE}/security`);
  await page.waitForSelector(".tool");
  const status0 = hits.status;
  check(
    "run: banner shows current tool",
    (await page.locator("#running").innerText()).includes("ClamAV") &&
      (await page.locator("#run-quick").isDisabled()) &&
      (await page.locator("#run-full").isDisabled()),
  );
  check(
    "run: states duration for both modes",
    (await page.locator("#running").innerText()).includes("about 80 minutes"),
  );
  await shoot(page, "running");
  await page.waitForSelector("#running", { state: "hidden", timeout: 20000 });
  check(
    "run: polls then refreshes",
    status0 === 1 && hits.latest >= 2 && (await page.locator("#run-quick").isEnabled()),
    JSON.stringify(hits),
  );
  check("run: no console errors", errors.length === 0, errors.join(" | ").slice(0, 200));
  await page.click("#run-quick");
  await page.waitForSelector("#running:not([hidden])");
  check("run: click starts and shows banner", hits.run === 1);
  check("run: quick sends mode=quick", runModes[0] === "quick", runModes.join());
  check(
    "run: banner states quick duration",
    (await page.locator("#running").innerText()).includes("quick scan takes a few minutes"),
  );
  await ctx.close();
}
// mode display: quick result shows mode in verdict, ClamAV card, history
{
  const { ctx, page } = await open({ width: 390, height: 844 }, "light", {
    ...findings,
    latest: () => ({ result: QUICK }),
    history: () => ({ scans: [{ ...HISTORY[1], id: QUICK.id, mode: "quick" }, HISTORY[0]] }),
  });
  await page.goto(`${BASE}/security`);
  await page.waitForSelector(".tool");
  check(
    "mode: verdict says Quick scan",
    (await page.locator("#verdict").innerText()).includes("Quick scan"),
  );
  check(
    "mode: clamav card says files changed since",
    /Checked 312 files changed since/.test(await page.locator(".tool").first().innerText()),
  );
  check(
    "mode: history labels quick",
    (await page.locator("#strip .tick").last().getAttribute("title"))?.includes("Quick scan") &&
      (await page.locator("#strip .tick").first().getAttribute("title"))?.includes("Full scan"),
  );
  await ctx.close();
}
// scan log sheet
const many = Array.from(
  { length: 80 },
  (_, i) =>
    `2026-10-23T00:${String(10 + Math.floor(i / 6)).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}Z ${["clamav", "trivy", "nmap", "falco"][i % 4]}: line ${i + 1} of the scan`,
);
// serves `lines` in pages; running until the caller has read everything and `n` polls have passed
const logApi =
  (lines: string[], doneAfter = 3) =>
  (n: number, url: URL) => {
    const after = Number(url.searchParams.get("after") || 0),
      end = n >= doneAfter ? lines.length : Math.min(lines.length, 40 + n * 10);
    return {
      id: LOG_ID,
      running: n < doneAfter,
      from: after,
      total: end,
      lines: lines.slice(after, end),
    };
  };
const runningStatus = () => ({
  running: true,
  id: LOG_ID,
  startedAt: new Date().toISOString(),
  currentTool: "trivy",
});
for (const [name, viewport, scheme] of [
  ["phone-light", { width: 390, height: 844 }, "light"],
  ["desktop-dark", { width: 1280, height: 900 }, "dark"],
  ["phone-dark", { width: 390, height: 844 }, "dark"],
  ["desktop-light", { width: 1280, height: 900 }, "light"],
] as const) {
  const { ctx, page, errors, hits } = await open(viewport, scheme, {
    ...findings,
    status: runningStatus,
    log: logApi(many, name === "phone-light" ? 4 : 99),
  });
  await page.goto(`${BASE}/security`);
  await page.waitForSelector("#running:not([hidden])");
  await page.click("#running >> text=View live log");
  await page.waitForSelector("#logsheet[open] .ll");
  check(
    `log ${name}: sheet opens with lines`,
    (await page.locator("#log-body .ll").count()) === 50 &&
      (await page.locator("#log-state").innerText()).includes("Live"),
  );
  check(
    `log ${name}: tool names highlighted`,
    (await page.locator("#log-body .lk.clamav").count()) > 0 &&
      (await page.locator("#log-body .lk.trivy").count()) > 0,
  );
  check(
    `log ${name}: local short time`,
    /^\d{1,2}:\d{2}:\d{2}/.test(await page.locator("#log-body .lt").first().innerText()),
  );
  check(
    `log ${name}: following scrolls to bottom`,
    await page.evaluate(() => {
      const b = document.getElementById("log-body")!;
      return b.scrollHeight - b.scrollTop - b.clientHeight < 4;
    }),
  );
  check(
    `log ${name}: no horizontal overflow`,
    !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)),
  );
  await page.screenshot({ path: `${OUT}/security-log-running-${name}.png` });
  if (name === "phone-light") {
    await page.locator("#log-body").evaluate((b) => {
      b.scrollTop = 0;
    });
    await page.waitForSelector("#log-jump:not([hidden])");
    const top = await page.locator("#log-body").evaluate((b) => b.scrollTop);
    await page.waitForFunction(() => document.querySelectorAll("#log-body .ll").length > 50, null, {
      timeout: 15000,
    });
    check(
      "log: scrolled up pauses follow",
      (await page.locator("#log-body").evaluate((b) => b.scrollTop)) === top &&
        (await page.locator("#log-jump").isVisible()),
    );
    await page.click("#log-jump");
    check(
      "log: jump to latest resumes follow",
      (await page.evaluate(() => {
        const b = document.getElementById("log-body")!;
        return b.scrollHeight - b.scrollTop - b.clientHeight < 4;
      })) && (await page.locator("#log-jump").isHidden()),
    );
    await page.waitForFunction(
      () => document.querySelectorAll("#log-body .ll").length === 80,
      null,
      { timeout: 15000 },
    );
    await page.waitForFunction(
      () => document.getElementById("log-state")!.textContent === "Finished",
      null,
      { timeout: 5000 },
    );
    const latestBefore = hits.latest;
    check(
      "log: polling stops when finished and page refreshes",
      (await page.locator("#log-state").innerText()) === "Finished" &&
        (hits.latest ?? 0) >= latestBefore,
    );
    const polls = hits.log;
    await page.waitForTimeout(3500);
    check("log: no polls after finish", hits.log === polls, `${polls} -> ${hits.log}`);
    await page.screenshot({ path: `${OUT}/security-log-finished-${name}.png` });
    await page.keyboard.press("Escape");
    check("log: Escape closes", (await page.locator("#logsheet[open]").count()) === 0);
    await page.click("text=View live log").catch(() => {});
  } else {
    await page.click("#log-close");
    check(`log ${name}: close button`, (await page.locator("#logsheet[open]").count()) === 0);
    await page.click("#running >> text=View live log");
    await page.mouse.click(5, 5);
    check(`log ${name}: backdrop closes`, (await page.locator("#logsheet[open]").count()) === 0);
  }
  check(`log ${name}: no console errors`, errors.length === 0, errors.join(" | ").slice(0, 200));
  await ctx.close();
}
// finished scan from the history strip, missing log, older server
{
  const { ctx, page } = await open({ width: 390, height: 844 }, "dark", {
    ...findings,
    log: () => logApi(LOG_LINES, 0)(1, new URL(`${BASE}/x?after=0`)),
  });
  await page.goto(`${BASE}/security`);
  await page.waitForSelector(".tool");
  await page.locator("#strip .tick").first().click();
  await page.click("#verdict >> text=Scan log");
  await page.waitForSelector("#logsheet[open] .ll");
  check(
    "log: finished scan shows all lines, no Live",
    (await page.locator("#log-body .ll").count()) === LOG_LINES.length &&
      (await page.locator("#log-state").innerText()) === "Finished",
  );
  await page.screenshot({ path: `${OUT}/security-log-finished-phone-dark.png` });
  await ctx.close();
}
for (const [label, body] of [
  ["no log", { error: "No such scan.", __status: 404 }],
  ["older server", { error: "Not found", __status: 404 }],
] as const) {
  const { ctx, page, errors } = await open({ width: 390, height: 844 }, "light", {
    ...findings,
    log: () => body,
  });
  await page.goto(`${BASE}/security`);
  await page.waitForSelector(".tool");
  await page.click("#verdict >> text=Scan log");
  await page.waitForSelector("#log-body .lmsg");
  check(
    `log ${label}: graceful message`,
    (await page.locator("#log-body").innerText()).includes("No log for this scan") &&
      (await page.locator("#log-state").isHidden()),
  );
  await page.screenshot({ path: `${OUT}/security-log-empty.png` });
  await page.click("#log-close");
  check(
    `log ${label}: page still works`,
    (await page.locator(".tool").count()) === 4 && errors.length === 0,
    errors.join(" | ").slice(0, 200),
  );
  await ctx.close();
}

// empty, unreachable and error states
{
  const { ctx, page, errors } = await open({ width: 390, height: 844 }, "dark", {
    latest: () => ({ result: null }),
    history: () => ({ scans: [] }),
    status: () => ({ running: false, startedAt: null, currentTool: null }),
  });
  await page.goto(`${BASE}/security`);
  await page.waitForSelector(".tool");
  check(
    "empty: no scan yet",
    (await page.locator("#verdict h2").innerText()) === "No scan yet" &&
      (await page.locator("#trivy").isHidden()) &&
      (await page.locator("#history").isHidden()),
  );
  await shoot(page, "empty");
  await ctx.close();
}
{
  const down = (): any => ({ error: "Could not reach the scan host over SSH.", __status: 502 });
  const { ctx, page } = await open({ width: 390, height: 844 }, "dark", {
    latest: down,
    history: down,
    status: down,
  });
  await page.goto(`${BASE}/security`);
  await page.waitForSelector("#verdict h2");
  check(
    "unreachable: explained",
    (await page.locator("#verdict").innerText()).includes("unreachable") &&
      (await page.locator("#verdict").innerText()).includes("over SSH") &&
      (await page.locator("#tools").isHidden()) &&
      (await page.locator("#verdict >> text=Try again").count()) === 1,
  );
  await shoot(page, "unreachable");
  await ctx.close();
}
{
  const errRes = {
    ...LATEST,
    status: "error",
    tools: {
      ...LATEST.tools,
      clamav: {
        ...LATEST.tools.clamav,
        status: "error",
        infected: [],
        error: "clamscan exited with code 2: database missing",
      },
      falco: {
        ...LATEST.tools.falco,
        status: "error",
        alerts: [],
        error: "falco.service is not running",
      },
      trivy: { ...LATEST.tools.trivy, status: "clean", targets: [] },
    },
  };
  const { ctx, page } = await open({ width: 390, height: 844 }, "light", {
    ...findings,
    latest: () => ({ result: errRes }),
  });
  await page.goto(`${BASE}/security`);
  await page.waitForSelector(".tool");
  check(
    "error: tool error shown",
    (await page.locator(".tool .terr").first().innerText()).includes("database missing") &&
      (await page.locator("#verdict h2").innerText()).includes("errors"),
  );
  await shoot(page, "error");
  await ctx.close();
}
await browser.close();
if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}

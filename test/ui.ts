// Real-Chromium UI check: dark/light, desktop/phone, tool-card heights, installability. Needs the server running.
import { chromium } from "playwright";
import { makeToken } from "../server/auth.ts";

const BASE = process.env.BASE || "http://127.0.0.1:7070";
const OUT = process.env.OUT || "/tmp";
const browser = await chromium.launch();
let failed = 0;
const check = (n: string, ok: boolean, x = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${n} ${x}`); if (!ok) failed++; };

for (const [name, viewport, scheme] of [
  ["desktop-dark", { width: 1280, height: 800 }, "dark"],
  ["phone-dark", { width: 390, height: 844 }, "dark"],
  ["desktop-light", { width: 1280, height: 800 }, "light"],
] as const) {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme, hasTouch: name.startsWith("phone"), isMobile: name.startsWith("phone") });
  await ctx.addCookies([{ name: "ac_session", value: makeToken(), url: BASE }]);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(BASE + "/");
  await page.waitForSelector("#threads li", { timeout: 8000 }).catch(() => {});
  if (name.startsWith("phone")) await page.evaluate(() => document.querySelector("#threads li") && (document.querySelector("#threads li") as HTMLElement).click());
  await page.waitForTimeout(1200);
  const m = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".card")] as HTMLElement[];
    const chat = document.getElementById("chat")!;
    return { cards: cards.length, minH: Math.min(...cards.map((c) => c.getBoundingClientRect().height)), overflow: chat.scrollHeight > chat.clientHeight,
             hScroll: document.documentElement.scrollWidth > window.innerWidth, name0: (cards[0]?.querySelector(".name") as HTMLElement)?.innerText || "" };
  });
  if (m.cards) {
    check(`${name}: cards keep height in overflowing chat`, m.minH >= 30 && m.overflow, `cards=${m.cards} minH=${Math.round(m.minH)} overflow=${m.overflow}`);
    check(`${name}: card shows tool name`, m.name0.length > 0, m.name0);
  } else console.log(`SKIP  ${name}: no tool cards in any thread`);
  check(`${name}: no horizontal page scroll`, !m.hScroll);
  check(`${name}: no console/page errors`, errors.length === 0, errors.join(" | ").slice(0, 160));
  await page.screenshot({ path: `${OUT}/ui-${name}.png` });
  if (name === "desktop-dark") {
    const cdp = await ctx.newCDPSession(page);
    const r: any = await cdp.send("Page.getInstallabilityErrors" as any);
    check("Chrome installability: no errors", (r.installabilityErrors ?? []).length === 0, JSON.stringify(r.installabilityErrors ?? []).slice(0, 200));
    const mf: any = await cdp.send("Page.getAppManifest" as any);
    check("manifest parses with no errors", !(mf.errors ?? []).length, JSON.stringify(mf.errors ?? []).slice(0, 200));
  }
  await ctx.close();
}
// ---- slash menu (no model quota used: nothing is sent) ----
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" });
  await ctx.addCookies([{ name: "ac_session", value: makeToken(), url: BASE }]);
  const page = await ctx.newPage();
  await page.goto(BASE + "/");
  await page.waitForSelector("#threads li", { timeout: 8000 });
  await page.waitForFunction(() => !(document.getElementById("input") as HTMLTextAreaElement).disabled);
  const input = page.locator("#input");
  const visible = () => page.locator("#slash").isVisible();
  const opts = () => page.locator("#slash [role=option]").count();
  await input.click();
  await input.fill("hello");
  check("slash: closed for normal text", !(await visible()));
  await input.fill("");
  await input.pressSequentially("/");
  check("slash: opens on '/'", await visible() && (await opts()) > 10, `options=${await opts()}`);
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}/ui-slash-open.png` });
  await input.pressSequentially("cave");
  const first = await page.locator("#slash [role=option] .cmd").first().innerText();
  check("slash: filters, best match first", first === "/caveman", first);
  await input.press("ArrowDown");
  const sel = await page.locator("#slash [aria-selected=true]").count();
  check("slash: arrow keys move selection", sel === 1);
  await input.press("ArrowUp");
  await input.press("Enter"); // partial query + Enter must accept, not send
  const v = await input.inputValue();
  check("slash: Enter on partial completes instead of sending", /^\/caveman $/.test(v), JSON.stringify(v));
  check("slash: menu closes after accept", !(await visible()));
  await input.fill("");
  await input.pressSequentially("/zzzzqq");
  check("slash: empty result message", (await page.locator("#slash li.none").count()) === 1);
  await input.press("Escape");
  check("slash: Esc closes", !(await visible()));
  await input.fill("");
  await input.pressSequentially("/apple");
  await page.locator("#slash [role=option]").first().click();
  check("slash: click selects", /^\/apple-design $/.test(await input.inputValue()), JSON.stringify(await input.inputValue()));
  const a11y = await page.evaluate(() => { const i = document.getElementById("input")!; return [i.getAttribute("role"), i.getAttribute("aria-controls")]; });
  check("slash: combobox aria wiring", a11y[0] === "combobox" && a11y[1] === "slash");
  await ctx.close();
}
await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall UI checks passed");
process.exit(failed ? 1 : 0);

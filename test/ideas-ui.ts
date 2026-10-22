// App ideas page in real Chromium: list from index.md, add an idea through the form (committed to git), open its markdown,
// 44px touch targets, no horizontal overflow on a phone, first-party only. Needs a scratch server whose AGENT_CONSOLE_IDEAS
// points under the temp dir (refuses to write to a real ideas repo).
import os from "node:os";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { makeToken } from "../server/auth.ts";

const BASE = process.env.BASE || "http://127.0.0.1:7071";
const OUT = process.env.OUT || "/tmp";
let failed = 0;
const check = (n: string, ok: boolean, x = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${n} ${x}`); if (!ok) failed++; };
const cookie = `ac_session=${makeToken()}`;
const { dir } = await (await fetch(`${BASE}/api/ideas`, { headers: { cookie } })).json();
if (!String(dir).startsWith(os.tmpdir())) { console.log(`refusing: ideas repo ${dir} is not under ${os.tmpdir()}`); process.exit(1); }
const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();

const browser = await chromium.launch();
for (const [name, viewport, scheme] of [["phone-light", { width: 390, height: 844 }, "light"], ["desktop-dark", { width: 1280, height: 900 }, "dark"]] as const) {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme, hasTouch: name.startsWith("phone") });
  await ctx.addCookies([{ name: "ac_session", value: makeToken(), url: BASE }]);
  const page = await ctx.newPage();
  const errors: string[] = [], external: string[] = [];
  page.on("console", (m) => m.type() === "error" && !/status of 409/.test(m.text()) /* the duplicate check below */ && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("request", (r) => { const u = r.url(); if (!/^(data:|blob:|about:)/.test(u) && !u.startsWith(BASE)) external.push(u); });
  await page.goto(`${BASE}/ideas`);
  await page.waitForFunction(() => document.getElementById("im")!.getAttribute("aria-busy") === "false");
  const before = await page.locator("#list li").count();

  // add through the form: the list grows, and one commit holds index.md and the new file
  const idea = `Cloud Diary ${name}`, slug = `cloud-diary-${name}`;
  await page.click("#add");
  check(`${name}: New idea opens the form`, await page.locator("#form").isVisible());
  await page.fill("#name", idea);
  await page.fill("#line", "Photo log of interesting clouds");
  await page.click("#save");
  await page.waitForFunction((n) => document.querySelectorAll("#list li").length === n, before + 1);
  check(`${name}: added idea shows in the list`, (await page.locator("#list li").last().innerText()).includes(idea));
  check(`${name}: form closes after adding`, await page.locator("#form").isHidden());
  check(`${name}: toast names the commit`, /Committed [0-9a-f]{7}/.test(await page.locator("#toast").innerText()));
  check(`${name}: index.md has the entry`, fs.readFileSync(`${dir}/index.md`, "utf8").includes(`- [${idea}](${slug}.md) — Photo log of interesting clouds`));
  check(`${name}: commit holds index.md and ${slug}.md`, git("log", "-1", "--format=%s") === `Add idea: ${idea}` && git("show", "--name-only", "--format=", "HEAD").split("\n").sort().join() === ["index.md", `${slug}.md`].sort().join());

  // a duplicate is refused in the form, not silently dropped
  await page.click("#add");
  await page.fill("#name", idea); await page.fill("#line", "again"); await page.click("#save");
  await page.waitForSelector("#formErr:not([hidden])");
  check(`${name}: duplicate name explains itself`, /already exists/.test(await page.locator("#formErr").innerText()));
  await page.click("#cancel");

  // touch targets and layout on the list
  const small = await page.evaluate(() => [...document.querySelectorAll("a, button, input")].filter(e => (e as HTMLElement).offsetParent)
    .map(e => { const r = e.getBoundingClientRect(); return { id: e.id || e.textContent!.trim().slice(0, 20), h: r.height, w: r.width }; })
    .filter(r => r.h < 44 || r.w < 44));
  check(`${name}: every visible control is at least 44px`, small.length === 0, JSON.stringify(small));
  check(`${name}: no horizontal overflow`, !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)));
  await page.screenshot({ path: `${OUT}/ideas-${name}-list.png`, fullPage: true });

  // open the idea: its markdown renders, back returns to the list
  await page.click(`#list a[href="#/${slug}"]`);
  await page.waitForSelector("#detail h2");
  check(`${name}: idea opens its markdown`, (await page.locator("#detail h1").innerText()) === idea && (await page.locator("#detail h2").allInnerTexts()).join() === "Features,Implementation,Others");
  check(`${name}: header names the idea`, (await page.locator("#title").innerText()) === idea && (await page.locator("#backLabel").innerText()) === "Ideas");
  await page.screenshot({ path: `${OUT}/ideas-${name}-detail.png`, fullPage: true });

  // plus button adds a bullet under the chosen section; the page re-renders and git holds one commit
  check(`${name}: plus button shows on the idea, New idea hides`, await page.locator("#addBullet").isVisible() && await page.locator("#add").isHidden());
  await page.click("#addBullet");
  await page.locator(".seg label", { hasText: "Implementation" }).click();
  await page.fill("#bullet", "SQLite + cron");
  await page.screenshot({ path: `${OUT}/ideas-${name}-bullet-form.png`, fullPage: true });
  await page.click("#bulletSave");
  await page.waitForSelector("#detail li");
  check(`${name}: bullet renders in the body`, (await page.locator("#detail li").first().innerText()) === "SQLite + cron");
  check(`${name}: bullet form closes`, await page.locator("#bulletForm").isHidden());
  check(`${name}: bullet commit`, git("log", "-1", "--format=%s") === `Add implementation bullet: ${idea}` && /## Implementation\n\n- SQLite \+ cron\n\n## Others/.test(fs.readFileSync(`${dir}/${slug}.md`, "utf8")));
  await page.screenshot({ path: `${OUT}/ideas-${name}-detail-bullet.png`, fullPage: true });
  await page.click("#back");
  await page.waitForSelector("#listView:not([hidden])");
  check(`${name}: back returns to the list`, (await page.locator("#title").innerText()) === "App ideas" && await page.locator("#add").isVisible());
  check(`${name}: no console errors, first-party only`, errors.length === 0 && external.length === 0, errors.concat(external).join(" | ").slice(0, 200));
  await ctx.close();
}
const cross = await fetch(`${BASE}/api/ideas`, { method: "POST", headers: { cookie, origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ name: "x", line: "y" }) });
check("api: cross-site add is refused", cross.status === 403);
const missing = await fetch(`${BASE}/api/ideas/nope`, { headers: { cookie } });
check("api: unknown idea is 404", missing.status === 404);
await browser.close();
if (failed) { console.log(`\n${failed} FAILED`); process.exit(1); }
console.log("\nall ideas checks passed");

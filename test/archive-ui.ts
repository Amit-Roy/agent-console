// Archive: the ⋯ menu files a thread under a collapsed "Archived" section, Unarchive brings it back, and a new message unarchives it.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { makeToken } from "../server/auth.ts";
const base = process.env.BASE || "http://127.0.0.1:7071";
const OUT = process.env.OUT;
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "dark" });
  await ctx.addCookies([{ name: "ac_session", value: makeToken(), url: base }]);
  const page = await ctx.newPage();
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.waitForSelector("#threads li .t");
  const title = (await page.locator("#threads li .t").nth(1).textContent())!;
  const row = (list: string) => page.locator(`#${list} li`, { has: page.locator(".t", { hasText: title }) });
  const act = async (list: string, label: string) => {
    await row(list).first().hover();
    await row(list).first().locator(".row-more").click();
    await page.locator(".menu [role=menuitem]", { hasText: label }).first().click();
  };
  const before = await page.locator("#threads li").count();
  await act("threads", "Archive");
  await page.waitForFunction((t) => ![...document.querySelectorAll("#threads li .t")].some((e) => e.textContent === t), title);
  assert.equal(await page.locator("#threads li").count(), before - 1, "archived row leaves the working list");
  assert.equal(await page.locator("#archive").isVisible(), true, "Archived section appears");
  assert.equal(await page.locator("#archived").isVisible(), false, "section starts collapsed");
  await page.click("#archive-toggle");
  assert.equal(await page.locator("#archive-toggle").getAttribute("aria-expanded"), "true");
  await row("archived").first().waitFor();
  if (OUT) await page.locator("#side").screenshot({ path: `${OUT}/archive-open.png` });
  await page.reload();
  await page.waitForSelector("#threads li .t");
  assert.equal(await row("archived").count(), 1, "archive survives a reload, section stays open");
  await act("archived", "Unarchive");
  await row("threads").first().waitFor();
  assert.equal(await row("archived").count(), 0);
  // a message to an archived thread puts it back to work
  await act("threads", "Archive");
  await row("archived").first().waitFor();
  await row("archived").first().click();
  await page.fill("#input", "back to work please");
  await page.keyboard.press("Enter");
  await row("threads").first().waitFor();
  assert.equal(await row("archived").count(), 0, "sending unarchives");
  assert.deepEqual(errors, []);
  console.log("PASS archive: menu archive/unarchive, collapsed section, persists, send unarchives");
} finally {
  await browser.close();
}

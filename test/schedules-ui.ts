// Scheduled tasks UI against a mock server (AGENT_CONSOLE_MOCK=1, empty AGENT_CONSOLE_DATA, AGENT_CONSOLE_OUTPUTS=/tmp/...):
// the Threads | Scheduled lanes, creating a task in the shared dialog, the on/off switch, Run now, run child rows, the report card,
// editing, and deleting. OUT=dir saves phone dark screenshots.
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright";
import { makeToken } from "../server/auth.ts";
const base = process.env.BASE || "http://127.0.0.1:7071";
const OUT = process.env.OUT;
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    colorScheme: "dark",
  });
  await ctx.addCookies([{ name: "ac_session", value: makeToken(), url: base }]);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(base);
  await page.waitForSelector("#lanes");
  assert.equal(
    await page.locator("#lane-threads").getAttribute("aria-selected"),
    "true",
    "Threads is the default lane",
  );
  await page.click("#lane-tasks");
  assert.equal(await page.locator("#pane-tasks").isVisible(), true);
  assert.equal(await page.locator("#pane-threads").isVisible(), false);
  await page.getByText("Run a prompt on a timer").waitFor();

  // create a task in the shared dialog
  await page.click("#new-task");
  await page.locator("#dlg").waitFor({ state: "visible" });
  assert.equal(await page.locator("#dlg-title").textContent(), "New scheduled task");
  assert.equal(await page.locator("#d-ok").textContent(), "Schedule task");
  await page.click("#d-prov");
  await page.getByRole("option", { name: /^Mock/ }).click();
  await page.fill("#d-title", "Morning digest");
  await page.fill("#d-prompt", "Summarise what changed overnight.");
  assert.equal(await page.locator("#d-day").isVisible(), false, "day picker only for weekly");
  await page.fill("#d-time", "07:30");
  await page.click("#d-ok");
  const task = page.locator("#tasks li.task", { hasText: "Morning digest" });
  await task.waitFor();
  assert.match((await task.locator(".meta").textContent())!, /Daily 07:30.*Mock.*in \d+[mh]/);
  assert.equal(await task.locator(".switch").getAttribute("aria-checked"), "true");
  await page
    .locator("#tasks li.empty-run")
    .getByText(/First run/)
    .waitFor();

  // pause and resume
  await task.locator(".switch").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#tasks li.task .switch")?.getAttribute("aria-checked") === "false",
  );
  assert.match((await task.locator(".meta").textContent())!, /Paused/);
  await task.locator(".switch").click();
  await page.waitForFunction(
    () => document.querySelector("#tasks li.task .switch")?.getAttribute("aria-checked") === "true",
  );

  // Run now opens the run thread; the run is a child row, not a thread-list row; the report card lands in the transcript
  await task.locator(".row-more").click();
  await page.getByRole("menuitem", { name: /^Run now/ }).click();
  const card = page.locator("#chat .run-report");
  await card.waitFor({ timeout: 15000 });
  assert.match((await page.locator("#ttl").textContent())!, /^Morning digest · /);
  assert.match((await card.locator(".rr-status").textContent())!, /Done/);
  const ref = await card.locator("a.btn", { hasText: "Open report" }).getAttribute("data-file-ref");
  assert.ok(
    ref && fs.existsSync(ref) && /morning-digest\/\d{4}-\d\d-\d\d-\d{4}\.md$/.test(ref),
    "the report was written to the outputs repo",
  );
  assert.match(
    fs.readFileSync(ref!, "utf8"),
    /Summarise what changed overnight/,
    "the mock agent's final message is the report",
  );
  assert.equal(await card.getByRole("button", { name: "Fork" }).count(), 1);
  assert.equal(await card.getByRole("button", { name: "Run again" }).count(), 1);
  const run = page.locator("#tasks li.run.done");
  await run.waitFor();
  assert.equal(
    await run.getAttribute("aria-current"),
    "true",
    "the open run is highlighted under its task",
  );
  assert.match((await run.locator(".meta").textContent())!, /Done · \d+s · Report saved/);
  await page.click("#lane-threads");
  assert.equal(
    await page.locator("#threads li", { hasText: "Morning digest" }).count(),
    0,
    "runs stay out of the thread list",
  );
  await page.click("#lane-tasks");

  // the lane survives a reload
  await page.reload();
  await page.locator("#tasks li.task").waitFor();
  assert.equal(await page.locator("#lane-tasks").getAttribute("aria-selected"), "true");

  // edit: the row opens the dialog prefilled; weekly shows the day picker
  await page.locator("#tasks li.task .t").click();
  assert.equal(await page.locator("#dlg-title").textContent(), "Edit scheduled task");
  assert.equal(await page.inputValue("#d-title"), "Morning digest");
  assert.equal(await page.inputValue("#d-time"), "07:30");
  await page.click("#d-repeat");
  await page.getByRole("option", { name: /^Weekly/ }).click();
  assert.equal(await page.locator("#d-day").isVisible(), true);
  await page.click("#d-day");
  await page.getByRole("option", { name: "Fridays" }).click();
  await page.click("#d-ok");
  await page.waitForFunction(() =>
    /Fridays 07:30/.test(document.querySelector("#tasks li.task .meta")?.textContent || ""),
  );

  if (OUT) {
    const phone = await browser.newContext({
      viewport: { width: 412, height: 915 },
      deviceScaleFactor: 2.625,
      isMobile: true,
      hasTouch: true,
      colorScheme: "dark",
    });
    await phone.addCookies([{ name: "ac_session", value: makeToken(), url: base }]);
    const p = await phone.newPage();
    await p.goto(base);
    await p.locator("#chat .run-report").waitFor();
    await p.screenshot({ path: `${OUT}/run-phone-dark.png` });
    await p.click("#menu");
    await p.click("#lane-tasks");
    await p.locator("#tasks li.task").waitFor();
    await p.waitForTimeout(400);
    await p.screenshot({ path: `${OUT}/tasks-phone-dark.png` });
    await p.click("#new-task");
    await p.waitForTimeout(400);
    await p.screenshot({ path: `${OUT}/dialog-phone-dark.png` });
    await phone.close();
  }

  // delete removes the task and its run threads
  await page.locator("#tasks li.task .row-more").click();
  await page.getByRole("menuitem", { name: /^Delete task/ }).click();
  await page.getByText("Run a prompt on a timer").waitFor();
  await page.click("#lane-threads");
  assert.equal(await page.locator("#threads li", { hasText: "Morning digest" }).count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "PASS schedules UI: lanes, create, switch, run now, run rows, report card, reload, edit, delete",
  );
} finally {
  await browser.close();
}

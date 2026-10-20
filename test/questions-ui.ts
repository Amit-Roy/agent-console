import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { WebSocket } from "ws";
import { makeToken } from "../server/auth.ts";

// Run only against a scratch server started with AGENT_CONSOLE_MOCK=1 and an isolated data directory.
const base = process.env.BASE || "http://127.0.0.1:7071";
const cookie = `ac_session=${makeToken()}`;
const connect = () => {
  const inbox: any[] = [];
  const ws = new WebSocket(base.replace(/^http/, "ws") + "/ws", { headers: { origin: base, cookie } });
  ws.on("message", d => inbox.push(JSON.parse(String(d))));
  const wait = async (pred: (m: any) => boolean) => {
    for (let i = 0; i < 400; i++) {
      const at = inbox.findIndex(pred);
      if (at >= 0) return inbox.splice(at, 1)[0];
      await new Promise(r => setTimeout(r, 20));
    }
    throw new Error("Timed out waiting for question protocol message");
  };
  return { ws, wait };
};
const { ws, wait } = connect();
const hello = await wait(m => m.t === "hello");
assert.ok(hello.providers.some((p: any) => p.id === "mock"), "question UI tests require the isolated mock provider");
const browser = await chromium.launch();
const ids: string[] = [];
try {
  for (const width of [1280, 390]) {
    ws.send(JSON.stringify({ t: "create", provider: "mock", cwd: hello.dirs[0], title: `Question fixture ${width}` }));
    const id = (await wait(m => m.t === "created")).thread.id;
    ids.push(id);
    ws.send(JSON.stringify({ t: "send", thread: id, text: "question" }));
    const question = (await wait(m => m.t === "event" && m.thread === id && m.event.type === "question")).event;
    const other = connect();
    try {
      const reopened = await other.wait(m => m.t === "hello");
      assert.equal(reopened.questions[id][0].id, question.id, "a new connection recovers the active question");
    } finally { other.ws.close(); }
    ws.send(JSON.stringify({ t: "open", thread: id }));
    const history = await wait(m => m.t === "history" && m.thread === id);
    assert.equal(history.questions[0].id, question.id, "history explicitly carries active prompts");
    const request = `invalid-${width}`;
    ws.send(JSON.stringify({ t: "answer", thread: id, id: question.id, answers: { scope: ["Quick pass"] }, request }));
    const invalid = await wait(m => m.t === "answer_error" && m.request === request);
    assert.equal(invalid.thread, id); assert.equal(invalid.id, question.id); assert.ok(invalid.message);

    const ctx = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width === 390, hasTouch: width === 390 });
    await ctx.addCookies([{ name: "ac_session", value: makeToken(), url: base }]);
    await ctx.addInitScript(id => localStorage.setItem("ac_thread", id), id);
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(base);
    const activeCard = ".question-card:not(.question-summary)[data-question-id]";
    const card = page.locator(activeCard);
    await card.waitFor();
    if (process.env.SCREENSHOTS) {
      fs.mkdirSync(process.env.SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.SCREENSHOTS, `question-${width}.png`), fullPage: true });
    }
    assert.match(await card.innerText(), /Question 1 of 2/);
    const radio = card.getByRole("radio", { name: /Quick pass/ });
    await radio.focus(); await page.keyboard.press("Space");
    assert.equal(await radio.isChecked(), true, "native radio works with keyboard input");
    await card.getByRole("button", { name: "Continue", exact: true }).click();
    assert.match(await card.innerText(), /Question 2 of 2/);
    await card.getByRole("checkbox", { name: /Tests/ }).check();
    await card.getByRole("checkbox", { name: /Screenshots/ }).check();
    await card.getByRole("button", { name: "Back", exact: true }).click();
    assert.equal(await card.getByRole("radio", { name: /Quick pass/ }).isChecked(), true);
    await card.getByRole("radio", { name: /Something else/ }).check();
    await card.getByRole("textbox", { name: "Your answer", exact: true }).fill("Review just the changed lines");
    await card.getByRole("button", { name: "Continue", exact: true }).click();
    assert.equal(await card.getByRole("checkbox", { name: /Tests/ }).isChecked(), true, "Back preserves selections from later questions");
    assert.equal(await card.getByRole("checkbox", { name: /Screenshots/ }).isChecked(), true);
    await page.reload();
    await card.waitFor();
    // Reload may reopen the first question; either state must retain the saved answers.
    if (await card.getByRole("radio", { name: /Something else/ }).count()) {
      assert.equal(await card.getByRole("textbox", { name: "Your answer", exact: true }).inputValue(), "Review just the changed lines");
      await card.getByRole("button", { name: "Continue", exact: true }).click();
    }
    assert.equal(await card.getByRole("checkbox", { name: /Tests/ }).isChecked(), true);
    assert.equal(await card.getByRole("checkbox", { name: /Screenshots/ }).isChecked(), true);
    await card.getByRole("button", { name: "Send answer", exact: true }).click();
    const answered = await wait(m => m.t === "event" && m.thread === id && m.event.type === "question_answer" && !m.event.cancelled);
    assert.deepEqual(answered.event.answers, { scope: ["Review just the changed lines"], checks: ["Tests", "Screenshots"] });
    await wait(m => m.t === "event" && m.thread === id && m.event.type === "result");
    await page.locator(".question-summary").waitFor();
    if (process.env.SCREENSHOTS) await page.screenshot({ path: path.join(process.env.SCREENSHOTS, `question-answered-${width}.png`), fullPage: true });
    assert.match(await page.locator(".question-summary").innerText(), /Review just the changed lines/);
    assert.equal(await page.locator(activeCard).count(), 0, "completed prompts have a compact transcript summary");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    ws.send(JSON.stringify({ t: "answer", thread: id, id: question.id, answers: answered.event.answers, request: `stale-${width}` }));
    assert.equal((await wait(m => m.t === "answer_error" && m.request === `stale-${width}`)).id, question.id);
    await page.reload(); await page.locator(".question-summary").waitFor();
    assert.equal(await page.locator(activeCard).count(), 0, "reload never reactivates a completed prompt");

    ws.send(JSON.stringify({ t: "send", thread: id, text: "question skip fixture" }));
    const skippedRequest = (await wait(m => m.t === "event" && m.thread === id && m.event.type === "question")).event;
    await card.waitFor();
    await card.getByRole("button", { name: "Skip", exact: true }).click();
    await wait(m => m.t === "event" && m.thread === id && m.event.type === "question_answer" && m.event.id === skippedRequest.id && m.event.skip);
    await wait(m => m.t === "event" && m.thread === id && m.event.type === "result");
    await page.locator(".question-summary").filter({ hasText: "Skipped" }).waitFor();
    assert.equal(await page.locator(activeCard).count(), 0);

    ws.send(JSON.stringify({ t: "send", thread: id, text: "question abort fixture" }));
    const abortedRequest = (await wait(m => m.t === "event" && m.thread === id && m.event.type === "question")).event;
    await card.waitFor();
    ws.send(JSON.stringify({ t: "abort", thread: id }));
    await wait(m => m.t === "event" && m.thread === id && m.event.type === "question_answer" && m.event.id === abortedRequest.id && m.event.cancelled);
    await page.locator(".question-summary").filter({ hasText: /cancelled|closed/ }).waitFor();
    assert.equal(await page.locator(activeCard).count(), 0, "Stop closes the pending prompt in every connected browser");

    ws.send(JSON.stringify({ t: "send", thread: id, text: "question composer reply fixture" }));
    const chatRequest = (await wait(m => m.t === "event" && m.thread === id && m.event.type === "question")).event;
    await card.waitFor();
    const note = "Use your judgment and focus on the changed code";
    assert.equal(await page.locator("#input").getAttribute("data-placeholder"), "Reply to the agent, or choose an option above…");
    assert.equal(await page.locator("#send").getAttribute("aria-label"), "Reply to agent");
    await page.locator("#input").fill(note);
    if (width === 390) await page.getByRole("button", { name: "Reply to agent", exact: true }).click();
    else await page.locator("#input").press("Enter");
    const chatAnswered = await wait(m => m.t === "event" && m.thread === id && m.event.type === "question_answer" && m.event.id === chatRequest.id);
    assert.equal(chatAnswered.event.note, note);
    await wait(m => m.t === "event" && m.thread === id && m.event.type === "result");
    assert.equal(await page.locator(activeCard).count(), 0, "ordinary composer replies immediately release a pending question");
    ws.send(JSON.stringify({ t: "open", thread: id }));
    const afterChat = await wait(m => m.t === "history" && m.thread === id);
    assert.deepEqual(afterChat.questions, []);
    const reconnected = connect();
    try {
      const state = await reconnected.wait(m => m.t === "hello");
      assert.equal(state.queues[id], undefined, "composer replies are delivered to the tool rather than stranded in the queue");
    } finally { reconnected.ws.close(); }
    assert.deepEqual(errors, []);
    await ctx.close();
    console.log(`PASS ${width}px question flow: keyboard/custom/multi-select, Back/reload, reconnect, completed summaries, stale/invalid replies, Skip, Stop and ordinary composer reply`);
  }
} finally {
  for (const id of ids) ws.send(JSON.stringify({ t: "delete", thread: id }));
  ws.close();
  await browser.close();
}

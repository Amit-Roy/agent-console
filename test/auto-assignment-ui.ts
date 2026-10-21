// Browser integration uses the real app and dialog with a local HTTP/WebSocket fixture. No providers or user data are accessed.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium, type Page } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const out = process.env.OUT || "/tmp/auto-assignment-ui";
fs.mkdirSync(out, { recursive: true });
const now = Date.now();
const issue = { repo: "Amit-Roy/agent-console", number: 7 };
const thread = (id: string, title: string, provider = "codex", extra = {}) => ({ id, title, provider, model: provider === "claude" ? "opus" : "gpt-6.1-sol", effort: "high", mode: "acceptEdits", cwd: "/fixture/repos/agent-console", status: "idle", cost: 0, createdAt: now, updatedAt: now, ...extra });
const initialThreads = [
  thread("failed-worker", "Issue #7 worker stopped", "codex", { issueRun: { ...issue, key: "Amit-Roy/agent-console#7", role: "work", effort: "bau" } }),
  thread("failed-review", "Issue #7 review stopped", "claude", { issueRun: { ...issue, key: "Amit-Roy/agent-console#7", role: "review", effort: "bau", pr: 95 } }),
];
const provider = (id: string, label: string, model: string) => ({ id, label, ok: true, models: [model], defaultModel: model, modes: ["plan", "acceptEdits", "bypassPermissions"], defaultMode: "acceptEdits", modelDetails: { [model]: { label: id === "claude" ? "Opus" : "Sol 6.1", efforts: ["low", "medium", "high"], defaultEffort: "medium" } } });
const providers = [
  { ...provider("claude", "Claude Code", "opus"), accounts: [{ id: "sunny", label: "Sunny", ready: true }, { id: "nefro", label: "Nefro", ready: true }] },
  provider("codex", "Codex", "gpt-6.1-sol"), provider("pi", "Pi", "free-model"),
];
const baseline = process.env.AUTO_ASSIGNMENT_BASELINE === "1" ? execFileSync("git", ["show", "HEAD:public/app.js"], { cwd: root }) : null;
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname.startsWith("/api/")) { res.setHeader("content-type", "application/json"); res.end("{}"); return; }
  if (url.pathname === "/app.js" && baseline) { res.setHeader("content-type", "application/javascript"); res.end(baseline); return; }
  const vendors: Record<string, string> = { "/vendor/marked.js": "node_modules/marked/lib/marked.esm.js", "/vendor/purify.js": "node_modules/dompurify/dist/purify.es.mjs" };
  const file = path.resolve(root, vendors[url.pathname] || `public${url.pathname === "/" ? "/index.html" : url.pathname}`);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; res.end(); return; }
  res.setHeader("content-type", file.endsWith(".html") ? "text/html" : file.endsWith(".css") ? "text/css" : /\.(js|mjs)$/.test(file) ? "application/javascript" : "application/octet-stream");
  fs.createReadStream(file).pipe(res);
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch();
async function openAssignment(page: Page, mobile: boolean) {
  if (mobile && !await page.locator("#pane-auto").isVisible()) await page.locator("#menu").click();
  if (!await page.locator("#lane-auto").isVisible()) await page.locator("#menu").click();
  await page.locator("#lane-auto").click();
  await page.locator('.auto-group[data-issue="amit-roy/agent-console#7"] .auto-group-more').click();
  await page.getByRole("menuitem", { name: "Assign to premium", exact: true }).click();
  await page.locator("#dlg").waitFor({ state: "visible", timeout: 3000 });
}
try {
  for (const [device, viewport] of [["desktop", { width: 1280, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) for (const colorScheme of ["dark", "light"] as const) {
    const name = `${device}-${colorScheme}`, mobile = device === "phone";
    const context = await browser.newContext({ viewport, colorScheme, isMobile: mobile, hasTouch: mobile, serviceWorkers: "block", recordVideo: { dir: out, size: viewport } });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const errors: string[] = [], messages: any[] = [], assignments: any[] = [];
    let responseMode = "error";
    let releaseError!: () => void;
    const errorGate = new Promise<void>(resolve => { releaseError = resolve; });
    let socket: any;
    page.on("pageerror", error => errors.push(error.message));
    await page.routeWebSocket(/\/ws$/, ws => {
      socket = ws;
      ws.onMessage(raw => {
        const message = JSON.parse(String(raw)); messages.push(message);
        if (message.t === "open") ws.send(JSON.stringify({ t: "history", thread: message.thread, request: message.request, events: [], start: 0, end: 0 }));
        if (message.t === "ping") ws.send(JSON.stringify({ t: "pong" }));
      });
      ws.send(JSON.stringify({ t: "hello", threads: initialThreads, providers, dirs: ["/fixture/repos/agent-console"], tasks: [], questions: {}, usage: {}, queues: {}, commands: {}, features: {} }));
    });
    await page.route("**/api/automation/assign", async route => {
      assignments.push(route.request().postDataJSON());
      if (responseMode === "error") {
        await errorGate;
        return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "A premium session is already running for this issue." }) });
      }
      const created = thread("premium-handoff", "Premium issue #7 recovery");
      socket.send(JSON.stringify({ t: "thread", thread: created }));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ thread: created.id }) });
    });
    await page.goto(base);
    await page.waitForFunction(() => document.getElementById("ttl")?.textContent === "Issue #7 worker stopped");
    await openAssignment(page, mobile);
    assert.equal(await page.locator("#dlg-title").textContent(), "Assign to premium", `${name}: the existing thread/fork dialog is reused`);
    assert.match(await page.locator("#dlg-sub").innerText(), /Amit-Roy\/agent-console#7.*2 related runs/);
    assert.match(await page.locator("#dlg-sub").innerText(), /failed thread IDs and linked PRs/);
    for (const id of ["cwd-field", "context-field", "task-fields"]) assert.equal(await page.locator(`#${id}`).isVisible(), false, `${name}: assignment hides ${id}`);
    for (const id of ["d-prov", "d-account", "d-model", "d-effort", "d-mode"]) assert.equal(await page.locator(`#${id}`).isVisible(), true, `${name}: existing ${id} remains available`);
    assert.equal(assignments.length, 0, `${name}: opening the dialog starts no session`);
    await page.screenshot({ path: path.join(out, `${name}-assignment-dialog.png`) });
    await page.waitForTimeout(650);
    await page.locator("#d-prov").click();
    assert.deepEqual(await page.getByRole("listbox", { name: "Agent", exact: true }).locator(".m-label").allTextContents(), ["Claude Code", "Codex"], `${name}: only premium providers are offered`);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(await page.locator("#dlg").isVisible(), false);
    assert.equal(assignments.length, 0, `${name}: cancel sends no assignment`);
    assert.equal(messages.filter(m => ["create", "fork", "task_save"].includes(m.t)).length, 0, `${name}: cancel starts no other session`);
    await openAssignment(page, mobile);
    await page.locator("#d-account").click();
    await page.getByRole("option", { name: /^Nefro/ }).click();
    await page.locator("#d-effort").click();
    await page.getByRole("option", { name: "Effort · High", exact: true }).click();
    await page.locator("#d-mode").click();
    await page.getByRole("option", { name: /Plan/ }).click();
    await page.locator("#d-ok").click();
    assert.equal(await page.getByRole("button", { name: "Cancel", exact: true }).isDisabled(), true, `${name}: pending request disables cancellation`);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#dlg").isVisible(), true, `${name}: Escape cannot abandon a pending session start`);
    await page.locator("#dform").evaluate(form => form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: document.getElementById("d-ok")! })));
    await page.waitForTimeout(700);
    assert.equal(assignments.length, 1, `${name}: repeated submit cannot create duplicate requests`);
    await page.screenshot({ path: path.join(out, `${name}-assignment-pending.png`) });
    releaseError();
    await page.locator("#d-assignment-error").waitFor();
    assert.equal(await page.locator("#dlg").isVisible(), true, `${name}: server failure keeps the editable dialog open`);
    assert.match(await page.getByRole("alert").filter({ hasText: "A premium session is already running" }).innerText(), /already running/);
    assert.equal(await page.locator("#d-ok").isEnabled(), true, `${name}: retry remains available`);
    assert.equal(await page.getByRole("button", { name: "Cancel", exact: true }).isEnabled(), true, `${name}: server failure reenables cancellation`);
    assert.equal(assignments.length, 1);
    assert.deepEqual(assignments[0], { v: 1, ...issue, provider: "claude", model: "opus", effort: "high", mode: "plan", claudeAccount: "nefro" });
    await page.screenshot({ path: path.join(out, `${name}-assignment-error.png`) });
    await page.waitForTimeout(900);
    await page.locator("#d-prov").click();
    await page.getByRole("option", { name: "Codex", exact: true }).click();
    assert.equal(await page.locator("#account-field").isVisible(), false);
    await page.locator("#d-effort").click();
    await page.getByRole("option", { name: "Effort · High", exact: true }).click();
    responseMode = "success";
    await page.locator("#d-ok").click();
    await page.waitForFunction(() => document.getElementById("ttl")?.textContent === "Premium issue #7 recovery");
    assert.equal(await page.locator("#dlg").isVisible(), false, `${name}: successful assignment opens the returned thread`);
    assert.equal(assignments.length, 2);
    assert.equal(assignments[1].provider, "codex");
    assert.equal(assignments[1].model, "gpt-6.1-sol");
    assert.equal(assignments[1].effort, "high");
    assert.equal(assignments[1].claudeAccount, undefined);
    assert.match(page.url(), /#thread=premium-handoff$/);
    assert.equal(messages.filter(m => ["create", "fork", "task_save"].includes(m.t)).length, 0, `${name}: assignment never uses ordinary create/fork transport`);
    await page.screenshot({ path: path.join(out, `${name}-assignment-opened.png`) });
    await page.waitForTimeout(700);
    await page.locator("#new").evaluate((el: HTMLElement) => el.click());
    assert.equal(await page.locator("#dlg-title").textContent(), "New thread", `${name}: normal new-thread flow resets assignment state`);
    assert.equal(await page.locator("#cwd-field").isVisible(), true);
    await page.locator("#d-prov").click();
    assert.equal(await page.getByRole("option", { name: "Pi", exact: true }).count(), 1, `${name}: normal creation restores other providers`);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.deepEqual(errors, [], `${name}: no browser runtime errors`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name}: no page overflow`);
    const video = page.video();
    await context.close();
    assert.ok(video);
    await video.saveAs(path.join(out, `${name}-assignment-interaction.webm`));
  }
  console.log("PASS Auto premium assignment: shared dialog, premium choices/account/effort/mode, cancel, visible retryable server error, selected settings transport, returned thread, normal-dialog reset; desktop/phone dark/light.");
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

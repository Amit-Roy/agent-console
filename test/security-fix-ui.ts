// Security Fix it deep link: share thread picker, finding prompt lands as a draft in the chosen thread, nothing is sent.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { freePort } from "./free-port.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-fix-ui-"));
const data = path.join(root, "data");
fs.mkdirSync(path.join(data, "uploads"), { recursive: true });
fs.mkdirSync(path.join(data, "logs"));
fs.writeFileSync(path.join(data, "threads.json"), "[]");
const fake = path.join(root, "yt-dlp");
fs.writeFileSync(
  fake,
  `#!/bin/sh
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-o" ]; then out="$2"; fi
  shift
done
dir=$(dirname "$out")
printf 'fakevideo' > "$dir/1.mp4"
printf '{"description":"hello caption","uploader":"someone"}' > "$dir/1.info.json"
`,
  { mode: 0o755 },
);
const port = Number(process.env.FIX_UI_PORT) || (await freePort());
const base = `http://127.0.0.1:${port}`;
const shot = process.env.SHOT_DIR || process.env.OUT || "/tmp/ac474-evidence";
if (shot) fs.mkdirSync(shot, { recursive: true });
process.env.AGENT_CONSOLE_DATA = data;
const server = spawn(process.execPath, [process.env.TEST_SERVER_ENTRY || "server/index.ts"], {
  env: {
    ...process.env,
    PORT: String(port),
    AGENT_CONSOLE_MOCK: "1",
    AGENT_CONSOLE_WARM_MAX: "0",
    AGENT_CONSOLE_YTDLP: fake,
    AGENT_CONSOLE_RUN: path.join(root, "run"),
    AGENT_CONSOLE_BRAIN: path.join(root, "no-brain"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const listening = new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Scratch server did not start")), 15000);
  server.stdout.on("data", (chunk) => {
    if (String(chunk).includes("agent-console listening")) {
      clearTimeout(timer);
      resolve();
    }
  });
  server.once("exit", (code) => reject(new Error(`Scratch server exited: ${code}`)));
});
listening.catch(() => {});
let closeBrowser = async () => {};
try {
  const [{ makeToken }, { chromium }] = await Promise.all([
    import("../server/auth.ts"),
    import("playwright"),
  ]);
  await listening;
  const browser = await chromium.launch();
  closeBrowser = () => browser.close();
  const context = await browser.newContext({
    viewport: { width: 412, height: 915 },
    colorScheme: "dark",
    serviceWorkers: "block",
  });
  context.setDefaultTimeout(8000);
  await context.addCookies([
    {
      name: "__Host-ac_session",
      value: makeToken(),
      domain: new URL(base).hostname,
      path: "/",
      secure: true,
    },
  ]);
  const fix = "fix_scan=s1&fix_kind=trivy&fix_key=CVE-1";
  const reply = { title: "Fix CVE-1", prompt: "Please fix CVE-1 in libfoo." };
  const open = async (viewport = { width: 412, height: 915 }, status = 200) => {
    const page = await context.newPage();
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    const sends: unknown[] = [];
    const posts: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("websocket", (socket) =>
      socket.on("framesent", (frame) => {
        if (JSON.parse(String(frame.payload)).t === "send") sends.push(frame.payload);
      }),
    );
    await page.route("**/api/security/fix", (route) => {
      posts.push(route.request().postData() || "");
      return route.fulfill(status === 200 ? { json: reply } : { status, json: { error: "x" } });
    });
    await page.goto(`${base}/?${fix}&keep=1`);
    return { page, errors, sends, posts };
  };
  const openPicker = async (viewport?: { width: number; height: number }) => {
    const opened = await open(viewport);
    await opened.page.locator("body.sharing").waitFor();
    return opened;
  };

  // picker + cancel
  const cancelled = await openPicker();
  assert.match(
    (await cancelled.page.locator("#share-banner-text").textContent()) || "",
    /fix this finding/,
  );
  assert.equal(new URL(cancelled.page.url()).search, "?keep=1", "fix_* params stripped");
  assert.deepEqual(JSON.parse(cancelled.posts[0]), { scan: "s1", kind: "trivy", key: "CVE-1" });
  await cancelled.page.locator("#share-cancel").click();
  await cancelled.page.getByText("Fix cancelled").waitFor();
  await cancelled.page.close();

  // not found
  const missing = await open(undefined, 404);
  await missing.page.getByText("Finding not found").waitFor();
  assert.equal(await missing.page.locator("body.sharing").count(), 0);
  await missing.page.close();

  // new thread path: dialog with the title prefilled, then draft
  const created = await openPicker();
  const { page } = created;
  await page.locator("#new").click();
  await page.locator("#dlg[open]").waitFor();
  assert.match((await page.locator("#dlg-sub").textContent()) || "", /Fix CVE-1/);
  await page.locator("#d-prov").click();
  await page
    .locator('[role="menuitemradio"], [role="option"], [role="menuitem"]')
    .filter({ hasText: /mock/i })
    .first()
    .click();
  await page.locator("#d-ok").click();
  await page.waitForFunction(() => /fix CVE-1/.test(document.querySelector("#input")?.value || ""));
  assert.deepEqual(created.sends, [], "nothing sent");
  assert.deepEqual(created.errors, []);
  const threads = JSON.parse(fs.readFileSync(path.join(data, "threads.json"), "utf8"));
  assert.equal(threads.length, 1);
  assert.equal(threads[0].title, "Fix CVE-1", "title passed to create");
  await page.close();

  // existing thread pick, phone + desktop screenshots
  const sizes = [
    ["phone", { width: 390, height: 844 }],
    ["desktop", { width: 1280, height: 800 }],
  ] as const;
  for (const [name, viewport] of sizes) {
    const picked = await openPicker(viewport);
    fs.mkdirSync(shot, { recursive: true });
    await picked.page.screenshot({ path: path.join(shot, `fix-picker-${name}.png`) });
    await picked.page.locator("#threads > li").first().click();
    await picked.page.waitForFunction(() =>
      /fix CVE-1/.test(document.querySelector("#input")?.value || ""),
    );
    const draft = await picked.page
      .locator("#input")
      .evaluate((inputEl) => (inputEl as HTMLInputElement).value);
    assert.ok(draft.endsWith(reply.prompt), "prompt appended to draft");
    await picked.page.screenshot({ path: path.join(shot, `fix-draft-${name}.png`) });
    assert.deepEqual(picked.sends, [], "nothing sent");
    assert.deepEqual(picked.errors, []);
    await picked.page.close();
  }
  console.log("security-fix-ui ok");
} finally {
  await closeBrowser();
  if (server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill();
    await exited;
  }
  fs.rmSync(root, { recursive: true, force: true });
}

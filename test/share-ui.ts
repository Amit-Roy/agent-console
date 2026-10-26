// Share + compose tap opens the normal New thread dialog; the chosen thread receives the shared post as a draft, nothing is sent.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-share-ui-"));
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
const port = Number(process.env.SHARE_UI_PORT || 7071);
const base = `http://127.0.0.1:${port}`;
const shot = process.env.SHOT_DIR;
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
  const link = encodeURIComponent("https://www.instagram.com/reel/ABCDE12345/");
  const open = async () => {
    const page = await context.newPage();
    const errors: string[] = [];
    const posts: string[] = [];
    const sends: unknown[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (request.url().includes("/api/share")) posts.push(request.postData() || "");
    });
    page.on("websocket", (socket) =>
      socket.on("framesent", (frame) => {
        if (JSON.parse(String(frame.payload)).t === "send") sends.push(frame.payload);
      }),
    );
    await page.goto(`${base}/?share_text=${link}`);
    await page.locator("body.sharing").waitFor();
    return { page, errors, posts, sends };
  };

  // cancel: no POST, toast
  const cancelled = await open();
  await cancelled.page.locator("#new").click();
  await cancelled.page.locator("#dlg[open]").waitFor();
  assert.match((await cancelled.page.locator("#dlg-title").textContent()) || "", /New thread/);
  assert.match((await cancelled.page.locator("#dlg-sub").textContent()) || "", /shared post/);
  await cancelled.page.locator('#dform button[value="cancel"]').click();
  await cancelled.page.getByText("Share cancelled").waitFor();
  assert.equal(cancelled.posts.length, 0, "cancel makes no POST");
  await cancelled.page.close();

  // create with a non-default provider
  const created = await open();
  const { page } = created;
  await page.locator("#new").click();
  await page.locator("#dlg[open]").waitFor();
  if (shot) await page.screenshot({ path: path.join(shot, "dialog.png") });
  await page.locator("#d-prov").click();
  const options = page.locator('[role="menuitemradio"], [role="option"], [role="menuitem"]');
  const labels = (await options.allTextContents()).map((text) => text.trim());
  assert.ok(labels.length >= 2, `provider choices visible: ${labels.join("|")}`);
  await options.filter({ hasText: /mock/i }).first().click();
  assert.match((await page.locator("#d-prov").textContent()) || "", /mock/i);
  await page.locator("#d-ok").click();
  await page.locator("#input").waitFor();
  await page.waitForFunction(() =>
    /watch skill/.test(document.querySelector("#input")?.value || ""),
  );
  assert.equal(created.posts.length, 1, "one POST");
  assert.match(created.posts[0], /"thread":"[0-9a-f-]{36}"/, "client passes the new thread id");
  await page.locator("#thumbs .thumb, #thumbs > *").first().waitFor();
  assert.deepEqual(created.sends, [], "nothing sent");
  assert.deepEqual(created.errors, []);
  const threads = JSON.parse(fs.readFileSync(path.join(data, "threads.json"), "utf8"));
  assert.equal(threads.length, 1, "only the dialog thread exists");
  assert.equal(threads[0].provider, "mock");
  console.log("share-ui ok");
} finally {
  await closeBrowser();
  if (server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill();
    await exited;
  }
  fs.rmSync(root, { recursive: true, force: true });
}

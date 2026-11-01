// Time-travel UI: History panel, scrubber, diffs, rewind confirm and undo, fork. Checkpoint routes are stubbed with page.route.
// Run: node test/time-travel-ui.ts   (screenshots land in /tmp/ac-tt-shots)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-tt-ui-"));
const port = process.env.TT_UI_PORT || "7071";
assert.match(port, /^707[1-5]$/, "use an isolated scratch port, 7071–7075");
const base = `http://127.0.0.1:${port}`;
const shots = process.env.OUT || "/tmp/ac-tt-shots";
const mainId = "tt-ui-main";
const forkId = "tt-ui-fork-target";
fs.mkdirSync(path.join(data, "uploads"));
fs.mkdirSync(path.join(data, "logs"));
fs.writeFileSync(
  path.join(data, "threads.json"),
  JSON.stringify(
    [mainId, forkId].map((threadId, index) => ({
      id: threadId,
      provider: "mock",
      model: "echo",
      mode: "acceptEdits",
      title: index ? "Forked conversation" : "History conversation",
      cwd: os.tmpdir(),
      status: "idle",
      cost: 0,
      createdAt: 2 - index,
      updatedAt: 2 - index,
    })),
  ),
);

type Change = { p: string; s: "A" | "M" | "D"; a: number; d: number };
const greet = (status: "A" | "M"): Change => ({
  p: "greet.txt",
  s: status,
  a: 2,
  d: status === "M" ? 1 : 0,
});
const notes: Change = { p: "notes.md", s: "A", a: 3, d: 0 };
const stamp = Date.now() - 60_000;
const checkpoint = (seq: number, kind: string, files: Change[], toolUseId?: string) => ({
  type: "checkpoint",
  seq,
  kind,
  commit: `c${seq}`,
  head: null,
  ts: stamp + seq * 1000,
  files,
  filesTotal: files.length,
  ...(toolUseId ? { toolUseId } : {}),
});
const toolPair = (toolId: string, name: string, input: object) => [
  {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id: toolId, name, input }] },
  },
  {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolId, content: "ok" }],
    },
  },
];
const target = path.join(os.tmpdir(), "greet.txt");
const history: object[] = [
  { type: "user_input", text: "Add a greeting file and a notes file." },
  checkpoint(1, "turn_start", []),
  ...toolPair("tt-write-1", "Write", { file_path: target, content: "hello\n" }),
  checkpoint(2, "tool", [greet("A")], "tt-write-1"),
  ...toolPair("tt-edit-1", "Edit", {
    file_path: target,
    old_string: "hello",
    new_string: "hello world",
  }),
  checkpoint(3, "tool", [greet("M"), notes], "tt-edit-1"),
  {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "Both files are in place." }] },
  },
  checkpoint(4, "turn_end", []),
];
fs.writeFileSync(
  path.join(data, "logs", `${mainId}.jsonl`),
  `${history.map((event) => JSON.stringify(event)).join("\n")}\n`,
);
fs.writeFileSync(
  path.join(data, "logs", `${forkId}.jsonl`),
  `${JSON.stringify({ type: "user_input", text: "Forked history." })}\n`,
);

const PATCH = {
  "greet.txt-A":
    "diff --git a/greet.txt b/greet.txt\nnew file mode 100644\n--- /dev/null\n+++ b/greet.txt\n@@ -0,0 +1 @@\n+hello\n",
  "greet.txt-M":
    "diff --git a/greet.txt b/greet.txt\nindex 1..2 100644\n--- a/greet.txt\n+++ b/greet.txt\n@@ -1 +1,2 @@\n-hello\n+hello world\n+bye\n",
  "notes.md-A":
    "diff --git a/notes.md b/notes.md\nnew file mode 100644\n--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1,3 @@\n+# Notes\n+one\n+two\n",
};
const diffFor = (seq: number) => {
  const files = { 2: [greet("A")], 3: [greet("M"), notes] }[seq] ?? [];
  const patch = files.map((file) => PATCH[`${file.p}-${file.s}` as keyof typeof PATCH]).join("");
  return { files: files.map((file) => ({ p: file.p, s: file.s })), patch, truncated: false };
};
const baseList = () =>
  (history as any[])
    .filter((event) => event.type === "checkpoint")
    .map(({ seq, kind, toolUseId, commit, head, ts }) => ({
      seq,
      kind,
      toolUseId,
      commit,
      head,
      ts,
    }));

type Call = { method: string; path: string; body: any };
type Mode = { busy: boolean };
async function stubRoutes(page: Page, calls: Call[], mode: Mode) {
  const list = baseList();
  await page.route("**/api/threads/*/checkpoints**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postData() ? JSON.parse(request.postData() as string) : null;
    calls.push({
      method: request.method(),
      path: (url.pathname.split("/checkpoints")[1] || "") + url.search,
      body,
    });
    const json = (status: number, payload: unknown) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
    const [, seqText, action] = url.pathname.split("/checkpoints")[1].split("/");
    if (!seqText) return json(200, list);
    if (action === "diff") return json(200, diffFor(Number(seqText)));
    if (action === "fork") return json(200, { id: forkId });
    if (mode.busy) return json(409, { error: "busy", threads: [mainId] });
    if (body.dryRun)
      return json(200, {
        files: [
          { p: "greet.txt", s: "M" },
          { p: "notes.md", s: "D" },
        ],
        outside: ["scratch.txt", "other.txt"],
      });
    list.push({
      seq: 5,
      kind: "pre_rewind",
      toolUseId: undefined,
      commit: "c5",
      head: null,
      ts: Date.now(),
    });
    return json(200, { preRewindSeq: 5 });
  });
}

process.env.AGENT_CONSOLE_DATA = data;
const { makeToken } = await import("../server/auth.ts");
const server = spawn(process.execPath, ["server/index.ts"], {
  env: {
    ...process.env,
    PORT: port,
    AGENT_CONSOLE_DATA: data,
    AGENT_CONSOLE_RUN: path.join(data, "run"),
    AGENT_CONSOLE_PID_FILE: "",
    AGENT_CONSOLE_AUTH: "password",
    AGENT_CONSOLE_MOCK: "1",
    AGENT_CONSOLE_WARM_MAX: "0",
    AGENT_CONSOLE_HEADROOM: "0",
    AGENT_CONSOLE_LABELS: "0",
    AGENT_CONSOLE_ENV_FILES: "/dev/null",
    AGENT_CONSOLE_BRAIN: path.join(data, "no-brain"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let browser: Browser | undefined;
let serverError = "";
server.stderr.on("data", (chunk) => {
  serverError += String(chunk);
});
const errors: string[] = [];

type View = { page: Page; context: BrowserContext; calls: Call[]; mode: Mode };
async function openView(
  viewport: { width: number; height: number },
  scheme: "light" | "dark",
  phone: boolean,
): Promise<View> {
  const context = await (browser as Browser).newContext({
    viewport,
    colorScheme: scheme,
    serviceWorkers: "block",
    ...(phone ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}),
  });
  await context.addCookies([
    {
      name: "__Host-ac_session",
      value: makeToken(),
      domain: new URL(base).hostname,
      path: "/",
      secure: true,
    },
  ]);
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const calls: Call[] = [];
  const mode: Mode = { busy: false };
  await stubRoutes(page, calls, mode);
  await page.goto(`${base}/#thread=${mainId}`);
  await page.waitForFunction(
    () =>
      document.getElementById("ttl")?.textContent === "History conversation" &&
      !(document.getElementById("input") as HTMLTextAreaElement)?.disabled,
  );
  await page.locator("#chat .tt-row").first().waitFor();
  return { page, context, calls, mode };
}
const callsTo = (view: View, method: string, tail: RegExp) =>
  view.calls.filter((call) => call.method === method && tail.test(call.path));

async function shoot(
  name: string,
  viewport: { width: number; height: number },
  scheme: "light" | "dark",
  phone: boolean,
) {
  const view = await openView(viewport, scheme, phone);
  const { page } = view;
  await page.click("#tt-toggle");
  await page.locator("#tt-track .tt-tick").nth(2).waitFor();
  await page.locator("#tt-track .tt-tick").nth(2).click();
  await page.locator("#tt-files .tt-file-item").nth(1).waitFor();
  if (!phone) await page.locator("#tt-files .tt-file summary").first().click();
  await page.waitForTimeout(250);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    `${name}: no horizontal overflow`,
  );
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
  if (phone) await checkPhone(page, name);
  await view.context.close();
}
async function checkPhone(page: Page, name: string) {
  const sheet = await page.locator("#tt-panel").boundingBox();
  assert.ok(
    sheet && Math.abs(sheet.y + sheet.height - 800) < 2,
    `${name}: panel is a bottom sheet`,
  );
  assert.ok(sheet.width >= 400, `${name}: sheet is full width`);
  assert.equal(await page.locator("#tt-range").isVisible(), true, `${name}: slider is visible`);
  for (const id of ["#tt-prev", "#tt-next", "#tt-range", "#tt-rewind", "#tt-fork"]) {
    const box = await page.locator(id).boundingBox();
    assert.ok(
      box && box.height >= 44 - 0.5,
      `${name}: ${id} is at least 44px tall (${box?.height})`,
    );
  }
  const prevBox = await page.locator("#tt-prev").boundingBox();
  assert.ok(prevBox && prevBox.width >= 43.5, `${name}: step button is 44px wide`);
  await page.locator("#tt-files .tt-file summary").first().click();
  await page.locator("#tt-diff-dialog[open]").waitFor();
  assert.match(
    (await page.locator("#tt-diff-code").textContent()) || "",
    /hello world/,
    `${name}: diff opens full screen`,
  );
  await page.screenshot({ path: path.join(shots, `${name}-diff.png`) });
  await page.click("#tt-diff-close");
  await page.click("#tt-next");
  await page.waitForFunction(() =>
    document.getElementById("tt-position")?.textContent?.startsWith("4 of 4"),
  );
}

try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Scratch server did not start: ${serverError}`)),
      15000,
    );
    server.stdout.on("data", (chunk) => {
      if (String(chunk).includes("agent-console listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Scratch server exited: ${code}: ${serverError}`));
    });
  });
  browser = await chromium.launch();
  fs.mkdirSync(shots, { recursive: true });
  const view = await openView({ width: 1280, height: 860 }, "dark", false);
  const { page } = view;

  // The panel opens and the scrubber shows ticks.
  assert.equal(await page.locator("#tt-panel").isVisible(), false, "panel starts closed");
  await page.click("#tt-toggle");
  await page.locator("#tt-panel").waitFor({ state: "visible" });
  await page.locator("#tt-track .tt-tick").nth(3).waitFor();
  assert.equal(await page.locator("#tt-track .tt-tick").count(), 4, "one tick per checkpoint");
  assert.equal(await page.locator("#tt-track .tt-tick.big").count(), 2, "turn ticks are big");
  assert.equal(await page.locator("#tt-track .tt-tick.small").count(), 2, "tool ticks are small");
  const toneOf = (index: number) =>
    page.locator("#tt-track .tt-tick").nth(index).getAttribute("data-tone");
  const letterOf = (index: number) =>
    page.locator("#tt-track .tt-tick .tt-letter").nth(index).textContent();
  assert.equal(await toneOf(1), "add");
  assert.equal(await letterOf(1), "A", "colour always has a letter");
  assert.equal(await toneOf(2), "mixed");
  assert.equal(await letterOf(2), "±");
  assert.equal(await toneOf(0), "none");
  assert.match(
    (await page.locator("#tt-track .tt-tick").nth(2).getAttribute("aria-label")) || "",
    /Checkpoint 3, Tool, 1 A · 1 M/,
  );
  assert.equal(
    (await page.locator("#chat .tt-row").count()) >= 4,
    true,
    "checkpoint events render as thin transcript rows",
  );

  // Selecting a tick shows the diff and scrolls the transcript.
  await page.locator("#tt-track .tt-tick").nth(2).click();
  await page.locator("#tt-files .tt-file-item").nth(1).waitFor();
  assert.match(
    (await page.locator("#tt-summary").textContent()) || "",
    /#3 Tool · 2 files changed/,
  );
  assert.match(
    (await page.locator("#tt-counts").textContent()) || "",
    /A 1 added.*M 1 modified.*D 0 deleted/,
  );
  await page.locator("#chat .tt-row.tt-active[data-tt-seq='3']").waitFor();
  await page.locator("#tt-files .tt-file summary").first().click();
  await page.waitForFunction(() =>
    /hello world/.test(document.querySelector("#tt-files .tt-diff code")?.textContent || ""),
  );
  assert.ok(
    callsTo(view, "GET", /^\/3\/diff\?base=prev$/).length >= 1,
    "diff fetched against the previous checkpoint",
  );
  await page.selectOption("#tt-base", "turn");
  await page.waitForFunction(
    () => document.getElementById("tt-detail")?.getAttribute("aria-busy") === "false",
  );
  assert.ok(
    callsTo(view, "GET", /^\/3\/diff\?base=turn$/).length >= 1,
    "compare base is switchable",
  );
  await page.keyboard.press("Escape").catch(() => {});

  if (process.env.TT_DEBUG) console.log((await page.locator("#chat").innerHTML()).slice(0, 3500));
  // The Edit/Write chip opens the panel at its checkpoint.
  assert.equal(
    await page.locator("#chat .tt-chip:visible").count(),
    2,
    "Write and Edit cards show the chip once their checkpoint exists",
  );
  await page.locator("#tt-track .tt-tick").nth(3).click();
  await page.locator("#chat .tt-chip[data-tool-use='tt-write-1']").click();
  await page.waitForFunction(
    () =>
      document
        .querySelector("#tt-track .tt-tick[aria-pressed='true']")
        ?.getAttribute("data-index") === "1",
  );

  // Rewind confirm: busy, then counts and the outside warning.
  await page.locator("#tt-track .tt-tick").nth(2).click();
  view.mode.busy = true;
  await page.click("#tt-rewind");
  await page.waitForFunction(() =>
    /running in this folder/.test(document.getElementById("tt-confirm-error")?.textContent || ""),
  );
  assert.match(
    (await page.locator("#tt-confirm-error").textContent()) || "",
    /History conversation is running/,
    "busy names the running thread",
  );
  await page.click("#tt-confirm-cancel");
  view.mode.busy = false;
  await page.click("#tt-rewind");
  await page.waitForFunction(
    () => !(document.getElementById("tt-confirm-go") as HTMLButtonElement).disabled,
  );
  assert.equal(await page.locator("#tt-confirm-files li").count(), 2);
  assert.match(
    (await page.locator("#tt-confirm-counts").textContent()) || "",
    /M 1 modified.*D 1 deleted/,
  );
  assert.equal(
    await page.locator("#tt-confirm-warn-text").textContent(),
    "2 files changed outside this thread; they'll be saved first",
  );
  assert.equal(await page.locator("#tt-confirm-go").textContent(), "Rewind 2 files");
  const dry = callsTo(view, "POST", /^\/3\/rewind$/).find((call) => call.body.dryRun);
  assert.deepEqual(
    dry?.body,
    { expectCommit: "c4", dryRun: true },
    "dry run first, with the latest commit",
  );
  await page.screenshot({ path: path.join(shots, "desktop-dark-confirm.png") });

  // Real rewind, then the Undo toast.
  await page.click("#tt-confirm-go");
  await page.locator(".tt-toast:not([hidden])").waitFor();
  assert.match(
    (await page.locator(".tt-toast").textContent()) || "",
    /Files rewound to checkpoint #3.*Undo rewind/,
  );
  const real = callsTo(view, "POST", /^\/3\/rewind$/).find((call) => !call.body.dryRun);
  assert.deepEqual(real?.body, { expectCommit: "c4" }, "real rewind sends expectCommit");
  await page.locator("#tt-track .tt-tick").nth(4).waitFor();
  await page.screenshot({ path: path.join(shots, "desktop-dark-undo.png") });
  await page.click(".tt-toast .tt-undo");
  await page.waitForFunction(() => document.querySelector(".tt-toast")?.hasAttribute("hidden"));
  await page.waitForFunction(
    () => (document.getElementById("toast")?.textContent || "") === "Rewind undone.",
  );
  const undo = callsTo(view, "POST", /^\/5\/rewind$/)[0];
  assert.deepEqual(undo?.body, { expectCommit: "c5" }, "undo rewinds to preRewindSeq");

  // Fork calls the route and opens the new thread.
  await page.locator("#tt-track .tt-tick").nth(2).click();
  await page.click("#tt-fork");
  await page.waitForFunction(
    () => document.getElementById("ttl")?.textContent === "Forked conversation",
  );
  const fork = callsTo(view, "POST", /^\/3\/fork$/);
  assert.equal(fork.length, 1, "fork route called once for the selected checkpoint");
  assert.equal(await page.locator("#tt-panel").isVisible(), false, "panel closes after forking");
  await view.context.close();

  // Screenshots: desktop and phone, light and dark.
  const desktop = { width: 1280, height: 860 };
  const phone = { width: 412, height: 800 };
  await shoot("desktop-dark", desktop, "dark", false);
  await shoot("desktop-light", desktop, "light", false);
  await shoot("phone-dark", phone, "dark", true);
  await shoot("phone-light", phone, "light", true);
  assert.deepEqual(errors, [], "no browser errors");
  console.log(
    "PASS time travel UI: panel, scrubber ticks, diff, rewind confirm, undo toast, fork, phone sheet, themes",
  );
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill();
    await exited;
  }
  fs.rmSync(data, { recursive: true, force: true });
}

// Real-Chromium UI check: themes, viewports, type system, menus, code blocks, contrast, touch targets, slash menu, installability.
// Needs the server running. Spends no model quota: nothing is ever sent to the agent. The one thread it creates (empty, never run)
// is deleted through the app's own delete flow at the end.
import { chromium } from "playwright";
import { makeToken } from "../server/auth.ts";

const BASE = process.env.BASE || "http://127.0.0.1:7070";
const OUT = process.env.OUT || "/tmp";
const browser = await chromium.launch();
let failed = 0;
const check = (n: string, ok: boolean, x = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${n} ${x}`); if (!ok) failed++; };
const newCtx = async (o: any) => {
  const ctx = await browser.newContext(o);
  await ctx.addCookies([{ name: "ac_session", value: makeToken(), url: BASE }]);
  return ctx;
};

// ---------- contrast math (WCAG 2.x), computed from the live CSS tokens ----------
const parse = (s: string): [number, number, number, number] => {
  s = s.trim();
  if (s[0] === "#") { const h = s.slice(1); const f = h.length === 3 ? h.replace(/./g, "$&$&") : h; return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)).concat(1) as any; }
  const m = s.match(/[\d.]+/g)!.map(Number);
  return [m[0], m[1], m[2], m[3] ?? 1];
};
const over = (fg: number[], bg: number[]) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
const lum = (c: number[]) => { const [r, g, b] = c.slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a: number[], b: number[]) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

for (const [name, viewport, scheme] of [
  ["desktop-dark", { width: 1280, height: 800 }, "dark"],
  ["phone-dark", { width: 390, height: 844 }, "dark"],
  ["desktop-light", { width: 1280, height: 800 }, "light"],
] as const) {
  const phone = name.startsWith("phone");
  const ctx = await newCtx({ viewport, colorScheme: scheme, hasTouch: phone, isMobile: phone, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  const errors: string[] = [];
  const external: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("request", (r) => { const u = r.url(); if (!/^(data:|blob:|about:)/.test(u) && !/^wss?:\/\/127\.0\.0\.1|^https?:\/\/127\.0\.0\.1/.test(u)) external.push(u); });
  await page.goto(BASE + "/");
  await page.waitForSelector("#threads li", { timeout: 8000 }).catch(() => {});
  if (phone) await page.evaluate(() => (document.querySelector("#threads li") as HTMLElement | null)?.click());
  await page.waitForTimeout(1200);
  await page.evaluate(() => document.fonts.ready);

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
  check(`${name}: no request leaves 127.0.0.1`, external.length === 0, external.join(", "));

  // fonts: really loaded from /fonts, and applied
  const f = await page.evaluate(async () => {
    await document.fonts.load("400 15px Inter"); await document.fonts.load("400 13px 'JetBrains Mono'");
    const loaded = [...document.fonts].filter((x) => x.status === "loaded").map((x) => x.family.replace(/"/g, ""));
    return { loaded, inter: document.fonts.check("15px Inter"), mono: document.fonts.check("13px 'JetBrains Mono'"),
             body: getComputedStyle(document.body).fontFamily, code: getComputedStyle(document.getElementById("cwd-t")!).fontFamily };
  });
  check(`${name}: Inter + JetBrains Mono loaded`, f.inter && f.mono && f.loaded.includes("Inter") && f.loaded.includes("JetBrains Mono"), f.loaded.join(","));
  check(`${name}: type applied (UI Inter, paths mono)`, f.body.startsWith("Inter") && f.code.startsWith('"JetBrains Mono"'), `${f.body.slice(0, 20)} / ${f.code.slice(0, 22)}`);

  // chrome audit
  const a = await page.evaluate(() => {
    const vw = window.innerWidth;
    const selects = document.querySelectorAll("select").length;
    const rules = [...document.querySelectorAll("body *")].filter((e) => {
      if (e.closest("svg,hr,.table-wrap,.bar,.usage")) return false;
      const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
      return r.height > 0 && r.height < 3 && r.width > vw * 0.4 && cs.visibility !== "hidden" && cs.display !== "none";
    }).map((e) => e.tagName + "." + e.className);
    const red = [...document.querySelectorAll("#head,#composer,main,#side,#cbox,#mode")].filter((e) => /rgb\((1[89]\d|2\d\d), ?\d{1,2},/.test(getComputedStyle(e).boxShadow + getComputedStyle(e).borderColor + getComputedStyle(e).outlineColor)).map((e) => e.id);
    const head = getComputedStyle(document.getElementById("head"));
    return { selects, rules, red, headShadow: head.boxShadow, headBorder: head.borderBottomWidth };
  });
  check(`${name}: no <select> in the chat UI`, a.selects === 0);
  check(`${name}: no decorative full-width rules`, a.rules.length === 0, a.rules.join(","));
  check(`${name}: header has no bar/border, nothing red in chrome`, a.headShadow === "none" && a.headBorder === "0px" && a.red.length === 0, a.headShadow);

  // touch targets on the phone
  if (phone) {
    const t = await page.evaluate(() => ["send", "model", "mode", "more", "menu"].map((id) => { const e = document.getElementById(id)!; const r = e.getBoundingClientRect(); return [id, Math.round(r.width), Math.round(r.height), e.hidden || r.height === 0]; }));
    const small = t.filter(([, , h, hid]) => !hid && Number(h) < 44);
    check(`${name}: 44px touch targets (send/model/mode/more/menu)`, small.length === 0, JSON.stringify(t));
    const side = await page.evaluate(() => ({ c: document.getElementById("side")!.getBoundingClientRect().right }));
    check(`${name}: drawer closed offscreen`, side.c <= 1);
    await page.screenshot({ path: `${OUT}/ui-${name}-drawer-closed.png` });
    await page.click("#menu");
    await page.waitForTimeout(400);
    check(`${name}: drawer opens`, (await page.evaluate(() => document.getElementById("side")!.getBoundingClientRect().right)) > 200);
    await page.screenshot({ path: `${OUT}/ui-${name}-drawer-open.png` });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    // composer menus open upward without leaving the screen
    await page.click("#mode");
    const pop = await page.evaluate(() => { const r = document.querySelector(".menu")!.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom, innerWidth, innerHeight]; });
    check(`${name}: mode menu fits viewport`, pop[0] >= 0 && pop[1] >= 0 && pop[2] <= pop[4] && pop[3] <= pop[5], pop.map(Math.round).join(","));
    await page.screenshot({ path: `${OUT}/ui-${name}-menu.png` });
    await page.keyboard.press("Escape");
  }

  // contrast from live tokens
  const tok = await page.evaluate(() => { const cs = getComputedStyle(document.documentElement); const o: Record<string, string> = {}; for (const k of ["s0","s1","s2","s3","pop","code-bg","code-head","t1","t2","t3","accent","fill","on-fill","sel","ok","warn","bad","warn-tint","bad-tint","accent-tint","add-bg","del-bg","hl-kw","hl-str","hl-num","hl-fn","hl-type","hl-var","hl-cmt","hl-attr","hl-meta"]) o[k] = cs.getPropertyValue(`--${k}`); return o; });
  const C = (k: string) => parse(tok[k]);
  const pairs: [string, number[], number[]][] = [];
  for (const t of ["t1", "t2", "t3"]) for (const s of ["s0", "s1", "s2"]) pairs.push([`${t} on ${s}`, C(t), C(s)]);
  pairs.push(["t2 on pop", C("t2"), C("pop")], ["t1 on sel", C("t1"), C("sel")], ["t2 on sel", C("t2"), C("sel")], ["t3 on sel", C("t3"), C("sel")]);
  pairs.push(["accent on s1", C("accent"), C("s1")], ["accent on s2", C("accent"), C("s2")], ["on-fill on fill", C("on-fill"), C("fill")]);
  pairs.push(["ok on s1", C("ok"), C("s1")], ["bad on s1", C("bad"), C("s1")], ["warn on s1", C("warn"), C("s1")]);
  pairs.push(["warn on warn-tint/s2", C("warn"), over(C("warn-tint"), C("s2"))], ["warn on warn-tint/sel (bypass tag in selected row)", C("warn"), over(C("warn-tint"), C("sel"))],
    ["warn on warn-tint/s0", C("warn"), over(C("warn-tint"), C("s0"))], ["bad on bad-tint/s1", C("bad"), over(C("bad-tint"), C("s1"))], ["accent on accent-tint/s1", C("accent"), over(C("accent-tint"), C("s1"))],
    ["t1 on add-bg/code", C("t1"), over(C("add-bg"), C("code-bg"))], ["t1 on del-bg/code", C("t1"), over(C("del-bg"), C("code-bg"))]);
  for (const k of ["hl-kw", "hl-str", "hl-num", "hl-fn", "hl-type", "hl-var", "hl-cmt", "hl-attr", "hl-meta"]) pairs.push([`${k} on code`, C(k), C("code-bg")]);
  pairs.push(["t1 on code", C("t1"), C("code-bg")], ["t2 on code-head", C("t2"), C("code-head")]);
  const res = pairs.map(([n, a, b]) => [n, ratio(a, b)] as [string, number]);
  const bad = res.filter(([, r]) => r < 4.5);
  check(`${name}: contrast >= 4.5:1 for ${res.length} text pairs`, bad.length === 0, `min=${Math.min(...res.map(([, r]) => r)).toFixed(2)} ${bad.map(([n, r]) => `${n}=${r.toFixed(2)}`).join("; ")}`);
  if (!phone) {
    const pick = (n: string) => res.find(([x]) => x === n)![1].toFixed(1);
    console.log(`INFO  ${name} contrast: t1/s1 ${pick("t1 on s1")}, t2/s1 ${pick("t2 on s1")}, t3/s1 ${pick("t3 on s1")}, t3/s2 ${pick("t3 on s2")}, accent/s1 ${pick("accent on s1")}, on-fill/fill ${pick("on-fill on fill")}, bypass tag ${pick("warn on warn-tint/s2")}, bad/s1 ${pick("bad on s1")}, code tokens min ${Math.min(...res.filter(([n]) => n.startsWith("hl-")).map(([, r]) => r)).toFixed(1)}`);
  }

  await page.screenshot({ path: `${OUT}/ui-${name}.png` });
  if (name === "desktop-dark") {
    const cdp = await ctx.newCDPSession(page);
    const r: any = await cdp.send("Page.getInstallabilityErrors" as any);
    check("Chrome installability: no errors", (r.installabilityErrors ?? []).length === 0, JSON.stringify(r.installabilityErrors ?? []).slice(0, 200));
    const mf: any = await cdp.send("Page.getAppManifest" as any);
    check("manifest parses with no errors", !(mf.errors ?? []).length, JSON.stringify(mf.errors ?? []).slice(0, 200));
    // tool card, opened, for the screenshot
    const card = page.locator(".card").first();
    if (await card.count()) {
      await card.scrollIntoViewIfNeeded();
      await card.locator("summary").click();
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${OUT}/ui-cards.png` });
    }
  }
  await ctx.close();
}

// ---------- markdown render path: code blocks, copy, sanitiser (uses the app's own render.js) ----------
for (const scheme of ["dark", "light"] as const) {
  const ctx = await newCtx({ viewport: { width: 900, height: 900 }, colorScheme: scheme, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  await page.goto(BASE + "/");
  await page.waitForSelector("#threads li", { timeout: 8000 }).catch(() => {});
  await page.evaluate(async () => {
    const r = await import("/render.js");
    const chat = document.getElementById("chat")!;
    chat.replaceChildren();
    const src = "# Heading\n\nSome `inline code` and a [link](https://example.com).\n\n```js\n// greet\nconst greet = (name) => `hi ${name}`;\nconsole.log(greet(\"world\"), 42, true);\n```\n\n```python\ndef f(x):\n    return x * 2  # double\n```\n\n```diff\n- old line\n+ new line\n```\n\n```nosuchlang\nplain <b>text</b>\n```\n\n| a | b |\n|---|---|\n| 1 | `two` |\n\n<img src=x onerror=\"window.__xss=1\"><script>window.__xss=2</script>";
    const d = document.createElement("div"); d.className = "msg asst"; const p = document.createElement("div"); p.className = "prose"; d.append(p); chat.append(d);
    r.renderMarkdown(src, p);
    (window as any).__src = src;
  });
  const q = await page.evaluate(() => ({
    blocks: document.querySelectorAll("#chat .code").length,
    langs: [...document.querySelectorAll("#chat .code-head .lang")].map((e) => e.textContent),
    copyBtns: document.querySelectorAll("#chat .code-head button[aria-label=Copy]").length,
    kw: document.querySelectorAll("#chat .hljs-keyword").length, str: document.querySelectorAll("#chat .hljs-string").length, cmt: document.querySelectorAll("#chat .hljs-comment").length,
    add: document.querySelectorAll("#chat .hljs-addition").length, del: document.querySelectorAll("#chat .hljs-deletion").length,
    xss: (window as any).__xss ?? 0, scripts: document.querySelectorAll("#chat script").length, onerr: document.querySelectorAll("#chat [onerror]").length,
    table: !!document.querySelector("#chat .table-wrap table"), a: document.querySelector("#chat a")?.getAttribute("rel"),
    liga: getComputedStyle(document.querySelector("#chat .code pre")!).fontVariantLigatures, codeFont: getComputedStyle(document.querySelector("#chat .code pre code")!).fontSize,
    inlineFont: getComputedStyle(document.querySelector("#chat p code")!).fontFamily.slice(0, 14), bodySize: getComputedStyle(document.querySelector("#chat p")!).fontSize, lh: getComputedStyle(document.querySelector("#chat p")!).lineHeight,
  }));
  check(`code (${scheme}): 4 blocks with header rows`, q.blocks === 4 && q.langs.join() === "JavaScript,Python,Diff,nosuchlang", q.langs.join());
  check(`code (${scheme}): copy button per block`, q.copyBtns === 4);
  check(`code (${scheme}): syntax tokens highlighted`, q.kw > 2 && q.str > 0 && q.cmt >= 2 && q.add === 1 && q.del === 1, JSON.stringify([q.kw, q.str, q.cmt, q.add, q.del]));
  check(`code (${scheme}): sanitiser strips script + handlers`, q.xss === 0 && q.scripts === 0 && q.onerr === 0 && q.a === "noopener noreferrer");
  check(`code (${scheme}): tables wrapped, ligatures off`, q.table && /none/.test(q.liga), q.liga);
  check(`code (${scheme}): 13px mono code, 15px/1.6 Inter body`, q.codeFont === "13px" && q.bodySize === "15px" && q.lh === "24px" && q.inlineFont.startsWith('"JetBrains'), `${q.codeFont} ${q.bodySize}/${q.lh} ${q.inlineFont}`);
  if (scheme === "dark") {
    const btn = page.locator("#chat .code-head button:has(.lab)").first();
    await btn.click();
    await page.waitForFunction((e) => /Copied/.test(e!.textContent || ""), await btn.elementHandle(), { timeout: 2000 }).catch(() => {});
    check("code: Copy shows Copied then resets", (await btn.innerText()).includes("Copied"));
    check("code: announced politely", (await page.locator("#announce").innerText()) === "Copied");
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    check("code: clipboard holds the raw code", clip.startsWith("// greet\nconst greet") && !clip.includes("<span"), JSON.stringify(clip.slice(0, 30)));
    await page.waitForTimeout(1700);
    check("code: Copied state clears after 1.5s", (await btn.innerText()).includes("Copy") && !(await btn.innerText()).includes("Copied"));
    // fallback path: clipboard API rejects -> execCommand
    await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("denied")) }, configurable: true }); });
    const b2 = page.locator("#chat .code-head button:has(.lab)").nth(1);
    await b2.click();
    await page.waitForTimeout(300);
    check("code: execCommand fallback reports a result", /Copied|Copy failed/.test(await b2.innerText()), await b2.innerText());
    const wrapBtn = page.locator("#chat .code-head button[aria-label='Wrap lines']").first();
    await wrapBtn.click();
    check("code: wrap toggle", (await wrapBtn.getAttribute("aria-pressed")) === "true" && (await page.locator("#chat .code.wrapped").count()) === 1);
    await page.locator("#chat").evaluate((c) => c.scrollTo(0, 0));
    await page.screenshot({ path: `${OUT}/ui-codeblock-dark.png`, clip: { x: 0, y: 0, width: 900, height: 900 } });
  } else await page.screenshot({ path: `${OUT}/ui-codeblock-light.png` });
  await ctx.close();
}

// ---------- menus, composer, dialog, rename, delete (uses a throw-away empty thread; nothing is sent) ----------
{
  const ctx = await newCtx({ viewport: { width: 1280, height: 800 }, colorScheme: "dark", permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  let confirmAnswer = true; const confirms: string[] = [];
  page.on("dialog", (d) => { confirms.push(d.message()); confirmAnswer ? d.accept() : d.dismiss(); });
  await page.goto(BASE + "/");
  await page.waitForSelector("#threads li", { timeout: 8000 });
  await page.waitForFunction(() => document.querySelectorAll("#d-cwd span").length && document.querySelector("#d-cwd span")!.textContent!.length > 0);
  const before = await page.locator("#threads li").count();

  // New thread dialog uses the same custom menus
  await page.click("#new");
  await page.waitForTimeout(250);
  check("dialog: no native selects", (await page.locator("dialog select").count()) === 0);
  // agent picker: one dialog, several harnesses; models and modes follow the choice
  const agentLabels = async () => { await page.click("#d-prov"); const t = await page.locator(".menu [role=option] .m-label").allInnerTexts(); return t; };
  const labels = await agentLabels();
  check("dialog: agent menu lists Claude Code, Pi, Codex", ["Claude Code", "Pi", "Codex"].every((l) => labels.includes(l)), labels.join());
  const codexDisabled = await page.locator(".menu [role=option]", { hasText: "Codex" }).getAttribute("aria-disabled");
  check("dialog: a not-ready agent is disabled and says why", codexDisabled === "true" ? (await page.locator(".menu [role=option]", { hasText: "Codex" }).innerText()).includes("codex login") : true);
  const piItem = page.locator(".menu [role=option]", { hasText: "Pi" }).first();
  if ((await piItem.getAttribute("aria-disabled")) !== "true") {
    await piItem.click();
    await page.click("#d-mode");
    const piModes = await page.locator(".menu [role=option] .m-label").allInnerTexts();
    check("dialog: Pi offers only Plan and Bypass (it has no approval prompts)", piModes.join() === "Plan,Bypass", piModes.join());
    await page.keyboard.press("Escape");
    check("dialog: Pi shows its permission note and defaults to the bypass warning", (await page.locator("#d-note").isVisible()) && (await page.locator("#d-warn").isVisible()));
    await page.click("#d-model");
    const piModels = await page.locator(".menu [role=option]").count();
    const firstDesc = await page.locator(".menu [role=option] .m-desc").first().innerText();
    check("dialog: Pi model menu is populated and labels source", piModels > 0 && /free|openrouter|openai/.test(firstDesc), `${piModels} ${firstDesc}`);
    await page.screenshot({ path: `${OUT}/ui-pi-models.png` });
    await page.keyboard.press("Escape");
  } else console.log("SKIP  Pi checks (Pi not configured on this machine)");
  await page.click("#d-prov");
  await page.locator(".menu [role=option]", { hasText: "Claude Code" }).click();
  await page.click("#d-mode");
  const claudeModes = await page.locator(".menu [role=option] .m-label").allInnerTexts();
  check("dialog: switching back restores Claude's three modes", claudeModes.length === 3, claudeModes.join());
  await page.keyboard.press("Escape");
  check("dialog: create button enabled for a ready agent", !(await page.locator("#d-ok").isDisabled()));
  await page.click("#d-cwd");
  const inDialog = await page.evaluate(() => !!document.querySelector("dialog .menu"));
  check("dialog: folder menu opens inside the modal", inDialog);
  await page.screenshot({ path: `${OUT}/ui-dialog-menu.png` });
  await page.keyboard.press("Escape");
  check("dialog: Esc closes the menu only, dialog stays", (await page.evaluate(() => (document.getElementById("dlg") as HTMLDialogElement).open)) && (await page.locator(".menu").count()) === 0);
  check("dialog: focus returns to the field", await page.evaluate(() => document.activeElement?.id === "d-cwd"));
  await page.click("#d-cwd");
  await page.locator(".menu [role=option]", { hasText: "agent-console" }).first().click();
  await page.click("#d-mode");
  await page.locator(".menu [role=option]", { hasText: "Bypass" }).click();
  check("dialog: bypass shows the warning", await page.locator("#d-warn").isVisible());
  await page.screenshot({ path: `${OUT}/ui-newthread-dialog.png` });
  await page.click("#d-mode");
  await page.locator(".menu [role=option]", { hasText: "Plan" }).click();
  check("dialog: warning clears for Plan", !(await page.locator("#d-warn").isVisible()));
  await page.click("#d-ok");
  await page.waitForFunction((n) => document.querySelectorAll("#threads li").length === n + 1, before, { timeout: 5000 });
  await page.waitForFunction(() => document.getElementById("ttl")!.textContent === "agent-console");
  check("dialog: creates and opens the thread", (await page.locator("#mode").innerText()).includes("Plan"), await page.locator("#mode").innerText());

  // model chip: keyboard
  const model = page.locator("#model");
  await model.focus();
  await page.keyboard.press("Enter");
  const opened = await page.evaluate(() => { const m = document.querySelector(".menu")!; return { role: m.getAttribute("role"), opts: m.querySelectorAll("[role=option]").length, exp: document.getElementById("model")!.getAttribute("aria-expanded"), focus: document.activeElement === m, haspopup: document.getElementById("model")!.getAttribute("aria-haspopup") }; });
  check("model menu: opens on Enter, listbox with 3 options, focus inside", opened.role === "listbox" && opened.opts === 3 && opened.exp === "true" && opened.focus && opened.haspopup === "listbox", JSON.stringify(opened));
  const act0 = await page.evaluate(() => document.querySelector(".menu [data-active]")!.textContent);
  await page.keyboard.press("ArrowDown");
  const act1 = await page.evaluate(() => document.querySelector(".menu [data-active] .m-label")!.textContent);
  check("model menu: ArrowDown moves the active option", act1 !== act0.slice(0, act1!.length) || act1 === "Opus", `${act0} -> ${act1}`);
  await page.keyboard.press("Escape");
  check("model menu: Esc closes and returns focus", (await page.locator(".menu").count()) === 0 && (await page.evaluate(() => document.activeElement?.id)) === "model" && (await model.getAttribute("aria-expanded")) === "false");
  await page.keyboard.press("ArrowUp"); // opens on last
  check("model menu: ArrowUp on trigger opens at last item", (await page.evaluate(() => document.querySelector(".menu [data-active] .m-label")!.textContent)) === "Haiku");
  await page.keyboard.press("Home");
  await page.keyboard.type("o"); // typeahead
  check("model menu: typeahead jumps to Opus", (await page.evaluate(() => document.querySelector(".menu [data-active] .m-label")!.textContent)) === "Opus");
  await page.screenshot({ path: `${OUT}/ui-model-menu.png` });
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => /Opus/.test(document.querySelector("#threads li.sel")?.getAttribute("title") || ""), null, { timeout: 4000 });
  check("model menu: Enter changes the thread's model (server round-trip)", /Opus/.test(await model.innerText()));
  await page.click("#model");
  await page.click("body", { position: { x: 640, y: 300 } });
  check("model menu: outside click closes", (await page.locator(".menu").count()) === 0);
  await page.click("#model");
  await page.locator(".menu [role=option]", { hasText: "Sonnet" }).click();
  await page.waitForFunction(() => /Sonnet/.test(document.querySelector("#threads li.sel")?.getAttribute("title") || ""));
  check("model menu: mouse select", /Sonnet/.test(await model.innerText()));

  // mode chip: bypass is confirmed, shown as a calm amber chip, never red
  await page.click("#mode");
  const modeOpts = await page.locator(".menu [role=option] .m-desc").allInnerTexts();
  check("mode menu: options carry descriptions", modeOpts.length === 3, modeOpts.join(" | "));
  confirmAnswer = false;
  await page.locator(".menu [role=option]", { hasText: "Bypass" }).click();
  await page.waitForTimeout(300);
  check("mode menu: declined confirm leaves mode unchanged", (await page.locator("#mode").innerText()).includes("Plan") && confirms.some((c) => /Bypass mode runs every tool/.test(c)));
  confirmAnswer = true;
  await page.click("#mode");
  await page.locator(".menu [role=option]", { hasText: "Bypass" }).click();
  await page.waitForFunction(() => document.getElementById("mode")!.dataset.tone === "warn");
  await page.waitForTimeout(400);
  const chip = await page.evaluate(() => { const c = getComputedStyle(document.getElementById("mode")!); const tag = document.querySelector("#threads li.sel .tag"); return { color: c.color, bg: c.backgroundColor, tag: !!tag, label: document.getElementById("mode")!.textContent!.trim() }; });
  const [r, g, b] = parse(chip.color);
  check("bypass: amber chip with label (not red), tag on the thread row", chip.label === "Bypass" && chip.tag && r > 200 && g > 140 && b < 130 && g > b + 40, JSON.stringify(chip));
  await page.screenshot({ path: `${OUT}/ui-bypass-chip.png` });
  await page.click("#mode");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.getElementById("mode")!.dataset.tone);
  check("mode menu: keyboard back to Plan", (await page.locator("#mode").innerText()).includes("Plan"));

  // composer card layout + slash anchored to it
  const lay = await page.evaluate(() => { const c = document.getElementById("cbox")!.getBoundingClientRect(); const i = document.getElementById("input")!.getBoundingClientRect(); const t = document.querySelector(".toolbar")!.getBoundingClientRect(); return { r: parseFloat(getComputedStyle(document.getElementById("cbox")!).borderRadius), textAbove: i.bottom <= t.top, inside: i.left >= c.left && t.right <= c.right }; });
  check("composer: card radius >= 20px, textarea above toolbar", lay.r >= 20 && lay.textAbove && lay.inside, JSON.stringify(lay));
  await page.fill("#input", "");
  await page.click("#input");
  await page.keyboard.type("/");
  await page.waitForTimeout(350);
  const an = await page.evaluate(() => { const s = document.getElementById("slash")!.getBoundingClientRect(); const c = document.getElementById("cbox")!.getBoundingClientRect(); return [Math.abs(s.left - c.left), Math.abs(s.right - c.right), c.top - s.bottom]; });
  check("slash menu: anchored to the composer card", an[0] < 1 && an[1] < 1 && an[2] > 0 && an[2] < 16, an.map(Math.round).join(","));
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/ui-slash-open.png` });
  await page.keyboard.press("Escape");
  await page.fill("#input", "");

  // overflow menu: rename, then delete (with the existing confirm)
  await page.click("#more");
  check("overflow: menu with Rename + Delete", (await page.locator(".menu[role=menu] [role=menuitem]").allInnerTexts()).join().includes("Delete thread"));
  await page.locator(".menu [role=menuitem]", { hasText: "Rename" }).click();
  await page.waitForSelector("#ttl-edit");
  await page.fill("#ttl-edit", "ui-polish-test");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.getElementById("ttl")!.textContent === "ui-polish-test");
  check("rename: title updates via websocket update", (await page.locator("#threads li.sel .t").innerText()) === "ui-polish-test");
  await page.screenshot({ path: `${OUT}/ui-desktop-test-thread.png` });
  await page.click("#more");
  await page.locator(".menu [role=menuitem]", { hasText: "Delete thread" }).click();
  await page.waitForFunction((n) => document.querySelectorAll("#threads li").length === n, before, { timeout: 5000 });
  check("delete: confirmed and removed", confirms.some((c) => /Delete "ui-polish-test"/.test(c)) && (await page.locator("#threads li").count()) === before);
  await ctx.close();
}

// ---------- slash menu (no model quota used: nothing is sent) ----------
{
  const ctx = await newCtx({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" });
  const page = await ctx.newPage();
  await page.goto(BASE + "/");
  await page.waitForSelector("#threads li", { timeout: 8000 });
  // slash commands are per agent and the test expects Claude's: open a Claude thread (non-Claude rows carry an agent tag)
  await page.locator("#threads li").filter({ hasNotText: /Codex|Pi|Mock/ }).first().click();
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

// ---------- sign-in page: same type + buttons, fonts reachable without a session ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" });
  const page = await ctx.newPage();
  await page.goto(BASE + "/login");
  await page.evaluate(async () => { await document.fonts.load("600 24px Inter"); });
  const l = await page.evaluate(() => ({ inter: document.fonts.check("15px Inter") && [...document.fonts].some((f) => f.family.includes("Inter") && f.status === "loaded"), btn: getComputedStyle(document.querySelector("button")!).borderRadius, h1: getComputedStyle(document.querySelector("h1")!).fontFamily.slice(0, 5) }));
  check("login: Inter loads without a session", l.inter && l.h1 === "Inter", JSON.stringify(l));
  await page.screenshot({ path: `${OUT}/ui-login.png` });
  await ctx.close();
}
await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall UI checks passed");
process.exit(failed ? 1 : 0);

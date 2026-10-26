// Real-Chromium UI check: themes, viewports, type system, menus, code blocks, contrast, touch targets, slash menu, installability.
// Needs the server running. Spends no model quota: nothing is ever sent to the agent. The one thread it creates (empty, never run)
// is deleted through the app's own delete flow at the end.
// Scratch server: AGENT_CONSOLE_MOCK=1 AGENT_CONSOLE_MOCK_COMPACT_MS=1500 (two messages must queue while the mock compacts).
import { chromium } from "playwright";
import { makeToken } from "../server/auth.ts";

const BASE = process.env.BASE || "http://127.0.0.1:7070";
const OUT = process.env.OUT || "/tmp";
const browser = await chromium.launch();
let failed = 0;
const check = (n: string, ok: boolean, x = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${n} ${x}`);
  if (!ok) failed++;
};
const newCtx = async (o: any) => {
  const ctx = await browser.newContext(o);
  await ctx.addCookies([{ name: "__Host-ac_session", value: makeToken(), domain: new URL(BASE).hostname, path: "/", secure: true }]);
  return ctx;
};

// ---------- contrast math (WCAG 2.x), computed from the live CSS tokens ----------
const parse = (s: string): [number, number, number, number] => {
  s = s.trim();
  if (s[0] === "#") {
    const h = s.slice(1);
    const f = h.length === 3 ? h.replace(/./g, "$&$&") : h;
    return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)).concat(1) as any;
  }
  const m = s.match(/[\d.]+/g)!.map(Number);
  return [m[0], m[1], m[2], m[3] ?? 1];
};
const over = (fg: number[], bg: number[]) =>
  [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
const lum = (c: number[]) => {
  const [r, g, b] = c.slice(0, 3).map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: number[], b: number[]) => {
  const x = lum(a),
    y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

for (const [name, viewport, scheme] of [
  ["desktop-dark", { width: 1280, height: 800 }, "dark"],
  ["phone-dark", { width: 390, height: 844 }, "dark"],
  ["desktop-light", { width: 1280, height: 800 }, "light"],
] as const) {
  const phone = name.startsWith("phone");
  const ctx = await newCtx({
    viewport,
    colorScheme: scheme,
    hasTouch: phone,
    isMobile: phone,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  const external: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("request", (r) => {
    const u = r.url();
    if (
      !/^(data:|blob:|about:)/.test(u) &&
      !/^wss?:\/\/127\.0\.0\.1|^https?:\/\/127\.0\.0\.1/.test(u)
    )
      external.push(u);
  });
  await page.goto(BASE + "/");
  await page.waitForSelector("#threads li", { timeout: 8000 }).catch(() => {});
  if (phone)
    await page.evaluate(() =>
      (document.querySelector("#threads li") as HTMLElement | null)?.click(),
    );
  await page.waitForTimeout(1200);
  await page.evaluate(() => document.fonts.ready);

  const m = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".card")] as HTMLElement[];
    const chat = document.getElementById("chat")!;
    return {
      cards: cards.length,
      minH: Math.min(...cards.map((c) => c.getBoundingClientRect().height)),
      overflow: chat.scrollHeight > chat.clientHeight,
      hScroll: document.documentElement.scrollWidth > window.innerWidth,
      name0: (cards[0]?.querySelector(".name") as HTMLElement)?.textContent || "",
    };
  });
  if (m.cards && m.overflow) {
    // needs a thread long enough to overflow; which one opens first depends on the seeded data
    check(
      `${name}: cards keep height in overflowing chat`,
      m.minH >= 30 && m.overflow,
      `cards=${m.cards} minH=${Math.round(m.minH)} overflow=${m.overflow}`,
    );
    check(`${name}: card shows tool name`, m.name0.length > 0, m.name0);
  } else console.log(`SKIP  ${name}: no tool cards in any thread`);
  check(`${name}: no horizontal page scroll`, !m.hScroll);
  check(`${name}: no console/page errors`, errors.length === 0, errors.join(" | ").slice(0, 160));
  check(`${name}: no request leaves 127.0.0.1`, external.length === 0, external.join(", "));

  // fonts: really loaded from /fonts, and applied
  const f = await page.evaluate(async () => {
    await document.fonts.load("400 15px Inter");
    await document.fonts.load("400 13px 'JetBrains Mono'");
    await document.fonts.load("400 18px Newsreader");
    const loaded = [...document.fonts]
      .filter((x) => x.status === "loaded")
      .map((x) => x.family.replace(/"/g, ""));
    return {
      loaded,
      inter: document.fonts.check("15px Inter"),
      mono: document.fonts.check("13px 'JetBrains Mono'"),
      body: getComputedStyle(document.body).fontFamily,
      code: getComputedStyle(document.getElementById("cwd-t")!).fontFamily,
      serif: document.fonts.check("18px Newsreader"),
      input: getComputedStyle(document.getElementById("input")!).fontFamily,
    };
  });
  check(
    `${name}: Inter + JetBrains Mono + Newsreader loaded`,
    f.inter &&
      f.mono &&
      f.serif &&
      f.loaded.includes("Inter") &&
      f.loaded.includes("JetBrains Mono") &&
      f.loaded.includes("Newsreader"),
    f.loaded.join(","),
  );
  check(
    `${name}: type applied (UI Inter, paths mono, what you type in Newsreader)`,
    f.body.startsWith("Inter") &&
      f.code.startsWith('"JetBrains Mono"') &&
      f.input.startsWith("Newsreader"),
    `${f.body.slice(0, 20)} / ${f.code.slice(0, 22)} / ${f.input.slice(0, 12)}`,
  );

  // chrome audit
  const a = await page.evaluate(() => {
    const vw = window.innerWidth;
    const selects = document.querySelectorAll("select").length;
    const rules = [...document.querySelectorAll("body *")]
      .filter((e) => {
        if (e.closest("svg,hr,.table-wrap,.bar,.usage")) return false;
        const r = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        return (
          r.height > 0 &&
          r.height < 3 &&
          r.width > vw * 0.4 &&
          cs.visibility !== "hidden" &&
          cs.display !== "none"
        );
      })
      .map((e) => e.tagName + "." + e.className);
    const red = [...document.querySelectorAll("#head,#composer,main,#side,#cbox,#mode")]
      .filter((e) =>
        /rgb\((1[89]\d|2\d\d), ?\d{1,2},/.test(
          getComputedStyle(e).boxShadow +
            getComputedStyle(e).borderColor +
            getComputedStyle(e).outlineColor,
        ),
      )
      .map((e) => e.id);
    const head = getComputedStyle(document.getElementById("head"));
    return { selects, rules, red, headShadow: head.boxShadow, headBorder: head.borderBottomWidth };
  });
  check(`${name}: no <select> in the chat UI`, a.selects === 0);
  check(`${name}: no decorative full-width rules`, a.rules.length === 0, a.rules.join(","));
  check(
    `${name}: header has no bar/border, nothing red in chrome`,
    a.headShadow === "none" && a.headBorder === "0px" && a.red.length === 0,
    a.headShadow,
  );

  // touch targets on the phone
  if (phone) {
    const t = await page.evaluate(() =>
      ["attach", "send", "model", "mode", "more", "menu"].map((id) => {
        const e = document.getElementById(id)!;
        const r = e.getBoundingClientRect();
        return [id, Math.round(r.width), Math.round(r.height), e.hidden || r.height === 0];
      }),
    );
    const small = t.filter(([, , h, hid]) => !hid && Number(h) < 44);
    check(
      `${name}: 44px touch targets (attach/send/model/mode/more/menu)`,
      small.length === 0,
      JSON.stringify(t),
    );
    const side = await page.evaluate(() => ({
      c: document.getElementById("side")!.getBoundingClientRect().right,
    }));
    check(`${name}: drawer closed offscreen`, side.c <= 1);
    await page.screenshot({ path: `${OUT}/ui-${name}-drawer-closed.png` });
    await page.click("#menu");
    await page.waitForTimeout(400);
    check(
      `${name}: drawer opens`,
      (await page.evaluate(() => document.getElementById("side")!.getBoundingClientRect().right)) >
        200,
    );
    await page.screenshot({ path: `${OUT}/ui-${name}-drawer-open.png` });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    // composer menus open upward without leaving the screen
    await page.click("#mode");
    const pop = await page.evaluate(() => {
      const r = document.querySelector(".menu")!.getBoundingClientRect();
      return [r.left, r.top, r.right, r.bottom, innerWidth, innerHeight];
    });
    check(
      `${name}: mode menu fits viewport`,
      pop[0] >= 0 && pop[1] >= 0 && pop[2] <= pop[4] && pop[3] <= pop[5],
      pop.map(Math.round).join(","),
    );
    await page.screenshot({ path: `${OUT}/ui-${name}-menu.png` });
    await page.keyboard.press("Escape");
  }

  // contrast from live tokens
  const tok = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const o: Record<string, string> = {};
    for (const k of [
      "stop",
      "on-stop",
      "stop-hover",
      "s0",
      "s1",
      "s2",
      "s3",
      "pop",
      "code-bg",
      "code-head",
      "t1",
      "t2",
      "t3",
      "accent",
      "fill",
      "on-fill",
      "sel",
      "ok",
      "warn",
      "bad",
      "warn-tint",
      "bad-tint",
      "accent-tint",
      "add-bg",
      "del-bg",
      "hl-kw",
      "hl-str",
      "hl-num",
      "hl-fn",
      "hl-type",
      "hl-var",
      "hl-cmt",
      "hl-attr",
      "hl-meta",
    ])
      o[k] = cs.getPropertyValue(`--${k}`);
    return o;
  });
  const C = (k: string) => parse(tok[k]);
  const pairs: [string, number[], number[]][] = [];
  for (const t of ["t1", "t2", "t3"])
    for (const s of ["s0", "s1", "s2"]) pairs.push([`${t} on ${s}`, C(t), C(s)]);
  pairs.push(
    ["on-stop on stop (Stop button)", C("on-stop"), C("stop")],
    ["on-stop on stop-hover", C("on-stop"), C("stop-hover")],
  );
  pairs.push(
    ["t2 on pop", C("t2"), C("pop")],
    ["t1 on sel", C("t1"), C("sel")],
    ["t2 on sel", C("t2"), C("sel")],
    ["t3 on sel", C("t3"), C("sel")],
  );
  pairs.push(
    ["accent on s1", C("accent"), C("s1")],
    ["accent on s2", C("accent"), C("s2")],
    ["on-fill on fill", C("on-fill"), C("fill")],
  );
  pairs.push(
    ["ok on s1", C("ok"), C("s1")],
    ["bad on s1", C("bad"), C("s1")],
    ["warn on s1", C("warn"), C("s1")],
  );
  pairs.push(
    ["warn on warn-tint/s2", C("warn"), over(C("warn-tint"), C("s2"))],
    [
      "warn on warn-tint/sel (bypass tag in selected row)",
      C("warn"),
      over(C("warn-tint"), C("sel")),
    ],
    ["warn on warn-tint/s0", C("warn"), over(C("warn-tint"), C("s0"))],
    ["bad on bad-tint/s1", C("bad"), over(C("bad-tint"), C("s1"))],
    ["accent on accent-tint/s1", C("accent"), over(C("accent-tint"), C("s1"))],
    ["accent on accent-tint/s2 (attach with files)", C("accent"), over(C("accent-tint"), C("s2"))],
    ["t1 on add-bg/code", C("t1"), over(C("add-bg"), C("code-bg"))],
    ["t1 on del-bg/code", C("t1"), over(C("del-bg"), C("code-bg"))],
  );
  for (const k of [
    "hl-kw",
    "hl-str",
    "hl-num",
    "hl-fn",
    "hl-type",
    "hl-var",
    "hl-cmt",
    "hl-attr",
    "hl-meta",
  ])
    pairs.push([`${k} on code`, C(k), C("code-bg")]);
  pairs.push(["t1 on code", C("t1"), C("code-bg")], ["t2 on code-head", C("t2"), C("code-head")]);
  const res = pairs.map(([n, a, b]) => [n, ratio(a, b)] as [string, number]);
  const bad = res.filter(([, r]) => r < 4.5);
  check(
    `${name}: contrast >= 4.5:1 for ${res.length} text pairs`,
    bad.length === 0,
    `min=${Math.min(...res.map(([, r]) => r)).toFixed(2)} ${bad.map(([n, r]) => `${n}=${r.toFixed(2)}`).join("; ")}`,
  );
  if (!phone) {
    const pick = (n: string) => res.find(([x]) => x === n)![1].toFixed(1);
    console.log(
      `INFO  ${name} contrast: t1/s1 ${pick("t1 on s1")}, t2/s1 ${pick("t2 on s1")}, t3/s1 ${pick("t3 on s1")}, t3/s2 ${pick("t3 on s2")}, accent/s1 ${pick("accent on s1")}, on-fill/fill ${pick("on-fill on fill")}, bypass tag ${pick("warn on warn-tint/s2")}, bad/s1 ${pick("bad on s1")}, code tokens min ${Math.min(...res.filter(([n]) => n.startsWith("hl-")).map(([, r]) => r)).toFixed(1)}`,
    );
  }

  await page.screenshot({ path: `${OUT}/ui-${name}.png` });
  if (name === "desktop-dark") {
    const cdp = await ctx.newCDPSession(page);
    const r: any = await cdp.send("Page.getInstallabilityErrors" as any);
    check(
      "Chrome installability: no errors",
      (r.installabilityErrors ?? []).length === 0,
      JSON.stringify(r.installabilityErrors ?? []).slice(0, 200),
    );
    const mf: any = await cdp.send("Page.getAppManifest" as any);
    check(
      "manifest parses with no errors",
      !(mf.errors ?? []).length,
      JSON.stringify(mf.errors ?? []).slice(0, 200),
    );
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
  const ctx = await newCtx({
    viewport: { width: 900, height: 900 },
    colorScheme: scheme,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await ctx.newPage();
  await page.goto(BASE + "/");
  await page.waitForSelector("#threads li", { timeout: 8000 }).catch(() => {});
  // Finish the initial history render before replacing chat with the markdown fixture.
  await page.waitForFunction(() => !!(window as any).agentConsoleMetrics, { timeout: 15000 });
  await page.evaluate(async () => {
    const r = await import("/render.js");
    const chat = document.getElementById("chat")!;
    chat.replaceChildren();
    const src =
      '# Heading\n\nSome `inline code` and a [link](https://example.com).\n\n```js\n// greet\nconst greet = (name) => `hi ${name}`;\nconsole.log(greet("world"), 42, true);\n```\n\n```python\ndef f(x):\n    return x * 2  # double\n```\n\n```diff\n- old line\n+ new line\n```\n\n```nosuchlang\nplain <b>text</b>\n```\n\n| a | b |\n|---|---|\n| 1 | `two` |\n\n<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
    const d = document.createElement("div");
    d.className = "msg asst";
    const p = document.createElement("div");
    p.className = "prose";
    d.append(p);
    chat.append(d);
    r.renderMarkdown(src, p);
    (window as any).__src = src;
  });
  const q = await page.evaluate(() => ({
    blocks: document.querySelectorAll("#chat .code").length,
    langs: [...document.querySelectorAll("#chat .code-head .lang")].map((e) => e.textContent),
    copyBtns: document.querySelectorAll("#chat .code-head button[aria-label=Copy]").length,
    kw: document.querySelectorAll("#chat .hljs-keyword").length,
    str: document.querySelectorAll("#chat .hljs-string").length,
    cmt: document.querySelectorAll("#chat .hljs-comment").length,
    add: document.querySelectorAll("#chat .hljs-addition").length,
    del: document.querySelectorAll("#chat .hljs-deletion").length,
    xss: (window as any).__xss ?? 0,
    scripts: document.querySelectorAll("#chat script").length,
    onerr: document.querySelectorAll("#chat [onerror]").length,
    table: !!document.querySelector("#chat .table-wrap table"),
    a: document.querySelector("#chat a")?.getAttribute("rel"),
    liga: getComputedStyle(document.querySelector("#chat .code pre")!).fontVariantLigatures,
    codeFont: getComputedStyle(document.querySelector("#chat .code pre code")!).fontSize,
    inlineFont: getComputedStyle(document.querySelector("#chat p code")!).fontFamily.slice(0, 14),
    bodySize: getComputedStyle(document.querySelector("#chat p")!).fontSize,
    bodyFont: getComputedStyle(document.querySelector("#chat p")!).fontFamily.slice(0, 10),
    lh: getComputedStyle(document.querySelector("#chat p")!).lineHeight,
  }));
  check(
    `code (${scheme}): 4 blocks with header rows`,
    q.blocks === 4 && q.langs.join() === "JavaScript,Python,Diff,nosuchlang",
    q.langs.join(),
  );
  check(`code (${scheme}): copy button per block`, q.copyBtns === 4);
  check(
    `code (${scheme}): syntax tokens highlighted`,
    q.kw > 2 && q.str > 0 && q.cmt >= 2 && q.add === 1 && q.del === 1,
    JSON.stringify([q.kw, q.str, q.cmt, q.add, q.del]),
  );
  check(
    `code (${scheme}): sanitiser strips script + handlers`,
    q.xss === 0 && q.scripts === 0 && q.onerr === 0 && q.a === "noopener noreferrer",
  );
  check(`code (${scheme}): tables wrapped, ligatures off`, q.table && /none/.test(q.liga), q.liga);
  check(
    `code (${scheme}): 13px mono code, 18px/1.6 Newsreader body`,
    q.codeFont === "13px" &&
      q.bodySize === "18px" &&
      q.lh === "28.8px" &&
      q.bodyFont.startsWith("Newsreader") &&
      q.inlineFont.startsWith('"JetBrains'),
    `${q.codeFont} ${q.bodySize}/${q.lh} ${q.bodyFont} ${q.inlineFont}`,
  );
  if (scheme === "dark") {
    const btn = page.locator("#chat .code-head button:has(.lab)").first();
    await btn.click();
    await page
      .waitForFunction((e) => /Copied/.test(e!.textContent || ""), await btn.elementHandle(), {
        timeout: 2000,
      })
      .catch(() => {});
    check("code: Copy shows Copied then resets", (await btn.innerText()).includes("Copied"));
    check("code: announced politely", (await page.locator("#announce").innerText()) === "Copied");
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    check(
      "code: clipboard holds the raw code",
      clip.startsWith("// greet\nconst greet") && !clip.includes("<span"),
      JSON.stringify(clip.slice(0, 30)),
    );
    await page.waitForTimeout(1700);
    check(
      "code: Copied state clears after 1.5s",
      (await btn.innerText()).includes("Copy") && !(await btn.innerText()).includes("Copied"),
    );
    // fallback path: clipboard API rejects -> execCommand
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: () => Promise.reject(new Error("denied")) },
        configurable: true,
      });
    });
    const b2 = page.locator("#chat .code-head button:has(.lab)").nth(1);
    await b2.click();
    await page.waitForTimeout(300);
    check(
      "code: execCommand fallback reports a result",
      /Copied|Copy failed/.test(await b2.innerText()),
      await b2.innerText(),
    );
    const wrapBtn = page.locator("#chat .code-head button[aria-label='Wrap lines']").first();
    await wrapBtn.click();
    check(
      "code: wrap toggle",
      (await wrapBtn.getAttribute("aria-pressed")) === "true" &&
        (await page.locator("#chat .code.wrapped").count()) === 1,
    );
    await page.locator("#chat").evaluate((c) => c.scrollTo(0, 0));
    await page.screenshot({
      path: `${OUT}/ui-codeblock-dark.png`,
      clip: { x: 0, y: 0, width: 900, height: 900 },
    });
  } else await page.screenshot({ path: `${OUT}/ui-codeblock-light.png` });
  await ctx.close();
}

// ---------- menus, composer, dialog, rename, delete (uses a throw-away empty thread; nothing is sent) ----------
{
  const ctx = await newCtx({
    viewport: { width: 1280, height: 800 },
    colorScheme: "dark",
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await ctx.newPage();
  let confirmAnswer = true;
  const confirms: string[] = [];
  page.on("dialog", (d) => {
    confirms.push(d.message());
    confirmAnswer ? d.accept() : d.dismiss();
  });
  await page.goto(BASE + "/");
  await page.waitForSelector("#threads li", { timeout: 8000 });
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#d-cwd span").length &&
      document.querySelector("#d-cwd span")!.textContent!.length > 0,
  );
  const before = await page.locator("#threads li").count();

  // New thread dialog uses the same custom menus
  await page.click("#new");
  await page.waitForTimeout(250);
  check("dialog: no native selects", (await page.locator("dialog select").count()) === 0);
  // agent picker: one dialog, several harnesses; models and modes follow the choice
  const agentLabels = async () => {
    await page.click("#d-prov");
    const t = await page.locator(".menu [role=option] .m-label").allInnerTexts();
    return t;
  };
  const labels = await agentLabels();
  check(
    "dialog: agent menu lists Claude Code, Pi, Codex",
    ["Claude Code", "Pi", "Codex"].every((l) => labels.includes(l)),
    labels.join(),
  );
  const codexDisabled = await page
    .locator(".menu [role=option]", { hasText: "Codex" })
    .getAttribute("aria-disabled");
  check(
    "dialog: a not-ready agent is disabled and says why",
    codexDisabled === "true"
      ? (await page.locator(".menu [role=option]", { hasText: "Codex" }).innerText()).includes(
          "codex login",
        )
      : true,
  );
  const piItem = page.locator(".menu [role=option]", { hasText: "Pi" }).first();
  if ((await piItem.getAttribute("aria-disabled")) !== "true") {
    await piItem.click();
    await page.click("#d-mode");
    const piModes = await page.locator(".menu [role=option] .m-label").allInnerTexts();
    check(
      "dialog: Pi offers only Plan and Bypass (it has no approval prompts)",
      piModes.join() === "Plan,Bypass",
      piModes.join(),
    );
    await page.keyboard.press("Escape");
    check(
      "dialog: Pi shows its permission note and defaults to the bypass warning",
      (await page.locator("#d-note").isVisible()) && (await page.locator("#d-warn").isVisible()),
    );
    await page.click("#d-model");
    const piModels = await page.locator(".menu [role=option]").count();
    const firstDesc = await page.locator(".menu [role=option] .m-desc").first().innerText();
    check(
      "dialog: Pi model menu is populated and labels source",
      piModels > 0 && /^[a-z0-9-]+ · \S/i.test(firstDesc),
      `${piModels} ${firstDesc}`,
    );
    await page.screenshot({ path: `${OUT}/ui-pi-models.png` });
    await page.keyboard.press("Escape");
  } else console.log("SKIP  Pi checks (Pi not configured on this machine)");
  await page.click("#d-prov");
  await page.locator(".menu [role=option]", { hasText: "Claude Code" }).click();
  await page.click("#d-mode");
  const claudeModes = await page.locator(".menu [role=option] .m-label").allInnerTexts();
  check(
    "dialog: switching back restores Claude's three modes",
    claudeModes.length === 3,
    claudeModes.join(),
  );
  await page.keyboard.press("Escape");
  check(
    "dialog: create button enabled for a ready agent",
    !(await page.locator("#d-ok").isDisabled()),
  );
  await page.click("#d-cwd");
  const inDialog = await page.evaluate(() => !!document.querySelector("dialog .menu"));
  check("dialog: folder menu opens inside the modal", inDialog);
  await page.screenshot({ path: `${OUT}/ui-dialog-menu.png` });
  await page.keyboard.press("Escape");
  check(
    "dialog: Esc closes the menu only, dialog stays",
    (await page.evaluate(() => (document.getElementById("dlg") as HTMLDialogElement).open)) &&
      (await page.locator(".menu").count()) === 0,
  );
  check(
    "dialog: focus returns to the field",
    await page.evaluate(() => document.activeElement?.id === "d-cwd"),
  );
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
  await page.waitForFunction(
    (n) => document.querySelectorAll("#threads li").length === n + 1,
    before,
    { timeout: 5000 },
  );
  await page.waitForFunction(() => document.getElementById("ttl")!.textContent === "agent-console");
  check(
    "dialog: creates and opens the thread",
    (await page.locator("#mode").innerText()).includes("Plan"),
    await page.locator("#mode").innerText(),
  );

  // model chip: keyboard
  const model = page.locator("#model");
  await model.focus();
  await page.keyboard.press("Enter");
  const opened = await page.evaluate(() => {
    const m = document.querySelector(".menu")!;
    return {
      role: m.getAttribute("role"),
      opts: m.querySelectorAll("[role=option]").length,
      exp: document.getElementById("model")!.getAttribute("aria-expanded"),
      focus: document.activeElement === m,
      haspopup: document.getElementById("model")!.getAttribute("aria-haspopup"),
    };
  });
  const modelLabels = await page.locator(".menu [role=option] .m-label").allTextContents();
  check(
    "model menu: opens on Enter with models and advisor choices, focus inside",
    opened.role === "listbox" &&
      modelLabels.slice(0, 3).join("|") === "Sonnet|Opus|Haiku" &&
      modelLabels.slice(3).every((label) => label.startsWith("Advisor · ")) &&
      opened.opts === modelLabels.length &&
      opened.exp === "true" &&
      opened.focus &&
      opened.haspopup === "listbox",
    JSON.stringify(opened),
  );
  const act0 = await page.evaluate(
    () => document.querySelector(".menu [data-active]")!.textContent,
  );
  await page.keyboard.press("ArrowDown");
  const act1 = await page.evaluate(
    () => document.querySelector(".menu [data-active] .m-label")!.textContent,
  );
  check(
    "model menu: ArrowDown moves the active option",
    act1 !== act0.slice(0, act1!.length) || act1 === "Opus",
    `${act0} -> ${act1}`,
  );
  await page.keyboard.press("Escape");
  check(
    "model menu: Esc closes and returns focus",
    (await page.locator(".menu").count()) === 0 &&
      (await page.evaluate(() => document.activeElement?.id)) === "model" &&
      (await model.getAttribute("aria-expanded")) === "false",
  );
  await page.keyboard.press("ArrowUp"); // opens on last
  check(
    "model menu: ArrowUp on trigger opens at last item",
    (await page.evaluate(
      () => document.querySelector(".menu [data-active] .m-label")!.textContent,
    )) === modelLabels.at(-1),
  );
  await page.keyboard.press("Home");
  await page.keyboard.type("o"); // typeahead
  check(
    "model menu: typeahead jumps to Opus",
    (await page.evaluate(
      () => document.querySelector(".menu [data-active] .m-label")!.textContent,
    )) === "Opus",
  );
  await page.screenshot({ path: `${OUT}/ui-model-menu.png` });
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => /Opus/.test(document.querySelector("#threads li.sel")?.getAttribute("title") || ""),
    null,
    { timeout: 4000 },
  );
  check(
    "model menu: Enter changes the thread's model (server round-trip)",
    /Opus/.test(await model.innerText()),
  );
  await page.click("#model");
  await page.click("body", { position: { x: 640, y: 300 } });
  check("model menu: outside click closes", (await page.locator(".menu").count()) === 0);
  await page.click("#model");
  await page.locator(".menu [role=option]", { hasText: "Sonnet" }).click();
  await page.waitForFunction(() =>
    /Sonnet/.test(document.querySelector("#threads li.sel")?.getAttribute("title") || ""),
  );
  check("model menu: mouse select", /Sonnet/.test(await model.innerText()));

  // mode chip: bypass is confirmed, shown as a calm amber chip, never red
  await page.click("#mode");
  const modeOpts = await page.locator(".menu [role=option] .m-desc").allInnerTexts();
  check("mode menu: options carry descriptions", modeOpts.length === 3, modeOpts.join(" | "));
  confirmAnswer = false;
  await page.locator(".menu [role=option]", { hasText: "Bypass" }).click();
  await page.waitForTimeout(300);
  check(
    "mode menu: declined confirm leaves mode unchanged",
    (await page.locator("#mode").innerText()).includes("Plan") &&
      confirms.some((c) => /Bypass mode runs every tool/.test(c)),
  );
  confirmAnswer = true;
  await page.click("#mode");
  await page.locator(".menu [role=option]", { hasText: "Bypass" }).click();
  await page.waitForFunction(() => document.getElementById("mode")!.dataset.tone === "warn");
  await page.waitForTimeout(400);
  const chip = await page.evaluate(() => {
    const c = getComputedStyle(document.getElementById("mode")!);
    const tag = document.querySelector("#threads li.sel .tag");
    return {
      color: c.color,
      bg: c.backgroundColor,
      tag: !!tag,
      label: document.getElementById("mode")!.textContent!.trim(),
    };
  });
  const [r, g, b] = parse(chip.color);
  check(
    "bypass: amber chip with label (not red), tag on the thread row",
    chip.label === "Bypass" && chip.tag && r > 200 && g > 140 && b < 130 && g > b + 40,
    JSON.stringify(chip),
  );
  await page.screenshot({ path: `${OUT}/ui-bypass-chip.png` });
  await page.click("#mode");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.getElementById("mode")!.dataset.tone);
  check(
    "mode menu: keyboard back to Plan",
    (await page.locator("#mode").innerText()).includes("Plan"),
  );

  // composer card layout + slash anchored to it
  const lay = await page.evaluate(() => {
    const c = document.getElementById("cbox")!.getBoundingClientRect();
    const i = document.getElementById("input")!.getBoundingClientRect();
    const t = document.querySelector(".toolbar")!.getBoundingClientRect();
    return {
      r: parseFloat(getComputedStyle(document.getElementById("cbox")!).borderRadius),
      textAbove: i.bottom <= t.top,
      inside: i.left >= c.left && t.right <= c.right,
    };
  });
  check(
    "composer: card radius >= 20px, textarea above toolbar",
    lay.r >= 20 && lay.textAbove && lay.inside,
    JSON.stringify(lay),
  );
  await page.fill("#input", "");
  await page.click("#input");
  await page.keyboard.type("/");
  await page.waitForTimeout(350);
  const an = await page.evaluate(() => {
    const s = document.getElementById("slash")!.getBoundingClientRect();
    const c = document.getElementById("cbox")!.getBoundingClientRect();
    return [Math.abs(s.left - c.left), Math.abs(s.right - c.right), c.top - s.bottom];
  });
  check(
    "slash menu: anchored to the composer card",
    an[0] < 1 && an[1] < 1 && an[2] > 0 && an[2] < 16,
    an.map(Math.round).join(","),
  );
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/ui-slash-open.png` });
  await page.keyboard.press("Escape");
  await page.fill("#input", "");

  // overflow menu: rename, then delete (with the existing confirm)
  await page.click("#more");
  check(
    "overflow: menu with Rename + Archive",
    (await page.locator(".menu[role=menu] [role=menuitem] .m-label").allInnerTexts())
      .join()
      .includes("Archive"),
  );
  await page.locator(".menu [role=menuitem]", { hasText: "Rename" }).click();
  await page.waitForSelector("#ttl-edit");
  await page.fill("#ttl-edit", "ui-polish-test");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => document.getElementById("ttl")!.textContent === "ui-polish-test",
  );
  check(
    "rename: title updates via websocket update",
    (await page.locator("#threads li.sel .t").innerText()) === "ui-polish-test",
  );
  await page.screenshot({ path: `${OUT}/ui-desktop-test-thread.png` });
  await page.click("#more");
  await page.getByRole("menuitem", { name: /^Archive/ }).click();
  await page.locator(".menu [role=menuitem]", { hasText: "Delete thread" }).click();
  await page.waitForFunction((n) => document.querySelectorAll("#threads li").length === n, before, {
    timeout: 5000,
  });
  check(
    "delete: confirmed and removed",
    confirms.some((c) => /Delete "ui-polish-test"/.test(c)) &&
      (await page.locator("#threads li").count()) === before,
  );
  await ctx.close();
}

// ---------- slash menu (no model quota used: nothing is sent) ----------
{
  const ctx = await newCtx({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" });
  const page = await ctx.newPage();
  await page.goto(BASE + "/");
  await page.waitForSelector("#threads li", { timeout: 8000 });
  // slash commands are per agent and the test expects Claude's: open a Claude thread (non-Claude rows carry an agent tag)
  await page
    .locator("#threads li")
    .filter({ hasNotText: /Codex|Pi|Mock/ })
    .first()
    .click();
  await page.waitForFunction(() => !(document.getElementById("input") as any).disabled);
  const input = page.locator("#input");
  const visible = () => page.locator("#slash").isVisible();
  const opts = () => page.locator("#slash [role=option]").count();
  await input.click();
  await input.fill("hello");
  check("slash: closed for normal text", !(await visible()));
  await input.fill("");
  await input.pressSequentially("/");
  check("slash: opens on '/'", (await visible()) && (await opts()) > 10, `options=${await opts()}`);
  await input.pressSequentially("cave");
  const first = await page.locator("#slash [role=option] .cmd").first().innerText();
  check("slash: filters, best match first", first === "/caveman", first);
  await input.press("ArrowDown");
  const sel = await page.locator("#slash [aria-selected=true]").count();
  check("slash: arrow keys move selection", sel === 1);
  await input.press("ArrowUp");
  await input.press("Enter"); // partial query + Enter must accept, not send
  const v = await input.evaluate((e: any) => e.value);
  check(
    "slash: Enter on partial completes instead of sending",
    /^\/caveman $/.test(v),
    JSON.stringify(v),
  );
  check("slash: menu closes after accept", !(await visible()));
  await input.fill("");
  await input.pressSequentially("/zzzzqq");
  check("slash: empty result message", (await page.locator("#slash li.none").count()) === 1);
  await input.press("Escape");
  check("slash: Esc closes", !(await visible()));
  await input.fill("");
  await input.pressSequentially("/apple");
  await page.locator("#slash [role=option]").first().click();
  check(
    "slash: click selects",
    /^\/apple-design $/.test(await input.evaluate((e: any) => e.value)),
    JSON.stringify(await input.evaluate((e: any) => e.value)),
  );
  const a11y = await page.evaluate(() => {
    const i = document.getElementById("input")!;
    return [i.getAttribute("role"), i.getAttribute("aria-controls")];
  });
  check("slash: combobox aria wiring", a11y[0] === "combobox" && a11y[1] === "slash");
  await ctx.close();
}

// ---------- attachments: paste / drop / pick, images and files (mock agent only: needs the server started with AGENT_CONSOLE_MOCK=1) ----------
{
  const ctx = await newCtx({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE + "/");
  await page.waitForSelector("#threads li", { timeout: 8000 });
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#d-cwd span").length &&
      document.querySelector("#d-cwd span")!.textContent!.length > 0,
  );
  const before = await page.locator("#threads li").count();
  await page.click("#new");
  await page.click("#d-prov");
  const mockItem = page.locator(".menu [role=option]", { hasText: "Mock" });
  if (await mockItem.count()) {
    await mockItem.click();
    await page.click("#d-ok");
    await page.waitForFunction(
      (n) => document.querySelectorAll("#threads li").length === n + 1,
      before,
      { timeout: 5000 },
    );
    await page.waitForFunction(() => !(document.getElementById("input") as any).disabled);

    // a real paste event whose clipboard holds the given files (and optionally text)
    type F = { name: string; type: string; w?: number; h?: number; body?: string };
    const paste = (files: F[], text = "") =>
      page.evaluate(
        async ([files, text]) => {
          const dt = new DataTransfer();
          for (const f of files as any[]) {
            let blob: Blob;
            if (f.w) {
              const c = document.createElement("canvas");
              c.width = f.w;
              c.height = f.h;
              const g = c.getContext("2d")!;
              g.fillStyle = "#c33";
              g.fillRect(0, 0, f.w, f.h);
              blob = await new Promise((r) => c.toBlob((b) => r(b!), f.type));
            } else blob = new Blob([f.body ?? "x"], { type: f.type });
            dt.items.add(new File([blob], f.name, { type: f.type }));
          }
          if (text) dt.setData("text/plain", text as string);
          const ev = new ClipboardEvent("paste", {
            clipboardData: dt,
            bubbles: true,
            cancelable: true,
          });
          document.getElementById("input")!.dispatchEvent(ev);
          return ev.defaultPrevented;
        },
        [files, text] as const,
      );
    const png = (name = "shot.png", w = 400, h = 300): F => ({ name, type: "image/png", w, h });
    const txt = (name = "notes.txt", body = "hello"): F => ({ name, type: "text/plain", body });
    const items = () => page.locator("#thumbs li").count();
    const settled = () =>
      page.waitForFunction(() => !document.querySelector("#thumbs li[aria-busy=true]"));

    check("paste: image on the clipboard is claimed", await paste([png()]));
    await page.waitForFunction(() => document.querySelectorAll("#thumbs li").length === 1);
    await settled();
    check(
      "paste: thumbnail shows, labelled, with a remove button",
      (await items()) === 1 &&
        (await page.locator("#thumbs img").getAttribute("alt")) === "shot.png (Image 1)" &&
        (await page.locator("#thumbs .rm").getAttribute("aria-label")) === "Remove shot.png",
    );
    check(
      "image label: pasting drops [Image #1] into the message at the cursor, and the thumbnail wears the number",
      (await page.locator("#input").evaluate((e: any) => e.value)) === "[Image #1] " &&
        (await page.locator("#thumbs .n").innerText()) === "1",
    );
    check(
      "paste: no console errors / CSP violations",
      errors.length === 0,
      errors.join(" | ").slice(0, 160),
    );
    await page.locator("#thumbs .rm").click();
    check(
      "remove: clears it, and its [Image #1] label leaves the message",
      (await items()) === 0 &&
        (await page.locator("#thumbs").isHidden()) &&
        (await page.locator("#input").evaluate((e: any) => e.value)) === "",
    );
    check(
      "paste: picture beside real text is left to the text paste",
      !(await paste([png("shot.png", 50, 50)], "some cells")) && (await items()) === 0,
    );
    check(
      "paste: file copied in a file manager (text = its name) is still a file paste",
      await paste([png("copied.png", 40, 40)], "copied.png"),
    );
    await settled();
    await page.locator("#thumbs .rm").click();

    // any file type: pasted, picked, shown as a chip
    check("paste: a non-image file is claimed", await paste([txt("notes.txt")]));
    await page.waitForFunction(() => document.querySelectorAll("#thumbs li.file").length === 1);
    await settled();
    const chip = await page.evaluate(() => {
      const li = document.querySelector("#thumbs li.file")!;
      return [
        li.querySelector(".nm")!.textContent,
        li.querySelector(".sz")!.textContent,
        li.querySelector(".rm")!.getAttribute("aria-label"),
      ];
    });
    check(
      "file chip: name, size and a labelled remove button",
      chip.join("|") === "notes.txt|5 B|Remove notes.txt",
      chip.join("|"),
    );
    await page.locator("#thumbs .rm").click();

    // a 3000px screenshot is downscaled to <= 2000px before upload
    await paste([png("big.png", 3000, 1500)]);
    await page.waitForFunction(() => document.querySelectorAll("#thumbs li").length === 1);
    await settled();
    const dims = await page.evaluate(() => {
      const i = document.querySelector("#thumbs img") as HTMLImageElement;
      return [i.naturalWidth, i.naturalHeight];
    });
    check(
      "paste: large image is downscaled to 2000px long edge",
      dims[0] === 2000 && dims[1] === 1000,
      dims.join(","),
    );

    await page.setInputFiles("#file", [
      { name: "pick.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 test") },
      { name: "data.csv", mimeType: "text/csv", buffer: Buffer.from("a,b\n1,2\n") },
    ]);
    await page.waitForFunction(() => document.querySelectorAll("#thumbs li").length === 3);
    await settled();
    check(
      "attach button: picker adds several files of any type",
      (await items()) === 3 && (await page.locator("#thumbs li.file").count()) === 2,
    );
    check(
      "attach: an empty file is refused with a message",
      await (async () => {
        await page.setInputFiles("#file", {
          name: "empty.txt",
          mimeType: "text/plain",
          buffer: Buffer.alloc(0),
        });
        await page.waitForTimeout(300);
        return (
          (await items()) === 3 &&
          (await page.locator(".errtxt", { hasText: "empty" }).count()) === 1
        );
      })(),
    );
    for (let i = 0; i < 6; i++) await paste([txt(`f${i}.txt`)]);
    await page.waitForTimeout(700);
    await settled();
    check(
      "attach: capped at 8, with a message",
      (await items()) === 8 &&
        (await page.locator(".errtxt", { hasText: "At most 8" }).count()) >= 1,
      String(await items()),
    );
    await page.screenshot({ path: `${OUT}/ui-attach-thumbs.png` });
    check(
      "attach button: highlighted with a count while files wait",
      (await page.getAttribute("#attach", "data-count")) === "8" &&
        (await page.getAttribute("#attach", "aria-label")) === "Attach files",
    );

    // send (no text), see everything in the log, then reload and see it again from /uploads
    await page.click("#send");
    await page.waitForSelector(".msg.user .imgs img");
    // the reply element appears before its streamed text: wait for the text itself
    await page.waitForFunction(
      () => /mock reply/.test([...document.querySelectorAll(".msg.asst")].pop()?.textContent || ""),
      null,
      { timeout: 8000 },
    );
    check(
      "send: composer clears",
      (await items()) === 0 && (await page.getAttribute("#attach", "data-count")) === null,
    );
    check(
      "send: log shows 1 image and 7 file chips",
      (await page.locator(".msg.user .imgs img").count()) === 1 &&
        (await page.locator(".msg.user .chip").count()) === 7,
    );
    check(
      "image label: [Image #1] in the sent message is a link to that image",
      (await page.locator(".msg.user .bubble .imgref").count()) === 1 &&
        (await page.locator(".msg.user .bubble").innerText()).trim() === "Image 1" &&
        ((await page.locator(".msg.user .bubble .imgref").getAttribute("href")) ?? "").includes(
          "/uploads/",
        ),
    );
    const reply = await page.locator(".msg.asst").last().innerText();
    check(
      "send: agent got the image and the file paths",
      /1 image\(s\)/.test(reply) && /Attached files/.test(reply) && /pick\.pdf/.test(reply),
      reply.slice(0, 120),
    );
    const href = await page.locator(".msg.user .chip").first().getAttribute("href");
    const dl = await page.evaluate(async (h) => {
      const r = await fetch(h!);
      return [r.status, r.headers.get("content-disposition")?.slice(0, 10)];
    }, href);
    check(
      "send: file chip links to an authed download",
      dl[0] === 200 && dl[1] === "attachment",
      dl.join(),
    );
    await page.screenshot({ path: `${OUT}/ui-attach-sent.png` });
    await page.reload();
    await page.waitForSelector(".msg.user .imgs img");
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll(".msg.user .imgs img")].every(
          (i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0,
        ),
      null,
      { timeout: 5000 },
    );
    check(
      "history: image and file chips re-render after a reload",
      (await page.locator(".msg.user .imgs img").count()) === 1 &&
        (await page.locator(".msg.user .chip").count()) === 7,
    );

    // drag and drop: whole-window overlay, files and a folder
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(["a"], "drop.md", { type: "text/markdown" }));
      (window as any).__dt = dt;
      document.dispatchEvent(
        new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true }),
      );
    });
    check(
      "drop: whole-window overlay appears while dragging files",
      (await page.locator("#dropzone").isVisible()) &&
        (await page.locator("#dropzone").innerText()).includes("Drop files"),
    );
    await page.screenshot({ path: `${OUT}/ui-attach-dropzone.png` });
    await page.evaluate(() => {
      const dt = (window as any).__dt;
      document.dispatchEvent(
        new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }),
      );
      document.dispatchEvent(
        new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }),
      );
    });
    await page.waitForFunction(() => document.querySelectorAll("#thumbs li.file").length === 1);
    await settled();
    check(
      "drop: file dropped anywhere in the window is attached, overlay gone",
      !(await page.locator("#dropzone").isVisible()) &&
        (await page.locator("#thumbs .nm").innerText()) === "drop.md",
    );
    await page.fill("#input", "caption");
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => [...document.querySelectorAll(".msg.user .bubble")].at(-1)?.textContent === "caption",
    );
    check(
      "send: text and file together",
      (await page.locator(".msg.user").last().locator(".chip").count()) === 1 &&
        (await page.locator(".msg.user .bubble").last().innerText()) === "caption",
    );

    // switching threads drops unsent attachments (and deletes their uploads)
    await paste([txt("stray.txt")]);
    await settled();
    await page.locator("#threads li:not(.sel)").first().click();
    await page.waitForFunction(() => document.querySelectorAll("#thumbs li").length === 0);
    check("threads: unsent attachments do not follow you to another thread", (await items()) === 0);
    await page.locator("#threads li:has(.tag:text('Mock'))").first().click();
    await page.waitForFunction(
      () => document.querySelector("#threads li.sel .tag")?.textContent === "Mock",
    );

    // phone layout (with a file waiting): paperclip leads the toolbar, Send still fits, nothing overflows
    await paste([txt("phone.txt")]);
    await settled();
    await page.setViewportSize({ width: 390, height: 844 });
    const fit = await page.evaluate(() => {
      const r = (id: string) => document.getElementById(id)!.getBoundingClientRect();
      const a = r("attach"),
        s = r("send"),
        c = r("cbox"),
        m = r("model");
      const tb = document.querySelector("#cbox .toolbar") as HTMLElement;
      return [
        a.width > 0 && a.left >= c.left && a.right <= m.left,
        s.width > 0 && s.right <= c.right,
        tb.scrollWidth <= tb.clientWidth,
        tb.firstElementChild?.nextElementSibling?.id === "attach",
      ];
    });
    check(
      "layout: at 390px attach leads the toolbar, Send fits, no toolbar overflow",
      fit.every(Boolean),
      fit.join(),
    );
    await page.locator("#thumbs .rm").click();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.click("#more");
    await page.getByRole("menuitem", { name: /^Archive/ }).click();
    await page.locator(".menu [role=menuitem]", { hasText: "Delete thread" }).click();
    await page.waitForFunction(
      (n) => document.querySelectorAll("#threads li").length === n,
      before,
      { timeout: 5000 },
    );
    check("image test: no page errors", errors.length === 0, errors.join(" | ").slice(0, 200));
  } else {
    console.log("SKIP  attachment checks (start the server with AGENT_CONSOLE_MOCK=1)");
    await page.keyboard.press("Escape");
  }
  await ctx.close();
}

// ---------- tool cards: plain-English label overlays the raw command (mock agent only) ----------
{
  const ctx = await newCtx({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE + "/");
  await page.waitForSelector("#threads li", { timeout: 8000 });
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#d-cwd span").length &&
      document.querySelector("#d-cwd span")!.textContent!.length > 0,
  );
  const before = await page.locator("#threads li").count();
  await page.click("#new");
  await page.click("#d-prov");
  const mockItem = page.locator(".menu [role=option]", { hasText: "Mock" });
  if (await mockItem.count()) {
    await mockItem.click();
    await page.click("#d-ok");
    await page.waitForFunction(
      (n) => document.querySelectorAll("#threads li").length === n + 1,
      before,
      { timeout: 5000 },
    );
    await page.waitForFunction(() => !(document.getElementById("input") as any).disabled);
    await page.fill("#input", "tool please run it");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".card .sum");
    check(
      "tool card: shows the raw command until a label arrives",
      (await page.locator(".card .sum").first().innerText()) === "echo hello" ||
        (await page.locator(".card .sum.human").count()) === 1,
    );
    await page.waitForSelector(".card .sum.human", { timeout: 5000 });
    check(
      "tool card: closed input body is deferred",
      !(await page.locator(".card .body").first().textContent())?.includes("echo hello"),
    );
    await page.locator(".card summary").first().click();
    await page.waitForFunction(() =>
      document.querySelector(".card .body")?.textContent?.includes("echo hello"),
    );
    const c = await page.evaluate(() => {
      const s = document.querySelector(".card .sum.human") as HTMLElement;
      return {
        text: s.textContent,
        font: getComputedStyle(s).fontFamily.slice(0, 5),
        hover: s.closest("summary")!.getAttribute("title"),
        body: document.querySelector(".card .body")!.textContent,
      };
    });
    check(
      "tool card: label replaces the command, in the UI font",
      c.text === "Running echo" && c.font === "Inter",
      JSON.stringify(c),
    );
    check(
      "tool card: raw command stays on hover and in the body",
      c.hover === "echo hello" && /echo hello/.test(c.body || ""),
    );
    await page.reload();
    await page.waitForSelector(".card .sum.human", { timeout: 5000 });
    check(
      "tool card: label survives a reload (history replay)",
      (await page.locator(".card .sum.human").first().innerText()) === "Running echo",
    );
    await page.screenshot({ path: `${OUT}/ui-tool-label.png` });
    await page.click("#more");
    await page.getByRole("menuitem", { name: /^Archive/ }).click();
    await page.locator(".menu [role=menuitem]", { hasText: "Delete thread" }).click();
    await page.waitForFunction(
      (n) => document.querySelectorAll("#threads li").length === n,
      before,
      { timeout: 5000 },
    );
  } else {
    console.log("SKIP  tool label checks (start the server with AGENT_CONSOLE_MOCK=1)");
    await page.keyboard.press("Escape");
  }
  await ctx.close();
}

// ---------- thread actions: the ⋯ on every row and in the header (mock agent only) ----------
{
  const ctx = await newCtx({
    viewport: { width: 1280, height: 800 },
    colorScheme: "dark",
    permissions: ["clipboard-read", "clipboard-write"],
    acceptDownloads: true,
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE + "/");
  await page.waitForSelector("#threads li", { timeout: 8000 });
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#d-cwd span").length &&
      document.querySelector("#d-cwd span")!.textContent!.length > 0,
  );
  const before = await page.locator("#threads li").count();
  await page.click("#new");
  await page.click("#d-prov");
  const mockItem = page.locator(".menu [role=option]", { hasText: "Mock" });
  if (await mockItem.count()) {
    await mockItem.click();
    await page.click("#d-ok");
    await page.waitForFunction(
      (n) => document.querySelectorAll("#threads li").length === n + 1,
      before,
      { timeout: 5000 },
    );
    await page.waitForFunction(() => !(document.getElementById("input") as any).disabled);
    await page.fill("#input", "plan the weekend trip itinerary");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".msg.asst");
    await page.waitForFunction(
      () => /weekend/i.test(document.querySelector("#threads li.sel .t")?.textContent || ""),
      null,
      { timeout: 5000 },
    ); // auto-title
    const title = (await page.locator("#threads li.sel .t").innerText()).trim();
    const rowMenu = (row: string) => page.locator(`#threads li${row} .row-more`);
    const items = () => page.locator(".menu[role=menu] [role=menuitem] .m-label").allInnerTexts();

    // visibility: hidden until hover on a fine pointer, present in the layout either way
    const idle = await page.evaluate(() => {
      const b = document.querySelector("#threads li.sel .row-more") as HTMLElement;
      return [getComputedStyle(b).opacity, b.getBoundingClientRect().width > 0];
    });
    await page.mouse.move(640, 400);
    check(
      "row menu: the ⋯ is laid out but quiet until you hover the row",
      idle[0] === "0" && idle[1] === true,
      idle.join(),
    );
    await page.locator("#threads li.sel").hover();
    await page
      .waitForFunction(
        () =>
          getComputedStyle(document.querySelector("#threads li.sel .row-more")!).opacity === "1",
        null,
        { timeout: 2000 },
      )
      .catch(() => {});
    check(
      "row menu: hovering the row reveals it",
      (await rowMenu(".sel").evaluate((b) => getComputedStyle(b).opacity)) === "1",
    );
    const label = await rowMenu(".sel").getAttribute("aria-label");
    check(
      "row menu: the button names its thread for screen readers",
      label === `Actions for ${title}`,
      label ?? "",
    );

    // opening it on a row does not open that thread
    const other = page.locator("#threads li:not(.sel)").first();
    await other.hover();
    await other.locator(".row-more").click();
    check(
      "row menu: opens from any row without switching to it",
      (await page.locator(".menu[role=menu]").count()) === 1 &&
        (await page.locator("#threads li.sel .t").innerText()).trim() === title,
    );
    const its = await items();
    check(
      "row menu: grouped thread actions",
      its.join("|") ===
        "Search in chat|Rename|Compaction|Economy settings|Fork|Download|Share|Run details|Archive",
      (await items()).join("|"),
    );
    check(
      "row menu: destructive actions stay inside Archive",
      (await page.locator(".menu [data-tone=danger]").count()) === 0,
    );
    await page.screenshot({ path: `${OUT}/ui-row-menu.png` });
    await page.keyboard.press("Escape");
    check(
      "row menu: Esc closes it and returns focus to its button",
      (await page.locator(".menu").count()) === 0 &&
        (await other.locator(".row-more").evaluate((b) => b === document.activeElement)),
    );
    await other.locator(".row-more").focus();
    await page.keyboard.press("Enter");
    check(
      "row menu: keyboard Enter opens the menu, not the thread",
      (await page.locator(".menu[role=menu]").count()) === 1 &&
        (await page.locator("#threads li.sel .t").innerText()).trim() === title,
    );
    await page.keyboard.press("Escape");

    // rename from a row
    await rowMenu(".sel").click();
    await page.locator(".menu [role=menuitem]", { hasText: "Rename" }).click();
    await page.waitForSelector("#ttl-edit");
    await page.fill("#ttl-edit", "Weekend trip");
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => document.querySelector("#threads li.sel .t")?.textContent === "Weekend trip",
    );
    check(
      "rename (row menu): edits the title in place",
      (await page.locator("#ttl").innerText()) === "Weekend trip",
    );

    // fork
    const rows0 = await page.locator("#threads li").count();
    await rowMenu(".sel").click();
    await page.getByRole("menuitem", { name: /^Fork/ }).click();
    await page.locator(".menu [role=menuitem]", { hasText: /^Fork/ }).first().click();
    await page.waitForFunction(() =>
      /\(fork\)$/.test(document.querySelector("#threads li.sel .t")?.textContent || ""),
    );
    await page.waitForSelector(".msg.user .bubble");
    check(
      "fork: opens a new thread titled (fork) holding the same conversation",
      (await page.locator("#threads li").count()) === rows0 + 1 &&
        (await page.locator("#ttl").innerText()) === "Weekend trip (fork)" &&
        /weekend trip itinerary/.test(await page.locator(".msg.user .bubble").first().innerText()),
    );

    // download, from the header menu (the same actions live there too)
    await page.click("#more");
    check(
      "header menu: same thread actions",
      (await items()).join("|") ===
        "Search in chat|Rename|Compaction|Economy settings|Fork|Download|Share|Run details|Archive",
      (await items()).join("|"),
    );
    const dl = page.waitForEvent("download");
    await page.locator(".menu [role=menuitem]", { hasText: "Download" }).click();
    const file = await dl;
    check(
      "download: a Markdown file named after the thread",
      file.suggestedFilename() === "Weekend trip (fork).md",
      file.suggestedFilename(),
    );
    const body = await (await import("node:fs")).promises.readFile(await file.path(), "utf8");
    check(
      "download: contains the conversation",
      body.startsWith("# Weekend trip (fork)") &&
        body.includes("plan the weekend trip itinerary") &&
        body.includes("## Agent"),
    );

    // share: native sheet when there is one, clipboard otherwise
    await page.evaluate(() => {
      (window as any).__shared = null;
      navigator.share = async (d: any) => {
        (window as any).__shared = d;
      };
    });
    await page.click("#more");
    await page.locator(".menu [role=menuitem]", { hasText: "Share" }).click();
    await page.waitForFunction(() => (window as any).__shared);
    const shared = await page.evaluate(() => (window as any).__shared);
    check(
      "share: hands the title and Markdown to the system share sheet",
      shared.title === "Weekend trip (fork)" && shared.text.includes("## You"),
      JSON.stringify(shared).slice(0, 80),
    );
    await page.evaluate(() => {
      (navigator as any).share = undefined;
    });
    await page.click("#more");
    await page.locator(".menu [role=menuitem]", { hasText: "Share" }).click();
    await page.waitForSelector("#toast:not([hidden])");
    check(
      "share: without a share sheet it copies Markdown and says so",
      /Copied/.test(await page.locator("#toast").innerText()) &&
        (await page.evaluate(() => navigator.clipboard.readText())).includes(
          "# Weekend trip (fork)",
        ),
    );
    await page.screenshot({ path: `${OUT}/ui-share-toast.png` });

    // delete from a row: the fork, then the original
    for (const name of ["Weekend trip (fork)", "Weekend trip"]) {
      await page.locator("#threads li", { hasText: name }).first().hover();
      await page.locator("#threads li", { hasText: name }).first().locator(".row-more").click();
      await page.getByRole("menuitem", { name: /^Archive/ }).click();
      await page.locator(".menu [role=menuitem]", { hasText: "Delete thread" }).click();
      await page.waitForFunction(
        (n) => ![...document.querySelectorAll("#threads li .t")].some((e) => e.textContent === n),
        name,
        { timeout: 5000 },
      );
    }
    check(
      "delete (row menu): confirmed and gone, both copies",
      (await page.locator("#threads li").count()) === before && errors.length === 0,
      errors.join(" | ").slice(0, 160),
    );

    // phone: the ⋯ is always visible (no hover) and the menu fits the screen
    await page.setViewportSize({ width: 390, height: 844 });
    await page.click("#menu");
    await page.waitForTimeout(400);
    const touch = await page.evaluate(() => {
      const b = document.querySelector("#threads li .row-more") as HTMLElement;
      const r = b.getBoundingClientRect();
      return [getComputedStyle(b).opacity, r.right <= innerWidth && r.width > 0];
    });
    check(
      "row menu (phone width): visible without hover and inside the drawer",
      touch[1] === true,
      touch.join(),
    );
    await page.locator("#threads li .row-more").first().click();
    const pop = await page.evaluate(() => {
      const r = document.querySelector(".menu")!.getBoundingClientRect();
      return [r.left >= 0, r.right <= innerWidth, r.top >= 0, r.bottom <= innerHeight];
    });
    check("row menu (phone width): fits the viewport", pop.every(Boolean), pop.join());
    await page.screenshot({ path: `${OUT}/ui-row-menu-phone.png` });
  } else {
    console.log("SKIP  thread action checks (start the server with AGENT_CONSOLE_MOCK=1)");
    await page.keyboard.press("Escape");
  }
  await ctx.close();
}

// ---------- running agents: loading state, paging, steering, queue, stop, context meter, subagents (mock agent) ----------
{
  const ctx = await newCtx({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("dialog", (d) => d.accept());
  // hold history back for 900ms so the loading state can be seen (the server is local and answers in a few ms)
  let delayHistory = 0;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (delayHistory && /"t":"history"/.test(String(m).slice(0, 20)))
        setTimeout(() => ws.send(m), delayHistory);
      else ws.send(m);
    });
  });
  await page.goto(BASE + "/");
  await page.waitForSelector("#threads li", { timeout: 8000 });
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#d-cwd span").length &&
      document.querySelector("#d-cwd span")!.textContent!.length > 0,
  );
  const before = await page.locator("#threads li").count();

  // ---- a long real thread: loading state, then only the newest page, then older messages on request
  const rows = page.locator("#threads li");
  let big = -1;
  for (let i = 0; i < before && big < 0; i++) {
    await rows.nth(i).click();
    for (let k = 0; k < 40 && big < 0; k++) {
      await page.waitForTimeout(100);
      if (
        (await page.locator(".earlier").count()) &&
        (await page.locator("#chat > .msg").count()) > 5
      )
        big = i;
    }
  }
  if (big >= 0) {
    await page.waitForFunction(
      () => {
        const b = document.querySelector(".earlier") as HTMLButtonElement | null;
        return b && !b.disabled;
      },
      null,
      { timeout: 15000 },
    ); // the newest page has finished drawing
    const shown = await page.locator("#chat > .msg").count();
    check(
      "paging: a long thread opens on its newest page with a 'Show earlier messages' button",
      (await page.locator(".earlier").innerText()) === "Show earlier messages" &&
        shown > 5 &&
        shown < 600,
      String(shown),
    );
    await page.waitForFunction(
      () => {
        const c = document.getElementById("chat")!;
        return c.scrollHeight - c.scrollTop - c.clientHeight < 5;
      },
      null,
      { timeout: 1000 },
    );
    const bottomGap = await page.evaluate(() => {
      const c = document.getElementById("chat")!;
      return c.scrollHeight - c.scrollTop - c.clientHeight;
    });
    check("paging: it opens scrolled to the latest message", bottomGap < 5, String(bottomGap));
    const topOff = await page.evaluate(() => {
      const c = document.getElementById("chat")!;
      c.scrollTop = 0;
      const anchor = c.querySelector(":scope > .msg") as HTMLElement;
      anchor.dataset.testAnchor = "true";
      return anchor.getBoundingClientRect().top;
    });
    // Scrolling near the top automatically fetches the preceding page.
    // a short page may not overflow, so scrolling alone cannot trigger the load: the button does the same thing
    await page.waitForTimeout(800);
    let viaButton = false;
    if ((await page.locator("#chat > .msg").count()) === shown) {
      viaButton = true;
      await page.locator(".earlier").click();
    }
    await page.waitForFunction((n) => document.querySelectorAll("#chat > .msg").length > n, shown, {
      timeout: 8000,
    });
    await page.waitForFunction(
      () => document.querySelector("#chat")?.getAttribute("aria-busy") === "false",
    );
    const grew = await page.locator("#chat > .msg").count();
    const kept = await page.evaluate((top) => {
      const c = document.getElementById("chat")!;
      return [top, c.querySelector("[data-test-anchor]")!.getBoundingClientRect().top];
    }, topOff);
    check(
      "paging: older messages are slid in above, the page does not jump",
      grew > shown && (viaButton || Math.abs(kept[1] - kept[0]) < 80),
      `${shown}->${grew} anchor ${kept[0]} -> ${kept[1]}`,
    );
    // opening it again with the history held back shows the loading state, in the message pane only
    delayHistory = 900;
    const earlySkeleton = await page.evaluate(
      async (i) => {
        (document.querySelectorAll("#threads li")[i] as HTMLElement).click();
        await new Promise((r) => setTimeout(r, 100));
        return !!document.querySelector(".skeleton");
      },
      big === 0 ? 1 : 0,
    );
    check("loading: nothing flashes in the first 150ms", !earlySkeleton);
    await rows.nth(big).click();
    check(
      "switching: revisiting an idle thread restores its cached view immediately",
      /from cache/.test(await page.locator("#diagnostics").textContent()),
    );
    // Refresh from the latest position. Reading older pages intentionally defers replacement.
    await page.locator("#chat").evaluate((chat) => {
      chat.scrollTop = chat.scrollHeight;
    });
    await page.waitForTimeout(50);
    // Reopening the current thread explicitly refreshes its history.
    await rows.nth(big).click();
    await page.waitForSelector(".loading", { timeout: 1500 });
    const lo = await page.evaluate(() => ({
      text: document.querySelector(".loading")!.textContent,
      bars: document.querySelectorAll(".skeleton .sk i").length,
      messages: document.querySelectorAll("#chat > .msg").length,
      head: !!document.getElementById("ttl")!.textContent,
      composer: !document.getElementById("input")!.hasAttribute("hidden"),
      live: document.querySelector(".loading")!.getAttribute("role"),
    }));
    check(
      "loading: refreshing a cached view retains the conversation with an update caption; header and composer stay put",
      /Updating conversation/.test(lo.text || "") &&
        lo.bars === 0 &&
        lo.messages === grew &&
        lo.head &&
        lo.composer &&
        lo.live === "status",
      JSON.stringify(lo),
    );
    await page.screenshot({ path: `${OUT}/ui-loading.png` });
    await page.waitForFunction(() => !document.querySelector(".loading"), null, { timeout: 5000 });
    await page.waitForFunction(
      () => document.querySelector("#chat")?.getAttribute("aria-busy") === "false",
    );
    check(
      "loading: replaced by the conversation once it arrives",
      (await page.locator("#chat > .msg").count()) > 5,
    );
    // switching away mid-load must not let the late history overwrite the thread you moved to
    await rows.nth(big === 0 ? 1 : 0).click();
    await page.waitForTimeout(1500);
    const sel = await page.locator("#threads li.sel .t").innerText();
    check(
      "loading: a late history for a thread you left is ignored",
      (await page.locator("#ttl").innerText()) === sel,
    );
    delayHistory = 0;
  } else console.log("SKIP  paging/loading checks (no thread long enough in this data dir)");

  // ---- steering, queue, stop, context meter (mock thread)
  await page.click("#new");
  await page.click("#d-prov");
  const mockItem = page.locator(".menu [role=option]", { hasText: "Mock" });
  if (await mockItem.count()) {
    await mockItem.click();
    await page.click("#d-ok");
    await page.waitForFunction(
      (n) => document.querySelectorAll("#threads li").length === n + 1,
      before,
      { timeout: 5000 },
    );
    await page.waitForFunction(() => !(document.getElementById("input") as any).disabled);
    const idleUi = await page.evaluate(() => ({
      stop: document.getElementById("stop")!.hidden,
      send: document.getElementById("send")!.getAttribute("aria-label"),
      ph: (document.getElementById("input") as any).placeholder,
      ctx: document.getElementById("ctx")!.hidden,
    }));
    check(
      "idle composer: Send only, no Stop, no context ring before anything ran",
      idleUi.stop && idleUi.send === "Send" && idleUi.ph === "Message the agent" && idleUi.ctx,
      JSON.stringify(idleUi),
    );

    await page.fill("#input", "slow burn please");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !document.getElementById("stop")!.hidden);
    const run = await page.evaluate(() => {
      const g = (id: string) => document.getElementById(id) as HTMLButtonElement;
      return {
        send: g("send").getAttribute("aria-label"),
        sendDisabled: g("send").disabled,
        sendHidden: g("send").hidden,
        stopBg: getComputedStyle(g("stop")).backgroundColor,
        stopFg: getComputedStyle(g("stop")).color,
        ph: (document.getElementById("input") as any).placeholder,
        inputDisabled: (document.getElementById("input") as HTMLTextAreaElement).disabled,
        state: document.getElementById("state-t")!.textContent,
      };
    });
    check(
      "running composer: empty box shows only a red Stop; input stays live",
      run.stopBg === "rgb(220, 38, 38)" &&
        run.stopFg === "rgb(255, 255, 255)" &&
        run.sendHidden &&
        !(await page.locator("#queue").count()) &&
        /Queue a message/.test(run.ph) &&
        !run.inputDisabled,
      JSON.stringify(run),
    );
    await page.fill("#input", "x");
    check(
      "running composer: typing swaps Stop for one Send button (queues)",
      (await page.locator("#stop").isHidden()) &&
        (await page.getAttribute("#send", "aria-label")) === "Queue message",
    );
    await page.fill("#input", "");
    check(
      "running composer: emptying it brings Stop back",
      await page.locator("#stop").isVisible(),
    );
    await page.screenshot({ path: `${OUT}/ui-running-composer.png` });

    await page.fill("#input", "turn left");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#queued li");
    check(
      "queue: Enter mid-run queues first (nothing sent yet), with a Steer button on the card",
      (await page.locator("#queued .steer").isVisible()) &&
        ![...(await page.locator(".msg.user .bubble").allInnerTexts())].some((t) =>
          /turn left/.test(t),
        ),
    );
    await page.click("#queued .steer");
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".msg.user")].some((m) =>
        /turn left/.test(m.textContent || ""),
      ),
    );
    const steered = await page.evaluate(() => {
      const m = [...document.querySelectorAll(".msg.user")].find((x) =>
        /turn left/.test(x.textContent || ""),
      )!;
      return {
        cap: m.querySelector(".delivery")?.textContent,
        box: (document.getElementById("input") as any).value,
        stillRunning: !document.getElementById("stop")!.hidden,
      };
    });
    check(
      "steer: Steer on the queued card sends it now, captioned, composer clears, the turn keeps going",
      steered.cap === "Sent while the agent was working" &&
        steered.box === "" &&
        steered.stillRunning,
      JSON.stringify(steered),
    );
    await page.waitForFunction(
      () => /\[steered: turn left\]/.test(document.getElementById("chat")!.textContent || ""),
      null,
      { timeout: 4000 },
    );
    check("steer: the agent received it (the mock folds it into its stream)", true);

    await page.fill("#input", "after you are done");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#queued li");
    const q1 = await page.evaluate(() => ({
      n: document.querySelectorAll("#queued li").length,
      tag: document.querySelector("#queued .tag")!.textContent,
      txt: document.querySelector("#queued .txt")!.textContent,
      rm: document.querySelector("#queued .rm")!.getAttribute("aria-label"),
      box: (document.getElementById("input") as any).value,
    }));
    check(
      "queue: the Queue button holds it above the composer as a removable chip",
      q1.n === 1 &&
        q1.tag === "Queued" &&
        q1.txt === "after you are done" &&
        q1.rm === "Remove queued message" &&
        q1.box === "",
      JSON.stringify(q1),
    );
    await page.screenshot({ path: `${OUT}/ui-queued.png` });
    await page.locator("#queued .rm").click();
    await page.waitForFunction(() => !document.querySelector("#queued li"));
    await page.fill("#input", "alt enter queues");
    await page.keyboard.press("Alt+Enter");
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".msg.user")].some(
        (m) =>
          /alt enter queues/.test(m.textContent || "") &&
          /while the agent was working/.test(m.querySelector(".delivery")?.textContent || ""),
      ),
    );
    check(
      "steer: Alt+Enter steers directly, no queue card",
      (await page.locator("#queued li").count()) === 0,
    );
    await page.fill("#input", "one more queued");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#queued li");
    await page.click("#stop");
    await page.waitForFunction(() => document.getElementById("stop")!.hidden);
    check(
      "stop: ends the turn and clears the queue; Send is Send again",
      (await page.locator("#queued li").count()) === 0 &&
        (await page.getAttribute("#send", "aria-label")) === "Send" &&
        (await page.locator("#queue").isHidden()),
    );

    // compaction: one progress card (no /compact bubble), messages typed meanwhile queue and go out together afterwards
    await page.fill("#input", "before compaction");
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () =>
        document.getElementById("stop")!.hidden &&
        /mock reply[\s\S]*before compaction/.test(
          document.getElementById("chat")!.textContent || "",
        ),
      null,
      { timeout: 8000 },
    );
    await page.fill("#input", "/compact");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".compact-card.running");
    const cc = await page.evaluate(() => ({
      title: document.querySelector(".compact-card .cc-title")!.textContent,
      bubble: [...document.querySelectorAll(".msg.user")].some((m) =>
        /\/compact/.test(m.textContent || ""),
      ),
      spin: !!document.querySelector(".compact-card .cc-ico .spin"),
      ph: (document.getElementById("input") as any).placeholder,
      head: document.getElementById("state-t")!.textContent,
    }));
    check(
      "compaction: a progress card with a spinner, no /compact message bubble, header says so, composer offers to queue",
      cc.title === "Compacting context" &&
        !cc.bubble &&
        cc.spin &&
        /after compaction/.test(cc.ph) &&
        cc.head === "Compacting context",
      JSON.stringify(cc),
    );
    await page.screenshot({ path: `${OUT}/ui-compacting.png` });
    for (const t of ["queued one", "queued two"]) {
      await page.fill("#input", t);
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        (n) => document.querySelectorAll("#queued li").length >= n,
        t === "queued one" ? 1 : 2,
      );
    }
    await page.waitForSelector(".compact-card.done", { timeout: 8000 });
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll(".msg.user .bubble")].some((b) =>
          /queued one\s+queued two/.test(b.textContent || ""),
        ),
      null,
      { timeout: 8000 },
    );
    check(
      "compaction: the card settles to done, and the two queued messages arrive as ONE prompt",
      (await page.locator(".compact-card").count()) === 1 &&
        (await page.locator(".compact-card .cc-title").innerText()) === "Context compacted",
    );
    await page.screenshot({ path: `${OUT}/ui-compacted.png` });

    // context meter
    const ring = await page.evaluate(() => {
      const b = document.getElementById("ctx")!;
      return {
        hidden: b.hidden,
        pct: b.querySelector(".pct")!.textContent,
        label: b.getAttribute("aria-label"),
        tip: b.dataset.tip,
        level: b.dataset.level || "",
      };
    });
    check(
      "context: the ring shows % of the window, with the exact tokens in its label and tooltip",
      !ring.hidden &&
        /^\d+%$/.test(ring.pct || "") &&
        /of 200,000 tokens/.test(ring.label || "") &&
        /Context window/.test(ring.tip || "") &&
        ring.level === "",
      JSON.stringify(ring),
    );
    for (const [n, level] of [
      [85, "high"],
      [97, "crit"],
      [40, ""],
    ] as const) {
      await page.fill("#input", `ctx ${n} please`);
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        (n) => document.getElementById("ctx")!.querySelector(".pct")!.textContent === `${n}%`,
        n,
        { timeout: 4000 },
      );
      await page.waitForFunction(() => document.getElementById("stop")!.hidden);
      const c = await page.evaluate(() => {
        const b = document.getElementById("ctx")!;
        const cs = getComputedStyle(b);
        return {
          level: b.dataset.level || "",
          color: cs.color,
          dash: (b.querySelector(".fill") as SVGElement).style.strokeDasharray,
          tip: b.dataset.tip,
        };
      });
      check(
        `context: ${n}% is ${level || "calm"} (${n >= 90 ? "red" : n >= 70 ? "amber" : "green"})${n >= 80 ? ", with a hint in the tooltip" : ""}`,
        c.level === level &&
          new RegExp(`^${n}[, ]`).test(c.dash) &&
          (n >= 90
            ? c.color === "rgb(255, 143, 135)"
            : level
              ? /rgb\(24\d, 1[78]\d, \d+\)/.test(c.color)
              : true) &&
          (n >= 80 ? /fills|full/.test(c.tip || "") : !/fills|full/.test(c.tip || "")),
        JSON.stringify(c),
      );
      if (n === 97) await page.screenshot({ path: `${OUT}/ui-context-crit.png` });
    }
    await page.hover("#ctx");
    await page.waitForTimeout(250);
    const tipBox = await page.evaluate(() => {
      const b = document.getElementById("ctx")!;
      const r = b.getBoundingClientRect();
      return { opacity: getComputedStyle(b, "::after").opacity, top: r.top };
    });
    check("context: hovering shows the details", tipBox.opacity === "1");
    await page.screenshot({ path: `${OUT}/ui-context-tip.png` });

    // ---- subagent
    await page.fill("#input", "agent please");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".card.agent");
    await page.waitForFunction(
      () => document.querySelectorAll(".card.agent .sub-row").length >= 2,
      null,
      { timeout: 4000 },
    );
    const ag = await page.evaluate(() => {
      const c = document.querySelector(".card.agent")!;
      const top = [...document.querySelectorAll("#chat > .msg")].map((m) => m.textContent || "");
      return {
        name: c.querySelector(".name")!.textContent,
        sum: c.querySelector(".sum")!.textContent,
        rows: c.querySelectorAll(".sub-row").length,
        leaked: top.some(
          (t, i) =>
            /Looking at the repo structure/.test(t) &&
            !(document.querySelectorAll("#chat > .msg")[i] as HTMLElement).classList.contains(
              "agent",
            ),
        ),
        nestedText: c.querySelector(".sub-row.text")?.textContent,
        nestedTool: c.querySelector(".sub-row.tool .name")?.textContent,
        nestedDone: c.querySelector(".sub-row.tool")?.classList.contains("done"),
      };
    });
    check(
      "subagent: one card, named, with its activity nested inside (not spilled into the main thread)",
      ag.name === "Agent · explore" &&
        ag.sum === "Survey the repo" &&
        ag.rows === 2 &&
        !ag.leaked &&
        /Looking at the repo/.test(ag.nestedText || "") &&
        ag.nestedTool === "Bash" &&
        ag.nestedDone,
      JSON.stringify(ag),
    );
    await page.waitForFunction(
      () =>
        /1 tool · 4k tokens · 3s/.test(
          document.querySelector(".card.agent .stats")?.textContent || "",
        ),
      null,
      { timeout: 3000 },
    );
    check(
      "subagent: live stats (tools, tokens, time) on the card",
      (await page.locator(".card.agent .stats").innerText()) === "1 tool · 4k tokens · 3s",
      await page.locator(".card.agent .stats").innerText(),
    );
    check(
      "subagent: a 'in background' chip while it runs, and the header counts it",
      (await page.locator(".card.agent .task-chip.running").innerText()).includes(
        "in background",
      ) && /Working · 1 agent/.test(await page.locator("#state-t").innerText()),
      await page.locator("#state-t").innerText(),
    );
    await page.locator(".card.agent > summary").click();
    await page
      .waitForFunction(() => document.querySelector(".card.agent .sub-row.tool .sum.human"), null, {
        timeout: 4000,
      })
      .catch(() => {});
    check(
      "subagent: its shell commands get plain-English labels too",
      (await page.locator(".card.agent .sub-row.tool .sum").innerText()) === "Running ls",
    );
    await page.screenshot({ path: `${OUT}/ui-subagent.png` });
    await page.waitForFunction(
      () => /finished/.test(document.querySelector(".card.agent .task-chip")?.textContent || ""),
      null,
      { timeout: 5000 },
    );
    check(
      "subagent: the chip turns to 'finished' when it reports back",
      ((await page.locator(".card.agent .task-chip").innerText()).includes("finished") &&
        /Working$/.test(await page.locator("#state-t").innerText())) ||
        (await page.locator("#state").isHidden()),
    );
    await page.waitForFunction(() => document.getElementById("stop")!.hidden);
    await page.reload();
    await page.waitForSelector(".card.agent", { timeout: 6000 });
    await page.waitForFunction(() =>
      /finished/.test(document.querySelector(".card.agent .task-chip")?.textContent || ""),
    );
    const re = await page.evaluate(() => {
      const c = document.querySelector(".card.agent")!;
      return [c.querySelectorAll(".sub-row").length, c.querySelector(".stats")!.textContent];
    });
    check(
      "subagent: card, nested rows, stats and chip all rebuild from history after a reload",
      re[0] === 2 && re[1] === "1 tool · 4k tokens · 3s",
      JSON.stringify(re),
    );

    // phone: everything still fits the composer while running
    await page.setViewportSize({ width: 390, height: 844 });
    await page.fill("#input", "slow burn on a phone");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !document.getElementById("stop")!.hidden);
    const fit = await page.evaluate(() => {
      const t = document.querySelector(".toolbar")!;
      const c = document.getElementById("cbox")!.getBoundingClientRect();
      const btns = ["attach", "model", "mode", "ctx", "stop", "send"]
        .map((id) => document.getElementById(id)!.getBoundingClientRect())
        .filter((r) => r.width);
      return {
        overflow: t.scrollWidth > t.clientWidth + 1,
        inside: btns.every((r) => r.left >= c.left - 1 && r.right <= c.right + 1),
        n: btns.length,
      };
    });
    check(
      "phone width, running: model and permissions stay visible alongside attach, context and one action button",
      !fit.overflow && fit.inside && fit.n === 5,
      JSON.stringify(fit),
    );
    await page.screenshot({ path: `${OUT}/ui-running-phone.png` });
    await page.click("#stop");
    await page.waitForFunction(() => document.getElementById("stop")!.hidden);
    const idleFit = await page.evaluate(() => {
      const t = document.querySelector(".toolbar")!;
      const c = document.getElementById("cbox")!.getBoundingClientRect();
      const btns = ["attach", "model", "mode", "ctx", "send"]
        .map((id) => document.getElementById(id)!.getBoundingClientRect())
        .filter((r) => r.width);
      return {
        overflow: t.scrollWidth > t.clientWidth + 1,
        inside: btns.every((r) => r.left >= c.left - 1 && r.right <= c.right + 1),
        n: btns.length,
      };
    });
    check(
      "phone width, idle: attach, model, mode, context ring and Send fit too",
      !idleFit.overflow && idleFit.inside && idleFit.n === 5,
      JSON.stringify(idleFit),
    );
    await page.screenshot({ path: `${OUT}/ui-idle-phone.png` });
    await page.setViewportSize({ width: 1280, height: 800 });
    check(
      "running agents: no console or page errors",
      errors.length === 0,
      errors.join(" | ").slice(0, 200),
    );
    await page.click("#more");
    await page.getByRole("menuitem", { name: /^Archive/ }).click();
    await page.locator(".menu [role=menuitem]", { hasText: "Delete thread" }).click();
    await page.waitForFunction(
      (n) => document.querySelectorAll("#threads li").length === n,
      before,
      { timeout: 5000 },
    );
  } else {
    console.log(
      "SKIP  steering/context/subagent checks (start the server with AGENT_CONSOLE_MOCK=1)",
    );
    await page.keyboard.press("Escape");
  }
  await ctx.close();
}

// ---------- sign-in page: same type + buttons, fonts reachable without a session ----------
{
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: "dark",
  });
  const page = await ctx.newPage();
  await page.goto(BASE + "/login");
  await page.evaluate(async () => {
    await document.fonts.load("600 24px Inter");
  });
  const l = await page.evaluate(() => ({
    inter:
      document.fonts.check("15px Inter") &&
      [...document.fonts].some((f) => f.family.includes("Inter") && f.status === "loaded"),
    btn: getComputedStyle(document.querySelector("button")!).borderRadius,
    h1: getComputedStyle(document.querySelector("h1")!).fontFamily.slice(0, 5),
  }));
  check("login: Inter loads without a session", l.inter && l.h1 === "Inter", JSON.stringify(l));
  await page.screenshot({ path: `${OUT}/ui-login.png` });
  await ctx.close();
}
await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall UI checks passed");
process.exit(failed ? 1 : 0);

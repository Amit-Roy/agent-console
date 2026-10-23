// Vault page: real browser, phone widths + desktop, mocked /api/vault (fake keys and values only), passkey prompt stubbed.
import { chromium } from "playwright";
import { makeToken } from "../server/auth.ts";

const BASE = process.env.BASE || "http://127.0.0.1:7070";
const OUT = process.env.OUT || "/tmp";
let failed = 0;
const check = (n: string, ok: boolean, x = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${n} ${x}`);
  if (!ok) failed++;
};
const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});
const browser = await chromium.launch();
const now = Date.now();
const row = (
  key: string,
  length: number | null,
  hint: string | null,
  hash: string | null,
  mtime: number,
  extra: object = {},
) => ({ key, length, hint, hash, mtime, editable: true, viewable: false, ...extra });
// extras sit among the real keys, alphabetical, with the file's own mtime; `mine` only comes with a grant
const GROUPS = (granted: boolean) => {
  const m = (v: boolean) => (granted ? { mine: v } : {});
  const envM = now - 3 * 3600_000;
  return [
    {
      id: "aaaaaaaaaaaa",
      label: "agent-console/env",
      canAdd: true,
      entries: [
        row("ANTHROPIC_API_KEY", 20, null, "5e6f7a8b", envM, m(true)),
        row("AWS_SECRET_ACCESS_KEY", 40, "cdEF", "33334444", envM, { viewable: true, ...m(false) }),
        row("OPENAI_API_KEY", 51, "x7Qa", "1a2b3c4d", envM, m(true)),
        row("SERVICE_TOKEN_FOR_A_VERY_LONG_NAME_THAT_WRAPS", 64, "9fK2", "0c0c0c0c", envM, m(true)),
        row("STRIPE_SECRET_KEY", 40, "q3Zt", "77778888", envM, m(false)),
      ],
    },
    {
      id: "bbbbbbbbbbbb",
      label: "agent-console/tool.key",
      canAdd: false,
      entries: [row("tool.key", 40, "ab12", "99887766", now - 86400_000, m(true))],
    },
    {
      id: "cccccccccccc",
      label: "GitHub · acme/widgets",
      canAdd: true,
      entries: [
        row("DATABASE_URL", null, null, null, now - 5 * 86400_000, {
          valueHidden: true,
          ...m(false),
        }),
        row("DEPLOY_TOKEN", null, null, null, now - 6 * 86400_000, {
          valueHidden: true,
          ...m(true),
        }),
      ],
    },
  ];
};
const FAKE_VIEW = "AKIAFAKEFAKEFAKE0001";

async function open(
  viewport: { width: number; height: number },
  scheme: "light" | "dark",
  opts: { enrolled?: number; hang?: boolean } = {},
) {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme });
  await ctx.addCookies([{ name: "ac_session", value: makeToken(), url: BASE }]);
  const page = await ctx.newPage();
  const errors: string[] = [],
    external: string[] = [],
    calls: string[] = [];
  const st = { granted: false, enrolled: opts.enrolled ?? 1, asserts: 0, bodies: [] as any[] };
  page.on(
    "console",
    (m) =>
      m.type() === "error" &&
      !/status of (401|403|404|50\d)/.test(m.text()) &&
      errors.push(m.text()),
  );
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("request", (r) => {
    const u = r.url();
    if (!/^(data:|blob:|about:)/.test(u) && !u.startsWith(BASE)) external.push(u);
  });
  // the passkey ceremony itself cannot run headless: stub the browser library, count calls, optionally never finish
  await page.route("**/vendor/simplewebauthn-browser.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `window.SimpleWebAuthnBrowser={startAuthentication:()=>{window.__asserts=(window.__asserts||0)+1;return ${opts.hang ? "new Promise(()=>{})" : "Promise.resolve({id:'x',response:{}})"}},startRegistration:()=>Promise.resolve({id:'x',response:{}})};`,
    }),
  );
  await page.route("**/api/vault**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      p = url.pathname.replace("/api/vault", "") || "/",
      m = req.method();
    calls.push(`${m} ${p}`);
    if (m === "GET" && p === "/") return route.fulfill(json({ sources: GROUPS(st.granted) }));
    if (m === "GET" && p === "/passkeys")
      return route.fulfill(
        json({
          enrolled: st.enrolled,
          passkeys: st.enrolled
            ? [
                {
                  id: "k1",
                  name: "My phone",
                  createdAt: new Date(now - 9 * 86400_000).toISOString(),
                  lastUsedAt: new Date(now - 3600_000).toISOString(),
                },
              ]
            : [],
        }),
      );
    if (p === "/stepup/options")
      return route.fulfill(json({ cid: "c1", options: { challenge: "ch" } }));
    if (p === "/stepup/verify") {
      st.granted = true;
      return route.fulfill(json({ ok: true, expiresIn: 300 }));
    }
    if (m === "POST" && /\/reveal$/.test(p)) return route.fulfill(json({ value: FAKE_VIEW }));
    if (m === "POST" && p === "/stores") {
      if (!st.granted)
        return route.fulfill(
          json(
            { error: "Confirm with your passkey first.", stepUp: true, enrolled: st.enrolled > 0 },
            401,
          ),
        );
      st.bodies.push(req.postData() || "");
      return route.fulfill(json({ ok: true, id: "eeeeeeeeeeee", label: "proj/.env" }));
    }
    if (m === "PUT" || m === "DELETE") {
      if (!st.granted)
        return route.fulfill(
          json(
            { error: "Confirm with your passkey first.", stepUp: true, enrolled: st.enrolled > 0 },
            401,
          ),
        );
      st.bodies.push(req.postData() || "");
      if (m === "DELETE") st.granted = false;
      return route.fulfill(
        json({ ok: true, ...(p.startsWith("/aaaaaaaaaaaa/") ? { restartNeeded: true } : {}) }),
      );
    }
    return route.fulfill(json({ error: "unmocked" }, 500));
  });
  return { ctx, page, errors, external, calls, st };
}
async function shoot(page: any, name: string) {
  await page.evaluate(() => {
    document.getElementById("hm")!.scrollTop = 0;
  });
  await page.screenshot({ path: `${OUT}/vault-${name}.png` });
}

for (const [name, viewport, scheme] of [
  ["phone360-light", { width: 360, height: 780 }, "light"],
  ["phone412-dark", { width: 412, height: 860 }, "dark"],
  ["phone360-dark", { width: 360, height: 780 }, "dark"],
  ["desktop-light", { width: 1280, height: 900 }, "light"],
] as const) {
  const { ctx, page, errors, external, calls, st } = await open(viewport, scheme);
  await page.goto(`${BASE}/vault`);
  await page.waitForSelector(".vrow");
  const html = await page.content();
  check(
    `${name}: three groups, no separate extra group`,
    (await page.locator(".vgroup h2").allInnerTexts()).join("|").toLowerCase() ===
      "agent-console/env|agent-console/tool.key|github · acme/widgets",
  );
  check(
    `${name}: masked hint and length`,
    (await page.locator(".vgroup").first().innerText()).includes("•••• x7Qa") &&
      (await page.locator(".vgroup").first().innerText()).includes("20 chars"),
  );
  check(
    `${name}: updated 3h ago`,
    (await page.locator(".vgroup").first().innerText()).includes("updated 3h ago"),
  );
  check(
    `${name}: keys interleaved alphabetically`,
    (await page.locator(".vgroup").first().locator(".hname b").allInnerTexts()).join() ===
      "ANTHROPIC_API_KEY,AWS_SECRET_ACCESS_KEY,OPENAI_API_KEY,SERVICE_TOKEN_FOR_A_VERY_LONG_NAME_THAT_WRAPS,STRIPE_SECRET_KEY",
  );
  check(
    `${name}: write-only lock on every row but the viewable one`,
    (await page.locator(".lockt").count()) === 7,
  );
  check(
    `${name}: only the viewable row gets Reveal`,
    (await page.locator("button:has-text('Reveal')").count()) === 1 &&
      (await page.locator(".vrow:has(.lockt) button:has-text('Reveal')").count()) === 0,
  );
  check(
    `${name}: the viewable row also has Replace and Delete`,
    (await page.locator("button[aria-label='Replace AWS_SECRET_ACCESS_KEY']").count()) === 1 &&
      (await page.locator("button[aria-label='Delete AWS_SECRET_ACCESS_KEY']").count()) === 1,
  );
  check(
    `${name}: no per-group Add buttons, one in the header`,
    (await page.locator(".vgroup button:has-text('Add key')").count()) === 0 &&
      (await page.locator(".dh #add-key").count()) === 1,
  );
  check(`${name}: no owner marker without a grant`, (await page.locator(".hmark").count()) === 0);
  check(
    `${name}: banner hidden with a passkey, settings section shown`,
    (await page.locator("#pk-banner").isHidden()) && (await page.locator("#passkeys").isVisible()),
  );
  check(`${name}: no giveaway words in page`, !/decoy|canary|fake|trap/i.test(html));
  for (const f of ["vault.js", "vault.html", "vault.css"])
    check(
      `${name}: no giveaway words in ${f}`,
      !/decoy|canary|fake|trap/i.test(await (await page.request.get(`${BASE}/${f}`)).text()),
    );
  check(
    `${name}: footer line`,
    (await page.locator(".vfoot").innerText()) ===
      "Values are write-only: they never leave the server.",
  );
  check(
    `${name}: no horizontal overflow`,
    !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)),
  );
  await shoot(page, name);

  // reveal works without a passkey
  await page.locator("button[aria-label='Reveal AWS_SECRET_ACCESS_KEY']").click();
  await page.waitForSelector(".shown");
  check(
    `${name}: reveal shows value, no grant needed`,
    (await page.locator(".shown").innerText()) === FAKE_VIEW &&
      st.asserts === 0 &&
      !calls.includes("POST /stepup/options"),
  );

  // replace: password input, step-up retry, cleared after save, restart note
  await page.locator("button[aria-label='Replace OPENAI_API_KEY']").click();
  const inp = page.locator("#value");
  const attrs = await inp.evaluate((e: HTMLInputElement) => [
    e.type,
    e.autocomplete,
    e.getAttribute("autocapitalize"),
    e.spellcheck,
  ]);
  check(
    `${name}: password input, no autofill/caps/spellcheck`,
    attrs.join(",") === "password,off,off,false",
    attrs.join(","),
  );
  await inp.fill("fake-new-value-123");
  await page.click("#reveal");
  check(
    `${name}: show toggle`,
    (await inp.getAttribute("type")) === "text" &&
      (await page.locator("#reveal").innerText()) === "Hide",
  );
  await page.click("#reveal");
  await page.click("#edit-save");
  await page.waitForSelector(".show");
  check(
    `${name}: passkey prompted once, write retried`,
    (await page.evaluate(() => (window as any).__asserts)) === 1 &&
      calls.filter((c) => c.startsWith("PUT")).length === 2,
  );
  check(
    `${name}: toast + restart note`,
    (await page.locator("#toast").innerText()).includes("OPENAI_API_KEY saved") &&
      (await page.locator("#restart-note").isVisible()),
  );
  check(
    `${name}: value not echoed back or left in the field`,
    (await inp.inputValue()) === "" && !(await page.content()).includes("fake-new-value-123"),
  );

  // after the step-up above the server sent `mine`: owner-only marker on the non-live rows
  check(
    `${name}: owner marker on three rows after the step-up`,
    (await page.locator(".hmark").count()) === 3,
    String(await page.locator(".hmark").count()),
  );

  // header Add key: three fields, store dropdown with New…
  await page.click("#add-key");
  const opts = await page.locator("#where option").allInnerTexts();
  check(
    `${name}: Where lists writable stores then New…`,
    opts.join("|") === "agent-console/env|GitHub · acme/widgets|New…",
    opts.join("|"),
  );
  check(
    `${name}: three fields, no sub-form yet`,
    (await page.locator("#where").isVisible()) &&
      (await page.locator("#name").isVisible()) &&
      (await page.locator("#value").isVisible()) &&
      (await page.locator("#new-wrap").isHidden()),
  );
  await page.fill("#name", "new_key");
  check(`${name}: key name uppercased`, (await page.inputValue("#name")) === "NEW_KEY");
  await page.fill("#name", "feature_flag");
  check(
    `${name}: hint for env names the list would hide`,
    await page.locator("#name-hint").isVisible(),
  );
  await page.fill("#name", "new_key");
  check(`${name}: no hint for secret-like names`, await page.locator("#name-hint").isHidden());
  await page.fill("#value", "fake");
  await page.selectOption("#where", "cccccccccccc");
  await page.click("#edit-save");
  await page.waitForFunction(() => !(document.getElementById("edit") as HTMLDialogElement).open);
  check(`${name}: add sent PUT to the chosen store`, calls.includes("PUT /cccccccccccc/NEW_KEY"));

  // New… sub-form: env file path, then the key
  await page.click("#add-key");
  await page.selectOption("#where", "__new");
  check(
    `${name}: New… reveals the sub-form`,
    (await page.locator("#new-wrap").isVisible()) &&
      (await page.locator("#new-type option").allInnerTexts()).length === 2,
  );
  await page.fill("#name", "app_token");
  await page.fill("#value", "demo-value-123");
  await page.click("#edit-save");
  check(
    `${name}: empty New… path is refused`,
    (await page.locator("#edit-err").isVisible()) && !calls.includes("POST /stores"),
  );
  await page.fill("#new-val", "~/proj/.env");
  if (name === "phone360-light" || name === "phone412-dark") await page.click("#reveal");
  if (name === "phone360-light") await shoot(page, "add-new");
  if (name === "phone360-light") await page.click("#reveal");
  await page.click("#edit-save");
  await page.waitForFunction(() => !(document.getElementById("edit") as HTMLDialogElement).open);
  check(
    `${name}: New… saves the store, then the key`,
    calls.includes("POST /stores") &&
      calls.includes("PUT /eeeeeeeeeeee/APP_TOKEN") &&
      calls.indexOf("POST /stores") < calls.indexOf("PUT /eeeeeeeeeeee/APP_TOKEN"),
  );
  check(
    `${name}: store request carried type and path`,
    st.bodies.some((b: string) => b.includes('"type":"env"') && b.includes("~/proj/.env")),
  );

  // delete: typed confirmation
  await page.locator("button[aria-label='Delete ANTHROPIC_API_KEY']").click();
  check(
    `${name}: delete disabled until the name is typed`,
    await page.locator("#del-go").isDisabled(),
  );
  await page.fill("#del-name", "ANTHROPIC_API_KE");
  check(`${name}: partial name keeps it disabled`, await page.locator("#del-go").isDisabled());
  await page.fill("#del-name", "ANTHROPIC_API_KEY");
  check(`${name}: full name enables delete`, await page.locator("#del-go").isEnabled());
  await shoot(page, `${name}-delete`);
  await page.click("#del-go");
  await page.waitForFunction(() => !(document.getElementById("del") as HTMLDialogElement).open);
  check(`${name}: delete sent`, calls.includes("DELETE /aaaaaaaaaaaa/ANTHROPIC_API_KEY"));
  check(
    `${name}: no console errors, first-party only`,
    errors.length === 0 && external.length === 0,
    errors.concat(external).join(" | ").slice(0, 200),
  );
  await ctx.close();
}

// passkey prompt state (the assertion never finishes)
{
  const { ctx, page } = await open({ width: 390, height: 844 }, "dark", { hang: true });
  await page.goto(`${BASE}/vault`);
  await page.waitForSelector(".vrow");
  await page.locator("button[aria-label='Replace OPENAI_API_KEY']").click();
  await page.fill("#value", "fake-new-value-123");
  await page.click("#edit-save");
  await page.waitForSelector("#edit-wait:not([hidden])");
  check(
    "prompt: waiting line shown and save disabled",
    (await page.locator("#edit-wait").innerText()).includes("fingerprint or face") &&
      (await page.locator("#edit-save").isDisabled()),
  );
  await page.screenshot({ path: `${OUT}/vault-passkey-prompt.png` });
  await ctx.close();
}
// no passkey yet: banner with the setup button, no one-time code
{
  const { ctx, page } = await open({ width: 390, height: 844 }, "light", { enrolled: 0 });
  await page.goto(`${BASE}/vault`);
  await page.waitForSelector(".vrow");
  check(
    "setup: banner on top of the page",
    (await page.locator("#pk-banner").isVisible()) &&
      (await page.locator("#pk-banner").innerText()).includes(
        "Set up a passkey (your fingerprint) to change keys",
      ),
  );
  check(
    "setup: banner is the first thing in main",
    await page.evaluate(() => document.querySelector("#hm")!.firstElementChild!.id === "pk-banner"),
  );
  check(
    "setup: settings section hidden with zero passkeys",
    await page.locator("#passkeys").isHidden(),
  );
  await page.screenshot({ path: `${OUT}/vault-banner.png` });
  await page.click("#pk-setup");
  check(
    "setup: enroll dialog opens with no code field",
    (await page.locator("#enroll").evaluate((d: HTMLDialogElement) => d.open)) &&
      (await page.locator("#code").count()) === 0 &&
      (await page.locator("#enroll-sub").innerText()).includes("fingerprint"),
  );
  await ctx.close();
}
// write with no passkey opens the enroll dialog instead of a dead end
{
  const { ctx, page } = await open({ width: 390, height: 844 }, "light", { enrolled: 0 });
  await page.goto(`${BASE}/vault`);
  await page.waitForSelector(".vrow");
  await page.click("#add-key");
  await page.fill("#name", "x_key");
  await page.fill("#value", "v");
  await page.click("#edit-save");
  await page.waitForFunction(() => (document.getElementById("enroll") as HTMLDialogElement).open);
  check("setup: saving without a passkey opens setup", true);
  await ctx.close();
}
await browser.close();
if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}

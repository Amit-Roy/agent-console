// Vault page: real browser, phone widths + desktop, mocked /api/vault (fake keys and values only), passkey prompt stubbed.
import { chromium } from "playwright";
import { makeToken } from "../server/auth.ts";

const BASE = process.env.BASE || "http://127.0.0.1:7070";
const OUT = process.env.OUT || "/tmp";
let failed = 0;
const check = (n: string, ok: boolean, x = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${n} ${x}`); if (!ok) failed++; };
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const browser = await chromium.launch();
const now = Date.now();
const GROUPS = () => [
  { id: "aaaaaaaaaaaa", label: "agent-console/env", canAdd: true, entries: [
    { key: "OPENAI_API_KEY", length: 51, hint: "x7Qa", hash: "1a2b3c4d", mtime: now - 3 * 3600_000, editable: true },
    { key: "ANTHROPIC_API_KEY", length: 20, hint: null, hash: "5e6f7a8b", mtime: now - 2 * 86400_000, editable: true },
    { key: "SERVICE_TOKEN_FOR_A_VERY_LONG_NAME_THAT_WRAPS", length: 64, hint: "9fK2", hash: "0c0c0c0c", mtime: now - 600_000, editable: true },
  ] },
  { id: "bbbbbbbbbbbb", label: "agent-console/tool.key", canAdd: false, entries: [{ key: "tool.key", length: 40, hint: "ab12", hash: "99887766", mtime: now - 86400_000, editable: true }] },
  { id: "cccccccccccc", label: "GitHub · acme/widgets", canAdd: true, entries: [{ key: "DEPLOY_TOKEN", length: null, hint: null, hash: null, mtime: now - 5 * 86400_000, editable: true, valueHidden: true }] },
  { id: "dddddddddddd", label: "AWS · backup-admin", canAdd: false, entries: [
    { key: "aws_access_key_id", length: 20, hint: null, hash: "11112222", mtime: now - 40 * 86400_000, editable: false, viewable: true },
    { key: "aws_secret_access_key", length: 40, hint: "cdEF", hash: "33334444", mtime: now - 40 * 86400_000, editable: false, viewable: true },
  ] },
];
const FAKE_VIEW = "AKIAFAKEFAKEFAKE0001";

async function open(viewport: { width: number; height: number }, scheme: "light" | "dark", opts: { enrolled?: number; hang?: boolean } = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme });
  await ctx.addCookies([{ name: "ac_session", value: makeToken(), url: BASE }]);
  const page = await ctx.newPage();
  const errors: string[] = [], external: string[] = [], calls: string[] = [];
  const st = { granted: false, enrolled: opts.enrolled ?? 1, asserts: 0, bodies: [] as any[] };
  page.on("console", (m) => m.type() === "error" && !/status of (401|403|404|50\d)/.test(m.text()) && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("request", (r) => { const u = r.url(); if (!/^(data:|blob:|about:)/.test(u) && !u.startsWith(BASE)) external.push(u); });
  // the passkey ceremony itself cannot run headless: stub the browser library, count calls, optionally never finish
  await page.route("**/vendor/simplewebauthn-browser.js", (route) => route.fulfill({ contentType: "text/javascript", body: `window.SimpleWebAuthnBrowser={startAuthentication:()=>{window.__asserts=(window.__asserts||0)+1;return ${opts.hang ? "new Promise(()=>{})" : "Promise.resolve({id:'x',response:{}})"}},startRegistration:()=>Promise.resolve({id:'x',response:{}})};` }));
  await page.route("**/api/vault**", async (route) => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname.replace("/api/vault", "") || "/", m = req.method();
    calls.push(`${m} ${p}`);
    if (m === "GET" && p === "/") return route.fulfill(json({ sources: GROUPS() }));
    if (m === "GET" && p === "/passkeys") return route.fulfill(json({ enrolled: st.enrolled, passkeys: st.enrolled ? [{ id: "k1", name: "My phone", createdAt: new Date(now - 9 * 86400_000).toISOString(), lastUsedAt: new Date(now - 3600_000).toISOString() }] : [] }));
    if (p === "/stepup/options") return route.fulfill(json({ cid: "c1", options: { challenge: "ch" } }));
    if (p === "/stepup/verify") { st.granted = true; return route.fulfill(json({ ok: true, expiresIn: 300 })); }
    if (m === "POST" && /\/reveal$/.test(p)) return route.fulfill(json({ value: FAKE_VIEW }));
    if (m === "PUT" || m === "DELETE") {
      if (!st.granted) return route.fulfill(json({ error: "Confirm with your passkey first.", stepUp: true, enrolled: st.enrolled > 0 }, 401));
      st.bodies.push(req.postData() || "");
      if (m === "DELETE") st.granted = false;
      return route.fulfill(json({ ok: true, ...(p.startsWith("/aaaaaaaaaaaa/") ? { restartNeeded: true } : {}) }));
    }
    return route.fulfill(json({ error: "unmocked" }, 500));
  });
  return { ctx, page, errors, external, calls, st };
}
async function shoot(page: any, name: string) {
  await page.evaluate(() => { document.getElementById("hm")!.scrollTop = 0; });
  await page.screenshot({ path: `${OUT}/vault-${name}.png` });
}

for (const [name, viewport, scheme] of [["phone360-light", { width: 360, height: 780 }, "light"], ["phone412-dark", { width: 412, height: 860 }, "dark"], ["phone360-dark", { width: 360, height: 780 }, "dark"], ["desktop-light", { width: 1280, height: 900 }, "light"]] as const) {
  const { ctx, page, errors, external, calls, st } = await open(viewport, scheme);
  await page.goto(`${BASE}/vault`);
  await page.waitForSelector(".vrow");
  const html = await page.content();
  check(`${name}: four groups with friendly labels`, (await page.locator(".vgroup h2").allInnerTexts()).join("|").toLowerCase() === "agent-console/env|agent-console/tool.key|github · acme/widgets|aws · backup-admin");
  check(`${name}: masked hint and length`, (await page.locator(".vgroup").first().innerText()).includes("•••• x7Qa") && (await page.locator(".vgroup").first().innerText()).includes("20 chars"));
  check(`${name}: updated 3h ago`, (await page.locator(".vgroup").first().innerText()).includes("updated 3h ago"));
  check(`${name}: real rows show write-only lock`, await page.locator(".lockt").count() === 5);
  check(`${name}: only viewable rows get Reveal`, await page.locator("button:has-text('Reveal')").count() === 2 && await page.locator(".vrow:has(.lockt) button:has-text('Reveal')").count() === 0);
  check(`${name}: no edit buttons on viewable rows`, await page.locator(".vgroup").nth(3).locator("button:has-text('Replace'), button:has-text('Delete')").count() === 0);
  check(`${name}: no secret-ish words in page`, !/decoy|canary/i.test(html));
  check(`${name}: footer line`, (await page.locator(".vfoot").innerText()) === "Values are write-only: they never leave the server.");
  check(`${name}: no horizontal overflow`, !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)));
  await shoot(page, name);

  // reveal works without a passkey
  await page.locator(".vgroup").nth(3).locator("button:has-text('Reveal')").first().click();
  await page.waitForSelector(".shown");
  check(`${name}: reveal shows value, no grant needed`, (await page.locator(".shown").innerText()) === FAKE_VIEW && st.asserts === 0 && !calls.includes("POST /stepup/options"));

  // replace: password input, step-up retry, cleared after save, restart note
  await page.locator("button[aria-label='Replace OPENAI_API_KEY']").click();
  const inp = page.locator("#value");
  const attrs = await inp.evaluate((e: HTMLInputElement) => [e.type, e.autocomplete, e.getAttribute("autocapitalize"), e.spellcheck]);
  check(`${name}: password input, no autofill/caps/spellcheck`, attrs.join(",") === "password,off,off,false", attrs.join(","));
  await inp.fill("fake-new-value-123");
  await page.click("#reveal");
  check(`${name}: show toggle`, await inp.getAttribute("type") === "text" && (await page.locator("#reveal").innerText()) === "Hide");
  await page.click("#reveal");
  await page.click("#edit-save");
  await page.waitForSelector(".show");
  check(`${name}: passkey prompted once, write retried`, await page.evaluate(() => (window as any).__asserts) === 1 && calls.filter((c) => c.startsWith("PUT")).length === 2);
  check(`${name}: toast + restart note`, (await page.locator("#toast").innerText()).includes("OPENAI_API_KEY saved") && await page.locator("#restart-note").isVisible());
  check(`${name}: value not echoed back or left in the field`, await inp.inputValue() === "" && !(await page.content()).includes("fake-new-value-123"));

  // add key to a group
  await page.locator("button[aria-label='Add key to agent-console/env']").click();
  await page.fill("#name", "new_key");
  check(`${name}: key name uppercased`, await page.inputValue("#name") === "NEW_KEY");
  await page.fill("#value", "fake");
  await page.click("#edit-save");
  await page.waitForFunction(() => !(document.getElementById("edit") as HTMLDialogElement).open);
  check(`${name}: add sent PUT with the new key`, calls.includes("PUT /aaaaaaaaaaaa/NEW_KEY"));

  // delete: typed confirmation
  await page.locator("button[aria-label='Delete ANTHROPIC_API_KEY']").click();
  check(`${name}: delete disabled until the name is typed`, await page.locator("#del-go").isDisabled());
  await page.fill("#del-name", "ANTHROPIC_API_KE");
  check(`${name}: partial name keeps it disabled`, await page.locator("#del-go").isDisabled());
  await page.fill("#del-name", "ANTHROPIC_API_KEY");
  check(`${name}: full name enables delete`, await page.locator("#del-go").isEnabled());
  await shoot(page, `${name}-delete`);
  await page.click("#del-go");
  await page.waitForFunction(() => !(document.getElementById("del") as HTMLDialogElement).open);
  check(`${name}: delete sent`, calls.includes("DELETE /aaaaaaaaaaaa/ANTHROPIC_API_KEY"));
  check(`${name}: no console errors, first-party only`, errors.length === 0 && external.length === 0, errors.concat(external).join(" | ").slice(0, 200));
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
  check("prompt: waiting line shown and save disabled", (await page.locator("#edit-wait").innerText()).includes("fingerprint or face") && await page.locator("#edit-save").isDisabled());
  await page.screenshot({ path: `${OUT}/vault-passkey-prompt.png` });
  await ctx.close();
}
// no passkey yet: setup state
{
  const { ctx, page } = await open({ width: 390, height: 844 }, "light", { enrolled: 0 });
  await page.goto(`${BASE}/vault`);
  await page.waitForSelector(".vrow");
  check("setup: passkey section offers setup", (await page.locator("#pk-add").innerText()) === "Set up passkey" && (await page.locator("#pk-note").innerText()).includes("one-time code"));
  await page.click("#pk-add");
  check("setup: code field shown", await page.locator("#code").isVisible());
  await page.screenshot({ path: `${OUT}/vault-setup.png` });
  await ctx.close();
}
await browser.close();
if (failed) { console.log(`${failed} failed`); process.exit(1); }

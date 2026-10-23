// End-to-end check against a running server: auth gate, websocket origin check, provider plumbing via the mock agent.
// Start a scratch server with AGENT_CONSOLE_PAGE=12 AGENT_CONSOLE_MOCK=1 and isolated AGENT_CONSOLE_DATA/AGENT_CONSOLE_RUN.
// REAL=1 also runs one turn against the real claude CLI (spends a little subscription quota).
import { WebSocket } from "ws";
import { makeToken } from "../server/auth.ts";

const BASE = process.env.BASE || "http://127.0.0.1:7070";
const cookie = `ac_session=${makeToken()}`;
let failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${extra}`);
  if (!ok) failed++;
};

const { CODER_HOST, CODER_HOSTS } = await import("../server/auth.ts");
const { request } = await import("node:http");
const withHost = (host: string) =>
  new Promise<number>((res, rej) => {
    const u = new URL(BASE + "/vendor/marked.js");
    const r = request(
      { host: u.hostname, port: u.port, path: u.pathname, headers: { host } },
      (x) => {
        x.resume();
        res(x.statusCode ?? 0);
      },
    );
    r.on("error", rej);
    r.end();
  });
const loginBody = JSON.stringify({ password: "nope" });
const [ssoCodes, evil, apiBlocked, pageRedirect, badLogin, indexAuthed, vendorAuthed] =
  await Promise.all([
    Promise.all(CODER_HOST ? CODER_HOSTS.map((h: string) => withHost(h)) : []),
    CODER_HOST ? withHost("evil.example") : Promise.resolve(0),
    fetch(BASE + "/vendor/marked.js").then((r) => r.status),
    fetch(BASE + "/", { redirect: "manual", headers: { accept: "text/html" } }).then(
      (r) => r.status,
    ),
    fetch(BASE + "/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: loginBody,
    }).then((r) => r.status),
    fetch(BASE + "/", { headers: { cookie } }).then((r) => r.status),
    fetch(BASE + "/vendor/marked.js", { headers: { cookie } }).then((r) => r.status),
  ]);
if (CODER_HOST) {
  CODER_HOSTS.forEach((h: string, i: number) =>
    check(`coder host ${h} passes without cookie (SSO)`, ssoCodes[i] === 200),
  );
  check("wrong host without cookie blocked", evil === 401);
} else console.log("SKIP  SSO checks (no VSCODE_PROXY_URI)");
check("unauthenticated API is blocked", apiBlocked === 401);
check("page redirects to login", pageRedirect === 302);
check("bad password rejected", badLogin === 401);
check("authed index loads", indexAuthed === 200);
check("authed vendor lib loads", vendorAuthed === 200);

const inbox: any[] = [];
const wakers = new Set<() => void>(); // waitFor sleepers, woken by the next incoming message instead of polling
const open = (headers: Record<string, string>) =>
  new Promise<WebSocket | null>((res) => {
    const w = new WebSocket(BASE.replace("http", "ws") + "/ws", { headers });
    w.on("message", (d) => {
      inbox.push(JSON.parse(String(d)));
      for (const wake of [...wakers]) wake();
    }); // before "open": the server sends hello immediately
    w.on("open", () => res(w));
    w.on("error", () => res(null));
    w.on("unexpected-response", () => res(null));
  });
const [wsNoCookie, wsForeign, ws] = await Promise.all([
  open({ origin: BASE }),
  open({ cookie, origin: "https://evil.example" }),
  open({ cookie, origin: BASE }),
]);
check("ws without cookie refused", wsNoCookie === null);
check("ws with foreign origin refused", wsForeign === null);
check("ws with cookie+origin accepted", ws !== null);
if (!ws) process.exit(1);

const waitFor = async (pred: (m: any) => boolean, ms = 90_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const m = inbox.find(pred);
    if (m) return m;
    const left = end - Date.now();
    if (left <= 0) return null;
    await new Promise<void>((r) => {
      const done = () => {
        clearTimeout(timer);
        wakers.delete(done);
        r();
      };
      const timer = setTimeout(done, left);
      wakers.add(done);
    });
  }
};
// short settle window for "this did NOT happen" checks: every server emit for a mock turn precedes its result on the same socket
const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const hello = await waitFor((m) => m.t === "hello");
check("hello received", !!hello);

check(
  "hello lists providers with readiness",
  Array.isArray(hello?.providers) && hello.providers.some((p: any) => p.id === "claude" && p.ok),
  JSON.stringify(hello?.providers?.map((p: any) => p.id)),
);
check(
  "pi and codex are registered",
  ["pi", "codex"].every((id) => hello?.providers?.some((p: any) => p.id === id)),
);

const dir = process.env.TEST_DIR || new URL("./tmp", import.meta.url).pathname;
(await import("node:fs")).mkdirSync(dir, { recursive: true });
const clear = () => (inbox.length = 0);
const events = (id: string) =>
  inbox.filter((m) => m.t === "event" && m.thread === id).map((m) => m.event);
const create = async (o: object) => {
  clear();
  ws.send(JSON.stringify({ t: "create", cwd: dir, title: "e2e", ...o }));
  const m = await waitFor((m) => m.t === "created" || m.t === "error", 10_000);
  return m;
};

// a provider that is not ready, or unknown, must refuse cleanly instead of spawning anything
const unknown = await create({ provider: "nope" });
check("unknown provider is rejected", unknown?.t === "error");
const notReady = hello.providers.find((p: any) => !p.ok);
if (notReady)
  check(
    `not-ready provider (${notReady.id}) is rejected with its hint`,
    (await create({ provider: notReady.id }))?.message?.includes("not ready"),
  );

if (hello.providers.some((p: any) => p.id === "mock")) {
  const made = await create({ provider: "mock", mode: "plan", model: "echo" });
  check(
    "mock thread created with provider + mode",
    made?.thread?.provider === "mock" && made.thread.mode === "plan",
  );
  const id = made.thread.id;

  clear();
  ws.send(JSON.stringify({ t: "send", thread: id, text: "hello there" }));
  check(
    "mock turn finishes",
    !!(await waitFor((m) => m.t === "event" && m.event.type === "result", 5000)),
  );
  const ev = events(id);
  check(
    "mock: streamed deltas + final assistant text",
    ev.some((e) => e.type === "stream_event") &&
      ev.some((e) => e.type === "assistant" && e.message.content[0].text.includes("hello there")),
  );
  check(
    "mock: reply reflects plan mode and model",
    ev.some((e) => e.type === "assistant" && e.message.content[0].text.includes("plan, echo")),
  );

  clear();
  ws.send(JSON.stringify({ t: "send", thread: id, text: "tool please" }));
  await waitFor((m) => m.t === "event" && m.event.type === "result", 5000);
  const ev2 = events(id);
  check(
    "mock: tool_use then tool_result then result",
    ["assistant", "user", "assistant", "result"].every(
      (t, i) =>
        ev2.filter((e) => !["system", "stream_event", "user_input"].includes(e.type))[i]?.type ===
        t,
    ),
  );

  const lab = await waitFor((m) => m.t === "event" && m.event.type === "tool_label", 3000);
  check(
    "tool label: a described-less shell call gets a plain-English label event",
    lab?.event?.tool_use_id === "t1" && lab.event.label === "Running echo",
    JSON.stringify(lab?.event),
  );
  clear();
  ws.send(JSON.stringify({ t: "open", thread: id }));
  const h0 = await waitFor((m) => m.t === "history", 3000);
  check(
    "tool label: persisted, so history replay carries it after the card",
    h0.events.findIndex((e: any) => e.type === "tool_label") >
      h0.events.findIndex(
        (e: any) => e.type === "assistant" && e.message.content[0].type === "tool_use",
      ),
  );

  // Completed tool work must never buy a separate model turn for memory housekeeping.
  clear();
  ws.send(JSON.stringify({ t: "send", thread: id, text: "tool second" }));
  await waitFor((m) => m.t === "event" && m.event.type === "result", 4000);
  await settle(100);
  check(
    "memory upkeep never starts an automatic model turn",
    !inbox.some(
      (m) => m.t === "event" && m.event.type === "user_input" && m.event.auto === "brain",
    ),
  );

  clear();
  ws.send(JSON.stringify({ t: "send", thread: id, text: "fail now" }));
  await waitFor((m) => m.t === "event" && m.event.type === "result", 5000);
  check(
    "mock: failure surfaces console_error and unlocks the thread",
    events(id).some((e) => e.type === "console_error") &&
      inbox.some((m) => m.t === "thread" && m.thread.id === id && m.thread.status === "idle"),
  );

  clear();
  ws.send(JSON.stringify({ t: "send", thread: id, text: "slow burn" }));
  await waitFor((m) => m.t === "event" && m.event.type === "stream_event", 3000);
  ws.send(JSON.stringify({ t: "abort", thread: id }));
  check(
    "abort stops a running mock turn",
    !!(await waitFor((m) => m.t === "event" && m.event.type === "aborted", 3000)),
  );
  clear();
  ws.send(JSON.stringify({ t: "send", thread: id, text: "after stop" }));
  check(
    "thread works again after abort",
    !!(await waitFor((m) => m.t === "event" && m.event.type === "result", 5000)),
  );

  clear();
  ws.send(
    JSON.stringify({ t: "update", thread: id, mode: "bypassPermissions", model: "nonexistent" }),
  );
  const upd = await waitFor((m) => m.t === "thread" && m.thread.id === id, 3000);
  check(
    "update applies valid mode, ignores unknown model",
    upd?.thread?.mode === "bypassPermissions" && upd.thread.model === "echo",
  );
  clear();
  ws.send(JSON.stringify({ t: "update", thread: id, mode: "acceptEdits" }));
  const upd2 = await waitFor((m) => m.t === "thread" && m.thread.id === id, 3000);
  check("mock accepts every mode", upd2?.thread?.mode === "acceptEdits");

  clear();
  ws.send(JSON.stringify({ t: "open", thread: id }));
  const hist = await waitFor((m) => m.t === "history", 3000);
  check(
    "history replay available",
    (hist?.events?.length ?? 0) > 8,
    `events=${hist?.events?.length}`,
  );
  check("history omits stream deltas", !hist.events.some((e: any) => e.type === "stream_event"));

  // ---- auto title: a thread made without a title is renamed after its first message; named or renamed ones are left alone
  const auto = await create({ provider: "mock", model: "echo", title: "" });
  const autoId = auto.thread.id;
  check(
    "title: a new thread starts with its folder name",
    auto.thread.title === "tmp",
    auto.thread.title,
  );
  clear();
  ws.send(JSON.stringify({ t: "send", thread: autoId, text: "ok" }));
  await waitFor((m) => m.t === "event" && m.event.type === "result", 5000);
  await settle();
  check(
    "title: a one-word opener does not use up the rename",
    !inbox.some((m) => m.t === "thread" && m.thread.id === autoId && m.thread.title !== "tmp"),
  );
  clear();
  ws.send(JSON.stringify({ t: "send", thread: autoId, text: "fix the flaky login test please" }));
  const retitled = await waitFor(
    (m) => m.t === "thread" && m.thread.id === autoId && m.thread.title !== "tmp",
    5000,
  );
  check(
    "title: renamed after the first message",
    retitled?.thread?.title === "fix the flaky login",
    retitled?.thread?.title,
  );
  await waitFor((m) => m.t === "event" && m.event.type === "result", 5000);
  clear();
  ws.send(JSON.stringify({ t: "send", thread: autoId, text: "now something unrelated entirely" }));
  const next = await waitFor(
    (m) => m.t === "thread" && m.thread.id === autoId && m.thread.title !== "fix the flaky login",
    5000,
  );
  check(
    "title: every later prompt renames it from the latest text, capped at 30 chars",
    next?.thread?.title === "now something unrelated",
    next?.thread?.title,
  );
  await waitFor((m) => m.t === "event" && m.event.type === "result", 5000);
  clear();
  ws.send(
    JSON.stringify({
      t: "send",
      thread: autoId,
      text: "![shot](/tmp/x.png) [Image #1] refactor the billing module now",
    }),
  );
  const refreshed = await waitFor(
    (m) =>
      m.t === "thread" && m.thread.id === autoId && m.thread.title !== "now something unrelated",
    5000,
  );
  check(
    "title: media is dropped from what names it",
    refreshed?.thread?.title === "refactor the billing module",
    refreshed?.thread?.title,
  );
  await waitFor((m) => m.t === "event" && m.event.type === "result", 5000);
  ws.send(JSON.stringify({ t: "delete", thread: autoId }));
  await waitFor((m) => m.t === "removed", 3000);
  // the two "title is left alone" cases are independent threads: run their turns side by side, scoped by thread id
  const typed = (await create({ provider: "mock", model: "echo", title: "" })).thread.id;
  const explicit = (await create({ provider: "mock", model: "echo", title: "explicit" })).thread.id;
  ws.send(JSON.stringify({ t: "update", thread: typed, title: "my own name" }));
  await waitFor((m) => m.t === "thread" && m.thread.title === "my own name", 3000);
  clear();
  const turnDone = (tid: string) =>
    waitFor((m) => m.t === "event" && m.thread === tid && m.event.type === "result", 5000);
  const pending = [turnDone(typed), turnDone(explicit)];
  ws.send(JSON.stringify({ t: "send", thread: typed, text: "hello there friend" }));
  ws.send(JSON.stringify({ t: "send", thread: explicit, text: "something else here" }));
  await Promise.all(pending);
  await settle();
  check(
    "title: a manual rename is never overwritten",
    !inbox.some(
      (m) => m.t === "thread" && m.thread.id === typed && m.thread.title !== "my own name",
    ),
  );
  check(
    "title: an explicit title at creation is kept",
    !inbox.some(
      (m) => m.t === "thread" && m.thread.id === explicit && m.thread.title !== "explicit",
    ),
  );
  for (const t of [typed, explicit]) ws.send(JSON.stringify({ t: "delete", thread: t }));
  await Promise.all(
    [typed, explicit].map((t) => waitFor((m) => m.t === "removed" && m.thread === t, 3000)),
  );

  // ---- steering, queued messages, context meter, noise, paged history
  const steerT = (await create({ provider: "mock", model: "echo", title: "steer" })).thread.id;
  check(
    "claude offers explicit advisor Off plus opus/fable; mock offers none",
    JSON.stringify(hello.providers.find((p: any) => p.id === "claude")?.advisors) ===
      '["off","opus","fable"]' &&
      hello.providers.find((p: any) => p.id === "mock")?.advisors.length === 0,
  );
  check(
    "providers advertise native steering",
    hello.providers
      .filter((p: any) => p.steer)
      .map((p: any) => p.id)
      .sort()
      .join() === ["claude", "codex", "mock", "pi"].sort().join(),
    JSON.stringify(hello.providers.map((p: any) => [p.id, p.steer])),
  );
  clear();
  ws.send(JSON.stringify({ t: "send", thread: steerT, text: "slow burn for steering" }));
  await waitFor((m) => m.t === "event" && m.event.type === "stream_event", 3000);
  clear();
  ws.send(JSON.stringify({ t: "send", thread: steerT, text: "change course", mode: "steer" })); // while it is running: steers
  const steered = await waitFor((m) => m.t === "event" && m.event.type === "user_input", 3000);
  check(
    "steer: a message sent mid-turn is logged as a steer and delivered to the agent now",
    steered?.event?.delivery === "steer" &&
      steered.event.text === "change course" &&
      !!(await waitFor(
        (m) =>
          m.t === "event" &&
          m.event.type === "stream_event" &&
          JSON.stringify(m.event.event).includes("[steered: change course]"),
        3000,
      )),
  );
  check(
    "steer: the turn keeps running and no error is raised",
    !inbox.some((m) => m.t === "error") &&
      !(await waitFor((m) => m.t === "event" && m.event.type === "result", 100)),
  );
  clear();
  ws.send(JSON.stringify({ t: "send", thread: steerT, text: "later one", mode: "queue" }));
  const q1 = await waitFor((m) => m.t === "queue" && m.thread === steerT, 3000);
  check(
    "queue: a queued message waits, shown to every client",
    q1?.items?.length === 1 &&
      q1.items[0].text === "later one" &&
      !inbox.some((m) => m.t === "event" && m.event.type === "user_input"),
  );
  clear();
  ws.send(JSON.stringify({ t: "unqueue", thread: steerT, id: q1.items[0].id }));
  check(
    "queue: it can be cancelled",
    (await waitFor((m) => m.t === "queue" && m.thread === steerT, 3000))?.items?.length === 0,
  );
  ws.send(
    JSON.stringify({ t: "send", thread: steerT, text: "stop will clear this", mode: "queue" }),
  );
  await waitFor((m) => m.t === "queue" && m.items.length === 1, 3000);
  clear();
  ws.send(JSON.stringify({ t: "abort", thread: steerT }));
  check(
    "queue: Stop clears whatever was queued behind it",
    (await waitFor((m) => m.t === "queue" && m.thread === steerT, 3000))?.items?.length === 0,
  );
  await waitFor((m) => m.t === "event" && m.event.type === "aborted", 3000);

  // two quick messages: the second lands while the first turn runs, then goes out on its own when that turn ends
  clear();
  ws.send(JSON.stringify({ t: "send", thread: steerT, text: "tool first" }));
  ws.send(JSON.stringify({ t: "send", thread: steerT, text: "second after", mode: "queue" }));
  await waitFor(
    (m) => m.t === "event" && m.event.type === "user_input" && m.event.delivery === "queued",
    5000,
  );
  await waitFor(
    (m) =>
      m.t === "event" &&
      m.event.type === "result" &&
      inbox.filter((x) => x.t === "event" && x.event.type === "result").length >= 2,
    5000,
  );
  const order = inbox
    .filter((m) => m.t === "event" && ["user_input", "result"].includes(m.event.type))
    .map((m) => m.event.type + (m.event.delivery ? ":" + m.event.delivery : ""));
  check(
    "queue: sent automatically when the turn ends, in its own turn",
    order.join() === "user_input,result,user_input:queued,result",
    order.join(),
  );
  check(
    "queue: the queue is empty afterwards",
    inbox.filter((m) => m.t === "queue" && m.thread === steerT).at(-1)?.items?.length === 0,
  );
  const ctxMsg = inbox
    .filter((m) => m.t === "thread" && m.thread.id === steerT && m.thread.context)
    .at(-1);
  check(
    "context: the thread carries tokens used and the window",
    ctxMsg?.thread.context.used > 0 && ctxMsg.thread.context.max === 200000,
    JSON.stringify(ctxMsg?.thread.context),
  );
  check(
    "noise: status chatter is neither broadcast nor logged",
    !inbox.some((m) => m.t === "event" && m.event.subtype === "status") &&
      (await (async () => {
        clear();
        ws.send(JSON.stringify({ t: "open", thread: steerT }));
        return !(await waitFor((m) => m.t === "history", 3000)).events.some(
          (e: any) => e.subtype === "status" || e.type === "context_usage",
        );
      })()),
  );
  for (let i = 0; i < 6; i++) {
    clear();
    ws.send(JSON.stringify({ t: "send", thread: steerT, text: `filler number ${i}` }));
    await waitFor((m) => m.t === "event" && m.event.type === "result", 3000);
  }
  clear();
  ws.send(JSON.stringify({ t: "open", thread: steerT }));
  const pg = await waitFor((m) => m.t === "history", 3000);
  if (process.env.AGENT_CONSOLE_PAGE) {
    check(
      "paging: opening a long thread returns only the newest page, starting on a user message",
      pg.events.length < pg.total &&
        pg.start > 0 &&
        pg.events[0].type === "user_input" &&
        pg.events.length <= Number(process.env.AGENT_CONSOLE_PAGE) + 150,
      `${pg.events.length}/${pg.total} start=${pg.start}`,
    );
    clear();
    ws.send(JSON.stringify({ t: "open", thread: steerT, before: pg.start }));
    const older = await waitFor((m) => m.t === "history" && m.before === pg.start, 3000);
    check(
      "paging: the page before it ends exactly where the first begins",
      older.events.length === pg.start - older.start &&
        older.start < pg.start &&
        older.total === pg.total,
      `${older.start}..${pg.start}`,
    );
    clear();
    ws.send(JSON.stringify({ t: "send", thread: steerT, text: "after the page" }));
    await waitFor((m) => m.t === "event" && m.event.type === "result", 3000);
    const lastSeq = inbox
      .filter((m) => m.t === "event" && m.thread === steerT && m.seq)
      .at(-1)?.seq;
    clear();
    ws.send(JSON.stringify({ t: "open", thread: steerT, since: pg.end }));
    const delta = await waitFor((m) => m.t === "history" && m.delta, 3000);
    check(
      "delta: a refresh from a cached view gets only the lines logged after it",
      delta?.start === pg.end &&
        delta.end === lastSeq &&
        delta.events[0]?.text === "after the page" &&
        delta.events.at(-1)?.type === "result",
      JSON.stringify({ start: delta?.start, end: delta?.end, lastSeq, n: delta?.events.length }),
    );
    clear();
    ws.send(JSON.stringify({ t: "open", thread: steerT, since: lastSeq }));
    const none = await waitFor((m) => m.t === "history", 3000);
    check("delta: nothing new is an empty delta", none?.delta === true && none.events.length === 0);
    clear();
    ws.send(JSON.stringify({ t: "open", thread: steerT, since: 0 }));
    check(
      "delta: too far behind gets a full page instead",
      !(await waitFor((m) => m.t === "history", 3000))?.delta,
    );
    clear();
    ws.send(JSON.stringify({ t: "open", thread: steerT, small: true }));
    const small = await waitFor((m) => m.t === "history", 3000);
    clear();
    ws.send(JSON.stringify({ t: "open", thread: steerT }));
    const full = await waitFor((m) => m.t === "history", 3000);
    check(
      "small pages: phones get fewer events per page",
      small.events.length < full.events.length && small.end === full.end,
      `${small.events.length} vs ${full.events.length}`,
    );
    for (const n of [1, 2]) {
      clear();
      ws.send(
        JSON.stringify({ t: "send", thread: steerT, text: `bulky ${n} ` + "z".repeat(30_000) }),
      );
      await waitFor((m) => m.t === "event" && m.event.type === "result", 3000);
    }
    clear();
    ws.send(JSON.stringify({ t: "open", thread: steerT }));
    const capped = await waitFor((m) => m.t === "history", 3000);
    check(
      "byte cap: an oversized page starts at the latest user message that fits",
      capped.events[0]?.type === "user_input" &&
        capped.events[0].text.startsWith("bulky 2") &&
        JSON.stringify(capped.events).length <= 96_000,
      `${capped.events.length} events, ${JSON.stringify(capped.events).length} bytes, first=${capped.events[0]?.text?.slice(0, 8)}`,
    );
  } else console.log("SKIP  paging (start the scratch server with AGENT_CONSOLE_PAGE=12)");
  ws.send(JSON.stringify({ t: "delete", thread: steerT }));
  await waitFor((m) => m.t === "removed", 3000);

  // ---- export (Download / Share)
  const [exp, expAnon, expMissing] = await Promise.all([
    fetch(`${BASE}/export/${id}`, { headers: { cookie } }),
    fetch(`${BASE}/export/${id}`),
    fetch(`${BASE}/export/00000000-0000-0000-0000-000000000000`, { headers: { cookie } }),
  ]);
  const md = await exp.text();
  check(
    "export: markdown attachment named after the thread",
    exp.status === 200 &&
      /attachment; filename="?e2e\.md"?/.test(exp.headers.get("content-disposition") ?? "") &&
      exp.headers.get("content-type")?.startsWith("text/markdown") === true,
  );
  check(
    "export: title, both speakers, tool activity",
    md.startsWith("# e2e\n") &&
      md.includes("## You\n\nhello there") &&
      md.includes("## Agent") &&
      /^> Bash: /m.test(md),
    md.slice(0, 200),
  );
  check(
    "export: needs a session, unknown thread is 404",
    expAnon.status === 401 && expMissing.status === 404,
  );

  // ---- fork: a new thread that continues from this one
  const histLen = async (tid: string) => {
    clear();
    ws.send(JSON.stringify({ t: "open", thread: tid }));
    return (
      (await waitFor((m) => m.t === "history" && m.thread === tid, 3000))?.events?.length ?? -1
    );
  };
  const parentLen = await histLen(id);
  clear();
  ws.send(JSON.stringify({ t: "fork", thread: id }));
  const forked = await waitFor((m) => m.t === "created", 3000);
  const fid = forked?.thread?.id;
  check(
    "fork: new thread, same agent/folder/mode, titled (fork)",
    !!fid &&
      fid !== id &&
      forked.thread.title === "e2e (fork)" &&
      forked.thread.provider === "mock" &&
      forked.thread.cwd === dir &&
      forked.thread.mode === "acceptEdits",
  );
  check(
    "fork: carries the whole history",
    (await histLen(fid)) === parentLen && parentLen > 8,
    `${parentLen}`,
  );
  clear();
  ws.send(JSON.stringify({ t: "send", thread: fid, text: "carry on please" }));
  await waitFor((m) => m.t === "event" && m.event.type === "result", 5000);
  const forkReply = events(fid).find((e) => e.type === "assistant")?.message.content[0].text ?? "";
  check(
    "fork: first message carries the earlier conversation (agents without native fork)",
    forkReply.includes("earlier conversation") &&
      forkReply.includes("hello there") &&
      forkReply.includes("carry on please"),
    forkReply.slice(0, 120),
  );
  check(
    "fork: the log shows only what the user typed, not the transcript",
    events(fid).find((e) => e.type === "user_input")?.text === "carry on please",
  );
  clear();
  ws.send(JSON.stringify({ t: "send", thread: fid, text: "and again" }));
  await waitFor((m) => m.t === "event" && m.event.type === "result", 5000);
  check(
    "fork: the earlier conversation is replayed once only",
    !(events(fid).find((e) => e.type === "assistant")?.message.content[0].text ?? "").includes(
      "earlier conversation",
    ),
  );
  check("fork: the parent is untouched", (await histLen(id)) === parentLen);
  clear();
  ws.send(JSON.stringify({ t: "fork", thread: id, provider: "claude" }));
  const xf = await waitFor((m) => m.t === "created" || m.t === "error", 3000);
  check(
    "fork: into another agent switches harness, resets model/effort, replays text",
    xf?.thread?.provider === "claude" &&
      xf.thread.replay === true &&
      !xf.thread.forkFrom &&
      xf.thread.effort === "default" &&
      xf.thread.model !== "mock" &&
      xf.thread.id !== id,
    JSON.stringify(xf).slice(0, 160),
  );
  check(
    "fork: into another agent still carries the whole history",
    !!xf?.thread && (await histLen(xf.thread.id)) === parentLen,
  );
  clear();
  ws.send(JSON.stringify({ t: "send", thread: id, text: "slow burn for fork" }));
  await waitFor((m) => m.t === "event" && m.event.type === "stream_event", 3000);
  clear();
  ws.send(JSON.stringify({ t: "fork", thread: id }));
  check(
    "fork: refused while the turn is running",
    (await waitFor((m) => m.t === "error", 3000))?.message?.includes("Wait for"),
  );
  ws.send(JSON.stringify({ t: "abort", thread: id }));
  await waitFor((m) => m.t === "event" && m.event.type === "aborted", 3000);
  ws.send(JSON.stringify({ t: "delete", thread: fid }));
  await waitFor((m) => m.t === "removed", 3000);

  // ---- attachments (images + files) over the HTTP upload API
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const fsm = await import("node:fs");
  const { threadDir } = await import("../server/uploads.ts");
  const up = (
    thread: string,
    name: string,
    body: Buffer | string,
    type = "application/octet-stream",
    headers: Record<string, string> = { origin: BASE },
  ) =>
    fetch(`${BASE}/uploads/${thread}`, {
      method: "POST",
      headers: { cookie, "content-type": type, "x-name": encodeURIComponent(name), ...headers },
      body,
    });
  const send = async (text: string, attachments: unknown, wait: "result" | "error" = "result") => {
    clear();
    ws.send(JSON.stringify({ t: "send", thread: id, text, attachments }));
    return waitFor(
      (m) => (wait === "result" ? m.t === "event" && m.event.type === "result" : m.t === "error"),
      5000,
    );
  };

  const upJson = (...args: Parameters<typeof up>) => up(...args).then((r) => r.json());
  const [img, doc, fake, html, renamed] = await Promise.all([
    upJson(id, "shot.png", PNG, "image/png"),
    upJson(id, "../../etc/notes report.txt", "hello file", "text/plain"),
    upJson(id, "fake.png", "<html><script>alert(1)</script></html>", "image/png"),
    upJson(id, "page.html", "<script>alert(1)</script>", "text/html"),
    upJson(id, "photo.txt", PNG, "text/plain"),
  ]);
  check(
    "upload: image recognised by its bytes",
    img.kind === "image" &&
      img.media_type === "image/png" &&
      img.name === "shot.png" &&
      img.size === PNG.length,
    JSON.stringify(img),
  );
  check(
    "upload: text file kept as a file, name sanitised to one segment",
    doc.kind === "file" && doc.name === "notes report.txt" && doc.media_type === "text/plain",
    JSON.stringify(doc),
  );
  check("upload: claimed image type is not trusted", fake.kind === "file", JSON.stringify(fake));
  check(
    "upload: image bytes under a wrong extension get the right one",
    renamed.kind === "image" && renamed.name === "photo.png",
    JSON.stringify(renamed),
  );

  const [noSession, crossSite, noOrigin, unknownThread, empty, big, bigImage] = await Promise.all([
    fetch(`${BASE}/uploads/${id}`, { method: "POST", headers: { origin: BASE }, body: "x" }),
    up(id, "a.txt", "x", "text/plain", { origin: "https://evil.example" }),
    up(id, "a.txt", "x", "text/plain", {}),
    up("00000000-0000-0000-0000-000000000000", "a.txt", "x"),
    up(id, "a.txt", ""),
    up(id, "big.bin", Buffer.alloc(26 << 20)),
    up(id, "big.png", Buffer.concat([PNG, Buffer.alloc(6 << 20)]), "image/png"),
  ]);
  check("upload: needs a session", noSession.status === 401);
  check("upload: cross-site request refused", crossSite.status === 403);
  check("upload: request without Origin refused", noOrigin.status === 403);
  check("upload: unknown thread", unknownThread.status === 404);
  check("upload: empty file rejected", empty.status === 400);
  check(
    "upload: over 25 MB rejected with a message",
    big.status === 413 && /25 MB/.test((await big.json()).error),
    String(big.status),
  );
  check("upload: image over 5 MB rejected", bigImage.status === 400);

  const get = (a: { id: string; name: string }, t = id) =>
    fetch(`${BASE}/uploads/${t}/${a.id}/${encodeURIComponent(a.name)}`, { headers: { cookie } });
  const [gi, gd, gh, gf, gAnon, gTrick1, gTrick2, gTrick3] = await Promise.all([
    get(img),
    get(doc),
    get(html),
    get(fake),
    fetch(`${BASE}/uploads/${id}/${img.id}/shot.png`),
    fetch(`${BASE}/uploads/${id}/${img.id}/..%2f..%2fthreads.json`, { headers: { cookie } }),
    fetch(`${BASE}/uploads/${id}/${img.id}/.hidden`, { headers: { cookie } }),
    get(img, "../x"),
  ]);
  check(
    "download: image served inline with its type",
    gi.status === 200 &&
      gi.headers.get("content-type") === "image/png" &&
      !gi.headers.get("content-disposition") &&
      Buffer.from(await gi.arrayBuffer()).equals(PNG),
  );
  check(
    "download: other files are attachments, octet-stream",
    gd.status === 200 &&
      /attachment/.test(gd.headers.get("content-disposition") ?? "") &&
      gd.headers.get("content-type")?.startsWith("application/octet-stream") === true &&
      (await gd.text()) === "hello file",
  );
  check(
    "download: uploaded html can never render on this origin",
    /attachment/.test(gh.headers.get("content-disposition") ?? "") &&
      !gh.headers.get("content-type")?.includes("html") &&
      gh.headers.get("x-content-type-options") === "nosniff",
  );
  check(
    "download: a fake .png is not served as an image",
    !gf.headers.get("content-type")?.startsWith("image/") &&
      /attachment/.test(gf.headers.get("content-disposition") ?? ""),
  );
  check("download: needs a session", gAnon.status === 401);
  check(
    "download: path tricks are 404",
    gTrick1.status === 404 && gTrick2.status === 404 && gTrick3.status === 404,
  );

  check(
    "send: image + file + text turn finishes",
    !!(await send("what are these", [{ id: img.id }, { id: doc.id }])),
  );
  const sent = events(id).find((e) => e.type === "user_input");
  check(
    "send: log keeps ids and names, never bytes or paths",
    sent?.attachments?.length === 2 &&
      sent.attachments[0].id === img.id &&
      !JSON.stringify(sent).includes(threadDir(id)) &&
      sent.text === "what are these",
  );
  const reply = events(id).find((e) => e.type === "assistant")?.message.content[0].text ?? "";
  check(
    "send: agent got the image as vision input",
    reply.includes("1 image(s): image/png"),
    reply,
  );
  check(
    "send: agent got the file's absolute path in its prompt",
    reply.includes("[Attached files") &&
      reply.includes(`${threadDir(id)}/${doc.id}/notes report.txt`),
    reply,
  );
  check(
    "send: images are labelled for the message to refer to",
    reply.includes("[Image #1] shot.png"),
    reply,
  );
  clear();
  const img2 = await (await up(id, "second.png", PNG, "image/png")).json();
  await send("compare [Image #3] with [Image #7]", [
    { id: img.id, n: 3 },
    { id: img2.id, n: 7 },
  ]);
  const lbl = events(id).find((e) => e.type === "assistant")?.message.content[0].text ?? "";
  check(
    "send: the composer's own numbers are kept and in order",
    lbl.includes("[Image #3] shot.png; [Image #7] second.png"),
    lbl,
  );
  check(
    "send: numbers are logged for the bubble's inline references",
    events(id)
      .find((e) => e.type === "user_input")
      ?.attachments?.map((x: any) => x.n)
      .join() === "3,7",
  );
  check(
    "send: attachment-only message (no text) is accepted",
    !!(await send("", [{ id: (await (await up(id, "only.txt", "x", "text/plain")).json()).id }])),
  );
  check(
    "send: unknown attachment id rejected",
    (await send("x", [{ id: "11111111-1111-1111-1111-111111111111" }], "error"))?.message?.includes(
      "expired",
    ),
  );
  check(
    "send: garbage attachment id rejected",
    (await send("x", [{ id: "../.." }], "error"))?.message?.includes("Unknown attachment"),
  );
  check(
    "send: an attachment cannot be used from another thread",
    (
      await (async () => {
        const o = await create({ provider: "mock", model: "echo" });
        const other = o.thread.id;
        clear();
        ws.send(
          JSON.stringify({ t: "send", thread: other, text: "x", attachments: [{ id: doc.id }] }),
        );
        const r = await waitFor((m) => m.t === "error", 3000);
        ws.send(JSON.stringify({ t: "delete", thread: other }));
        await waitFor((m) => m.t === "removed", 3000);
        return r;
      })()
    )?.message?.includes("expired"),
  );
  const many = await Promise.all(
    Array.from({ length: 9 }, (_, i) =>
      up(id, `f${i}.txt`, "x", "text/plain").then((r) => r.json()),
    ),
  );
  check(
    "send: too many attachments rejected",
    (
      await send(
        "x",
        many.map((m) => ({ id: m.id })),
        "error",
      )
    )?.message?.includes("At most 8"),
  );
  check(
    "send: a rejected send leaves the thread idle",
    !events(id).some((e) => e.type === "user_input"),
  );

  const discard = await up(id, "tmp.txt", "x", "text/plain").then((r) => r.json());
  check(
    "discard: DELETE removes an unsent upload",
    (
      await fetch(`${BASE}/uploads/${id}/${discard.id}`, {
        method: "DELETE",
        headers: { cookie, origin: BASE },
      })
    ).status === 204 && (await get(discard)).status === 404,
  );
  check(
    "discard: cross-site DELETE refused",
    (
      await fetch(`${BASE}/uploads/${id}/${doc.id}`, {
        method: "DELETE",
        headers: { cookie, origin: "https://evil.example" },
      })
    ).status === 403 && (await get(doc)).status === 200,
  );
  check(
    "files are on disk with mode 0600",
    (fsm.statSync(`${threadDir(id)}/${doc.id}/notes report.txt`).mode & 0o777) === 0o600,
  );

  clear();
  ws.send(JSON.stringify({ t: "delete", thread: id }));
  check("delete removes the thread", !!(await waitFor((m) => m.t === "removed", 3000)));
  check("delete removes its uploads", !fsm.existsSync(threadDir(id)));
} else console.log("SKIP  mock-provider checks (start the server with AGENT_CONSOLE_MOCK=1)");

if (process.env.REAL === "1") {
  const made = await create({ provider: "claude", mode: "bypassPermissions", model: "haiku" });
  const id = made.thread.id;
  clear();
  ws.send(
    JSON.stringify({
      t: "send",
      thread: id,
      text: "Use the Write tool to create e2e-out.txt containing the word pong, then reply with exactly: DONE",
    }),
  );
  const result = await waitFor((m) => m.t === "event" && m.event.type === "result");
  check(
    "claude: turn finished",
    !!result,
    result ? `cost=$${result.event.total_cost_usd?.toFixed(4)}` : "",
  );
  const text = events(id)
    .filter((e) => e.type === "assistant")
    .flatMap((e) => e.message.content)
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join(" ");
  check("claude: replied DONE", /DONE/.test(text), JSON.stringify(text).slice(0, 80));
  clear();
  ws.send(
    JSON.stringify({
      t: "send",
      thread: id,
      text: "What word did the file contain? Answer in one word.",
    }),
  );
  await waitFor((m) => m.t === "event" && m.event.type === "result");
  const text2 = events(id)
    .filter((e) => e.type === "assistant")
    .flatMap((e) => e.message.content)
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join(" ");
  check(
    "claude: second turn remembers context",
    /pong/i.test(text2),
    JSON.stringify(text2).slice(0, 60),
  );

  // an image the model has to actually look at: left half red, right half blue
  const { default: sharp } = await import("sharp");
  const half = (rgb: [number, number, number]) => ({
    create: {
      width: 100,
      height: 200,
      channels: 3 as const,
      background: { r: rgb[0], g: rgb[1], b: rgb[2] },
    },
  });
  const png = await sharp(
    await sharp(half([220, 20, 20]))
      .png()
      .toBuffer(),
  )
    .extend({ right: 100, background: { r: 20, g: 20, b: 220 } })
    .png()
    .toBuffer();
  const shot = await (
    await fetch(`${BASE}/uploads/${id}`, {
      method: "POST",
      headers: { cookie, origin: BASE, "content-type": "image/png", "x-name": "halves.png" },
      body: png,
    })
  ).json();
  clear();
  ws.send(
    JSON.stringify({
      t: "send",
      thread: id,
      text: "Name the two colours in this image, left then right. One line.",
      attachments: [{ id: shot.id }],
    }),
  );
  await waitFor((m) => m.t === "event" && m.event.type === "result");
  const text3 = events(id)
    .filter((e) => e.type === "assistant")
    .flatMap((e) => e.message.content)
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join(" ");
  check(
    "claude: sees an attached image (red then blue)",
    /red/i.test(text3) && /blue/i.test(text3) && text3.search(/red/i) < text3.search(/blue/i),
    JSON.stringify(text3).slice(0, 80),
  );
  ws.send(JSON.stringify({ t: "delete", thread: id }));
  await waitFor((m) => m.t === "removed", 5000);

  // a non-image file, in Plan mode: the agent can only reach it because uploads are an added directory
  const made2 = await create({ provider: "claude", mode: "plan", model: "haiku" });
  const id2 = made2.thread.id;
  const doc = await (
    await fetch(`${BASE}/uploads/${id2}`, {
      method: "POST",
      headers: { cookie, origin: BASE, "content-type": "text/plain", "x-name": "secret.txt" },
      body: "The passphrase is pineapple-7319.",
    })
  ).json();
  clear();
  ws.send(
    JSON.stringify({
      t: "send",
      thread: id2,
      text: "Read the attached file and tell me the passphrase.",
      attachments: [{ id: doc.id }],
    }),
  );
  await waitFor((m) => m.t === "event" && m.event.type === "result");
  const text4 = events(id2)
    .filter((e) => e.type === "assistant")
    .flatMap((e) => e.message.content)
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join(" ");
  check(
    "claude: reads an attached file in plan mode",
    /pineapple-7319/.test(text4),
    JSON.stringify(text4).slice(0, 80),
  );
  ws.send(JSON.stringify({ t: "delete", thread: id2 }));
  await waitFor((m) => m.t === "removed", 5000);

  // referring to an image by its [Image #n] label, and forking a real Claude session
  const made3 = await create({ provider: "claude", mode: "plan", model: "haiku" });
  const id3 = made3.thread.id;
  const put = async (tid: string, body: Buffer, name: string) =>
    (
      await (
        await fetch(`${BASE}/uploads/${tid}`, {
          method: "POST",
          headers: { cookie, origin: BASE, "content-type": "image/png", "x-name": name },
          body,
        })
      ).json()
    ).id;
  const green = await sharp({
    create: { width: 120, height: 120, channels: 3, background: { r: 20, g: 170, b: 60 } },
  })
    .png()
    .toBuffer();
  const aId = await put(id3, png, "halves.png");
  const bId = await put(id3, green, "plain.png");
  clear();
  ws.send(
    JSON.stringify({
      t: "send",
      thread: id3,
      text: "What single colour is [Image #2]? Answer with one word. Also remember the codeword kumquat.",
      attachments: [
        { id: aId, n: 1 },
        { id: bId, n: 2 },
      ],
    }),
  );
  await waitFor((m) => m.t === "event" && m.event.type === "result");
  const said = events(id3)
    .filter((e) => e.type === "assistant")
    .flatMap((e) => e.message.content)
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join(" ");
  check(
    "claude: understands a reference to [Image #2] among two images",
    /green/i.test(said) && !/\bred\b|\bblue\b/i.test(said),
    JSON.stringify(said).slice(0, 80),
  );
  clear();
  ws.send(JSON.stringify({ t: "fork", thread: id3 }));
  const fk = await waitFor((m) => m.t === "created", 5000);
  clear();
  ws.send(
    JSON.stringify({ t: "send", thread: fk.thread.id, text: "What was the codeword? One word." }),
  );
  await waitFor((m) => m.t === "event" && m.event.type === "result");
  const fsaid = events(fk.thread.id)
    .filter((e) => e.type === "assistant")
    .flatMap((e) => e.message.content)
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join(" ");
  check(
    "claude: a fork continues the parent's real session",
    /kumquat/i.test(fsaid),
    JSON.stringify(fsaid).slice(0, 80),
  );
  const forkSession = events(fk.thread.id).find(
    (e) => e.type === "system" && e.subtype === "init",
  )?.session_id;
  const parentSession = (
    await (async () => {
      clear();
      ws.send(JSON.stringify({ t: "open", thread: id3 }));
      return waitFor((m) => m.t === "history");
    })()
  ).events.find((e: any) => e.type === "system" && e.subtype === "init")?.session_id;
  check(
    "claude: the fork got its own session id",
    !!forkSession && !!parentSession && forkSession !== parentSession,
    `${parentSession} vs ${forkSession}`,
  );
  for (const t of [fk.thread.id, id3]) {
    ws.send(JSON.stringify({ t: "delete", thread: t }));
    await waitFor((m) => m.t === "removed" && m.thread === t, 5000);
  }
}

ws.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);

// PR cockpit wiring (#421) over a scratch server: WS {t:"pr"} push on subscribe, the /api/threads/:id/pr routes
// (auth, key validation, confirm token, 409 double ship, log redaction + 80-line cap, re-run endpoint), ask-fix,
// sha webhook signals and turn-end re-discovery. gh and pr-ship are fakes on PATH. Run: node test/pr-cockpit-http.ts
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { announcePr } from "../server/automation/closed-signal.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ac-prcock-")));
const bin = path.join(home, "bin");
const repo = path.join(home, "repo");
const ghLog = path.join(home, "gh.log");
const triageConfig = path.join(home, "triage.json");
fs.mkdirSync(bin);
fs.mkdirSync(repo);
const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
git("init", "-q", "-b", "feat-x");
git("remote", "add", "origin", "https://github.com/o/r.git");
git("commit", "-q", "--allow-empty", "-m", "init");

const SHA = "a".repeat(40);
const snapshot = {
  data: {
    repository: {
      pullRequest: {
        title: "Cockpit",
        state: "OPEN",
        isDraft: false,
        url: "https://github.com/o/r/pull/7",
        mergeable: "MERGEABLE",
        mergeStateStatus: "UNSTABLE",
        reviewDecision: null,
        headRefOid: SHA,
        bodyHTML: "",
        reviewThreads: { nodes: [] },
        comments: { nodes: [] },
        reviews: { nodes: [] },
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: {
                    nodes: [
                      {
                        __typename: "CheckRun",
                        name: "test",
                        status: "COMPLETED",
                        conclusion: "FAILURE",
                        detailsUrl: "https://github.com/o/r/actions/runs/22/job/11",
                        databaseId: 11,
                        checkSuite: { workflowRun: { databaseId: 22 } },
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      },
    },
  },
};
fs.writeFileSync(path.join(home, "snapshot.json"), JSON.stringify(snapshot));
const logLines = Array.from({ length: 200 }, (_, index) => `step ${index}`);
logLines[190] = `push with ghp_${"x".repeat(36)} done`;
fs.writeFileSync(path.join(home, "job.log"), `${logLines.join("\n")}\n`);
fs.writeFileSync(
  path.join(bin, "gh"),
  `#!/bin/sh
printf '%s\\n' "$*" >> "${ghLog}"
case "$*" in
  *"run view"*) cat "${home}/job.log" ;;
  *rerun-failed-jobs*) printf 'HTTP/2.0 201 Created\\r\\n\\r\\n' ;;
  *graphql*) printf 'HTTP/2.0 200 OK\\r\\n\\r\\n'; cat "${home}/snapshot.json" ;;
  *pulls*) printf 'HTTP/2.0 200 OK\\r\\n\\r\\n[{"number":7}]' ;;
  *check-runs*) printf 'HTTP/2.0 304 Not Modified\\r\\n\\r\\n' ;;
  *) printf 'HTTP/2.0 404 Not Found\\r\\n\\r\\n{}'; exit 1 ;;
esac
`,
  { mode: 0o755 },
);
fs.writeFileSync(
  path.join(bin, "pr-ship"),
  `#!/bin/sh
echo "waiting for checks on $1 $2 $3"
while [ ! -f "${home}/release" ]; do sleep 0.05; done
echo "Stop: check failing: test"
exit 1
`,
  { mode: 0o755 },
);

const listener = net.createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = (listener.address() as net.AddressInfo).port;
await new Promise<void>((resolve) => listener.close(() => resolve()));
const origin = `http://127.0.0.1:${port}`;
const password = randomBytes(24).toString("base64url");
const child = spawn(process.execPath, ["server/index.ts"], {
  cwd: root,
  env: {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    PORT: String(port),
    AGENT_CONSOLE_DATA: path.join(home, "data"),
    AGENT_CONSOLE_RUN: path.join(home, "run"),
    AGENT_CONSOLE_ENV_FILES: path.join(home, "no-env"),
    AGENT_CONSOLE_BRAIN: path.join(home, "no-brain"),
    AGENT_CONSOLE_TRIAGE_CONFIG: triageConfig,
    AGENT_CONSOLE_MOCK: "1",
    AGENT_CONSOLE_LABELS: "0",
    AGENT_CONSOLE_AUTH: "password",
    AGENT_CONSOLE_PASSWORD: password,
    PR_SHIP_STATE: path.join(home, "pr-ship-state"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stderr.on("data", (chunk) => process.env.PR_TEST_DEBUG && process.stderr.write(chunk));
const inbox: any[] = [];
let socket: WebSocket | undefined;
const settle = async (predicate: () => boolean | Promise<boolean>, label: string) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`timed out: ${label}`);
};
const ghCalls = (pattern: RegExp) =>
  (fs.existsSync(ghLog) ? fs.readFileSync(ghLog, "utf8") : "")
    .split("\n")
    .filter((line) => pattern.test(line)).length;

try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Scratch server startup timed out.")), 20_000);
    child.once("exit", (code) => reject(new Error(`Scratch server exited: ${code}`)));
    let output = "";
    child.stdout.on("data", (chunk) => {
      output = (output + chunk.toString()).slice(-2048);
      if (output.includes("agent-console listening on")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  const login = await fetch(`${origin}/login`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const headers = { Cookie: cookie, "Content-Type": "application/json", Origin: origin };
  const api = (route: string, init: RequestInit = {}) =>
    fetch(origin + route, { ...init, headers: { ...headers, ...init.headers } });
  const post = (route: string, body: unknown) =>
    api(route, { method: "POST", body: JSON.stringify(body) });

  socket = new WebSocket(`${origin.replace("http", "ws")}/ws`, { headers: { origin, cookie } });
  socket.on("message", (data) => inbox.push(JSON.parse(String(data))));
  await settle(() => inbox.some((message) => message.t === "hello"), "ws hello");
  socket.send(
    JSON.stringify({
      t: "create",
      provider: "mock",
      cwd: repo,
      mode: "bypassPermissions",
      title: "P",
    }),
  );
  await settle(() => inbox.some((message) => message.t === "created"), "created");
  const thread = inbox.find((message) => message.t === "created").thread.id as string;
  const base = `/api/threads/${thread}/pr`;
  const lastPr = () =>
    inbox.filter((message) => message.t === "pr" && message.thread === thread).at(-1);

  // subscribing discovers the branch PR and pushes its card
  socket.send(JSON.stringify({ t: "subscribe", thread }));
  await settle(() => lastPr()?.cards?.length === 1, "pr push on subscribe");
  const card = lastPr().cards[0];
  assert.equal(card.key, "o/r#7");
  assert.equal(card.checkCounts.failed, 1);
  assert.equal(card.checks[0].runId, "22");
  assert.equal(card.checks[0].jobId, "11");

  // auth: every route needs the session cookie
  assert.equal((await fetch(origin + base)).status, 401);
  assert.equal((await fetch(`${origin}${base}/log?key=o/r%237&job=11`)).status, 401);
  assert.equal(
    (
      await fetch(`${origin}${base}/ship`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ key: "o/r#7", confirm: true }),
      })
    ).status,
    401,
  );
  // cross-site POSTs are refused even with the cookie
  assert.equal(
    (
      await api(`${base}/refresh`, {
        method: "POST",
        headers: { Origin: "https://evil.example" },
        body: JSON.stringify({ key: "o/r#7" }),
      })
    ).status,
    403,
  );

  const listed: any = await (await api(base)).json();
  assert.deepEqual(
    listed.cards.map((entry: any) => entry.key),
    ["o/r#7"],
  );
  assert.equal((await api("/api/threads/nope/pr")).status, 404);

  // key validation: shape first, then membership in this thread's cards
  assert.equal((await post(`${base}/refresh`, { key: "nonsense" })).status, 400);
  assert.equal((await post(`${base}/refresh`, { key: "o/r#8" })).status, 404);
  assert.equal((await post(`${base}/refresh`, { key: "other/repo#7" })).status, 404);
  const graphqlBefore = ghCalls(/graphql/);
  assert.deepEqual(await (await post(`${base}/refresh`, { key: "O/R#7" })).json(), { ok: true });
  assert.equal(ghCalls(/graphql/), graphqlBefore + 1);

  // re-run: only a run of this PR, through the rerun-failed-jobs endpoint
  assert.equal((await post(`${base}/rerun`, { key: "o/r#7", runId: "99" })).status, 400);
  assert.equal((await post(`${base}/rerun`, { key: "o/r#7", runId: "22/../x" })).status, 400);
  assert.deepEqual(await (await post(`${base}/rerun`, { key: "o/r#7", runId: "22" })).json(), {
    ok: true,
  });
  assert.equal(ghCalls(/-X POST repos\/o\/r\/actions\/runs\/22\/rerun-failed-jobs$/), 1);

  // failed-job log: last 80 lines, redacted
  assert.equal((await api(`${base}/log?key=o/r%237&job=12`)).status, 400);
  const log: any = await (await api(`${base}/log?key=o/r%237&job=11`)).json();
  assert.equal(log.lines.length, 80);
  assert.equal(log.lines[0], "step 120");
  assert.equal(log.lines.at(-1), "step 199");
  assert.ok(log.lines.every((line: string) => !line.includes("ghp_")));
  assert.ok(log.lines.some((line: string) => line.includes("[redacted]")));
  assert.equal(ghCalls(/^run view --job 11 --log-failed -R o\/r$/), 1);

  // ship: confirm token, then 409 while the job runs
  assert.equal((await post(`${base}/ship`, { key: "o/r#7" })).status, 400);
  assert.equal((await post(`${base}/ship`, { key: "o/r#7", confirm: "yes" })).status, 400);
  const shipped: any = await (await post(`${base}/ship`, { key: "o/r#7", confirm: true })).json();
  assert.equal(shipped.ship.state, "running");
  assert.equal((await post(`${base}/ship`, { key: "o/r#7", confirm: true })).status, 409);
  assert.equal((await post(`${base}/ask-fix`, { key: "o/r#7" })).status, 409);
  await settle(
    () => lastPr()?.cards?.[0]?.ship?.line?.startsWith("waiting for checks on 7 -R o/r"),
    "ship progress",
  );
  fs.writeFileSync(path.join(home, "release"), "");
  await settle(() => lastPr()?.cards?.[0]?.ship?.state === "attention", "ship attention push");
  const ship = lastPr().cards[0].ship;
  assert.equal(ship.code, 1);
  assert.equal(ship.line, "Stop: check failing: test");
  assert.equal(typeof ship.startedAt, "number");
  const fetched: any = await (await api(base)).json();
  assert.equal(fetched.cards[0].ship.state, "attention");

  // ask-fix queues the attention line as a user message to the thread
  assert.deepEqual(await (await post(`${base}/ask-fix`, { key: "o/r#7" })).json(), { ok: true });
  await settle(
    () =>
      inbox.some(
        (message) =>
          message.t === "event" &&
          message.thread === thread &&
          JSON.stringify(message.event ?? message).includes("Stop: check failing: test"),
      ),
    "ask-fix message",
  );

  // the turn end re-discovers the branch PRs (branch cache invalidated)
  const pullsBefore = ghCalls(/pulls\?head=/);
  await settle(() => ghCalls(/pulls\?head=/) > pullsBefore, "turn-end re-discovery");

  // a webhook signal that names only the head sha refreshes the matching card
  const signalBefore = ghCalls(/graphql/);
  announcePr({ repo: "o/r", sha: SHA, event: "check_run" }, path.join(home, "github-events"));
  await settle(() => ghCalls(/graphql/) > signalBefore, "sha signal refresh");
  console.log("pr-cockpit-http: ok");
} finally {
  socket?.close();
  child.kill("SIGTERM");
  if (child.exitCode === null && child.signalCode === null)
    await once(child, "exit").catch(() => {});
  fs.rmSync(home, { recursive: true, force: true });
}

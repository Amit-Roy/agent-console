# agent-console

A personal, browser-based front end for coding agents running on this box. Installable as a PWA
(Chrome → ⋮ → Cast, save and share → Install page as app), so it opens in its own window on ChromeOS
or any other device. No remote desktop involved.

Currently drives the `claude` CLI headless (`claude -p --input-format stream-json --output-format stream-json`)
using the login already on this machine. For **personal use only**: it never offers the login to anyone else.
Anthropic's terms restrict third-party products that offer claude.ai login, so don't share this instance.

## Run
    npm install
    bin/agent-console start        # listens on 127.0.0.1:7070
    bin/agent-console url          # Coder proxy URL (HTTPS, requires your Coder login)
    bin/agent-console password     # sign-in password (generated once, ~/.config/agent-console/password)

## Features
- Type `/` in the composer for a command/skill menu (list comes from `claude`'s own `commands_changed` event, cached in `~/.config/agent-console/commands.json`). Skills run headless when a message starts with `/name`.
- Several agents behind one UI: Claude Code, Pi (any model Pi knows: OpenRouter, OpenAI, Google, local), Codex. Pick one per thread; see Providers.
- Threads (each its own agent session, resumable), streaming output, markdown, tool cards with diffs
- Per-thread model and permission mode (plan / accept edits / bypass). Bypass is opt-in and confirmed.
- Codex model picker reads the installed CLI's account-specific `models_cache.json`; effort choices follow each model's supported levels.
  Choose a model and effort in the new-thread dialog or composer. Changes are blocked during a running turn; switching model resets effort to inherited.
  “CLI default” omits `-m`; “Effort · default” omits `model_reasoning_effort`. Both inherit Codex configuration, including project overrides.
  Pin both choices for predictable runs. The catalog's model default is a hint; CLI configuration can override it. Extra model IDs can be supplied via `AGENT_CONSOLE_CODEX_MODELS`.
- `/` lists Console commands immediately, including `/compact`, `/help`, `/status`, `/model`, `/effort`, `/stop`; discovered Claude/Pi skills join the list.
  Command completion works with Tab, Enter and touch selection; Enter submits a completed slash command on mobile too.
  `/compact` (also ⋯ → Compact context) invokes the harness, keeping the visible transcript. Codex uses app-server `thread/resume` + `thread/compact/start` against its existing session;
  success waits for a `contextCompaction` completion and `turn/completed`, not the RPC acknowledgement. Claude receives native `/compact`; Pi gets RPC `compact`.
  Compaction queues behind a running turn; messages during compaction queue behind it. `/stop` cancels. Progress/failures are visible; an empty thread reports that it needs history first.
  Context tokens remain unreported after compaction until fresh telemetry arrives, rather than showing the old count. `/model` and `/effort` without arguments open their pickers.
  Unsupported Codex commands report an error rather than consuming a model turn. Other Claude/Pi commands remain routed to their native registries.
- Provider tabs in the sidebar separate **subscription allowance** from **thread context**: Claude/Codex quota windows, OpenRouter daily free requests and key budget when reported.
  Quotas persist across reconnects/restarts; timestamps and expired reset notices mark stale samples. Missing telemetry stays unknown. OpenRouter allowance refreshes on connection, at most once every five minutes; there is no idle network polling.
  Bars/rings use green below 70%, amber from 70%, red from 90%. Effort stays visible in the composer on mobile during a run (locked until the turn ends).
  Claude Sonnet/Opus use `--effort`; Pi reasoning models use RPC `set_thinking_level`; Codex uses `model_reasoning_effort` (including when its model is inherited).
- Codex context comes from app-server `thread/tokenUsage/updated` (last request); startup restores it from the native session's `token_count` records.
  `exec turn.completed.usage` accumulates usage across tool-loop requests: it belongs in turn diagnostics, never the context gauge. Old inflated counts are migrated automatically.
- Codex keeps an app-server connection open so Enter steers the active native turn (`turn/steer` with its turn ID); Alt+Enter explicitly queues.
  A steer is shown as delivered only after acknowledgement. A rejection is visible and falls back to the next message.
- Background telemetry/error reporting/update checks are disabled for agent children. RTK runs locally via Codex/Claude hooks and the Pi extension, with telemetry blocked.
  Headroom runs as a loopback-only proxy child of the server (`server/headroom.ts`, port 8790, `AGENT_CONSOLE_HEADROOM=0` disables, beacon/telemetry off) and Claude is pointed at it with `ANTHROPIC_BASE_URL` only while it answers health checks, so a dead proxy never breaks a turn.
  Codex (ChatGPT sign-in) and Pi (OpenRouter) use hosts the proxy cannot serve, so they rely on RTK alone. Its MCP server stays off.
- Title/tool-label helpers fail over **OpenRouter free router → Codex Luna at low effort → Haiku**. Exhausted quotas are skipped; errors and malformed replies trigger a five-minute cooldown.
  OpenRouter only uses the free router, never paid routing. Codex uses subscription auth, isolated CLI settings, ephemeral sessions and disabled shell tools.
  `AGENT_CONSOLE_LABEL_CODEX_MODEL` overrides its small model. These helper calls do not replace the thread's selected agent/model.
- Fast history: byte-indexed JSONL reads, newest 40 events by default (`AGENT_CONSOLE_PAGE`), older pages fetched automatically near the top (button also works).
  Pages render detached before insertion; closed tool cards defer syntax highlighting until opened; native `content-visibility` virtualizes offscreen message rendering.
  The five most recent views, including running threads, restore immediately from detached DOM. Changed views remain visible while history refreshes in the background; reconnects mark them stale.
  History responses omit provider/tool catalogs, diagnostic metadata and duplicate result text; logs and exports retain the originals. DOM for explicitly loaded older pages remains available to search and accessibility.
- ⋯ → Run details shows total load, server read, browser render time and page event count, plus the last Codex run's requested model/effort,
  duration and input/cached/output tokens. CLI-inherited settings are explicitly marked as inherited, not reported as a resolved model.
  Latest history timings also appear as `window.agentConsoleMetrics` and a browser debug log. No prompt content is included in diagnostics.
- Queued messages have Edit, Save and Cancel. Opening an editor holds that message; a held head pauses following messages to preserve order.
  Save retains attachments and queue position; Cancel retains the original. Revision checks reject stale edits across windows.
  Queue state and edit holds persist privately in `queues.json` across restarts. Reopen an Editing item to resume; Remove and Stop discard queued work.
- Browser latency samples are batched every five seconds over the existing authenticated WebSocket, with no idle polling or third-party analytics.
  WebSocket compression reduces history/tool bytes. Browsers request full live events only for the selected thread; other threads send small cache invalidations.
  Local `latency.sqlite` stores up to 20,000 samples for 14 days: opens, cached switches, background refreshes, older pages and interrupted loads.
  Cached switch latency measures the visible restoration; background refresh duration is tracked separately.
  Timings distinguish preparation, request round-trip (including server/transport), JSON decoding, server reads and rendering; counts and byte sizes aid diagnosis.
  Run details includes the request round-trip so server reads cannot hide transport delays. `wire_bytes` measures decoded JSON payload size, before transport compression.
  Provider, thread ID, viewport size and foreground/background state are recorded. Message content, titles, URLs, user-agent strings and credentials are excluded.
  Run details shows foreground median/p95; authenticated `GET /api/latency` adds provider/viewport groups, recent samples and slowest loads.
- Mobile composer: 44px controls, compact model/effort labels and an icon for permissions. Settings stay visible while locked during a run; Queue/Stop/Steer occupy a second row.
  Send/Steer is the primary action; Stop uses a quiet secondary style on mobile. Technical timings live in Run details rather than above the message.
  Visual-viewport keyboard handling preserves pinch zoom, caps long drafts to the remaining space, and keeps actions visible. Text can grow to 200%.
- Stop button, session history replay, subscription usage (5h / 7d) in the sidebar, mobile layout
- Composer is one rounded card: textarea over a toolbar with model and permission-mode menus (custom accessible menu buttons, keyboard + touch), Send/Stop.
  Bypass shows as a small amber chip, never red. Thread actions (Rename, Delete) live in the header overflow menu.
- Attachments: paste (Ctrl/Cmd+V), drag anywhere onto the window, or use the attach button. Any file type, up to 8 per message, 25 MB each.
  Each file uploads as soon as it is attached (`POST /uploads/<thread>`, raw bytes, same-origin only) and a message just names the uploads.
  Images are recognised by their bytes (never the claimed type), downscaled to 2000px in the browser, capped at 5 MB, shown as thumbnails; other files show as chips.
  Stored under `~/.config/agent-console/uploads/<thread>/<id>/<name>` (0600); the thread log keeps only `{id, name, kind, size}`. Downloads need the session;
  only verified images render inline, everything else is `Content-Disposition: attachment`. Deleting a thread deletes its uploads; switching threads drops unsent ones.
  Folders cannot be attached (zip them). A paste that carries real text beside a picture (spreadsheet copy) pastes the text only; a file copied in a file manager attaches.
  Delivery: images go to the model as vision input (Claude base64 blocks, Codex app-server `localImage`, Pi RPC `images`); every non-image file is listed by absolute path in the prompt
  and the agent opens it with its own tools (Claude gets `--add-dir` for the thread's upload folder so Plan/Accept-edits can read it).
  Verified live 2026-10-16: Claude (image + file in Plan mode), Codex (image + file on a resumed session), Pi (file by path; payload matches Pi's documented `ImageContent`, the free model tried reported no vision).
- Auto titles: a thread created without a title is named after its folder, then renamed by the label helper from its first message (2 to 5 words, e.g. "Stale Quant Dashboard Prices").
  The shared helper uses OpenRouter free first, subscription Luna second and Haiku last, and never blocks the turn.
  One-word openers ("ok") are skipped until a real message arrives; a manual rename or a title given at creation is never overwritten; any failure keeps the folder name.
  Threads that predate this: `node scripts/retitle.ts` (`--dry` to preview) titles those still named after their folder, through the running server's `update` API.
- Readable tool cards: a Bash card shows what the command is *for*, not the raw command. Claude's own `description` is used when it gives one; otherwise (Codex, Pi,
  terse calls) commands are batched and labelled by the shared helper a few seconds after the card appears ("Copying config to temp dir and resetting permissions"). The raw command stays
  in the card body and on hover. Labels are logged as `tool_label` events, so they survive reloads. `AGENT_CONSOLE_LABELS=0` turns model-written tool labels off.
- Thread actions: a ⋯ on every row (and in the header) offers Rename, Fork, Download, Share and Delete thread. The row's ⋯ is quiet until hover/focus on a mouse and always visible on touch.
  Fork opens a new thread that continues from this one: Claude forks its real session (`--resume <id> --fork-session`), Pi gets a copy of its session directory, and agents with no
  fork (Codex) are handed the earlier conversation as text in the first message. History and uploads are copied; forking is refused while a turn is running.
  Download is a Markdown file (`GET /export/<thread>`, named after the thread). Share hands the same Markdown to the system share sheet (`navigator.share`: Android, ChromeOS, Safari)
  and falls back to copying it. There are no public links: this server is private to you.
- Inline image references: pasting, dropping or picking an image drops `[Image #1]` into the message at the cursor (removing the thumbnail removes it), so you can write "compare [Image #1] with [Image #2]".
  The agent is told which image is which, and in the sent message each label is a link to that image.
- Type: conversation text is set in Newsreader (an editorial serif, variable weight, SIL OFL) at 18px; the interface chrome stays Inter and code JetBrains Mono. Tune `--font-text`, `--f-text`, `--fw-text` in `style.css`.
- Markdown with highlight.js syntax colours (bash, js/ts, json, python, css, html/xml, markdown, diff, yaml, sql, go, rust), code blocks with a
  language header, Copy and line-wrap toggle; Copy under every message; line-level +/- tints for Edit diffs. All output goes through DOMPurify.

## Type and assets (all self-hosted, no CDN, no asset requests leave 127.0.0.1)
- **Newsreader** variable (conversation text, 18px/1.6), **Inter** variable (UI chrome) and **JetBrains Mono** variable (code, ligatures off): SIL Open Font License 1.1.
  Latin + latin-ext woff2 in `public/fonts/` with metric-matched fallbacks (no layout jump). Licences: `public/fonts/LICENSE-*.txt`.
- **highlight.js** 11 (BSD-3-Clause), core + 13 languages as ES modules in `public/vendor/hljs/`.
- `npm run vendor` re-copies fonts and highlight.js from node_modules into `public/` (the copies are committed). `/fonts/*` is served before the auth gate so the sign-in page uses the same type.
- Design tokens (surfaces, text, accent, status, radii, spacing, type scale, motion) are at the top of `public/style.css`; contrast is asserted by `npm run test:ui`.

## Install as an app (ChromeOS / Android / desktop)
Open the Coder app URL in Chrome and sign in to Coder, then use the address-bar install icon (or ⋮ → Cast, save and share →
Install page as app / Android: ⋮ → Install app). It gets its own window, launcher icon and a maskable icon on Android.
The manifest link uses `crossorigin="use-credentials"` so Chrome can fetch it through Coder's login proxy.
Regenerate icons with `npm run icons`. A Play Store/TWA package is not practical: Digital Asset Links verification would be
blocked by Coder's login wall.

## Security model
- Binds to 127.0.0.1 only; reach it through Coder's authenticated port proxy.
- **Coder SSO:** when started with `VSCODE_PROXY_URI` set (any Coder terminal), requests whose `Host` header is exactly this
  app's Coder hostname are trusted: Coder already authenticated you. Direct hits on localhost use a different Host and still
  need the password. Keep the port's Coder share level on "owner"; if you widen it, anyone allowed by Coder can run agents
  here. Set `AGENT_CONSOLE_AUTH=password` to disable SSO, or `AGENT_CONSOLE_PUBLIC_HOST` (comma-separated, also read from `~/.config/agent-console/env`) to trust additional
  Coder-authenticated hosts, such as a direct wildcard app host.
- Password login (fallback) → signed HttpOnly/Secure/SameSite=Strict cookie; failed-login limiter.
- WebSocket requires the cookie **and** a matching Origin header (blocks cross-site hijacking).
- Thread folders are restricted to your home directory.
- `ANTHROPIC_API_KEY` is stripped from the child environment so the subscription login is never swapped for metered billing.
- Bypass mode means a prompt can run any command as this user. Treat the password like a shell login.

## Providers
Each thread runs one harness, chosen in the New thread dialog. A provider is a small adapter in `server/providers/` that starts the harness as a child
process and translates its events into one canonical stream (Claude Code's stream-json shape, which is what the UI renders).

| Agent | How it is driven | Login | Modes |
| --- | --- | --- | --- |
| Claude Code | `claude -p` stream-json, long-lived process | your Claude subscription | plan / accept edits / bypass |
| Pi | `pi --mode rpc`, long-lived, any model in `pi --list-models` | API key or `pi` `/login` | plan (read-only tools) / bypass. Pi has no approval prompts |
| Codex | `codex app-server`, persistent process per active session, resumed by thread id | `codex login --device-auth` | plan (read-only sandbox) / accept edits (workspace-write) / bypass; only bypass where the sandbox cannot run |
| Mock | scripted, offline (`AGENT_CONSOLE_MOCK=1` only) | none | all |

Credentials for non-Claude agents are read from env files, never from the Claude child's environment, so the subscription login cannot be swapped for metered billing:
`~/.config/agent-console/env`, then `~/openrouter/.env` (override the list with `AGENT_CONSOLE_ENV_FILES`, colon separated). `OPEN_ROUTER_TOKEN` is accepted as an alias of `OPENROUTER_API_KEY`.
With an OpenRouter key, Pi offers its `:free` OpenRouter models only (`AGENT_CONSOLE_PI_ALL=1` for everything, `AGENT_CONSOLE_PI_MODELS=a,b` to pin a list; both are read from the env file too, and the list loads once at server start).
OpenRouter's free tier allows 50 requests a day (1000 after a one-off $10 credit), so use the mock for routine tests.

**NVIDIA NIM (direct).** Pi has a built-in `nvidia` provider; no `models.json` and no custom provider needed.
1. Add `NVIDIA_API_KEY=...` to `~/.config/agent-console/env`.
2. Run `bin/agent-console restart-when-idle` (the model list loads only at server start).
3. In the New thread dialog pick Pi and a model whose subtitle starts with `nvidia ·` (id `nvidia/<vendor>/<model>`, e.g. `nvidia/nvidia/nemotron-3-super-120b-a12b`).

Direct or OpenRouter? Read the picker subtitle: `nvidia · nvidia` or `nvidia · moonshotai` is direct NIM; `openrouter · nvidia · free` is the same vendor via OpenRouter (id `openrouter/<vendor>/<model>:free`).
A key can list a model yet fail on use with 404 `Function ... Not found for account`; pick another model. The free tier allows about 1 request/s (~40/min).
Shared memory: every agent uses the same brain wiki (`~/repos/brain`, override with `AGENT_CONSOLE_BRAIN`). Claude reaches it through its user hooks; for Pi and Codex the
server injects the same context at start (`--append-system-prompt` / `-c developer_instructions=`), and after every turn it runs `brain commit`, so pages any agent writes land in the brain's git history.
Pi and Codex have no Stop hook, so the server applies the brain's own reminder rule: after `BRAIN_NUDGE_AFTER` (default 12) tool calls with no wiki write, a clean turn is followed by one automatic reminder turn (shown as a note, silenced by `BRAIN_NO_NUDGE=1`). Claude keeps using its hook.
Plan mode on Pi (read-only tools) can recall but not save. Codex's own `memories` feature is off by default; leave it off so there is one store.
Slash commands and skills are listed per agent. Codex was verified live (login, resume, shell tool). It needs the `codex-code-mode-host` helper beside the real binary (the standalone installer puts both in `~/.codex/packages/standalone/`). Its Plan and Accept-edits modes use a bubblewrap sandbox; where user namespaces are blocked (containers, this machine) the adapter detects it and offers Bypass only.

Adding an agent: implement `Provider` (`server/providers/types.ts`), emit canonical events through `ctx.event`, register it in `server/providers/index.ts`, add fixtures to `test/providers.ts`.

## Test
    node test/providers.ts   # offline: adapter translators (pi, codex), env files, model table. No network
    npm test                 # providers + end-to-end against the running server: auth gate, websocket checks, provider plumbing (mock agent if started with AGENT_CONSOLE_MOCK=1)
    REAL=1 npm test          # also one real Claude turn (uses a little subscription quota)
    npm run test:ui          # real Chromium (playwright): themes, viewports, fonts, menus incl. the agent picker, code blocks, contrast, slash menu, PWA installability. Needs a thread with tool cards and a Claude command cache (a live server has them)

To test on a scratch instance without touching your threads:
    BRAIN_NUDGE_AFTER=2 AGENT_CONSOLE_MOCK=1 AGENT_CONSOLE_DATA=/tmp/ac-test PORT=7071 node server/index.ts &   # then BASE=http://127.0.0.1:7071 AGENT_CONSOLE_DATA=/tmp/ac-test PORT=7071 npm test
Kill it by pid. `pkill -f "node server/index.ts"` also kills your real server.

## Layout
`server/` Node 24 (TypeScript via native type stripping, no build) · `public/` vanilla ES modules (`app.js`, `menu.js`, `render.js`), marked + DOMPurify + highlight.js · `bin/agent-console` process control
`server/providers/` one adapter per agent (`claude.ts`, `pi.ts`, `codex.ts`, `mock.ts`) behind `index.ts`; `server/threads.ts` is harness-agnostic.

Isolated checks: `node test/latency.ts`, `node test/history-wire.ts`, `npm run test:transport`, `npm run test:cache`, `npm run test:queue-ui` (mock agents; no model quota).

## Loading, steering, queue, context ring, subagents, compaction, dashboard

- Opening a thread shows a spinner and skeleton bars after 150 ms (never a flash), then the newest page of history; older pages load on scroll.
- Enter while an agent works **queues** the message above the composer; its **Steer** button (or Alt+Enter at send time) hands it to the running turn now (Claude stream-json, Pi `steer`, Codex `turn/steer`). Everything still queued goes out together as **one prompt** when the turn ends (a `/command` goes alone; `[Image #n]` tokens are renumbered). One action button: red Stop when a turn runs and the box is empty, otherwise Send. Tool labels send the model only a 100-character excerpt of each command.
- A ring beside Stop shows how full the context window is (amber, never red, as it fills).
- Subagents render as one card with their own nested activity, live stats and an "in background" chip.
- `/compact` is one progress card (spinner, then done/failed) instead of a message bubble; messages typed meanwhile queue.
- Effort menus: Claude offers Low, Medium, High, Extra high (`xhigh`), Max and Ultra (`ultracode`, Claude Code's multi-agent mode); the CLI itself downgrades levels a model does not support. Codex lists whatever the model advertises (includes Ultra).
- **Usage & savings** (`/dashboard`, link in the sidebar): Today / 7 / 30 / 90 days or a custom range, compared with the previous period. Turns, tokens, API-equivalent cost, tokens saved by RTK (`rtk gain`) and Headroom (proxy ledger), per-day charts, model/tool/thread breakdowns and a weekday-by-hour heatmap in local time.
  Turn history is `turns.jsonl` in the data dir (one row per finished turn; older turns are rebuilt once from the thread logs). Token and cost figures exist for Claude (and Codex when it reports usage); Pi reports neither.
  Headroom's "tool-schema deferral" is an estimate and is excluded from Tokens saved.

## Restarting after a turn

`bin/agent-console restart-when-idle` returns immediately and starts a detached watcher (`scripts/idle-restart.mjs`, log `~/.cache/agent-console/idle-restart.log`). It connects as an ordinary client, waits until no thread is running (plus 1.5 s of quiet, and until queues drain on servers that do not persist them), syntax-checks `server/`, runs `bin/agent-console stop`/`start`, and verifies the new server answers. It needs nothing from the running server, so it works on any version. Browsers reconnect and **reload themselves** (the `build` id in `hello` changed) unless the composer holds a draft, in which case a banner asks first. Agents should run it as the last step of a turn that touched `server/` or `public/`; never stop/start mid-turn. `bin/agent-console restart` is the immediate stop/start. `AGENT_CONSOLE_RUN` and `PORT` point it at a scratch instance.

## Lean context

Claude threads start with about 19k tokens of fixed context. Measured (haiku, trivial prompt): MCP servers ~3.5k, skills + slash-command lists ~6.6k, core prompt and tools ~8k. Threads now load only `codegraph` by default (`AGENT_CONSOLE_MCP=name,name`, or `all` for everything), cutting ~18%. Skills are the next biggest item; `--disable-slash-commands` would save ~6.6k but removes the `/` skill menu.

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
- Stop button, session history replay, subscription usage (5h / 7d) in the sidebar, mobile layout
- Composer is one rounded card: textarea over a toolbar with model and permission-mode menus (custom accessible menu buttons, keyboard + touch), Send/Stop.
  Bypass shows as a small amber chip, never red. Thread actions (Rename, Delete) live in the header overflow menu.
- Markdown with highlight.js syntax colours (bash, js/ts, json, python, css, html/xml, markdown, diff, yaml, sql, go, rust), code blocks with a
  language header, Copy and line-wrap toggle; Copy under every message; line-level +/- tints for Edit diffs. All output goes through DOMPurify.

## Type and assets (all self-hosted, no CDN, nothing leaves 127.0.0.1)
- **Inter** variable (UI, 15px/1.6 chat body) and **JetBrains Mono** variable (code, ligatures off): SIL Open Font License 1.1.
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
  here. Set `AGENT_CONSOLE_AUTH=password` to disable SSO, or `AGENT_CONSOLE_PUBLIC_HOST` to override the host.
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
| Codex | `codex exec --json`, one process per turn, resumed by thread id | `codex login --device-auth` | plan (read-only sandbox) / accept edits (workspace-write) / bypass; only bypass where the sandbox cannot run |
| Mock | scripted, offline (`AGENT_CONSOLE_MOCK=1` only) | none | all |

Credentials for non-Claude agents are read from env files, never from the Claude child's environment, so the subscription login cannot be swapped for metered billing:
`~/.config/agent-console/env`, then `~/openrouter/.env` (override the list with `AGENT_CONSOLE_ENV_FILES`, colon separated). `OPEN_ROUTER_TOKEN` is accepted as an alias of `OPENROUTER_API_KEY`.
With an OpenRouter key, Pi offers its `:free` models only (`AGENT_CONSOLE_PI_ALL=1` for everything, `AGENT_CONSOLE_PI_MODELS=a,b` to pin a list).
OpenRouter's free tier allows 50 requests a day (1000 after a one-off $10 credit), so use the mock for routine tests.
Shared memory: every agent uses the same brain wiki (`~/repos/brain`, override with `AGENT_CONSOLE_BRAIN`). Claude reaches it through its user hooks; for Pi and Codex the
server injects the same context at start (`--append-system-prompt` / `-c developer_instructions=`), and after every turn it runs `brain commit`, so pages any agent writes land in the brain's git history.
Plan mode on Pi (read-only tools) can recall but not save. Codex's own `memories` feature is off by default; leave it off so there is one store.
Slash commands and skills are listed per agent. Codex was verified live (login, resume, shell tool). It needs the `codex-code-mode-host` helper beside the real binary (the standalone installer puts both in `~/.codex/packages/standalone/`). Its Plan and Accept-edits modes use a bubblewrap sandbox; where user namespaces are blocked (containers, this machine) the adapter detects it and offers Bypass only.

Adding an agent: implement `Provider` (`server/providers/types.ts`), emit canonical events through `ctx.event`, register it in `server/providers/index.ts`, add fixtures to `test/providers.ts`.

## Test
    node test/providers.ts   # offline: adapter translators (pi, codex), env files, model table. No network
    npm test                 # providers + end-to-end against the running server: auth gate, websocket checks, provider plumbing (mock agent if started with AGENT_CONSOLE_MOCK=1)
    REAL=1 npm test          # also one real Claude turn (uses a little subscription quota)
    npm run test:ui          # real Chromium (playwright): themes, viewports, fonts, menus incl. the agent picker, code blocks, contrast, slash menu, PWA installability. Needs a thread with tool cards and a Claude command cache (a live server has them)

To test on a scratch instance without touching your threads:
    AGENT_CONSOLE_MOCK=1 AGENT_CONSOLE_DATA=/tmp/ac-test PORT=7071 node server/index.ts &   # then BASE=http://127.0.0.1:7071 AGENT_CONSOLE_DATA=/tmp/ac-test PORT=7071 npm test
Kill it by pid. `pkill -f "node server/index.ts"` also kills your real server.

## Layout
`server/` Node 24 (TypeScript via native type stripping, no build) · `public/` vanilla ES modules (`app.js`, `menu.js`, `render.js`), marked + DOMPurify + highlight.js · `bin/agent-console` process control
`server/providers/` one adapter per agent (`claude.ts`, `pi.ts`, `codex.ts`, `mock.ts`) behind `index.ts`; `server/threads.ts` is harness-agnostic.

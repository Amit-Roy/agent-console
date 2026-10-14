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
- Threads (each its own `claude` session, resumable), streaming output, markdown, tool cards with diffs
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

## Test
    npm run test:ui # real Chromium (playwright): dark/light, phone/desktop, fonts, no external requests, menus, code blocks + copy, contrast, touch targets, slash menu, PWA installability; spends no quota (creates then deletes one empty thread)
    npm test        # end-to-end: auth gate, websocket checks, a real agent turn (uses a little quota)

## Layout
`server/` Node 24 (TypeScript via native type stripping, no build) · `public/` vanilla ES modules (`app.js`, `menu.js`, `render.js`), marked + DOMPurify + highlight.js · `bin/agent-console` process control
Adding another agent (Codex, pi) means a new adapter beside `server/threads.ts`.

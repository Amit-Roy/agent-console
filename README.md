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
- Threads (each its own `claude` session, resumable), streaming output, markdown, tool cards with diffs
- Per-thread model and permission mode (plan / accept edits / bypass). Bypass is opt-in and confirmed.
- Stop button, session history replay, subscription usage (5h / 7d) in the sidebar, mobile layout

## Security model
- Binds to 127.0.0.1 only; reach it through Coder's authenticated port proxy.
- Password login → signed HttpOnly/Secure/SameSite=Strict cookie; failed-login limiter.
- WebSocket requires the cookie **and** a matching Origin header (blocks cross-site hijacking).
- Thread folders are restricted to your home directory.
- `ANTHROPIC_API_KEY` is stripped from the child environment so the subscription login is never swapped for metered billing.
- Bypass mode means a prompt can run any command as this user. Treat the password like a shell login.

## Test
    npm test        # end-to-end: auth gate, websocket checks, a real agent turn (uses a little quota)

## Layout
`server/` Node 24 (TypeScript via native type stripping, no build) · `public/` vanilla ES modules, marked + DOMPurify · `bin/agent-console` process control
Adding another agent (Codex, pi) means a new adapter beside `server/threads.ts`.

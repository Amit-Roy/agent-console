# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Primary user: the owner, a developer who runs coding agents all day from whatever device is at hand: an Android
phone (main device, dark mode), a laptop, or a Chromebook. The job is to start, steer and review agent work
(code changes, research, triage) without sitting at the machine that does the work.

Later audience (planned, not yet real): other developers who self-host their own instance once the project is
published as open source. Each person runs their own instance with their own agent logins.

## Product Purpose
One installable web app (PWA) that drives Claude Code, Codex and Pi on an always-on remote machine. Sign in from
any device, type a prompt, and the work runs and keeps running on the server, even when the device sleeps or
disconnects. Success: the owner reaches for this instead of the official Claude, Codex or Pi apps for real
development work, on every device.

## Positioning
The official apps are each locked to one agent and one device context. agent-console joins them: three agents,
one thread list, one file viewer, one usage view, reachable from phone, laptop or ChromeOS through a browser
login. The work runs on a managed remote VPS (SSD Nodes), so sessions survive device changes and the service
targets 99.9% uptime rather than depending on a laptop staying awake.

## Operating Context
- Mostly on a phone (Android, about 412 x 915 CSS px), often one-handed, often between other tasks.
- Long-running agent turns: the user leaves, comes back, and must see state, queue, cost and context at a glance.
- Threads map to repos under `~/repos`; output is code commits, files, research notes and GitHub triage labels.
- Remote Linux host behind Caddy + DuckDNS + Coder; WebSocket streaming; resumable sessions across restarts.

## Capabilities and Constraints
- Providers: Claude Code (headless CLI stream-json), Codex (app-server), Pi (RPC; any model Pi knows, including
  free OpenRouter and NVIDIA NIM models).
- Per-thread model, effort and permission mode (plan, accept edits, bypass; bypass is opt-in and confirmed).
  These settings must stay visible on mobile during a run.
- Message queue with steer and edit, `/` commands and skills, inline agent questions, compaction, file viewer
  with Acode editing, usage/quota tabs per provider, run details with turn telemetry, push notifications.
- Planned: scheduled tasks (GitHub issue #3) with a run history and forkable runs.
- Licensing constraint: an instance never offers its agent logins to anyone else. Anthropic's terms restrict
  third-party products that share claude.ai login, so open-sourcing means each user brings their own logins.
- Open-source license, packaging and onboarding for other users: undecided.

## Brand Commitments
- The hand-made icon pack (inline SVG sprite in `public/index.html`) is binding. The owner values that it does
  not look AI-generated. Extend it in the same style; never swap it for a stock icon library.

## Evidence on Hand
- The running instance and its real usage data (threads, quotas, telemetry) belong to the owner; never fabricate
  users, testimonials, benchmarks or uptime figures beyond the stated 99.9% target.
- Docs: `README.md`, `docs/`.

## Product Principles
1. Any device, same power: nothing important is desktop-only; phone is the reference device.
2. The server keeps working: design for leaving and returning, with state readable at a glance.
3. One console, many agents: providers differ underneath, the experience stays consistent.
4. Show the truth: real status, cost, quota and context; unknown stays unknown, never guessed.
5. Personal first, shareable later: no feature should require a multi-user service to make sense.

## Accessibility & Inclusion
- Touch targets at least 44 px on coarse pointers; usable one-handed on a phone.
- Light and dark themes both supported; dark is the main one.

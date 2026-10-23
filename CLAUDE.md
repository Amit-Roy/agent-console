# agent-console

Vanilla-JS PWA + Node 24 server (no build). Drives Claude Code / Pi / Codex. Read README.md sections on demand. Brain recall = `brain/wiki/index.md`; open referenced pages on demand.

## Rules
- Obey ../CLAUDE.md (you = orchestrator). Subagents for noisy work: logs, long tests, screenshot loops, research. Brief precisely; ask short conclusion (files, cause, evidence).
- Deploy last in turn: `bin/agent-console restart-when-idle`. Never stop/start mid-turn.
- Tests: `AGENT_CONSOLE_PAGE=12 npm test`. UI suites: fresh seeded scratch copy of data dir (keep `uploads/`), `AGENT_CONSOLE_MOCK=1`, ports 7071-7075. Start scratch servers with dedicated `AGENT_CONSOLE_DATA` + `AGENT_CONSOLE_RUN`, then kill by PID only; never `pkill -f` because it can stop the real server too.
- CI test budget: 10 s per file, 25 s for the pool (`scripts/ci-resources.mjs budget`). New UI cases go into an existing UI file, not a new one with its own server and browser. No fixed sleeps.
- Pi/Codex children: `childEnv()`. Claude: Headroom via `ANTHROPIC_BASE_URL` only. Never print tokens.
- Reply style preamble: `brain/config/style-preamble.md`, injected by `server/providers/brain.ts`.

## Rich chat output
Markdown renders inline. Phone: few, small media.
- Image `![alt](/abs/path.png)`; video `![alt](/abs/path.mp4)` (mp4/webm/mov/m4v). Abs, `~/`, relative, `file://`, http(s) ok. Space = `%20`. Outside `~` and `/tmp` or secret files refused.
- Chart: fenced `chart` block, strict JSON Chart.js (`type`, `data`, opt `options`; no functions). Small data.
- Table: GFM.
- Links: bare URL or markdown. Abs path in backticks opens file viewer.

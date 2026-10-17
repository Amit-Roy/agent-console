# agent-console

Vanilla-JS PWA + Node 24 server (no build step) driving Claude Code / Pi / Codex. Read relevant README.md sections as needed. Brain recall starts with `brain/wiki/index.md`; open only relevant referenced pages on demand.

## Working rules
- Follow the workspace rules in ../CLAUDE.md (you are the orchestrator). **Use subagents for noisy work**: log/transcript digging, test-suite runs with long output, screenshot review loops, broad research, multi-file investigations. Give each one a precise question and ask for a short conclusion (files, root cause, evidence), not raw output. Keep the main context for decisions and edits.
- Run the final deploy as the last step of a turn: `bin/agent-console restart-when-idle` (never stop/start mid-turn).
- Tests: `AGENT_CONSOLE_PAGE=12 npm test`; UI suites need a fresh seeded scratch copy of the data dir (keep `uploads/`), `AGENT_CONSOLE_MOCK=1`, ports 7071-7075, kill scratch servers by pid (never `pkill -f`).
- Pi/Codex children get `childEnv()`; Claude gets Headroom via `ANTHROPIC_BASE_URL` only. Never print tokens.

## Rich output in agent-console chat
Replies render markdown inline; use it when it helps the user (phone, so keep media small and few).
- Image: `![alt](/abs/path.png)`; video: `![alt](/abs/path.mp4)` (mp4/webm/mov/m4v). Absolute, `~/`, relative or `file://` paths work; URL-encode spaces as `%20`. Remote http(s) URLs work too. Files outside `~/repos` or secret files are refused.
- Chart: fenced block with language `chart` holding strict JSON Chart.js config (`type`, `data`, optional `options`; no functions). Keep data small.
- Table: normal GFM table (scrolls horizontally on mobile).
- Links: write bare URLs or markdown links; absolute file paths in backticks open the file viewer. Prefer these over printing raw paths.

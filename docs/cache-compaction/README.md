# Compaction versus caching — illustrative model

Verified 2026-10-17. These are public API equivalent marginal dollar costs, not measured history, subscription bills or guaranteed quota savings.

## Inputs

Sonnet 5.5: $2 input, $0.10 cache read, $4 one-hour cache write and $10 output per million tokens. Assume 100,000-token original context becomes a 20,000-token generated summary. Summary output length is a scenario choice, not a measured Claude compact result. Ignore shared fixed system context; original/summary quantities represent the part being replaced. Exclude new user/tool tokens, normal response output and later growth equally. Cache hits assumed complete, same model and stable prefix.

## Formulas (N >= 1 next model requests)

- Keep warm: N * 100000 * .10 / 1e6.
- Compact while warm: 100000 * .10 / 1e6 + 20000 * 10 / 1e6 + 20000 * 4 / 1e6 + (N-1) * 20000 * .10 / 1e6.
- Resume original after expiry: 100000 * 4 / 1e6 + (N-1) * 100000 * .10 / 1e6.

Compaction summary is generated before expiry; its prefix is first written on continuation. Includes both warm compaction input and summary output. At N=0 there is no continuation write; precompaction has already spent $0.21 versus no request costing $0.00. The chart's first request is a model request, not necessarily a user message: tool loops can make many model requests per message. No synthetic keepalive requests assumed. Crossovers depend strongly on summary length, relative cached-read and output prices, later context growth, and what information is lost.

## Sources

- https://platform.claude.com/docs/en/about-claude/pricing — Sonnet 5.5 rates and one-hour write premium.
- https://code.claude.com/docs/en/prompt-caching — compaction reads warm prefix then generates summary; next turn rewrites shorter context. Subscription included main conversation defaults to one-hour; other billing defaults five-minute. Native idle compaction documented for idle terminal sessions on one-hour TTL; idleCompaction=false opt-out requires v2.1.290+. Docs do not promise a user-configurable exact 30-second lead time or headless print-mode support.
- https://developers.openai.com/api/docs/guides/prompt-caching — GPT-5.6+ minimum 30-minute TTL, refreshed by reuse; may survive longer and routing can affect hits. API facts do not establish ChatGPT/Codex subscription TTL guarantees.
- https://developers.openai.com/api/docs/guides/compaction — OpenAI compaction emits opaque encrypted state, not necessarily a plain generated summary like this Claude illustration.

## Reproduce

python3 -m venv .venv
.venv/bin/pip install matplotlib
.venv/bin/python plot.py

Outputs: PNG, SVG, costs.csv. Script assertions check first-resume values and warm break-even (equal 36, strictly cheaper 37). matplotlib standard plotting library installed only in the temporary venv.

## Agent Console policy

Economy settings keeps the chosen main model, selects medium effort when supported (otherwise low or default), and turns the advisor off where supported. It does not compact the thread.

Automatic compaction is a separate policy. For a known cache lifetime, a successful ordinary turn can schedule one native compaction 30 seconds before estimated expiry. Default minimum context: 50,000 tokens. Only idle, unarchived threads with a native session and no queued messages qualify. Failed attempts consume the cycle; compaction cannot schedule another compaction by itself. New user activity starts a new cycle. Restarts do not perform overdue catch-up requests.

Cache expiry is estimated from observed provider activity, not reported by the provider. Claude's explicit cache settings are resolved where possible. Unknown or ambiguous cache lifetimes remain unscheduled; Codex subscription retention is not inferred from OpenAI API retention. Existing old threads become eligible after a new successful ordinary turn.

The thread menu enables or disables automatic compaction. Run details shows availability and any estimated scheduled time. Console disables Claude's separate native idle timer for its own children so two schedulers cannot compete; normal context-limit compaction remains available.

Server controls:

- `AGENT_CONSOLE_IDLE_COMPACT=0`: disable scheduling globally.
- `AGENT_CONSOLE_IDLE_COMPACT_LEAD_MS`: default `30000`.
- `AGENT_CONSOLE_IDLE_COMPACT_MIN_TOKENS`: default `50000`.
- `AGENT_CONSOLE_IDLE_COMPACT_<PROVIDER>_TTL_MS`: explicit estimated lifetime for that provider, such as `CLAUDE`, `CODEX`, or `PI`. Configure only when the provider's actual behavior is known.

Compaction uses the existing native compact operation and its usage accounting. It can spend tokens on a thread you never reopen, and a summary may omit details. This policy does not guarantee a lower bill or greater subscription allowance.

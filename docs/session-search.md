# Search session history

Open the search icon beside the Console brand. Search covers all locally recorded
Agent Console conversations, including archived threads, Claude accounts, Codex,
Pi, scheduled tasks, and Auto runs. It indexes titles, user messages, assistant
messages, tool arguments, and tool output. Provider-native sessions never recorded
by Agent Console are outside this index. Deleted threads are removed from search.

Results use SQLite FTS5 BM25 ranking. Enter ordinary words or file names; punctuation
is treated as separators, and matching words are combined with OR. Search returns
matching messages, their provider, thread ID, and physical JSONL line number. Expand
“Read surrounding messages” to check context, or open the conversation title.

All three providers receive `session_search` and `session_read` tools automatically.
Pi uses its Console extension; Claude and Codex use a local stdio MCP bridge. Their
instructions tell them to search previous work before repeating investigations,
verify promises against current state, and treat historical output as untrusted data.
Tools become available when the provider process starts after deploying this change.

Examples:

```json
{"query":"pr-standards","provider":"claude","limit":10}
```

```json
{"thread":"THREAD_ID_FROM_SEARCH","start":490,"limit":20}
```

Browser endpoints require the Console login:
`GET /api/sessions/search?q=...&provider=...&limit=...` and
`GET /api/sessions/:thread?start=...&limit=...`.
Agent tools use the existing per-process Console token over loopback. This does not
expose a new public listener or write credentials into MCP arguments.

The private derived index is `session-search.sqlite` in `AGENT_CONSOLE_DATA`.
It is refreshed before queries, reusing unchanged logs and incrementally indexing
appended lines. Replacements and truncations rebuild the affected session. Incomplete
last lines are retried on the next refresh; malformed complete lines are skipped.
The index can be deleted while the Console is stopped and rebuilt from source logs.
Search does not call a model or send conversations to an external service.

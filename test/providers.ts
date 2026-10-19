// Offline unit checks for the provider adapters: recorded/documented harness events in, canonical events out. No network, no quota.
import { brainContext } from "../server/providers/brain.ts";
import { codexTranslator, unwrapShell } from "../server/providers/codex.ts";
import { parseEnv } from "../server/providers/env.ts";
import { replayPreamble, threadToMarkdown, turnsOf } from "../server/export.ts";
import { excerpt, needsLabel, parseLabels, mcpName, mcpSketch } from "../server/providers/label.ts";
import { claudeAdvisorArgs, claudeConsoleSettingsArgs, claudeRoutingEnv, leanMcpArgs } from "../server/providers/claude.ts";
import { cleanTitle, titleText, titleInput } from "../server/providers/title.ts";
import { normTool, parsePiModels, piTranslator } from "../server/providers/pi.ts";

let failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${ok ? "" : extra}`);
  if (!ok) failed++;
};
const run = (make: (emit: (e: any) => void) => (r: any) => void, records: any[]) => {
  const out: any[] = [];
  const feed = make((e) => out.push(e));
  for (const r of records) feed(r);
  return out;
};
const types = (out: any[]) => out.map((e) => e.type + (e.subtype ? "/" + e.subtype : ""));

check("advisor: default inherits settings", claudeAdvisorArgs().length === 0 && claudeAdvisorArgs("default").length === 0);
check("advisor: off disables settings advisor", JSON.parse(claudeAdvisorArgs("off")[1]).advisorModel === "");
check("advisor: explicit selection preserved", claudeAdvisorArgs("opus").join(" ") === "--advisor opus");
check("idle compaction: console owns idle timer without disabling context-limit compaction", JSON.stringify(JSON.parse(claudeConsoleSettingsArgs()[1])) === JSON.stringify({ idleCompaction: false }));
check("idle compaction: advisor off survives settings merge", JSON.parse(claudeConsoleSettingsArgs("off")[1]).advisorModel === "" && JSON.parse(claudeConsoleSettingsArgs("off")[1]).idleCompaction === false);
check("idle compaction: explicit advisor preserved", claudeConsoleSettingsArgs("opus").slice(2).join(" ") === "--advisor opus");
const inheritedProxy = { ANTHROPIC_BASE_URL: "http://127.0.0.1:8790/" };
check("proxy: disabled local proxy cannot survive through inherited environment", claudeRoutingEnv(inheritedProxy).ANTHROPIC_BASE_URL === undefined && inheritedProxy.ANTHROPIC_BASE_URL.endsWith("8790/"));
check("proxy: explicit external provider endpoint preserved", claudeRoutingEnv({ ANTHROPIC_BASE_URL: "https://provider.example" }).ANTHROPIC_BASE_URL === "https://provider.example");

// ---- env files
const env = parseEnv(`# comment\nOPEN_ROUTER_TOKEN=sk-or-v1-abc\nexport FOO="bar baz"\nBAD LINE\nQ='x'\n`);
check("env: alias OPEN_ROUTER_TOKEN -> OPENROUTER_API_KEY", env.OPENROUTER_API_KEY === "sk-or-v1-abc" && !("OPEN_ROUTER_TOKEN" in env));
check("env: quotes + export handled", env.FOO === "bar baz" && env.Q === "x");

// ---- thread titles
check("title: plain title passes through", cleanTitle("Fix flaky login test") === "Fix flaky login test");
check("title: quotes, markdown and trailing punctuation stripped", cleanTitle('**"Image paste support".**') === "Image paste support");
check("title: 'Title:' prefix and extra lines dropped", cleanTitle("Title: Dark mode toggle\n\nThis title captures...") === "Dark mode toggle");
check("title: long titles are cut to 5 words", cleanTitle("one two three four five six seven eight") === "one two three four five");
check("title: capped at 30 chars on a word boundary", cleanTitle("Refresh thread names every prompt") === "Refresh thread names every" && cleanTitle("Refresh thread names every prompt").length <= 30);
check("title: a whole sentence is not a title", cleanTitle("I'm sorry, but I cannot determine a title for this particular message because it is empty.") === undefined);
check("title: empty / junk is rejected", cleanTitle("") === undefined && cleanTitle(undefined) === undefined && cleanTitle('""') === undefined);
check("title input: media references dropped", titleText("look ![a](/x/y.png) at [Image #2] this data:image/png;base64,AAAA bug") === "look at this bug");
check("title input: a long message is kept whole", titleText("x".repeat(500)).length === 500);
check("title input: every non-empty message, oldest first", titleInput(["a", "b", "![i](x)", "c"]).join("|") === "a|b|c");
check("title input: newest messages fill the budget", titleInput(["old".repeat(100), "n".repeat(300), "m".repeat(300)], 700).join("|").startsWith("old") === false && titleInput(["old".repeat(100), "n".repeat(300), "m".repeat(300)], 700).length === 2);
check("title input: overflow message is cut, not dropped", titleInput(["a".repeat(900), "b".repeat(300)], 700).map(m => m.length).join() === "400,300");
check("title input: tiny remainder is not worth a fragment", titleInput(["a".repeat(900), "b".repeat(300)], 400).map(m => m.length).join() === "300");
check("title input: 100000 chars by default", titleInput(["x".repeat(60_000), "y".repeat(60_000)]).reduce((n, m) => n + m.length, 0) === 100_000);

// ---- tool labels
check("labels: only a 100-char excerpt of a command is sent, with dots", excerpt("x".repeat(500)) === "x".repeat(100) + "..." && excerpt("ls  -la\n/tmp") === "ls -la /tmp");
process.env.AGENT_CONSOLE_MCP = "nonexistent";
check("lean context: only named MCP servers load (strict), none when unknown", leanMcpArgs()[0] === "--strict-mcp-config" && JSON.parse(leanMcpArgs()[2]).mcpServers && Object.keys(JSON.parse(leanMcpArgs()[2]).mcpServers).length === 0);
process.env.AGENT_CONSOLE_MCP = "all";
check("lean context: AGENT_CONSOLE_MCP=all restores every server", leanMcpArgs().length === 0);
delete process.env.AGENT_CONSOLE_MCP;
check("labels: parses a clean JSON array", JSON.stringify(parseLabels('["Running the tests", "Listing files."]', 2)) === JSON.stringify(["Running the tests", "Listing files"]));
check("labels: tolerates a code fence around the array", parseLabels('```json\n["Checking git status"]\n```', 1)?.[0] === "Checking git status");
check("labels: wrong length is rejected", parseLabels('["a", "b"]', 3) === undefined);
check("labels: prose / empty entries are rejected", parseLabels("Sure! Here you go", 1) === undefined && parseLabels('["ok", ""]', 2) === undefined && parseLabels("[1,", 1) === undefined);
check("labels: MCP calls without a description need one, with a readable sketch", needsLabel("mcp__codegraph__codegraph_explore", { query: "x" }) && !needsLabel("mcp__a__b", { description: "d" }) && mcpName("mcp__codegraph__explore") === "codegraph/explore" && mcpSketch("mcp__a__b", { query: "find me" }) === "a/b: find me");
check("labels: only description-less Bash needs one", needsLabel("Bash", { command: "ls" }) && !needsLabel("Bash", { command: "ls", description: "Lists files" }) && !needsLabel("Read", { file_path: "/a" }) && !needsLabel("Bash", { command: "  " }));

// ---- export / fork replay
const log = [
  { type: "user_input", text: "plan the trip", attachments: [{ name: "map.png" }] },
  { type: "user_input", text: "[brain] save notes", auto: "brain" },
  { type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Sure, where to?" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -la /tmp" } }] } },
  { type: "tool_label", tool_use_id: "t1", label: "Listing the temp folder" },
  { type: "console_error", text: "boom" },
  { type: "user_input", text: "Lisbon" },
  { type: "assistant", message: { content: [{ type: "text", text: "Great choice." }] } },
];
const turns = turnsOf(log);
check("export: nudges and thinking are left out, attachments named", turns.map((t) => t.role).join() === "user,agent,agent,agent,user,agent" && turns[0].text === "plan the trip\n(attached: map.png)");
check("export: a tool line prefers the Haiku label over the raw command", turns[2].tool === true && turns[2].text === "Bash: Listing the temp folder");
const md = threadToMarkdown({ title: "Trip", provider: "mock", model: "echo", cwd: "/x", createdAt: 0 }, "Mock", log);
check("export: markdown groups speakers and quotes tool activity", md.startsWith("# Trip\n") && md.includes("## You\n\nplan the trip") && md.includes("> Bash: Listing the temp folder") && (md.match(/## Agent/g) ?? []).length === 2 && (md.match(/## You/g) ?? []).length === 2);
const pre = replayPreamble(log);
check("replay: transcript has what was said, not tools", pre.includes("User: plan the trip") && pre.includes("Assistant: Sure, where to?") && !pre.includes("Bash") && pre.includes("forked from an earlier one"));
check("replay: long conversations keep the newest part", replayPreamble(Array.from({ length: 400 }, (_, i) => ({ type: "user_input", text: `message number ${i} `.repeat(20) })), 3000).includes("message number 399") && !replayPreamble(Array.from({ length: 400 }, (_, i) => ({ type: "user_input", text: `message number ${i} `.repeat(20) })), 3000).includes("message number 0 "));

// ---- pi model table
const table = `provider    model                                               context  max-out  thinking  images
openrouter  nvidia/nemotron-3-super-120b-a12b                   262.1K   235.9K   yes       no
openrouter  nvidia/nemotron-3-super-120b-a12b:free              262.1K   235.9K   yes       no
nvidia      stepfun-ai/step-5-preview                            1.0M     131.1K   yes       yes
nvidia      nvidia/nemotron-3-super-120b-a12b                    262.1K   262.1K   yes       no
nvidia      meta/llama-3.2-11b-vision-instruct                   128K     4.1K     no        yes
nvidia      nvidia/nemotron-3.5-super-vl-120b-a12b                262.1K   131.1K   yes       yes
nvidia      openai/gpt-oss-20b                                    131.1K   32.8K    yes       no
nvidia      google/gemma-3-12b-it                                 131.1K   16.4K    no        yes
openai      gpt-4o                                              128K     16K      no        yes`;
const freeDefault = ["openrouter/nvidia/nemotron-3-super-120b-a12b:free", "nvidia/stepfun-ai/step-5-preview", "nvidia/nvidia/nemotron-3-super-120b-a12b", "nvidia/meta/llama-3.2-11b-vision-instruct", "nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b", "nvidia/openai/gpt-oss-20b", "openai/gpt-4o"];
check("pi models: free OpenRouter and working NVIDIA models included by default", JSON.stringify(parsePiModels(table)) === JSON.stringify(freeDefault));
check("pi models: unavailable NVIDIA model excluded", !parsePiModels(table).includes("nvidia/google/gemma-3-12b-it"));
check("pi models: all=true keeps paid", parsePiModels(table, true).length === 9);
check("pi models: 'No models available' message yields none", parsePiModels("No models available. Use /login\n  /home/x/docs/providers.md\n").length === 0);

// ---- pi tool normalisation
check("pi tool: bash -> Bash{command}", normTool("bash", { command: "ls" }).name === "Bash");
check("pi tool: read path -> file_path", normTool("read", { path: "/a" }).input.file_path === "/a");
const e1 = normTool("edit", { path: "/a", edits: [{ oldText: "x", newText: "y" }] });
check("pi tool: edit gets old_string/new_string for the diff card", e1.input.old_string === "x" && e1.input.new_string === "y");

// ---- pi session: text turn with a tool call
const toolTurn = [
  { type: "session", id: "s" },
  { type: "agent_start" },
  { type: "turn_start" },
  { type: "message_start", message: { role: "user", content: "hi" } },
  { type: "message_end", message: { role: "user", content: "hi" } },
  { type: "message_start", message: { role: "assistant", content: [] } },
  { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hmm" } },
  { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Listing" } },
  {
    type: "message_end",
    message: {
      role: "assistant", stopReason: "toolUse", usage: { cost: { total: 0.002 } },
      content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Listing" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }],
    },
  },
  { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } },
  { type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "a.txt" }] }, isError: false },
  { type: "turn_end" },
  { type: "message_start", message: { role: "assistant", content: [] } },
  { type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { cost: { total: 0.001 } }, content: [{ type: "text", text: "Done." }] } },
  { type: "agent_end", messages: [], willRetry: false },
  { type: "agent_settled", aborted: false },
];
const o1 = run((emit) => piTranslator(emit), toolTurn);
check("pi: streams deltas then final blocks", types(o1).join() === "stream_event,stream_event,stream_event,assistant,user,stream_event,assistant,result/success", types(o1).join());
const asst = o1.find((e) => e.type === "assistant");
check("pi: assistant has thinking, text, tool_use(Bash)", asst.message.content.map((b: any) => b.type + (b.name ? ":" + b.name : "")).join() === "thinking,text,tool_use:Bash");
const tr = o1.find((e) => e.type === "user").message.content[0];
check("pi: tool_result links to the tool_use id", tr.tool_use_id === "c1" && tr.content === "a.txt" && tr.is_error === false);
const res = o1.at(-1);
check("pi: result sums cost and succeeds", res.subtype === "success" && Math.abs(res.total_cost_usd - 0.003) < 1e-9);

// ---- pi failure captured live from OpenRouter (free-models-per-day 429), three retries then give up
const rl = `429: {"message":"Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day","code":429}`;
const o2 = run((emit) => piTranslator(emit), [
  { type: "agent_start" },
  { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: rl, content: [], usage: {} } },
  { type: "auto_retry_end", success: false, attempt: 3, finalError: rl },
  { type: "agent_settled", aborted: false },
]);
check("pi: rate-limit becomes a readable error + failed result", o2.some((e) => e.type === "console_error" && e.text.startsWith("Rate limit exceeded: free-models-per-day")) && o2.at(-1).is_error === true, JSON.stringify(o2));
check("pi: error text is not raw JSON", !o2.find((e) => e.type === "console_error").text.includes("{"));
// captured from a scheduled NVIDIA run: a 500 mid-turn, pi retried, the turn then finished normally
const nv = `500: {"message":"Failed to generate completions","type":"Internal Server Error","code":500}`;
const o2b = run((emit) => piTranslator(emit), [
  { type: "agent_start" },
  { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: nv, content: [], usage: {} } },
  { type: "auto_retry_start", attempt: 1, errorMessage: nv, delayMs: 2000 },
  { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Report done." }], usage: {} } },
  { type: "agent_settled", aborted: false },
]);
check("pi: a retried provider error does not fail the finished turn", o2b.at(-1).subtype === "success" && !o2b.some((e) => e.type === "console_error"), JSON.stringify(o2b));
const o3 = run((emit) => piTranslator(emit), [{ type: "response", command: "prompt", success: false, error: "No model selected" }]);
check("pi: rejected prompt unlocks the thread (result emitted)", o3.at(-1)?.type === "result" && o3.at(-1).is_error);
const o4 = run((emit) => piTranslator(emit), [{ type: "agent_start" }, { type: "agent_settled", aborted: true }]);
check("pi: aborted settle is flagged", o4.at(-1).subtype === "error_during_execution");
let cmds: any[] = [];
run((emit) => piTranslator(emit, (l) => (cmds = l)), [{ type: "response", command: "get_commands", success: true, data: { commands: [{ name: "skill:x", description: "d", source: "skill" }, { name: "a" }] } }]);
check("pi: get_commands -> sorted slash commands", cmds.map((c) => c.name).join() === "a,skill:x");

// ---- codex exec --json
const o5 = run((emit) => codexTranslator(emit), [
  { type: "thread.started", thread_id: "T1" },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "i0", type: "reasoning", text: "plan" } },
  { type: "item.started", item: { id: "i1", type: "command_execution", command: "ls", aggregated_output: "", exit_code: null, status: "in_progress" } },
  { type: "item.completed", item: { id: "i1", type: "command_execution", command: "ls", aggregated_output: "a\nb", exit_code: 0, status: "completed" } },
  { type: "item.completed", item: { id: "i2", type: "file_change", changes: [{ path: "/x.ts", kind: "update" }], status: "completed" } },
  { type: "item.completed", item: { id: "i3", type: "agent_message", text: "All done" } },
  { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } },
]);
check("codex: thread id becomes session id", o5[0].subtype === "init" && o5[0].session_id === "T1");
check("codex: command started once, result linked", o5.filter((e) => e.type === "assistant" && e.message.content[0].name === "Bash").length === 1 && o5.some((e) => e.type === "user" && e.message.content[0].tool_use_id === "i1" && e.message.content[0].content === "a\nb"));
check("codex: ends with success result", o5.at(-1).type === "result" && o5.at(-1).subtype === "success");
const o6 = run((emit) => codexTranslator(emit), [{ type: "turn.started" }, { type: "item.completed", item: { id: "c", type: "command_execution", command: "false", aggregated_output: "", exit_code: 1, status: "failed" } }, { type: "turn.failed", error: { message: "boom" } }]);
check("codex: failed command flagged, turn.failed -> error result", o6.find((e) => e.type === "user").message.content[0].is_error === true && o6.some((e) => e.type === "console_error" && e.text === "boom") && o6.at(-1).is_error);

// captured from a live `codex exec --json` run (0.162.1): config warning, then a real error, then the turn
const o7 = run((emit) => codexTranslator(emit), [
  { type: "thread.started", thread_id: "T2" },
  { type: "item.completed", item: { id: "item_0", type: "error", message: "Codex is ignoring 1 unrecognized configuration setting. Check for typos or deprecated settings.\n  user (/home/coder/.codex/config.toml): `preferred_auth_method` is ignored." } },
  { type: "item.completed", item: { id: "item_2", type: "error", message: "Code Mode is unavailable because failed to spawn code-mode host" } },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "item_3", type: "agent_message", text: "DONE" } },
  { type: "turn.completed", usage: { input_tokens: 28584, output_tokens: 68 } },
]);
check("codex: config-file warnings are hidden, real errors kept", o7.filter((e) => e.type === "console_error").length === 1 && o7.find((e) => e.type === "console_error").text.startsWith("Code Mode"));
check("codex: live-captured turn ends with success", o7.at(-1).subtype === "success" && o7.some((e) => e.type === "assistant" && e.message.content[0].text === "DONE"));

check("codex: shell wrapper stripped from the displayed command", unwrapShell("/usr/bin/zsh -lc 'echo hi > a.txt && cat a.txt'") === "echo hi > a.txt && cat a.txt");
check("codex: plain commands untouched", unwrapShell("ls -la") === "ls -la");
check("codex: escaped single quotes restored", unwrapShell("/bin/bash -lc 'echo '\\''q'\\'''") === "echo 'q'", unwrapShell("/bin/bash -lc 'echo '\\''q'\\'''"));

// ---- shared brain: context handed to pi/codex at start
const ctx = await brainContext();
check("brain: context has the protocol and index (or brain is absent)", ctx === "" || (ctx.includes("# Brain index") && ctx.includes("Automatic context loads only this index.")));
check("brain: full index retained without arbitrary truncation", ctx === "" || ctx.includes("wiki/agent-console-context.md"));

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);

// Offline unit checks for the provider adapters: recorded/documented harness events in, canonical events out. No network, no quota.
import { brainContext } from "../server/providers/brain.ts";
import { createNudger } from "../server/providers/nudge.ts";
import { codexTranslator, unwrapShell } from "../server/providers/codex.ts";
import { parseEnv } from "../server/providers/env.ts";
import { replayPreamble, threadToMarkdown, turnsOf } from "../server/export.ts";
import { needsLabel, parseLabels } from "../server/providers/label.ts";
import { cleanTitle } from "../server/providers/title.ts";
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

// ---- env files
const env = parseEnv(`# comment\nOPEN_ROUTER_TOKEN=sk-or-v1-abc\nexport FOO="bar baz"\nBAD LINE\nQ='x'\n`);
check("env: alias OPEN_ROUTER_TOKEN -> OPENROUTER_API_KEY", env.OPENROUTER_API_KEY === "sk-or-v1-abc" && !("OPEN_ROUTER_TOKEN" in env));
check("env: quotes + export handled", env.FOO === "bar baz" && env.Q === "x");

// ---- thread titles
check("title: plain title passes through", cleanTitle("Fix flaky login test") === "Fix flaky login test");
check("title: quotes, markdown and trailing punctuation stripped", cleanTitle('**"Image paste support".**') === "Image paste support");
check("title: 'Title:' prefix and extra lines dropped", cleanTitle("Title: Dark mode toggle\n\nThis title captures...") === "Dark mode toggle");
check("title: long titles are cut to 6 words", cleanTitle("one two three four five six seven eight") === "one two three four five six");
check("title: a whole sentence is not a title", cleanTitle("I'm sorry, but I cannot determine a title for this particular message because it is empty.") === undefined);
check("title: empty / junk is rejected", cleanTitle("") === undefined && cleanTitle(undefined) === undefined && cleanTitle('""') === undefined);

// ---- tool labels
check("labels: parses a clean JSON array", JSON.stringify(parseLabels('["Running the tests", "Listing files."]', 2)) === JSON.stringify(["Running the tests", "Listing files"]));
check("labels: tolerates a code fence around the array", parseLabels('```json\n["Checking git status"]\n```', 1)?.[0] === "Checking git status");
check("labels: wrong length is rejected", parseLabels('["a", "b"]', 3) === undefined);
check("labels: prose / empty entries are rejected", parseLabels("Sure! Here you go", 1) === undefined && parseLabels('["ok", ""]', 2) === undefined && parseLabels("[1,", 1) === undefined);
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
openai      gpt-4o                                              128K     16K      no        yes`;
check("pi models: openrouter limited to :free by default", JSON.stringify(parsePiModels(table)) === JSON.stringify(["openrouter/nvidia/nemotron-3-super-120b-a12b:free", "openai/gpt-4o"]));
check("pi models: all=true keeps paid", parsePiModels(table, true).length === 3);
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
const ctx = brainContext();
check("brain: context has the protocol and index (or brain is absent)", ctx === "" || (ctx.includes("Shared memory for ALL agents") && ctx.includes("wiki/index.md")));
check("brain: context fits Codex's 1000-token additionalContext-style budget", ctx.length < 4000, `${ctx.length} chars`);

// ---- brain nudge (same rule as the Claude Stop hook)
process.env.BRAIN_NUDGE_AFTER = "3";
delete process.env.BRAIN_NO_NUDGE;
const tool = (command: string, extra: any = {}) => ({ type: "assistant", message: { content: [{ type: "tool_use", id: "x", name: "Bash", input: { command, ...extra } }] } });
const n1 = createNudger();
n1.observe(tool("ls")); n1.observe(tool("ls"));
check("nudge: quiet below the threshold", n1.check() === undefined);
n1.observe(tool("ls"));
const msg = n1.check();
check("nudge: fires at the threshold with the brain wording", !!msg && msg.startsWith("[brain] 3 tool calls") && msg.includes("brain: nothing to save"), String(msg));
check("nudge: fires once, then resets", n1.check() === undefined);
n1.observe(tool("ls")); n1.observe(tool("ls"));
check("nudge: counts from the reminder, not from zero", n1.check() === undefined);
const n2 = createNudger();
n2.observe(tool("ls")); n2.observe(tool("cat /home/coder/repos/brain/wiki/x.md")); n2.observe(tool("ls"));
check("nudge: a wiki write resets the count", n2.check() === undefined);
const n3 = createNudger();
n3.observe(tool("ls")); n3.observe(tool("ls")); n3.observe({ type: "assistant", message: { content: [{ type: "tool_use", id: "y", name: "Write", input: { file_path: "/home/coder/repos/brain/wiki/p.md" } }] } }); n3.observe(tool("ls"));
check("nudge: Write into wiki/ counts as a save", n3.check() === undefined);
const n4 = createNudger();
["ls", "ls", "ls"].forEach((c) => n4.observe(tool(c)));
process.env.BRAIN_NO_NUDGE = "1";
check("nudge: BRAIN_NO_NUDGE silences it", n4.check() === undefined);
delete process.env.BRAIN_NO_NUDGE;

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);

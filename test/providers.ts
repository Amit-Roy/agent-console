// Offline unit checks for the provider adapters: recorded/documented harness events in, canonical events out. No network, no quota.
import { codexTranslator } from "../server/providers/codex.ts";
import { parseEnv } from "../server/providers/env.ts";
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

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);

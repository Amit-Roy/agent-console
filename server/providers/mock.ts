import crypto from "node:crypto";
import type { Agent, AgentCtx, Attachment, Provider, QuestionReply, ThreadSpec } from "./types.ts";

// Deterministic fake agent for tests and UI work: no network, no quota. Enabled with AGENT_CONSOLE_MOCK=1.
//   "slow ..."   streams for ~10s (to test Stop)      "fail ..."  ends the turn with an error
//   "tool ..."   runs a fake Bash tool call            "agent ..." runs a background subagent with nested activity (~1.6s)
//   "ctx N ..."  reports the context N% full           anything else is echoed back
interface MockRun {
  thread: ThreadSpec;
  ctx: AgentCtx;
  timers: NodeJS.Timeout[];
  dead: boolean;
  // AGENT_CONSOLE_MOCK_START_MS simulates a harness cold start: nothing streams before the "process" is ready
  readyAt: number;
  turns: number;
  questionId: string | undefined;
}

function mockAt(run: MockRun, delayMs: number, action: () => void) {
  run.timers.push(setTimeout(action, delayMs + Math.max(0, run.readyAt - Date.now())));
}

function mockStop(run: MockRun) {
  run.timers.forEach(clearTimeout);
  run.timers = [];
}

function mockDelta(run: MockRun, text: string) {
  run.ctx.event({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  });
}

function mockDone(run: MockRun, extra: object = {}) {
  run.ctx.event({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 50,
    ...extra,
  });
}

function mockAssistantText(run: MockRun, text: string) {
  run.ctx.event({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

function mockCompact(run: MockRun) {
  mockStop(run);
  mockAt(run, Number(process.env.AGENT_CONSOLE_MOCK_COMPACT_MS) || 200, () => {
    run.ctx.event({ type: "system", subtype: "compact_boundary" });
    run.ctx.event({ type: "context_usage", used: 6000, max: 200000 });
    mockDone(run);
  });
}

function mockAnswerText(reply: QuestionReply): string {
  if (reply.note !== undefined) return `Continuing with your message: ${reply.note}`;
  if (reply.skip) return "Question skipped; continuing.";
  return `Continuing with ${JSON.stringify(reply.answers)}.`;
}

function mockAnswer(run: MockRun, questionId: string, reply: QuestionReply): boolean {
  if (run.dead || questionId !== run.questionId)
    throw new Error("This question is no longer waiting for an answer.");
  run.questionId = undefined;
  mockAt(run, 20, () => {
    mockAssistantText(run, mockAnswerText(reply));
    mockDone(run);
  });
  return true;
}

function mockQuestionScript(run: MockRun) {
  run.questionId = `fixture-question-${crypto.randomUUID()}`;
  const questionId = run.questionId;
  mockAt(run, 10, () =>
    run.ctx.event({
      type: "question",
      id: questionId,
      questions: [
        {
          id: "scope",
          header: "Scope",
          question: "How much should I review?",
          options: [
            { label: "Quick pass", description: "Focus on the changed code." },
            { label: "Full review", description: "Review the complete implementation." },
          ],
          allowOther: true,
        },
        {
          id: "checks",
          header: "Checks",
          question: "Which checks should I run?",
          options: [
            { label: "Tests", description: "Run the relevant automated checks." },
            { label: "Screenshots", description: "Inspect desktop and mobile layouts." },
          ],
          multiSelect: true,
          allowOther: true,
        },
      ],
    }),
  );
}

function mockSlowScript(run: MockRun) {
  for (let tick = 0; tick < 50; tick++)
    mockAt(run, 200 * tick, () => mockDelta(run, `tick ${tick} `));
  mockAt(run, 10_500, () => mockDone(run));
}

function mockFailScript(run: MockRun) {
  mockAt(run, 20, () => {
    run.ctx.event({ type: "console_error", text: "mock failure" });
    run.ctx.event({ type: "result", subtype: "error", is_error: true, duration_ms: 20 });
  });
}

// what Claude emits for a backgrounded subagent: the Agent call, task_started, the instant "launched" result, the subagent's own
// messages tagged with the parent id, progress, and a completion notice that arrives while the main turn is still going
function mockSubagentMessage(run: MockRun, type: string, content: any[]) {
  run.ctx.event({
    type,
    parent_tool_use_id: "a1",
    message: { role: type === "user" ? "user" : "assistant", content },
  });
}

function mockAgentScript(run: MockRun) {
  const { ctx } = run;
  mockAt(run, 10, () =>
    ctx.event({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "a1",
            name: "Agent",
            input: {
              description: "Survey the repo",
              subagent_type: "explore",
              prompt: "List the top-level files and say what they are.",
            },
          },
        ],
      },
    }),
  );
  mockAt(run, 20, () =>
    ctx.event({
      type: "system",
      subtype: "task_started",
      task_id: "k1",
      tool_use_id: "a1",
      task_type: "local_agent",
      is_backgrounded: true,
      description: "Survey the repo",
      subagent_type: "explore",
    }),
  );
  mockAt(run, 40, () =>
    ctx.event({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "a1",
            content: "Async agent launched successfully.",
            is_error: false,
          },
        ],
      },
    }),
  );
  mockAt(run, 60, () =>
    mockSubagentMessage(run, "assistant", [
      { type: "text", text: "Looking at the repo structure first." },
    ]),
  );
  mockAt(run, 70, () =>
    mockSubagentMessage(run, "assistant", [
      { type: "tool_use", id: "s1", name: "Bash", input: { command: "ls -la" } },
    ]),
  );
  mockAt(run, 90, () =>
    mockSubagentMessage(run, "user", [
      { type: "tool_result", tool_use_id: "s1", content: "total 8", is_error: false },
    ]),
  );
  mockAt(run, 100, () =>
    ctx.event({
      type: "system",
      subtype: "task_progress",
      task_id: "k1",
      tool_use_id: "a1",
      description: "Running ls",
      subagent_type: "explore",
      usage: { total_tokens: 4200, tool_uses: 1, duration_ms: 3000 },
    }),
  );
  mockAt(run, 120, () => mockAssistantText(run, "Subagent launched; waiting for it."));
  mockAt(run, 1500, () =>
    ctx.event({
      type: "system",
      subtype: "task_notification",
      task_id: "k1",
      tool_use_id: "a1",
      status: "completed",
      summary: "Survey the repo",
    }),
  );
  mockAt(run, 1600, () => mockDone(run));
}

function mockToolScript(run: MockRun, reply: string) {
  const { ctx } = run;
  mockAt(run, 10, () =>
    ctx.event({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "echo hello" } }],
      },
    }),
  );
  mockAt(run, 40, () =>
    ctx.event({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "hello", is_error: false }],
      },
    }),
  );
  mockAt(run, 70, () => {
    mockAssistantText(run, reply);
    mockDone(run, { total_cost_usd: 0.001 });
  });
}

function mockEchoScript(run: MockRun, reply: string) {
  mockAt(run, 10, () => mockDelta(run, reply.slice(0, 12)));
  mockAt(run, 30, () => mockDelta(run, reply.slice(12)));
  mockAt(run, 60, () => {
    mockAssistantText(run, reply);
    mockDone(run);
  });
}

function mockReplyText(thread: ThreadSpec, text: string, images: Attachment[]): string {
  const suffix = images.length
    ? ` [${images.length} image(s): ${images.map((image) => image.media_type).join(", ")}]`
    : "";
  return `mock reply (${thread.mode}, ${thread.model}): ${text}${suffix}`;
}

// First matching prefix wins; anything else is echoed back.
const MOCK_SCRIPTS: [string, (run: MockRun, reply: string) => void][] = [
  ["question", (run) => mockQuestionScript(run)],
  ["slow", (run) => mockSlowScript(run)],
  ["fail", (run) => mockFailScript(run)],
  ["agent", (run) => mockAgentScript(run)],
  ["tool", mockToolScript],
];

function mockRunScript(run: MockRun, text: string, reply: string) {
  const match = MOCK_SCRIPTS.find(([prefix]) => text.startsWith(prefix));
  (match ? match[1] : mockEchoScript)(run, reply);
}

function mockSend(run: MockRun, text: string, images: Attachment[]) {
  const { ctx, thread } = run;
  mockStop(run);
  run.questionId = undefined;
  run.turns++;
  ctx.event({ type: "system", subtype: "status", status: "requesting" }); // chatter the manager must drop
  const forced = /^ctx (\d+)/.exec(text);
  ctx.event({
    type: "context_usage",
    used: forced ? Number(forced[1]) * 2000 : run.turns * 12_000,
    max: 200_000,
  });
  ctx.event({
    type: "system",
    subtype: "init",
    session_id: thread.sessionId ?? `mock-${thread.id}`,
  });
  ctx.event({ type: "stream_event", event: { type: "message_start" } });
  mockRunScript(run, text, mockReplyText(thread, text, images));
}

function mockInterrupt(run: MockRun) {
  mockStop(run);
  run.questionId = undefined;
  run.ctx.event({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    duration_ms: 0,
  });
}

function mockExit(run: MockRun, signal: "SIGINT" | "SIGTERM") {
  mockStop(run);
  run.dead = true;
  run.ctx.exited({ code: null, signal, stderr: "", aborted: true });
}

export const mock: Provider = {
  id: "mock",
  label: "Mock",
  modes: ["plan", "acceptEdits", "bypassPermissions"],
  defaultMode: "acceptEdits",
  steer: true,
  models: () => ["echo"],
  defaultModel: () => "echo",
  status: () => ({ ok: true }),
  start(t: ThreadSpec, ctx: AgentCtx): Agent {
    const run: MockRun = {
      thread: t,
      ctx,
      timers: [],
      dead: false,
      readyAt: Date.now() + (Number(process.env.AGENT_CONSOLE_MOCK_START_MS) || 0),
      turns: 0,
      questionId: undefined,
    };
    return {
      get alive() {
        return !run.dead;
      },
      compact() {
        mockCompact(run);
      },
      // a steer arrives mid-turn: the mock folds it into the stream, like a real agent picking it up after its current tool call
      steer(text) {
        mockDelta(run, ` [steered: ${text}]`);
      },
      answer(id, reply) {
        return mockAnswer(run, id, reply);
      },
      send(text, images = []) {
        mockSend(run, text, images);
      },
      interrupt() {
        mockInterrupt(run);
      },
      configure(_from, to) {
        Object.assign(t, to);
        return true;
      },
      abort() {
        mockExit(run, "SIGINT");
      },
      kill() {
        mockExit(run, "SIGTERM");
      },
    };
  },
};

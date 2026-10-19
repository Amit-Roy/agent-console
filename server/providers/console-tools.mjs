// Loaded explicitly by the console for Pi threads: scheduled tasks and git-saved reports as tools. Kept small and flat so free
// models call them correctly: few parameters, enums for choices, examples in descriptions, errors that say how to fix the call.
// Calls go back to the console over loopback (AGENT_CONSOLE_TOOL_URL) with its per-process secret.

const when = {
  repeat: { type: "string", enum: ["manual", "hourly", "daily", "weekdays", "weekly"], description: "How often it runs. manual = only when asked." },
  time: { type: "string", description: "24-hour HH:MM in the user's time zone, e.g. \"09:00\". Hourly uses only the minutes." },
  day: { type: "string", enum: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], description: "Weekly only: which day." },
};
const id = { id: { type: "string", description: "Task id or exact title, from schedule_list." } };

export const TOOLS = [
  {
    name: "schedule_list", label: "List scheduled tasks",
    description: "List the user's scheduled tasks: id, title, schedule, next run and last run.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "schedule_create", label: "Create scheduled task",
    description: "Create a task that runs a prompt on a schedule in a fresh thread, e.g. a daily research digest. Each run's report is saved to git. Write the prompt so it works with no one watching.",
    parameters: {
      type: "object", required: ["title", "prompt", "repeat"],
      properties: {
        title: { type: "string", description: "Short name, e.g. \"AI news digest\"." },
        prompt: { type: "string", description: "Full instructions for each run." },
        ...when,
        agent: { type: "string", enum: ["pi", "claude", "codex"], description: "Agent that runs it. Default pi." },
        folder: { type: "string", description: "Absolute working folder. Default: this thread's folder." },
      },
    },
  },
  {
    name: "schedule_update", label: "Update scheduled task",
    description: "Change a scheduled task. Pass only the fields to change. enabled=false pauses it.",
    parameters: {
      type: "object", required: ["id"],
      properties: { ...id, title: { type: "string" }, prompt: { type: "string" }, ...when, enabled: { type: "boolean" } },
    },
  },
  {
    name: "schedule_delete", label: "Delete scheduled task",
    description: "Delete a scheduled task and its run threads. Saved reports stay in git. Only when the user asks.",
    parameters: { type: "object", required: ["id"], properties: id },
  },
  {
    name: "schedule_run_now", label: "Run scheduled task now",
    description: "Start a run of a scheduled task now, in a new thread.",
    parameters: { type: "object", required: ["id"], properties: id },
  },
  {
    name: "save_output", label: "Save report to git",
    description: "Save a markdown report to the user's outputs git repo and commit it. Use for finished research or reports. Pass the whole report, not a summary.",
    parameters: {
      type: "object", required: ["markdown"],
      properties: { markdown: { type: "string", description: "The full report in markdown." }, title: { type: "string", description: "Optional heading." } },
    },
  },
];

export async function callTool(name, params, signal) {
  const url = process.env.AGENT_CONSOLE_TOOL_URL, token = process.env.AGENT_CONSOLE_TOOL_TOKEN;
  if (!url || !token) return "Agent Console is not reachable from this session.";
  try {
    const r = await fetch(`${url}/${name}`, {
      method: "POST", signal,
      headers: { "content-type": "application/json", "x-agent-console-tool": token, "x-agent-console-thread": process.env.AGENT_CONSOLE_THREAD || "" },
      body: JSON.stringify(params ?? {}),
    });
    const body = await r.json().catch(() => ({}));
    return r.ok ? JSON.stringify(body, null, 1) : `Error: ${body.error || r.status}`;
  } catch (e) {
    return `Error: Agent Console did not answer (${e?.message || e}).`;
  }
}

export default function consoleTools(pi) {
  for (const tool of TOOLS) pi.registerTool({
    ...tool,
    async execute(_toolCallId, params, signal) {
      return { content: [{ type: "text", text: await callTool(tool.name, params, signal) }] };
    },
  });
}

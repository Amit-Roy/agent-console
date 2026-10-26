/** Isolated real-service gateway for CLI integration checks and reproducible evidence. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Threads } from "../server/threads.ts";

export async function createConsoleCliFixture() {
  fs.mkdirSync(path.join(os.homedir(), ".cache"), { recursive: true });
  const directory = fs.mkdtempSync(path.join(os.homedir(), ".cache", "console-cli-"));
  process.env.AGENT_CONSOLE_DATA = directory;
  process.env.AGENT_CONSOLE_BRAIN = path.join(directory, "no-brain");
  const [
    { Ideas },
    { Schedules },
    { SessionSearch },
    { consoleCliTool },
    { PROVIDERS },
    { mock },
    { gateToolCall },
  ] = await Promise.all([
    import("../server/ideas.ts"),
    import("../server/schedules.ts"),
    import("../server/session-search.ts"),
    import("../server/console-cli-tools.ts"),
    import("../server/providers/index.ts"),
    import("../server/providers/mock.ts"),
    import("../server/tool-token.ts"),
  ]);
  PROVIDERS.set("mock", mock);
  const ideasDirectory = path.join(directory, "ideas");
  const outputs = path.join(directory, "outputs");
  fs.mkdirSync(ideasDirectory);
  fs.mkdirSync(outputs);
  fs.writeFileSync(
    path.join(ideasDirectory, "index.md"),
    "# App ideas\n\n- [Habit Garden](habit-garden.md) — Turn daily habits into a growing garden.\n",
  );
  fs.writeFileSync(
    path.join(ideasDirectory, "habit-garden.md"),
    "# Habit Garden\n\n## Features\n\n- Grow a plant for every completed habit.\n- Track streaks without pressure.\n",
  );
  const report = path.join(outputs, "weekly-digest.md");
  const original = "# Weekly app research\n\nThree ideas validated with developer interviews.\n";
  fs.writeFileSync(report, original);
  execFileSync("git", ["init", "-q", outputs]);
  execFileSync("git", ["-C", outputs, "add", "weekly-digest.md"]);
  execFileSync("git", [
    "-C",
    outputs,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "Save first report",
  ]);
  const commit = execFileSync("git", ["-C", outputs, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  fs.writeFileSync(report, "# Newer report at the same path\n");
  const task = {
    id: "research-task",
    title: "Weekly app research",
    prompt: "Review app ideas and summarize findings.",
    provider: "mock",
    model: "echo",
    effort: "default",
    mode: "plan",
    cwd: directory,
    repeat: "manual",
    time: "09:00",
    day: 1,
    tz: "UTC",
    enabled: true,
    saveOutput: true,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    runs: [
      {
        id: "run-first",
        thread: "research-thread",
        at: 1700000001000,
        trigger: "manual",
        status: "done",
        output: { path: report, commit },
      },
      {
        id: "run-skipped",
        at: 1700000002000,
        trigger: "manual",
        status: "skipped",
        reason: "Already running.",
      },
    ],
  };
  const scheduleFile = path.join(directory, "schedules.json");
  fs.writeFileSync(scheduleFile, JSON.stringify({ tz: "UTC", tasks: [task] }));
  fs.mkdirSync(path.join(directory, "logs"));
  fs.writeFileSync(
    path.join(directory, "threads.json"),
    JSON.stringify([
      { id: "research-thread", provider: "mock", title: task.title, archived: true },
    ]),
  );
  fs.writeFileSync(
    path.join(directory, "logs", "research-thread.jsonl"),
    [
      JSON.stringify({ type: "user_input", text: task.prompt }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: original }] },
      }),
    ].join("\n") + "\n",
  );
  const schedules = new Schedules({} as Threads, () => {}, {
    file: scheduleFile,
    outputs,
    catchUp: false,
  });
  const services = {
    ideas: new Ideas({ dir: ideasDirectory }),
    schedules,
    sessionSearch: new SessionSearch(directory),
  };
  const credential = "console-cli-fixture-credential";
  const requests: { operation: string; input: Record<string, unknown> }[] = [];
  const server = http.createServer(async (request, response) => {
    const operation = request.url?.split("/").at(-1) ?? "";
    const header = request.headers["x-agent-console-thread"];
    const gate = gateToolCall(
      credential,
      String(request.headers["x-agent-console-tool"] || ""),
      typeof header === "string" ? header : undefined,
      operation,
      (thread) => thread === "auto-thread",
    );
    response.setHeader("Content-Type", "application/json");
    try {
      if (gate.status !== 200) {
        response.statusCode = gate.status;
        throw new Error(gate.error);
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      requests.push({ operation, input });
      response.end(JSON.stringify(await consoleCliTool(operation, input, services)));
    } catch (failure) {
      response.statusCode = response.statusCode === 200 ? 400 : response.statusCode;
      response.end(
        JSON.stringify({ error: failure instanceof Error ? failure.message : "Fixture failed." }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return {
    directory,
    services,
    requests,
    task: schedules.get(task.id)!,
    original,
    env: {
      AGENT_CONSOLE_TOOL_URL: `http://127.0.0.1:${address.port}/api/agent-tools`,
      AGENT_CONSOLE_TOOL_TOKEN: credential,
      AGENT_CONSOLE_THREAD: "manual-thread",
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      schedules.shutdown();
      services.sessionSearch.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

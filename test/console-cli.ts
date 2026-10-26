import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseIdeasArgs, parseTasksArgs } from "../scripts/console-cli-args.ts";
import { CliSearch } from "../server/cli-search.ts";
import { derivedToolToken } from "../server/tool-token.ts";
import { createConsoleCliFixture } from "./console-cli-fixture.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = await createConsoleCliFixture();
function invoke(command: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      path.join(root, "bin", command),
      args,
      { env: { ...process.env, ...fixture.env, ...extra }, timeout: 5000 },
      (failure, stdout, stderr) => {
        resolve({ code: failure ? Number(failure.code) || 1 : 0, stdout, stderr });
      },
    );
  });
}
async function processSuccess(command: string, args: string[]) {
  const result = await invoke(command, args);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}
async function success(command: string, args: string[]) {
  const request = command === "app-ideas" ? parseIdeasArgs(args) : parseTasksArgs(args);
  assert.ok(request);
  const response = await fetch(`${fixture.env.AGENT_CONSOLE_TOOL_URL}/${request.operation}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agent-console-tool": fixture.env.AGENT_CONSOLE_TOOL_TOKEN,
      "x-agent-console-thread": fixture.env.AGENT_CONSOLE_THREAD,
    },
    body: JSON.stringify(request.input),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error);
  return payload;
}
async function rejected(command: string, args: string[], message: RegExp) {
  await assert.rejects(() => success(command, args), message);
}
try {
  assert.equal(parseIdeasArgs([]), undefined);
  assert.equal(parseTasksArgs([]), undefined);
  assert.equal(parseIdeasArgs(["--help"]), undefined);
  assert.equal(parseTasksArgs(["-h"]), undefined);
  assert.throws(() => parseTasksArgs(["toString", "task"]));
  assert.equal((await processSuccess("app-ideas", ["list"])).ideas[0].slug, "habit-garden");
  assert.match(
    (await processSuccess("app-ideas", ["read", "habit-garden"])).markdown,
    /Grow a plant/,
  );
  const listed = await processSuccess("scheduled-tasks", ["list"]);
  assert.equal(listed.tasks[0].id, fixture.task.id);
  assert.equal(listed.tasks[0].runs, undefined);
  const read = await success("scheduled-tasks", ["get", "weekly APP research"]);
  assert.equal(read.task.prompt, fixture.task.prompt);
  assert.equal((await success("scheduled-tasks", ["runs", fixture.task.id])).runs.length, 2);
  const report = await processSuccess("scheduled-tasks", ["report", fixture.task.id]);
  assert.equal(report.markdown, fixture.original, "read pinned commit, not overwritten file");
  assert.equal(report.run, "run-first", "latest skipped run cannot hide saved report");
  const first = await success("scheduled-tasks", ["transcript", fixture.task.id, "--limit", "1"]);
  assert.equal(first.run, "run-first");
  assert.equal(first.next, 2);
  assert.equal(first.archived, true);
  const next = await success("scheduled-tasks", [
    "transcript",
    fixture.task.id,
    "run-first",
    "--start",
    String(first.next),
  ]);
  assert.match(next.events[0].text, /Three ideas validated/);
  assert.equal(next.next, null);
  const beforeReads = fs.readFileSync(path.join(fixture.directory, "schedules.json"), "utf8");
  await rejected("scheduled-tasks", ["report", fixture.task.id, "run-skipped"], /no saved report/);
  await rejected(
    "scheduled-tasks",
    ["transcript", fixture.task.id, "run-skipped"],
    /no transcript/,
  );
  await rejected("scheduled-tasks", ["get", "missing"], /Unknown scheduled task/);
  await rejected("app-ideas", ["read", "missing"], /No such idea/);
  assert.equal(
    fs.readFileSync(path.join(fixture.directory, "schedules.json"), "utf8"),
    beforeReads,
    "reads do not persist task changes",
  );
  const requestCount = fixture.requests.length;
  for (const args of [
    ["update", fixture.task.id, "--json", '{"enabled":"false"}'],
    ["update", fixture.task.id, "--json", '{"runs":[]}'],
    ["update", fixture.task.id, "--json", '{"tz":"wrong-zone"}'],
    ["transcript", fixture.task.id, "--limit", "101"],
    ["report", fixture.task.id, "--start", "1"],
    ["update", fixture.task.id, "--json", "null"],
    ["get", fixture.task.id, "extra"],
  ]) {
    await rejected("scheduled-tasks", args, /./);
  }
  await rejected("app-ideas", ["read", "../escape"], /app-ideas/);
  assert.equal(fixture.requests.length, requestCount, "invalid arguments fail before HTTP");
  const preserved = { prompt: fixture.task.prompt, runs: JSON.stringify(fixture.task.runs) };
  const updated = await success("scheduled-tasks", [
    "update",
    fixture.task.id,
    "--json",
    '{"time":"10:30","tz":"Asia/Kolkata","enabled":false,"limitMin":30}',
  ]);
  assert.equal(updated.updated.time, "10:30");
  assert.equal(updated.updated.tz, "Asia/Kolkata");
  assert.equal(updated.updated.limitMin, 30);
  assert.equal(updated.updated.enabled, false);
  assert.equal(fixture.task.prompt, preserved.prompt);
  assert.equal(JSON.stringify(fixture.task.runs), preserved.runs);
  const patchFile = path.join(fixture.directory, "patch.json");
  fs.writeFileSync(patchFile, '{"title":"Renamed research"}');
  assert.equal(
    (await success("scheduled-tasks", ["update", fixture.task.id, "--file", patchFile])).updated
      .title,
    "Renamed research",
  );
  const duplicate = structuredClone(fixture.task);
  duplicate.id = "duplicate-task";
  fixture.services.schedules.list = () => [fixture.task, duplicate];
  await rejected("scheduled-tasks", ["get", "Renamed research"], /Ambiguous task title/);
  assert.equal(
    (await success("scheduled-tasks", ["get", fixture.task.id])).task.id,
    fixture.task.id,
  );
  const auto = {
    AGENT_CONSOLE_THREAD: "auto-thread",
    AGENT_CONSOLE_TOOL_TOKEN: derivedToolToken(fixture.env.AGENT_CONSOLE_TOOL_TOKEN, "auto-thread"),
  };
  assert.equal((await invoke("app-ideas", ["list"], auto)).code, 0);
  assert.equal((await invoke("scheduled-tasks", ["get", fixture.task.id], auto)).code, 0);
  const denied = await invoke(
    "scheduled-tasks",
    ["update", fixture.task.id, "--json", '{"enabled":true}'],
    auto,
  );
  assert.notEqual(denied.code, 0);
  assert.match(denied.stderr, /read-only/);
  assert.equal(fixture.task.enabled, false);
  const missingCredentials = await invoke("app-ideas", ["list"], { AGENT_CONSOLE_TOOL_TOKEN: "" });
  assert.notEqual(missingCredentials.code, 0);
  assert.match(missingCredentials.stderr, /inside an Agent Console session/);
  const badCredentials = await invoke("app-ideas", ["list"], { AGENT_CONSOLE_TOOL_TOKEN: "wrong" });
  assert.notEqual(badCredentials.code, 0);
  assert.match(badCredentials.stderr, /Not an Agent Console tool call/);
  process.env.AGENT_CONSOLE_TOOL_MANIFESTS = path.join(root, "tools.json");
  const search = new CliSearch();
  assert.match(search.search({ terms: ["app ideas"] }), /app-ideas:.*bin\/app-ideas/);
  assert.match(
    search.search({ terms: ["scheduled reports transcripts config"] }),
    /scheduled-tasks:.*bin\/scheduled-tasks/,
  );
  console.log(
    "console-cli: real gateway ideas, config, committed reports, archived paginated transcripts, validation, partial updates, Auto restrictions and discovery pass",
  );
} finally {
  await fixture.close();
}

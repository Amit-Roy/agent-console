import { parseTasksArgs, TASKS_USAGE } from "./console-cli-args.ts";
import { consoleRequest, failCommand, printResult } from "./console-cli-client.ts";

try {
  const request = parseTasksArgs(process.argv.slice(2));
  if (request) printResult(await consoleRequest(request.operation, request.input));
  else console.log(TASKS_USAGE);
} catch (failure) {
  failCommand("scheduled-tasks", failure);
}

import { IDEAS_USAGE, parseIdeasArgs } from "./console-cli-args.ts";
import { consoleRequest, failCommand, printResult } from "./console-cli-client.ts";

try {
  const request = parseIdeasArgs(process.argv.slice(2));
  if (request) printResult(await consoleRequest(request.operation, request.input));
  else console.log(IDEAS_USAGE);
} catch (failure) {
  failCommand("app-ideas", failure);
}

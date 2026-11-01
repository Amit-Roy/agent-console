import { CODEMAP_USAGE, parseCodemapArgs } from "./console-cli-args.ts";
import { consoleRequest, failCommand } from "./console-cli-client.ts";

type Summary = {
  slug: string;
  status: string;
  error?: string;
  files?: number;
  modules?: number;
  described?: boolean;
  source?: { ref: string };
};
const POLL_MS = 3000;
const WAIT_LIMIT_MS = 10 * 60 * 1000;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const statusLine = (map: Summary) => `${map.slug} ${map.status}`;

function listLine(map: Summary): string {
  const described = map.described ? "yes" : "no";
  return [
    map.slug,
    map.status,
    map.files ?? "-",
    map.modules ?? "-",
    described,
    map.source?.ref,
  ].join("  ");
}

async function waitReady(first: Summary): Promise<Summary> {
  let current = first;
  let phase = first.status;
  const deadline = Date.now() + WAIT_LIMIT_MS;
  while (current.status !== "ready" && current.status !== "failed") {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${first.slug}.`);
    await pause(POLL_MS);
    current = (await consoleRequest("map_status", { slug: first.slug })) as Summary;
    if (current.status !== phase) console.log(statusLine(current));
    phase = current.status;
  }
  if (current.status === "failed") throw new Error(current.error || `${first.slug} failed.`);
  return current;
}

async function run(args: string[]) {
  const request = parseCodemapArgs(args);
  if (!request) return console.log(CODEMAP_USAGE);
  const result = (await consoleRequest(request.operation, request.input)) as Record<string, any>;
  if (request.operation === "map_list") return printLines(result.maps.map(listLine));
  if (request.operation === "map_show") return console.log(result.brief);
  if (request.operation === "map_spec") return console.log(JSON.stringify(result.spec));
  if (request.operation === "map_remove") return console.log(`${result.removed} removed`);
  console.log(statusLine(result as Summary));
  if (request.wait) {
    const ready = await waitReady(result as Summary);
    const shown = (await consoleRequest("map_show", { slug: ready.slug })) as { brief: string };
    console.log(shown.brief);
  }
}

function printLines(lines: string[]) {
  if (lines.length) console.log(lines.join("\n"));
}

try {
  await run(process.argv.slice(2));
} catch (failure) {
  failCommand("codemap", failure);
}

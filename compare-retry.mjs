import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const source = path.resolve(process.argv[2]);
const { createReviewer } = await import(pathToFileURL(path.join(source, "server/issue-review.ts")));
async function scenario(error, recoveries = 0) {
  const worker = { id: "comparison", provider: "pi", model: "nvidia/nvidia/nemotron-3-ultra-550b-a55b", status: "idle", issueRun: { key: "owner/repo#201", repo: "owner/repo", number: 201, effort: "bau", role: "work", branch: "issue-201", recoveries } };
  const prompts = [];
  let reroutes = 0, assignments = 0;
  const reviewer = createReviewer({
    runner: {
      create() { throw new Error("Unexpected reviewer"); },
      send(_id, text) { prompts.push(text); worker.status = "running"; },
      mark(_id, patch) { Object.assign(worker.issueRun, patch); },
    },
    github: async (_method, endpoint) => endpoint.includes("/pulls?") ? [] : { state: "open" },
    canResume: () => true,
    rerouteWorker: () => { reroutes++; return { model: "nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b" }; },
    premium: async () => { assignments++; return { thread: "premium" }; },
    route: () => ({ v: 1, decision: "defer", alternatives: [], why: "Not used" }),
    now: () => 1_000_000,
  });
  await reviewer.turnEnded(worker, { is_error: true, error });
  await new Promise(setImmediate);
  await reviewer.sweep([worker]);
  return { retries: prompts.length, containsError: prompts.some((p) => p.includes(error)), recoveries: worker.issueRun.recoveries, reroutes, assignments, premiumPending: !!worker.issueRun.premiumPending };
}
const observed = {
  task: await scenario("TypeError: totals is undefined"),
  infrastructure: await scenario("429 rate limit exceeded"),
  exhausted: await scenario("TypeError: totals is undefined", 2),
};
if (process.argv.includes("--compact")) {
  for (const [scenario, result] of Object.entries(observed)) console.log(`${scenario}: ${JSON.stringify(result)}`);
} else console.log(JSON.stringify({ source, command: process.argv.join(" "), samplesPerScenario: 1, observed }, null, 2));

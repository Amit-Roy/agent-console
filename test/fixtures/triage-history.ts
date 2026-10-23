import {
  predictHistory,
  trainHistory,
  type HistoricalTask,
} from "../../server/providers/triage-history.ts";

// Synthetic measurements for isolated tests; these are never production calibration data.
const tasks: HistoricalTask[] = Array.from({ length: 6 }, (_, index) => ({
  id: `fixture-${index}`,
  group: `fixture-group-${Math.floor(index / 2)}`,
  startedAt: new Date(Date.UTC(2020, 0, index + 1, 0)).toISOString(),
  completedAt: new Date(Date.UTC(2020, 0, index + 1, 1)).toISOString(),
  request: `Implement isolated fixture feature number ${index}.`,
  provider: "fixture",
  inputTokens: (index + 1) * 1_000,
  outputTokens: (index + 1) * 100,
  commits: [{ repo: "fixture/repository", sha: (index + 1).toString(16).padStart(40, "0") }],
}));
const model = trainHistory(tasks);
if (model.status !== "ready") throw Error("Synthetic history model failed.");
const estimate = predictHistory(model, "Implement a fixture feature.");
if (estimate.status !== "ready") throw Error("Synthetic history estimate failed.");
export const fixtureHistory = estimate;

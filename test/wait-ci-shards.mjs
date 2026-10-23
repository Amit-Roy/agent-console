import { setTimeout as delay } from "node:timers/promises";

const deadline = Date.now() + 120_000;
const url = `${process.env.GITHUB_API_URL}/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}/artifacts?per_page=100`;
while (Date.now() < deadline) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${process.env.GH_TOKEN}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Cannot check shard readiness: HTTP ${response.status}`);
  const { artifacts } = await response.json();
  const ready = artifacts.filter(
    (artifact) => !artifact.expired && artifact.name.startsWith(process.env.READY_PREFIX),
  );
  if (ready.length === 2) {
    console.log("Both runners are ready; starting the test windows.");
    process.exit(0);
  }
  await delay(1000);
}
throw new Error("Both CI runners must finish setup within 120 seconds of the first ready runner.");

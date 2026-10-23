import { fileURLToPath, pathToFileURL } from "node:url";
import { type ModelPriority, modelRateEnv } from "./model-rate-client.ts";

/** Install the request gate before Pi loads its provider SDKs. Every Pi process asks the Console's single queue. */
export function piRateEnv(
  env: NodeJS.ProcessEnv,
  priority: ModelPriority = "interactive",
): NodeJS.ProcessEnv {
  const preload = pathToFileURL(
    fileURLToPath(new URL("./pi-rate-preload.mjs", import.meta.url)),
  ).href;
  const result = modelRateEnv({ ...env, AGENT_CONSOLE_MODEL_PRIORITY: priority });
  return { ...result, NODE_OPTIONS: `${env.NODE_OPTIONS || ""} --import=${preload}`.trim() };
}

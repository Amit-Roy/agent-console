import { pathToFileURL, fileURLToPath } from "node:url";

/** Install the request gate before Pi loads its provider SDKs. */
export function piRateEnv(env: NodeJS.ProcessEnv, broker = true): NodeJS.ProcessEnv {
  const preload = pathToFileURL(fileURLToPath(new URL("./pi-rate-preload.mjs", import.meta.url))).href;
  const result = { ...env };
  // Standalone triage survives Console restarts and uses the shared SQLite gate.
  if (!broker) {
    delete result.AGENT_CONSOLE_TOOL_URL;
    delete result.AGENT_CONSOLE_TOOL_TOKEN;
  }
  return { ...result, NODE_OPTIONS: `${env.NODE_OPTIONS || ""} --import=${preload}`.trim() };
}

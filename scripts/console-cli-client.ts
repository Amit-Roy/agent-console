/** Authenticated agent-tool transport. Never fall back to browser or host credentials. */
export async function consoleRequest(operation: string, input: unknown): Promise<unknown> {
  const endpoint = process.env.AGENT_CONSOLE_TOOL_URL;
  const credential = process.env.AGENT_CONSOLE_TOOL_TOKEN;
  if (!endpoint || !credential)
    throw new Error("Run this command inside an Agent Console session (tool URL/token required).");
  const response = await fetch(`${endpoint.replace(/\/+$/, "")}/${operation}`, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: {
      "content-type": "application/json",
      "x-agent-console-tool": credential,
      "x-agent-console-thread": process.env.AGENT_CONSOLE_THREAD || "",
    },
    body: JSON.stringify(input),
    redirect: "error",
  });
  const payload = await response.json().catch(() => {
    throw new Error(`Agent Console returned invalid JSON (HTTP ${response.status}).`);
  });
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

export function printResult(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function failCommand(name: string, failure: unknown): void {
  const message = failure instanceof Error ? failure.message : "Command failed.";
  console.error(`${name}: ${message}`);
  process.exitCode = 1;
}

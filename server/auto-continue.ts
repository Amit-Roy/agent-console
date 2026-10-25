export const AUTO_CONTINUE_PROMPT =
  "Continue if you are waiting on an action the user already approved, or if your changes are not yet merged. Stop only if a decision still needs sign-off or the work needs user intervention.";

// On by default; mock servers (tests, e2e) keep it off unless AGENT_CONSOLE_AUTO_CONTINUE=1 asks for it.
export function autoContinueEnabled(): boolean {
  const setting = process.env.AGENT_CONSOLE_AUTO_CONTINUE;
  if (setting) return setting !== "0";
  return process.env.AGENT_CONSOLE_MOCK !== "1";
}

export const AUTO_CONTINUE_PROMPT =
  "Continue if you are waiting on an action the user already approved, or if your changes are not yet merged. Stop only if a decision still needs sign-off or the work needs user intervention.";

export function autoContinueEnabled(): boolean {
  return process.env.AGENT_CONSOLE_AUTO_CONTINUE !== "0";
}

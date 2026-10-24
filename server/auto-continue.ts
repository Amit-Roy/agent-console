export const AUTO_CONTINUE_PROMPT =
  "Continue if you are waiting on an action the user already approved, or if your changes are not yet merged. Stop only if a decision still needs sign-off or the work needs user intervention.";

const FENCED_BLOCK = /```[\s\S]*?(```|$)/g;
const ANNOUNCES_NEXT_STEP =
  /^\W*(next( steps?)?:\s*)?(i'?ll|i will|i'm going to|i am going to|i implement|now i|next i|let me|then i)\b/i;
const ASKS_OR_DEFERS =
  /want me to|should i|shall i|would you like|let me know|if you want|approve|confirm|your call/i;
const MAX_TAIL_CHARS = 400;
const TAIL_LINE_COUNT = 2;

export function announcesNextStep(text: string): boolean {
  const visible = text.replace(FENCED_BLOCK, "").trim();
  if (!visible || visible.endsWith("?") || ASKS_OR_DEFERS.test(visible)) return false;
  const lines = visible
    .split("\n")
    .map((line) => line.replace(/[*_`]/g, "").trim())
    .filter(Boolean);
  const tail = lines.slice(-TAIL_LINE_COUNT).join("\n").slice(-MAX_TAIL_CHARS);
  return tail.split("\n").some((line) => ANNOUNCES_NEXT_STEP.test(line));
}

export function autoContinueEnabled(): boolean {
  return process.env.AGENT_CONSOLE_AUTO_CONTINUE !== "0";
}

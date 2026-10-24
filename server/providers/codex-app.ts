import { CodexAppSession } from "./codex-app-session.ts";
import type { Agent, AgentCtx, ThreadSpec } from "./types.ts";

export { codexQuestion } from "./codex-app-questions.ts";

// Keep the owning app-server alive: turn/steer must reach the process running the turn.
export function startCodexApp(
  spec: ThreadSpec,
  ctx: AgentCtx,
  translate: (row: any) => void,
): Agent {
  const session = new CodexAppSession(spec, ctx, translate);
  session.start();
  return {
    get alive() {
      return session.alive;
    },
    send(text, images = []) {
      session.send(text, images);
    },
    steer(text, images = []) {
      return session.steer(text, images);
    },
    compact(instructions = "") {
      session.compact(instructions);
    },
    answer(askId, reply) {
      return session.answer(askId, reply);
    },
    abort() {
      session.stop(false);
    },
    kill() {
      session.stop(true);
    },
  };
}

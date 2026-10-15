import path from "node:path";
import { BRAIN_BIN, brainAvailable } from "./brain.ts";

// Same rule as the brain's Claude Stop hook (~/repos/brain/bin/brain `nudge`), for harnesses without hooks: once an agent has made
// NUDGE_AFTER tool calls with no write to the wiki since, remind it once to save anything durable. Resets after each reminder.
const after = () => Number(process.env.BRAIN_NUDGE_AFTER) || 12;

export interface Nudger {
  observe(ev: any): void; // feed every canonical event
  check(): string | undefined; // call when a turn ends cleanly
}

export function createNudger(): Nudger {
  const brainDir = path.dirname(path.dirname(BRAIN_BIN));
  const wiki = path.join(brainDir, "wiki");
  let total = 0;
  let lastWrite = 0;
  let mark = 0;
  return {
    observe(ev) {
      if (ev?.type !== "assistant") return;
      for (const b of ev.message?.content ?? []) {
        if (b?.type !== "tool_use") continue;
        total++;
        const input = b.input ?? {};
        const target = `${input.file_path ?? ""} ${input.command ?? ""}`;
        if (target.includes(wiki) || target.includes("brain log") || target.includes("bin/brain")) lastWrite = total;
      }
    },
    check() {
      if (process.env.BRAIN_NO_NUDGE || !brainAvailable()) return;
      const base = Math.max(mark, lastWrite);
      if (total - base < after()) return;
      const n = total - base;
      mark = total;
      return (
        `[brain] ${n} tool calls since last brain save. Anything durable learned (user pref, correction, non-obvious decision, ` +
        `external pointer, hard-won fix)? If yes: save it now (caveman style; flow in ${brainDir}/CLAUDE.md), then finish. ` +
        "If not: reply exactly `brain: nothing to save`."
      );
    },
  };
}

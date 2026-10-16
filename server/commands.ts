import type { Command } from "./providers/types.ts";

export const CONSOLE_COMMANDS: Command[] = [
  { name: "compact", description: "Compact the agent's context; keep the visible conversation." },
  { name: "help", description: "Show the commands available for this agent." },
  { name: "status", description: "Show the agent, model, effort and current context." },
  { name: "model", description: "Choose a model for this thread.", argumentHint: "[model]" },
  { name: "effort", description: "Choose reasoning effort for this thread.", argumentHint: "[level]" },
  { name: "stop", description: "Stop the running operation and clear queued messages." },
];
export function parseCommand(text: string) {
  const m = /^\/([a-z][\w:-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return m ? { name: m[1].toLowerCase(), args: (m[2] || "").trim() } : undefined;
}
export function commandList(native: Command[] = []): Command[] {
  return [...new Map([...native.map(c => ({ ...c, name: c.name.replace(/^\/+/, "") })), ...CONSOLE_COMMANDS].map(c => [c.name, c])).values()];
}

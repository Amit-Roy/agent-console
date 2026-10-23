import { claudeAccounts } from "./claude-accounts.ts";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { mock } from "./mock.ts";
import { pi } from "./pi.ts";
import type { Provider } from "./types.ts";

export { refreshPiModels } from "./pi.ts";
export * from "./types.ts";

const all: Provider[] = [
  claude,
  pi,
  codex,
  ...(process.env.AGENT_CONSOLE_MOCK === "1" ? [mock] : []),
];
export const PROVIDERS = new Map(all.map((p) => [p.id, p]));
export const DEFAULT_PROVIDER = "claude";

export const providerInfo = () =>
  all.map((p) => ({
    id: p.id,
    label: p.label,
    modes: p.modes,
    defaultMode: p.defaultMode,
    note: p.note,
    steer: !!p.steer,
    advisors: p.advisors ?? [],
    models: p.models(),
    modelDetails: p.modelDetails?.(),
    defaultModel: p.defaultModel(),
    ...(p.id === "claude" ? { accounts: claudeAccounts() } : {}),
    ...p.status(),
  }));

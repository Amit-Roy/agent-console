import { headroom } from "../headroom.ts";

// Match Headroom's Codex session wrapper: the CLI override also covers WebSockets.
// Keep the built-in provider, native login, model selection, and durable CODEX_HOME.
export function codexRouting(env: NodeJS.ProcessEnv, proxy = headroom.url()) {
  const routed = { ...env };
  const managed = `${headroom.state().url}/v1`;
  const inherited = routed.OPENAI_BASE_URL?.replace(/\/+$/, "");
  if (inherited === managed) delete routed.OPENAI_BASE_URL;
  // An explicitly selected external endpoint remains user controlled.
  if (!proxy || (inherited && inherited !== managed)) return { env: routed, args: [] as string[] };
  const base = `${proxy}/v1`;
  routed.OPENAI_BASE_URL = base;
  return { env: routed, args: ["-c", `openai_base_url=${JSON.stringify(base)}`] };
}

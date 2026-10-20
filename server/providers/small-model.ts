import { acquireModelRequest, reportModel429 } from "./model-rate-client.ts";
import { childEnv } from "./env.ts";

export interface LabelEngine { id: string; call(prompt: string, system: string): Promise<string | undefined>; available?(): boolean; cooldownMs?: number }
export function createLabelCompletion(engines: LabelEngine[], cooldownMs = 5 * 60_000) {
  const cooldown = new Map<string, number>();
  return async <T>(prompt: string, system: string, validate: (raw: string | undefined) => T | undefined): Promise<T | undefined> => {
    for (const e of engines) {
      if (e.available?.() === false || (cooldown.get(e.id) || 0) > Date.now()) continue;
      let why: string;
      try {
        const result = validate(await e.call(prompt, system));
        if (result !== undefined) {
          console.info(`Label helper succeeded: ${e.id}.`);
          return result;
        }
        // The engine answered, just badly: try the next one now, but do not bench a working engine for one malformed reply.
        console.info(`Label helper ${e.id} gave an unusable reply; trying fallback.`);
        continue;
      } catch (err) { why = (err as Error)?.message || String(err); } // a failed helper must never stop a conversation
      cooldown.set(e.id, Date.now() + (e.cooldownMs ?? cooldownMs));
      console.info(`Label helper ${e.id} failed (${why}); trying fallback (cooldown ${(e.cooldownMs ?? cooldownMs) / 1000}s).`);
    }
  };
}
// Titles and tool labels are written by Nemotron 3 Super 120B, direct from NVIDIA (the same `nvidia` provider Pi uses). Haiku and
// Codex Luna are deliberately not used here. Thinking is off: it would spend the whole output budget before the label.
// NVIDIA retired nemotron-3-super for this key (404 "Function not found", 2026-10-20); 3.5 Super answers in ~0.3 s.
const NVIDIA_MODEL = process.env.AGENT_CONSOLE_LABEL_NVIDIA_MODEL || "nvidia/nemotron-3.5-super-vl-120b-a12b";
// All model requests share one priority queue, including Pi subprocesses. Labels are the lowest priority and yield to coding work.
export async function askNvidia(prompt: string, system: string) {
  const key = childEnv().NVIDIA_API_KEY;
  if (!key) return;
  for (let attempt = 0; ; attempt++) {
    await acquireModelRequest({ provider: "nvidia", priority: "label" });
    const r = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: NVIDIA_MODEL, messages: [{ role: "system", content: system }, { role: "user", content: prompt }], max_tokens: 512, temperature: 0.2, chat_template_kwargs: { enable_thinking: false } }),
      signal: AbortSignal.timeout(12_000),
    });
    if (r.status === 429) {
      await reportModel429(r.headers.get("retry-after"), "nvidia");
      if (attempt === 0) { await r.body?.cancel(); continue; }
    }
    if (!r.ok) throw Error(`NVIDIA HTTP ${r.status}`);
    return (await r.json() as any).choices?.[0]?.message?.content;
  }
}
// Fallback when NVIDIA is down or rate-limited: the same model on OpenRouter's free tier, never paid routing.
export async function askRouter(prompt: string, system: string) {
  const key = childEnv().OPENROUTER_API_KEY;
  if (!key) return;
  await acquireModelRequest({ provider: "openrouter", priority: "label" });
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ models: ["nvidia/nemotron-3-super-120b-a12b:free"], messages: [{ role: "system", content: system }, { role: "user", content: prompt }], max_tokens: 512, reasoning: { effort: "none", exclude: true } }),
    signal: AbortSignal.timeout(12_000),
  });
  if (r.status === 429) await reportModel429(r.headers.get("retry-after"), "openrouter");
  if (!r.ok) throw Error(`OpenRouter HTTP ${r.status}`);
  return (await r.json() as any).choices?.[0]?.message?.content;
}
export const completeLabel = createLabelCompletion([
  { id: "nvidia-nemotron", cooldownMs: 45_000, call: askNvidia, available: () => !!childEnv().NVIDIA_API_KEY }, // ~1 RPS key limit: a blip should recover soon
  { id: "openrouter-nemotron-free", cooldownMs: 45_000, call: askRouter, available: () => !!childEnv().OPENROUTER_API_KEY },
]);

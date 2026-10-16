// Legacy logs can contain WebSearch {query:""}; no metadata exists to reconstruct its action.
export const toolName = (name, input) => name === "WebSearch" && !input?.query?.trim() && !input?.queries?.length && !input?.description ? "WebBrowse" : name;
export function toolSummary(name, input = {}) {
  if (name === "WebSearch" && input.queries?.length) return input.queries.join(" · ");
  if (name === "WebFind") return [input.pattern || input.description, input.url].filter(Boolean).join(" · ");
  if (toolName(name, input) === "WebBrowse") return input.description || "Web action details not reported by Codex";
  return input.command || input.file_path || input.path || input.pattern || input.url || input.query || input.description || JSON.stringify(input).slice(0, 120);
}

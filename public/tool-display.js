// Legacy logs can contain WebSearch {query:""}; no metadata exists to reconstruct its action.
export const toolName = (name, input) => {
  if (
    name === "WebSearch" &&
    !input?.query?.trim() &&
    !input?.queries?.length &&
    !input?.description
  )
    return "WebBrowse";
  // MCP tools arrive as `mcp__<server>__<tool>`; show the readable `server/tool` instead.
  if (name.startsWith("mcp__")) {
    const parts = name.slice(5).split("__");
    const server = parts[0];
    const tool = parts.slice(1).join("__");
    return server && tool ? `${server}/${tool}` : name;
  }
  return name;
};
// Shorten an absolute file path to a readable, identifying summary. Keep the
// repo name onward when under a workspace, otherwise the last two segments, so
// the full absolute path is never clipped mid-segment in the UI.
const shortPath = (p) => {
  if (typeof p !== "string" || !p) return "";
  const segs = p.split(/[/\\]/).filter(Boolean);
  const i = segs.lastIndexOf("repos");
  if (i !== -1 && segs[i + 1]) return segs.slice(i + 1).join("/");
  return segs.slice(-2).join("/");
};

export function toolSummary(name, input = {}) {
  if (name === "WebSearch" && input.queries?.length) return input.queries.join(" · ");
  if (name === "WebFind")
    return [input.pattern || input.description, input.url].filter(Boolean).join(" · ");
  if (toolName(name, input) === "WebBrowse")
    return input.description || "Web action details not reported by Codex";
  if (name === "Read") return shortPath(input.file_path) || "";
  return (
    input.command ||
    input.file_path ||
    input.path ||
    input.pattern ||
    input.url ||
    input.query ||
    input.description ||
    JSON.stringify(input).slice(0, 120)
  );
}

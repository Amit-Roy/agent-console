// exec --json carries the Responses API's snake_case action (older CLIs may omit it).
// Never treat the legacy query field as a search when an explicit different action exists.
export function codexWebTool(item: any) {
  const action = item.action ?? {};
  const nonempty = (s: unknown): s is string => typeof s === "string" && !!s.trim();
  const input: Record<string, any> = {};
  let name = "WebBrowse";
  if (action.type === "search" || (!action.type && nonempty(item.query))) {
    name = "WebSearch";
    if (nonempty(action.query)) input.query = action.query;
    else if (nonempty(item.query)) input.query = item.query;
    if (Array.isArray(action.queries) && action.queries.some(nonempty)) input.queries = action.queries.filter(nonempty);
    if (!input.query && !input.queries) input.description = "Search query not reported by Codex";
  } else if (["open_page", "openPage"].includes(action.type)) {
    name = "WebFetch";
    if (nonempty(action.url)) input.url = action.url;
    else input.description = "Page URL not reported by Codex";
  } else if (["find_in_page", "findInPage"].includes(action.type)) {
    name = "WebFind";
    if (nonempty(action.url)) input.url = action.url;
    if (nonempty(action.pattern)) input.pattern = action.pattern;
    if (!input.pattern) input.description = "Find pattern not reported by Codex";
  } else {
    input.description = "Web action details not reported by Codex";
  }
  return { name, input };
}

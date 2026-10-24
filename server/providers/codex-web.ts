// exec --json carries the Responses API's snake_case action (older CLIs may omit it).
// Never treat the legacy query field as a search when an explicit different action exists.
function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && !!value.trim();
}

function webSearchInput(item: any, action: any): Record<string, any> {
  const input: Record<string, any> = {};
  if (isNonEmpty(action.query)) input.query = action.query;
  else if (isNonEmpty(item.query)) input.query = item.query;
  if (Array.isArray(action.queries) && action.queries.some(isNonEmpty))
    input.queries = action.queries.filter(isNonEmpty);
  if (!input.query && !input.queries) input.description = "Search query not reported by Codex";
  return input;
}

function webFetchInput(action: any): Record<string, any> {
  if (isNonEmpty(action.url)) return { url: action.url };
  return { description: "Page URL not reported by Codex" };
}

function webFindInput(action: any): Record<string, any> {
  const input: Record<string, any> = {};
  if (isNonEmpty(action.url)) input.url = action.url;
  if (isNonEmpty(action.pattern)) input.pattern = action.pattern;
  if (!input.pattern) input.description = "Find pattern not reported by Codex";
  return input;
}

export function codexWebTool(item: any) {
  const action = item.action ?? {};
  if (action.type === "search" || (!action.type && isNonEmpty(item.query)))
    return { name: "WebSearch", input: webSearchInput(item, action) };
  if (["open_page", "openPage"].includes(action.type))
    return { name: "WebFetch", input: webFetchInput(action) };
  if (["find_in_page", "findInPage"].includes(action.type))
    return { name: "WebFind", input: webFindInput(action) };
  return { name: "WebBrowse", input: { description: "Web action details not reported by Codex" } };
}

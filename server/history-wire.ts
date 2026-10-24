// History is a view, not a harness replay. Keep the fields rendered by public/app.js
// without repeatedly transferring provider diagnostics, signed reasoning, or tool catalogs.
// Logs, exports, and live events retain their full original data.
const fields = (source: any, names: string[]) =>
  Object.fromEntries(
    names.filter((name) => source[name] !== undefined).map((name) => [name, source[name]]),
  );

function blockView(block: any) {
  if (!block || typeof block !== "object") return block;
  switch (block.type) {
    case "text":
      return fields(block, ["type", "text"]);
    case "thinking":
      return fields(block, ["type", "thinking"]);
    case "redacted_thinking":
      return { type: block.type };
    case "tool_use":
      return fields(block, ["type", "id", "name", "input"]);
    case "tool_result": {
      const view = fields(block, ["type", "tool_use_id", "content", "is_error"]);
      // The tool card renders only text, never embedded image data or provider metadata.
      if (Array.isArray(block.content))
        view.content = block.content.map((part: any) => fields(part, ["type", "text"]));
      return view;
    }
    default:
      return block; // Unknown future content stays intact until its display contract is known.
  }
}

export function historyWireEvent(event: any) {
  if (!event || typeof event !== "object") return event;
  switch (event.type) {
    case "assistant":
    case "user": {
      const view = fields(event, ["type", "parent_tool_use_id", "ts"]); // ts: replayed rows show step durations
      if (event.message)
        view.message = {
          ...fields(event.message, ["role"]),
          ...(Array.isArray(event.message.content)
            ? { content: event.message.content.map(blockView) }
            : {}),
        };
      return view;
    }
    case "result": {
      const view = fields(event, ["type", "subtype", "is_error", "duration_ms", "total_cost_usd"]);
      // Error text is short and lets the reply footer offer a fix, such as signing in after an expired Claude login.
      if (event.is_error && typeof event.result === "string")
        view.result = event.result.slice(0, 500);
      return view;
    }
    case "system":
      return fields(
        event,
        event.subtype?.startsWith("task_")
          ? [
              "type",
              "subtype",
              "tool_use_id",
              "usage",
              "description",
              "is_backgrounded",
              "status",
              "summary",
            ]
          : ["type", "subtype"],
      );
    // Quotas already arrive in hello/usage; historical quota events do not update the UI.
    case "rate_limit_event":
      return { type: event.type };
    default:
      return event;
  }
}

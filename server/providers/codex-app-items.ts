const ITEM_TYPES: Record<string, string> = {
  agentMessage: "agent_message",
  commandExecution: "command_execution",
  fileChange: "file_change",
  mcpToolCall: "mcp_tool_call",
  webSearch: "web_search",
};

// App-server thread item -> the exec-style row codexTranslator understands; undefined when the item has no visible row.
export function adaptItem(item: any, done: boolean): any {
  if (item.type === "reasoning")
    return done
      ? {
          type: "item.completed",
          item: { ...item, text: [...(item.summary || []), ...(item.content || [])].join("\n") },
        }
      : undefined;
  if (!ITEM_TYPES[item.type]) return undefined;
  return {
    type: done ? "item.completed" : "item.started",
    item: {
      ...item,
      type: ITEM_TYPES[item.type],
      aggregated_output: item.aggregatedOutput,
      exit_code: item.exitCode,
      ...(item.changes
        ? {
            changes: item.changes.map((change: any) => ({
              ...change,
              kind: change.kind?.type || change.kind,
            })),
          }
        : {}),
    },
  };
}

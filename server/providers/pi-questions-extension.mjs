// Loaded explicitly by the console. Plain JSON Schema avoids depending on Pi's
// package name or the version of TypeBox bundled with the user's installation.
export const QUESTION_DIALOG = "Agent Console questions";

export default function questions(pi) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask the user",
    description: "Ask the user 1–3 concise questions when missing information or a preference would materially change your work. Offer clear choices with descriptions when useful; free text is always available. Wait for the answer before dependent work. Never use this tool for tool permissions or approvals. If skipped, use your best judgment without repeating the question.",
    parameters: {
      type: "object",
      required: ["questions"],
      properties: {
        questions: {
          type: "array", minItems: 1, maxItems: 3,
          items: {
            type: "object", required: ["id", "question"],
            properties: {
              id: { type: "string", description: "Unique answer key" },
              header: { type: "string", description: "Short topic label" },
              question: { type: "string" },
              options: { type: "array", maxItems: 8, items: {
                type: "object", required: ["label"], properties: {
                  label: { type: "string" }, description: { type: "string" },
                },
              } },
              multiSelect: { type: "boolean" },
            },
          },
        },
      },
    },
    executionMode: "sequential",
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      if (!ctx.hasUI) return { content: [{ type: "text", text: "User questions require an interactive host. Continue with your best judgment." }] };
      // The RPC input dialog is the supported transport; its placeholder carries
      // the structured payload which our host turns into the shared question UI.
      const value = await ctx.ui.input(QUESTION_DIALOG, JSON.stringify({
        agentConsoleQuestions: 1, toolCallId, questions: params.questions,
      }), { signal });
      return { content: [{ type: "text", text: value === undefined
        ? "The user skipped these questions. Continue with your best judgment without asking them again."
        : value }] };
    },
  });
}

/**
 * The `ask_orchestrator` tool every provider offers its agent: the arguments a call carries and
 * the tool's name, description and JSON Schema. Codex gets it as a dynamic tool; agy gets it from
 * the `foreman mcp-question` MCP server. Provider-neutral, so both share one definition.
 */
import { Schema } from "effect";

/** Whether the agent is asking a question or reporting that it is blocked. */
export const QuestionKind = Schema.Literals(["question", "blocked"]);
export type QuestionKind = typeof QuestionKind.Type;

/** The arguments of one `ask_orchestrator` call; decoding drops undeclared arguments. */
export const AskOrchestratorArguments = Schema.Struct({
  question: Schema.String,
  kind: Schema.optionalKey(QuestionKind),
});

/** The `ask_orchestrator` tool definition, with an input schema that closes extra properties. */
export const askOrchestratorDefinition = {
  name: "ask_orchestrator",
  description:
    "Ask the orchestrator only when blocked by something the contract and code don't settle, or a decision with real consequences is needed. Progress, findings and corrections go in the hand-off: every call pauses the turn until answered. If no answer comes in time, you'll be told to continue without it; the answer arrives later as a message.",
  inputSchema: Schema.toJsonSchemaDocument(AskOrchestratorArguments, { onExcessProperty: "error" })
    .schema,
};

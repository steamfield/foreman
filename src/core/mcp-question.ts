/**
 * The pure half of `foreman mcp-question`, the stdio MCP server agy launches per session:
 * decoding MCP messages and `ask_orchestrator` calls, and building every reply the bridge
 * writes. The stdin/stdout loop and the daemon call live in src/commands/mcp-question.ts.
 * docs/rfcs/0002-providers.md "Questions on agy" is the design.
 */
import { Result, Schema } from "effect";
import { type AppError, errorTable } from "../errors";
// The bridge must offer agy exactly the tool Codex gets, so it shares Codex's definition.
// biome-ignore lint/plugin: the ask_orchestrator tool is shared by both providers, not a Codex wire type.
import { AskOrchestratorArguments, askOrchestratorTool } from "../schemas/codex";
import type { QuestionKind } from "../schemas/daemon";

/** The MCP protocol version the bridge offers when the client names none. */
export const DEFAULT_MCP_PROTOCOL_VERSION = "2025-06-18";

/** The tool result the model gets when the bridge can't reach the foreman daemon. */
export const ORCHESTRATOR_UNAVAILABLE =
  "The foreman orchestrator is unavailable. Continue without the answer, list the question under Open in your hand-off, and take no irreversible step that depends on it.";

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

const RequestId = Schema.Union([Schema.String, Schema.Number]);
type RequestId = typeof RequestId.Type;

const McpMessage = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.optionalKey(Schema.NullOr(RequestId)),
    method: Schema.optionalKey(Schema.String),
    params: Schema.optionalKey(Schema.Unknown),
  }),
);
const InitializeParams = Schema.Struct({ protocolVersion: Schema.optionalKey(Schema.String) });
const ToolCallParams = Schema.Struct({
  name: Schema.String,
  arguments: Schema.optionalKey(Schema.Unknown),
});

const decodeMessage = Schema.decodeUnknownResult(McpMessage);
const decodeInitialize = Schema.decodeUnknownResult(InitializeParams);
const decodeToolCall = Schema.decodeUnknownResult(ToolCallParams);
// Undeclared arguments, such as the `toolSummary` agy adds, are dropped rather than refused.
const decodeArguments = Schema.decodeUnknownResult(AskOrchestratorArguments);

/** One JSON-RPC 2.0 response line's value. */
export type McpResponse =
  | { readonly jsonrpc: "2.0"; readonly id: RequestId; readonly result: unknown }
  | {
      readonly jsonrpc: "2.0";
      readonly id: RequestId;
      readonly error: { readonly code: number; readonly message: string };
    };

/** What the bridge does with one stdin line. */
export type McpStep =
  | { readonly _tag: "Reply"; readonly response: McpResponse }
  | {
      readonly _tag: "Ask";
      readonly id: RequestId;
      readonly question: string;
      readonly kind: QuestionKind;
    }
  | { readonly _tag: "Ignore" }
  | { readonly _tag: "Malformed"; readonly detail: string };

/** How the daemon settled one `Ask`. */
export type AskOutcome =
  | { readonly _tag: "Answered"; readonly text: string }
  | { readonly _tag: "Refused"; readonly reason: string }
  | { readonly _tag: "Unavailable" };

const result = (id: RequestId, value: unknown): McpResponse => ({
  jsonrpc: "2.0",
  id,
  result: value,
});
const failure = (id: RequestId, code: number, message: string): McpResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});
const reply = (response: McpResponse): McpStep => ({ _tag: "Reply", response });

/** The `tools/list` entry for `ask_orchestrator`, with Codex's description and input schema. */
export const askOrchestratorDefinition = {
  name: askOrchestratorTool.name,
  description: askOrchestratorTool.description,
  inputSchema: askOrchestratorTool.inputSchema,
};

function initializeResult(params: unknown, version: string) {
  const decoded = decodeInitialize(params ?? {});
  const requested = Result.isSuccess(decoded) ? decoded.success.protocolVersion : undefined;
  return {
    protocolVersion: requested ?? DEFAULT_MCP_PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: "foreman", version },
  };
}

function toolCallStep(id: RequestId, params: unknown): McpStep {
  const call = decodeToolCall(params);
  if (Result.isFailure(call))
    return reply(failure(id, INVALID_PARAMS, "tools/call needs params {name, arguments}."));
  if (call.success.name !== askOrchestratorTool.name)
    return reply(
      failure(
        id,
        INVALID_PARAMS,
        `Unknown tool "${call.success.name}"; this server has only ${askOrchestratorTool.name}.`,
      ),
    );
  const args = decodeArguments(call.success.arguments ?? {});
  if (Result.isFailure(args))
    return reply(
      failure(
        id,
        INVALID_PARAMS,
        `${askOrchestratorTool.name} needs arguments {question: string, kind?: "question" | "blocked"}.`,
      ),
    );
  return {
    _tag: "Ask",
    id,
    question: args.success.question,
    kind: args.success.kind ?? "question",
  };
}

/**
 * Decides what to do with one stdin line: reply at once, forward an `ask_orchestrator` call to
 * the daemon, ignore a notification or response, or report a line that isn't a JSON-RPC message.
 * `version` is foreman's version for `serverInfo`.
 */
export function stepForLine(line: string, version: string): McpStep {
  const decoded = decodeMessage(line);
  if (Result.isFailure(decoded))
    return { _tag: "Malformed", detail: "the line is not a JSON-RPC 2.0 object" };
  const { id, method, params } = decoded.success;
  // Notifications have no id and responses have no method; neither gets a reply.
  if (id === undefined || id === null || method === undefined) return { _tag: "Ignore" };
  switch (method) {
    case "initialize":
      return reply(result(id, initializeResult(params, version)));
    case "ping":
      return reply(result(id, {}));
    case "tools/list":
      return reply(result(id, { tools: [askOrchestratorDefinition] }));
    case "tools/call":
      return toolCallStep(id, params);
    default:
      return reply(failure(id, METHOD_NOT_FOUND, `Method not found: ${method}`));
  }
}

/**
 * Classifies a failed daemon `Ask`: a daemon that can't be reached or can't be used is
 * unavailable; any other tagged error is the run refusing the question, with its detail.
 */
export function outcomeForError(error: AppError): AskOutcome {
  if (error._tag === "DaemonUnavailable" || error._tag === "PermissionDenied")
    return { _tag: "Unavailable" };
  const detail = "detail" in error ? error.detail : undefined;
  return { _tag: "Refused", reason: detail ?? errorTable[error._tag].message };
}

/** Builds the `tools/call` response for a settled `Ask`: text, or text flagged `isError`. */
export function askReply(id: RequestId, outcome: AskOutcome): McpResponse {
  switch (outcome._tag) {
    case "Answered":
      return result(id, { content: [{ type: "text", text: outcome.text }] });
    case "Refused":
      return result(id, { content: [{ type: "text", text: outcome.reason }], isError: true });
    case "Unavailable":
      return result(id, {
        content: [{ type: "text", text: ORCHESTRATOR_UNAVAILABLE }],
        isError: true,
      });
  }
}

import { Schema } from "effect";

// The `codex app-server` messages forman sends and reads, for Codex 0.166.0 with the
// experimental API. Only the fields forman uses are declared. Decoding ignores fields Codex
// adds; a field it removes fails decoding. src/codex/protocol.ts records the Codex version
// and protocol schema these were written from.

export const CodexThreadId = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand("CodexThreadId"),
);
export type CodexThreadId = typeof CodexThreadId.Type;
export const CodexTurnId = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand("CodexTurnId"),
);
export type CodexTurnId = typeof CodexTurnId.Type;

export const Method = {
  initialize: "initialize",
  initialized: "initialized",
  hooksList: "hooks/list",
  threadStart: "thread/start",
  threadResume: "thread/resume",
  turnStart: "turn/start",
  turnSteer: "turn/steer",
  turnInterrupt: "turn/interrupt",
  turnStarted: "turn/started",
  turnCompleted: "turn/completed",
  itemStarted: "item/started",
  itemCompleted: "item/completed",
  tokenUsageUpdated: "thread/tokenUsage/updated",
  error: "error",
  hookStarted: "hook/started",
  hookCompleted: "hook/completed",
  mcpStartupStatus: "mcpServer/startupStatus/updated",
  toolCall: "item/tool/call",
} as const;

// JSON-RPC 2.0 over JSON lines. A line with `method` and `id` is a server request, with
// `method` alone a notification, with `id` alone a response to one of forman's requests.
export const RpcId = Schema.Union([Schema.Number, Schema.String]);
export type RpcId = typeof RpcId.Type;
export const RpcError = Schema.Struct({
  code: Schema.Number,
  message: Schema.String,
  data: Schema.optionalKey(Schema.Unknown),
});
export const RpcResponse = Schema.Struct({
  id: RpcId,
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(RpcError),
});
export const RpcNotification = Schema.Struct({
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
});
export const RpcServerRequest = Schema.Struct({
  id: RpcId,
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
});

// Requests forman sends.

export const InitializeParams = Schema.Struct({
  clientInfo: Schema.Struct({ name: Schema.String, title: Schema.String, version: Schema.String }),
  capabilities: Schema.Struct({ experimentalApi: Schema.Boolean }),
});

export const SandboxMode = Schema.Literals(["read-only", "danger-full-access"]);
export type SandboxMode = typeof SandboxMode.Type;

export const DynamicToolSpec = Schema.Struct({
  type: Schema.Literal("function"),
  name: Schema.String,
  description: Schema.String,
  inputSchema: Schema.Record(Schema.String, Schema.Unknown),
});

const ThreadSettings = {
  cwd: Schema.String,
  model: Schema.String,
  serviceTier: Schema.String,
  approvalPolicy: Schema.Literal("never"),
  sandbox: SandboxMode,
};

export const ThreadStartParams = Schema.Struct({
  ...ThreadSettings,
  ephemeral: Schema.Literal(false),
  dynamicTools: Schema.Array(DynamicToolSpec),
});

// thread/resume takes no dynamicTools. Every setting is passed again so nothing falls back
// to the user's config.toml defaults.
export const ThreadResumeParams = Schema.Struct({ threadId: CodexThreadId, ...ThreadSettings });

export const TextInput = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

export const SandboxPolicy = Schema.Union([
  Schema.Struct({ type: Schema.Literal("dangerFullAccess") }),
  Schema.Struct({ type: Schema.Literal("readOnly"), networkAccess: Schema.Boolean }),
  Schema.Struct({ type: Schema.String }),
]);

// effort and sandboxPolicy apply to this turn and every later turn on the thread.
export const TurnStartParams = Schema.Struct({
  threadId: CodexThreadId,
  input: Schema.Array(TextInput),
  effort: Schema.optionalKey(Schema.String),
  sandboxPolicy: Schema.optionalKey(SandboxPolicy),
});

export const TurnSteerParams = Schema.Struct({
  threadId: CodexThreadId,
  expectedTurnId: CodexTurnId,
  input: Schema.Array(TextInput),
});

export const TurnInterruptParams = Schema.Struct({ threadId: CodexThreadId, turnId: CodexTurnId });

// Responses to those requests.

export const ThreadOpened = Schema.Struct({
  thread: Schema.Struct({ id: CodexThreadId }),
  model: Schema.String,
  serviceTier: Schema.NullOr(Schema.String),
  cwd: Schema.String,
  sandbox: SandboxPolicy,
});

// Open on purpose: Codex adds error kinds, and some carry an object.
export const CodexErrorInfo = Schema.Union([
  Schema.String,
  Schema.Record(Schema.String, Schema.Unknown),
]);
export type CodexErrorInfo = typeof CodexErrorInfo.Type;

export const TurnError = Schema.Struct({
  message: Schema.String,
  codexErrorInfo: Schema.NullOr(CodexErrorInfo),
});
export type TurnError = typeof TurnError.Type;

export const TurnStatus = Schema.Literals(["completed", "interrupted", "failed", "inProgress"]);
export type TurnStatus = typeof TurnStatus.Type;

export const CommandExecutionItem = Schema.Struct({
  type: Schema.Literal("commandExecution"),
  id: Schema.String,
  command: Schema.String,
  status: Schema.Literals(["inProgress", "completed", "failed", "declined"]),
  aggregatedOutput: Schema.NullOr(Schema.String),
  exitCode: Schema.NullOr(Schema.Number),
});
export const AgentMessageItem = Schema.Struct({
  type: Schema.Literal("agentMessage"),
  id: Schema.String,
  text: Schema.String,
  phase: Schema.NullOr(Schema.String),
});
export const FileChangeItem = Schema.Struct({
  type: Schema.Literal("fileChange"),
  id: Schema.String,
  changes: Schema.Array(Schema.Struct({ path: Schema.String })),
});
export const DynamicToolCallItem = Schema.Struct({
  type: Schema.Literal("dynamicToolCall"),
  id: Schema.String,
  tool: Schema.String,
  status: Schema.String,
});
// Any other item type: userMessage, reasoning, plan, mcpToolCall and whatever Codex adds.
export const OtherItem = Schema.Struct({
  type: Schema.String.check(
    Schema.makeFilter(
      (type) =>
        ![
          CommandExecutionItem.fields.type.literal,
          AgentMessageItem.fields.type.literal,
          FileChangeItem.fields.type.literal,
          DynamicToolCallItem.fields.type.literal,
        ].some((known) => known === type),
    ),
  ),
  id: Schema.String,
});
export const ThreadItem = Schema.Union([
  CommandExecutionItem,
  AgentMessageItem,
  FileChangeItem,
  DynamicToolCallItem,
  OtherItem,
]);
export type ThreadItem = typeof ThreadItem.Type;

export const Turn = Schema.Struct({
  id: CodexTurnId,
  status: TurnStatus,
  error: Schema.NullOr(TurnError),
  items: Schema.Array(ThreadItem),
});
export type Turn = typeof Turn.Type;

export const TurnStartResponse = Schema.Struct({ turn: Turn });
export const TurnSteerResponse = Schema.Struct({ turnId: CodexTurnId });

// Notifications.

export const TurnNotification = Schema.Struct({ threadId: CodexThreadId, turn: Turn });

// Used when TurnNotification fails to decode, so a schema change can't leave a run running.
export const TurnNotificationMinimal = Schema.Struct({
  threadId: CodexThreadId,
  turn: Schema.Struct({ id: CodexTurnId, status: Schema.String }),
});

export const ItemNotification = Schema.Struct({
  threadId: CodexThreadId,
  turnId: CodexTurnId,
  item: ThreadItem,
});

// Hook enforcement fails closed on the item type alone, whatever else Codex changes.
export const ItemKind = Schema.Struct({ item: Schema.Struct({ type: Schema.String }) });

// Recovering an unconfirmed turn start needs the turn's identity.
export const ItemNotificationMinimal = Schema.Struct({
  threadId: CodexThreadId,
  turnId: CodexTurnId,
  item: Schema.Struct({ type: Schema.String, id: Schema.String }),
});

export const TokenUsageBreakdown = Schema.Struct({
  totalTokens: Schema.Number,
  inputTokens: Schema.Number,
  cachedInputTokens: Schema.Number,
  outputTokens: Schema.Number,
  reasoningOutputTokens: Schema.Number,
});
export type TokenUsageBreakdown = typeof TokenUsageBreakdown.Type;

// `total` is cumulative for the thread.
export const TokenUsageNotification = Schema.Struct({
  threadId: CodexThreadId,
  turnId: CodexTurnId,
  tokenUsage: Schema.Struct({ total: TokenUsageBreakdown, last: TokenUsageBreakdown }),
});

// `willRetry: true` is Codex reconnecting on its own.
export const ErrorNotification = Schema.Struct({
  threadId: CodexThreadId,
  turnId: CodexTurnId,
  error: TurnError,
  willRetry: Schema.Boolean,
});

export const HookNotification = Schema.Struct({
  threadId: CodexThreadId,
  turnId: Schema.NullOr(CodexTurnId),
  run: Schema.Struct({
    id: Schema.String,
    eventName: Schema.String,
    source: Schema.String,
    sourcePath: Schema.String,
    status: Schema.String,
    entries: Schema.Array(Schema.Struct({ kind: Schema.String, text: Schema.String })),
  }),
});

export const McpStartupNotification = Schema.Struct({
  threadId: Schema.NullOr(CodexThreadId),
  name: Schema.String,
  status: Schema.String,
  error: Schema.NullOr(Schema.String),
});

// Server requests: item/tool/call is the only one forman answers successfully.

export const ToolCallParams = Schema.Struct({
  threadId: CodexThreadId,
  turnId: CodexTurnId,
  callId: Schema.String,
  namespace: Schema.NullOr(Schema.String),
  tool: Schema.String,
  arguments: Schema.Unknown,
});

export const ToolCallResponse = Schema.Struct({
  success: Schema.Boolean,
  contentItems: Schema.Array(
    Schema.Struct({ type: Schema.Literal("inputText"), text: Schema.String }),
  ),
});

// The ask_orchestrator tool.

export const QuestionKind = Schema.Literals(["question", "blocked"]);
export type QuestionKind = typeof QuestionKind.Type;

export const AskOrchestratorArguments = Schema.Struct({
  question: Schema.String,
  kind: Schema.optionalKey(QuestionKind),
});

export const askOrchestratorTool: typeof DynamicToolSpec.Type = {
  type: "function",
  name: "ask_orchestrator",
  description:
    "Ask the orchestrator only when blocked by something the contract and code don't settle, or a decision with real consequences is needed. Progress, findings and corrections go in the hand-off: every call pauses the turn until answered. If the answer times out, proceed with best judgment and note the question and choice under Open.",
  inputSchema: Schema.toJsonSchemaDocument(AskOrchestratorArguments, { onExcessProperty: "error" })
    .schema,
};

// Repo hook trust, resolved by Codex for each requested working directory.
export const HooksListParams = Schema.Struct({ cwds: Schema.Array(Schema.String) });
export const HookMetadata = Schema.Struct({
  key: Schema.String,
  source: Schema.String,
  currentHash: Schema.String,
  trustStatus: Schema.String,
});
export const HooksListResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      cwd: Schema.String,
      hooks: Schema.Array(HookMetadata),
      warnings: Schema.Array(Schema.String),
      errors: Schema.Array(Schema.Struct({ path: Schema.String, message: Schema.String })),
    }),
  ),
});

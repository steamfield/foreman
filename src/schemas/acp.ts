import { Schema } from "effect";

// The `agy acp` (Agent Client Protocol) messages foreman reads, written against agy 1.5.14
// (tests/fixtures/agy-1.5.14.jsonl). Only the fields foreman uses are declared. Decoding
// ignores fields agy adds; a field it removes fails decoding. Fields agy leaves out of some
// messages (a tool_call_update often repeats only the id, kind and status) are optional.

export const Method = {
  initialize: "initialize",
  sessionNew: "session/new",
  setConfigOption: "session/set_config_option",
  setMode: "session/set_mode",
  prompt: "session/prompt",
  cancel: "session/cancel",
  update: "session/update",
  requestPermission: "session/request_permission",
} as const;

/** The `initialize` reply: the protocol agy speaks and its version. */
export const InitializeResult = Schema.Struct({
  protocolVersion: Schema.Number,
  agentInfo: Schema.optionalKey(Schema.Struct({ version: Schema.String })),
});
export type InitializeResult = typeof InitializeResult.Type;

/** The `session/new` reply. */
export const SessionNewResult = Schema.Struct({ sessionId: Schema.String });

/** Token counts on a `session/prompt` reply; agy splits them across merged prompts. */
export const PromptUsage = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cachedReadTokens: Schema.optionalKey(Schema.Number),
  thoughtTokens: Schema.optionalKey(Schema.Number),
});
export type PromptUsage = typeof PromptUsage.Type;

/** The `session/prompt` reply, which ends the turn. */
export const PromptResult = Schema.Struct({
  stopReason: Schema.String,
  usage: Schema.optionalKey(PromptUsage),
});
export type PromptResult = typeof PromptResult.Type;

/** A file a tool call touches. */
export const ToolLocation = Schema.Struct({ path: Schema.String });

/** One entry of a tool call's `content`; diffs carry the edited path. */
export const DiffContent = Schema.Struct({ type: Schema.Literal("diff"), path: Schema.String });

/** A shell command's result on an execute call. */
export const RawOutput = Schema.Struct({
  output: Schema.optionalKey(Schema.String),
  exit_code: Schema.optionalKey(Schema.Number),
});

/** The tool call fields of `tool_call`, `tool_call_update` and permission requests. */
export const ToolCall = Schema.Struct({
  toolCallId: Schema.String,
  name: Schema.optionalKey(Schema.String),
  kind: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  rawOutput: Schema.optionalKey(RawOutput),
  // Entries other than diffs are skipped, so content is decoded entry by entry.
  content: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  locations: Schema.optionalKey(Schema.Array(ToolLocation)),
});
export type ToolCall = typeof ToolCall.Type;

/** A text chunk of the agent's message. Non-text chunks carry no `text`. */
export const MessageChunk = Schema.Struct({
  content: Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) }),
});

/** The envelope of every `session/update`; `sessionUpdate` names the kind. */
export const SessionUpdate = Schema.Struct({
  sessionId: Schema.String,
  update: Schema.Struct({ sessionUpdate: Schema.String }),
});

/** Any message that names a session, for routing messages foreman doesn't otherwise read. */
export const SessionEnvelope = Schema.Struct({ sessionId: Schema.String });

/** An option agy offers on a permission request. */
export const PermissionOption = Schema.Struct({ optionId: Schema.String, kind: Schema.String });

/** `session/request_permission` params. */
export const PermissionRequest = Schema.Struct({
  sessionId: Schema.String,
  toolCall: ToolCall,
  options: Schema.Array(PermissionOption),
});
export type PermissionRequest = typeof PermissionRequest.Type;

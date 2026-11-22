import { Schema } from "effect";

// The script a fake `agy acp` plays in tests. Tests point AGY_BIN at the fake and pass the
// scenario file in FAKE_ACP_SCENARIO. The fake speaks JSON-RPC over JSON lines on stdio like
// the real agent, answers `initialize` on its own (with FAKE_ACP_PROTOCOL as the protocol
// version, default 1), and appends every line it receives to FAKE_ACP_LOG (when set).
//
// Steps match the fake app server's steps (notify, request, awaitResponse, awaitRequest, sleepMs,
// stderr, writeFile, gate, exit). `awaitRequest` also matches notifications such as
// `session/cancel`.
//
// For each request foreman sends, the fake picks the first unused rule whose `method` matches
// and whose `when` is a subset of the params. Unlike Codex, an ACP prompt's reply ends the
// turn, so a rule with `respondAfterSteps` plays its steps first and replies afterwards.
// Requests with no rule get a default: `session/new` and `session/load|resume` reply with a
// session id, `session/set_config_option` and `session/set_mode` reply `{}`, and anything else
// gets JSON-RPC error -32601.
//
// MCP steps drive the stdio MCP server foreman passed in `mcpServers`, as agy does for
// ask_orchestrator:
//   mcpCall: {tool, arguments, label}   launches the first stdio server of the most recent
//                  session/new|load|resume with its command, args and env (on top of the fake's
//                  own environment), sends `initialize` and `notifications/initialized`, then
//                  `tools/call {name: tool, arguments}`. It does not wait: the call runs while
//                  the following steps play. Each call gets its own server child.
//   awaitMcpResult: {label, timeoutMs?}   waits until that call ends, or the timeout passes.
//   killMcp: label   kills that call's server child with SIGKILL, mid-call.
// Every call's outcome is appended to FAKE_ACP_MCP_LOG (when set) as one line:
// `{label, response}` with the JSON-RPC response to tools/call (or to initialize when that
// failed), or `{label, exited: {code, signal}}` when the server exited first. The fake closes
// a server's stdin once its call ended, and kills every server child when it exits itself.
//
// Placeholders in params and results, replaced before sending:
//   {{session}}   the id of the most recent session/new (or the session a load named)
//   {{seq}}       a counter that increases on every use
//   {{cwd}}       the cwd of the most recent session/new

const Json = Schema.Unknown;

// The fake app server's steps, repeated here because Node's type stripping can't follow an
// extensionless import into the other fixture.
export const Step = Schema.Union([
  Schema.Struct({ notify: Schema.String, params: Json }),
  Schema.Struct({ request: Schema.String, params: Json, label: Schema.String }),
  Schema.Struct({ awaitResponse: Schema.String, timeoutMs: Schema.optionalKey(Schema.Int) }),
  Schema.Struct({ awaitRequest: Schema.String, timeoutMs: Schema.optionalKey(Schema.Int) }),
  Schema.Struct({ sleepMs: Schema.Int }),
  Schema.Struct({ stderr: Schema.String }),
  Schema.Struct({ writeFile: Schema.String, text: Schema.String }),
  Schema.Struct({ gate: Schema.Struct({ ready: Schema.String, release: Schema.String }) }),
  Schema.Struct({ exit: Schema.Int }),
  Schema.Struct({
    mcpCall: Schema.Struct({ tool: Schema.String, arguments: Json, label: Schema.String }),
  }),
  Schema.Struct({
    awaitMcpResult: Schema.Struct({
      label: Schema.String,
      timeoutMs: Schema.optionalKey(Schema.Int),
    }),
  }),
  Schema.Struct({ killMcp: Schema.String }),
]);
export type Step = typeof Step.Type;

export const AcpRule = Schema.Struct({
  method: Schema.String,
  when: Schema.optionalKey(Schema.Record(Schema.String, Json)),
  repeat: Schema.optionalKey(Schema.Boolean),
  delayMs: Schema.optionalKey(Schema.Int),
  respondAfterSteps: Schema.optionalKey(Schema.Boolean),
  respond: Schema.Union([
    Schema.Struct({ result: Json }),
    Schema.Struct({ error: Schema.Struct({ code: Schema.Int, message: Schema.String }) }),
    Schema.Literal("none"),
  ]),
  steps: Schema.optionalKey(Schema.Array(Step)),
});
export type AcpRule = typeof AcpRule.Type;

export const AcpScenario = Schema.Struct({
  rules: Schema.Array(AcpRule),
});
export type AcpScenario = typeof AcpScenario.Type;

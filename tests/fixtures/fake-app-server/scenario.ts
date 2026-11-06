import { Schema } from "effect";

// The script a fake `codex app-server` plays in tests. Tests point CODEX_BIN at the fake and
// pass the scenario file in FAKE_APP_SERVER_SCENARIO. The fake speaks JSON-RPC over JSON lines
// on stdio exactly like the real server, answers `initialize` on its own, and appends every
// line it receives to FAKE_APP_SERVER_LOG (when set) so a test can assert what foreman sent,
// including responses the real server would silently drop.
//
// For each request foreman sends, the fake picks the first unused rule whose `method` matches
// and whose `when` is a subset of the request's params (deep partial match), responds as the
// rule says, then plays the rule's `steps` in order. A rule is used once unless `repeat` is
// true. A request no rule matches gets JSON-RPC error -32601.
//
// Strings in `respond` and in step params may use placeholders, replaced before sending:
//   {{thread}}      the thread id of the most recent thread/start or thread/resume
//   {{turn}}        the turn id of the most recent turn/start
//   {{seq}}         a counter that increases on every use, for unique item and call ids
// The fake makes ids itself (UUID-shaped) for thread/start and turn/start responses when the
// rule's result doesn't give one.

const Json = Schema.Unknown;

export const Step = Schema.Union([
  // A notification from the server.
  Schema.Struct({ notify: Schema.String, params: Json }),
  // A server-to-client request (item/tool/call). `label` names it for awaitResponse.
  Schema.Struct({ request: Schema.String, params: Json, label: Schema.String }),
  // Wait until foreman responds to the labelled request, or until `timeoutMs` passes, then go on.
  Schema.Struct({ awaitResponse: Schema.String, timeoutMs: Schema.optionalKey(Schema.Int) }),
  // Wait until foreman sends a request with this method (the rule matching it still answers it).
  Schema.Struct({ awaitRequest: Schema.String, timeoutMs: Schema.optionalKey(Schema.Int) }),
  Schema.Struct({ sleepMs: Schema.Int }),
  Schema.Struct({ stderr: Schema.String }),
  // Exit the process with this code, as an app server crash.
  Schema.Struct({ exit: Schema.Int }),
]);
export type Step = typeof Step.Type;

export const Rule = Schema.Struct({
  method: Schema.String,
  when: Schema.optionalKey(Schema.Record(Schema.String, Json)),
  repeat: Schema.optionalKey(Schema.Boolean),
  // Wait this long before sending the response, without blocking other requests, so a later
  // request's response can arrive first. The rule's steps start after the response is sent.
  delayMs: Schema.optionalKey(Schema.Int),
  // Mark entry, then hold the response until the release FIFO is written.
  gate: Schema.optionalKey(Schema.Struct({ ready: Schema.String, release: Schema.String })),
  // `none` sends no response, for request-timeout tests.
  respond: Schema.Union([
    Schema.Struct({ result: Json }),
    Schema.Struct({ error: Schema.Struct({ code: Schema.Int, message: Schema.String }) }),
    Schema.Literal("none"),
  ]),
  // Steps play concurrently with later requests: a held tool call doesn't block turn/steer.
  steps: Schema.optionalKey(Schema.Array(Step)),
});
export type Rule = typeof Rule.Type;

export const Scenario = Schema.Struct({
  // Steps played once right after `initialized`, before any rule.
  onStart: Schema.optionalKey(Schema.Array(Step)),
  rules: Schema.Array(Rule),
});
export type Scenario = typeof Scenario.Type;

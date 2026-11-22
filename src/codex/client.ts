/**
 * The Codex app-server client: a thin layer over the shared JSON-RPC channel.
 *
 * Adds Codex's launch command, param encoding for known methods, the initialize handshake and
 * the mapping of channel errors to Codex's own error types.
 */
import { Data, type Duration, Effect, Schema } from "effect";
import { CodexUnavailable } from "../errors";
import {
  type ChannelEnd,
  openChannel,
  type RpcError,
  type RpcId,
  type RpcRequestTimeout,
} from "../providers/jsonrpc";
import {
  InitializeParams,
  Method,
  ThreadNameSetParams,
  ThreadResumeParams,
  ThreadStartParams,
  TurnInterruptParams,
  TurnStartParams,
  TurnSteerParams,
} from "../schemas/codex";

/** Codex answered a request with a JSON-RPC error. */
export class CodexRpcError extends Schema.TaggedError<CodexRpcError>()("CodexRpcError", {
  code: Schema.Number,
  message: Schema.String,
}) {}

/** Internal signal: the supervisor maps it to the existing public CodexUnavailable error. */
export class CodexRequestTimeout extends Data.TaggedError("CodexRequestTimeout")<{
  readonly method: string;
  readonly timeoutMs: number;
}> {}

const APP_SERVER_ARGS = ["app-server", "--listen", "stdio://"];
// The supervisor recognizes a deliberate close by this detail.
const CLOSED_DETAIL = "app server connection closed";

const paramsSchemas: Readonly<Record<string, Schema.ConstraintEncoder<unknown>>> = {
  [Method.initialize]: InitializeParams,
  [Method.threadStart]: ThreadStartParams,
  [Method.threadResume]: ThreadResumeParams,
  [Method.threadNameSet]: ThreadNameSetParams,
  [Method.turnStart]: TurnStartParams,
  [Method.turnSteer]: TurnSteerParams,
  [Method.turnInterrupt]: TurnInterruptParams,
};

/** Today's user-facing wording for each way the app-server channel can fail. */
const failureDetail = (codexBin: string, end: Extract<ChannelEnd, { _tag: "Failed" }>): string => {
  switch (end.reason) {
    case "launch":
      return `Could not launch ${JSON.stringify(codexBin)}. Install Codex or set CODEX_BIN to an executable, then run foreman doctor.`;
    case "encode":
      return "could not encode app server message";
    case "decode":
      return "invalid app server JSON-RPC message";
    case "stdin":
    case "stdout":
    case "stderr":
      return `app server ${end.reason} failed`;
    case "exit":
      return `app server exited with code ${end.exitCode}`;
    case "observe-exit":
      return "could not observe app server exit";
  }
};

const codexUnavailable = (codexBin: string) => (end: ChannelEnd) =>
  new CodexUnavailable({
    detail: end._tag === "Closed" ? CLOSED_DETAIL : failureDetail(codexBin, end),
  });

// `hasOwn` keeps prototype names such as "constructor" from selecting a schema.
const encodeParams = (method: string, params: unknown) =>
  Schema.encodeUnknownEffect(
    Object.hasOwn(paramsSchemas, method)
      ? (paramsSchemas[method] ?? Schema.Unknown)
      : Schema.Unknown,
  )(params);

const toCodexError = (error: RpcError | RpcRequestTimeout) =>
  error._tag === "RpcError"
    ? new CodexRpcError({ code: error.code, message: error.message })
    : new CodexRequestTimeout({ method: error.method, timeoutMs: error.timeoutMs });

/** Settings for one app-server process. */
export type ConnectionOptions = {
  codexBin: string;
  env: Readonly<Record<string, string>>;
  version: string;
  stderr: (line: string) => Effect.Effect<void>;
};

/**
 * Starts `codex app-server` and completes the initialize handshake, closed with the scope.
 * Single-consumer streams buffer even messages sent during initialization.
 * @throws {CodexUnavailable} When Codex can't be launched, exits, or the connection ends.
 * @throws {CodexRpcError} When Codex rejects the initialize request.
 * @throws {CodexRequestTimeout} When Codex doesn't answer initialize within 30 seconds.
 * @throws {Schema.SchemaError} When params or a result don't match their schema.
 */
export const openConnection = Effect.fn("codex.openConnection")(function* (
  options: ConnectionOptions,
) {
  const channel = yield* openChannel({
    command: options.codexBin,
    args: APP_SERVER_ARGS,
    env: options.env,
    stderr: options.stderr,
    unavailable: codexUnavailable(options.codexBin),
  });
  const request = <A, I, R>(
    method: string,
    params: unknown,
    result: Schema.Codec<A, I, R>,
    requestOptions: { timeout?: Duration.Input } = {},
  ) =>
    encodeParams(method, params).pipe(
      Effect.flatMap((encoded) => channel.request(method, encoded, result, requestOptions)),
      Effect.catchTag(["RpcError", "RpcRequestTimeout"], (error) =>
        Effect.fail(toCodexError(error)),
      ),
    );

  yield* request(
    Method.initialize,
    {
      clientInfo: { name: "foreman", title: "foreman", version: options.version },
      capabilities: { experimentalApi: true },
    },
    Schema.Unknown,
  );
  yield* channel.notify(Method.initialized);
  return {
    request,
    notifications: channel.notifications,
    serverRequests: channel.serverRequests,
    respond: (id: RpcId, result: unknown) => channel.respond(id, result),
    respondError: (id: RpcId, code: number, message: string) =>
      channel.respondError(id, code, message),
    exitCode: channel.exitCode,
    termination: channel.termination,
  };
});

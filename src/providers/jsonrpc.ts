/**
 * Newline-delimited JSON-RPC 2.0 over a child process's stdio, shared by every provider.
 *
 * Owns the child's lifetime within the caller's scope, request ids and timeouts, routing of
 * incoming lines into responses, notifications and server requests, and stderr forwarding.
 * It knows no provider methods: callers encode params and decode results with their own schemas.
 */
import {
  type Cause,
  Data,
  type Duration,
  type Effect,
  Schema,
  type Scope,
  type Stream,
} from "effect";
import type { ChildProcessSpawner } from "effect/process";

/** The agent answered a request with a JSON-RPC error. */
export class RpcError extends Schema.TaggedError<RpcError>()("RpcError", {
  code: Schema.Number,
  message: Schema.String,
}) {}

/** A request got no reply in time. Callers map it to their provider's unavailable error. */
export class RpcRequestTimeout extends Data.TaggedError("RpcRequestTimeout")<{
  readonly method: string;
  readonly timeoutMs: number;
}> {}

/** Why a channel ended: a deliberate close, or a failure with a provider-facing detail. */
export type ChannelEnd =
  | { readonly _tag: "Closed" }
  | { readonly _tag: "Failed"; readonly detail: string };

export const RpcId = Schema.Union([Schema.Number, Schema.String]);
export type RpcId = typeof RpcId.Type;
export const RpcNotification = Schema.Struct({
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
});
export type RpcNotification = typeof RpcNotification.Type;
export const RpcServerRequest = Schema.Struct({
  id: RpcId,
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
});
export type RpcServerRequest = typeof RpcServerRequest.Type;

export interface ChannelOptions<E> {
  readonly command: string;
  readonly args: readonly string[];
  /** The child's working directory; the caller's when omitted. */
  readonly cwd?: string;
  /** The complete child environment; nothing is inherited. */
  readonly env: Readonly<Record<string, string>>;
  readonly stderr: (line: string) => Effect.Effect<void>;
  /** Builds the caller's public error from a channel end (launch failure, exit, bad line). */
  readonly unavailable: (end: ChannelEnd) => E;
}

export interface RequestOptions {
  /** Defaults to 30 seconds; `"none"` waits for as long as the channel lives. */
  readonly timeout?: Duration.Input | "none";
}

export interface Channel<E> {
  /**
   * Sends a request with already-encoded params and decodes the result.
   * @throws {RpcError} When the agent replies with an error.
   * @throws {RpcRequestTimeout} When no reply arrives within the timeout.
   */
  readonly request: <A, I, R>(
    method: string,
    params: unknown,
    result: Schema.Codec<A, I, R>,
    options?: RequestOptions,
  ) => Effect.Effect<A, E | RpcError | RpcRequestTimeout | Schema.SchemaError, R>;
  readonly notify: (method: string, params?: unknown) => Effect.Effect<void, E>;
  readonly respond: (id: RpcId, result: unknown) => Effect.Effect<void, E>;
  readonly respondError: (id: RpcId, code: number, message: string) => Effect.Effect<void, E>;
  /** Single-consumer; buffers messages that arrive before it is consumed. */
  readonly notifications: Stream.Stream<RpcNotification, E>;
  /** Single-consumer; buffers messages that arrive before it is consumed. */
  readonly serverRequests: Stream.Stream<RpcServerRequest, E>;
  readonly exitCode: Effect.Effect<number, E>;
  /** Resolves with the end cause once the channel stops, deliberately or not. */
  readonly termination: Effect.Effect<Cause.Cause<E>>;
}

/**
 * Spawns the command and opens a channel on its stdio, closed with the caller's scope.
 * @throws E (from `unavailable`) When the command can't be launched.
 */
export const openChannel = <E>(
  _options: ChannelOptions<E>,
): Effect.Effect<Channel<E>, E, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner> => {
  throw new Error("not implemented");
};

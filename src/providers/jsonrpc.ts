/**
 * Newline-delimited JSON-RPC 2.0 over a child process's stdio, shared by every provider.
 *
 * Owns the child's lifetime within the caller's scope, request ids and timeouts, routing of
 * incoming lines into responses, notifications and server requests, and stderr forwarding.
 * It knows no provider methods: callers encode params and decode results with their own schemas.
 */
import {
  Cause,
  Data,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Queue,
  Schema,
  type Scope,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

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

/** A JSON-RPC request id; the channel numbers its own requests, agents may use strings. */
export const RpcId = Schema.Union([Schema.Number, Schema.String]);
export type RpcId = typeof RpcId.Type;
/** A message from the agent with a method and no id. */
export const RpcNotification = Schema.Struct({
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
});
export type RpcNotification = typeof RpcNotification.Type;
/** A request from the agent that expects `respond` or `respondError` with its id. */
export const RpcServerRequest = Schema.Struct({
  id: RpcId,
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
});
export type RpcServerRequest = typeof RpcServerRequest.Type;

/** How to start the child and how to turn a channel end into the caller's error. */
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

/** Per-request settings. */
export interface RequestOptions {
  /** Defaults to 30 seconds; `"none"` waits for as long as the channel lives. */
  readonly timeout?: Duration.Input | "none";
}

/** An open JSON-RPC conversation with one child process. */
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

const DEFAULT_REQUEST_TIMEOUT = "30 seconds";
const FORCE_KILL_AFTER = "2 seconds";
// After the child exits, its stdout and stderr may still hold lines; wait this long for them.
const DRAIN_AFTER_EXIT = "2 seconds";

const JsonLine = Schema.fromJsonString(Schema.Unknown);
const RpcResponse = Schema.Struct({
  id: RpcId,
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Struct({ code: Schema.Number, message: Schema.String })),
});
const Incoming = Schema.fromJsonString(
  Schema.Union([RpcServerRequest, RpcNotification, RpcResponse]),
);

/** Mutable bookkeeping shared by the channel's request side and its background fibers. */
interface ChannelState<E> {
  readonly failed: (detail: string) => E;
  readonly outgoing: Queue.Queue<string, Cause.Done>;
  readonly notifications: Queue.Queue<RpcNotification, E | Cause.Done>;
  readonly serverRequests: Queue.Queue<RpcServerRequest, E | Cause.Done>;
  readonly pending: Map<RpcId, Deferred.Deferred<unknown, E | RpcError>>;
  readonly termination: Deferred.Deferred<Cause.Cause<E>>;
  closed: Cause.Cause<E> | undefined;
  nextId: number;
}

const makeState = <E>(unavailable: (end: ChannelEnd) => E) =>
  Effect.gen(function* () {
    const state: ChannelState<E> = {
      failed: (detail) => unavailable({ _tag: "Failed", detail }),
      outgoing: yield* Queue.unbounded<string, Cause.Done>(),
      notifications: yield* Queue.unbounded<RpcNotification, E | Cause.Done>(),
      serverRequests: yield* Queue.unbounded<RpcServerRequest, E | Cause.Done>(),
      pending: new Map(),
      termination: yield* Deferred.make<Cause.Cause<E>>(),
      closed: undefined,
      nextId: 0,
    };
    return state;
  });

/** Records the end cause once, fails every waiting request with it and stops the writer. */
const stopRequests = Effect.fnUntraced(function* <E>(
  state: ChannelState<E>,
  cause: Cause.Cause<E>,
) {
  if (state.closed) return;
  state.closed = cause;
  yield* Deferred.succeed(state.termination, cause);
  for (const deferred of state.pending.values()) yield* Deferred.failCause(deferred, cause);
  state.pending.clear();
  yield* Queue.end(state.outgoing);
});

const endStreams = <E>(state: ChannelState<E>) =>
  Effect.all([Queue.end(state.notifications), Queue.end(state.serverRequests)], { discard: true });

/** Ends the channel with a typed failure; consumers drain what was buffered, then stop. */
const finish = <E>(state: ChannelState<E>, error: E) =>
  state.closed
    ? Effect.void
    : stopRequests(state, Cause.fail(error)).pipe(Effect.andThen(endStreams(state)));

/** Forks background work; a defect or unexpected failure ends the channel with that cause. */
const supervise =
  <E>(state: ChannelState<E>) =>
  (work: Effect.Effect<void>) =>
    work.pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          // Scope close interrupts the fibers after the channel already ended as Closed.
          if (state.closed && Cause.hasInterruptsOnly(cause)) return;
          yield* stopRequests(state, cause);
          yield* Queue.failCause(state.notifications, cause);
          yield* Queue.failCause(state.serverRequests, cause);
        }),
      ),
      Effect.forkScoped,
    );

const send = Effect.fnUntraced(function* <E>(state: ChannelState<E>, message: unknown) {
  if (state.closed) return yield* Effect.failCause(state.closed);
  const line = yield* Schema.encodeEffect(JsonLine)(message).pipe(
    Effect.mapError(() => state.failed("could not encode app server message")),
  );
  yield* Queue.offer(state.outgoing, `${line}\n`);
});

/** Routes one stdout line to a waiting request, the notification queue or the request queue. */
const receive = Effect.fnUntraced(function* <E>(state: ChannelState<E>, line: string) {
  const message = yield* Schema.decodeUnknownEffect(Incoming)(line).pipe(
    Effect.mapError(() => state.failed("invalid app server JSON-RPC message")),
  );
  if ("method" in message) {
    if ("id" in message) yield* Queue.offer(state.serverRequests, message);
    else yield* Queue.offer(state.notifications, message);
    return;
  }
  const deferred = state.pending.get(message.id);
  if (!deferred) return; // A response arriving after cancellation or timeout has no waiter.
  if (message.error) yield* Deferred.fail(deferred, new RpcError(message.error));
  else yield* Deferred.succeed(deferred, message.result);
});

const withTimeout =
  (method: string, timeout: Duration.Input | "none") =>
  <A, E>(reply: Effect.Effect<A, E>): Effect.Effect<A, E | RpcRequestTimeout> =>
    timeout === "none"
      ? reply
      : reply.pipe(
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () =>
              Effect.fail(new RpcRequestTimeout({ method, timeoutMs: Duration.toMillis(timeout) })),
          }),
        );

const makeRequest =
  <E>(state: ChannelState<E>) =>
  <A, I, R>(
    method: string,
    params: unknown,
    result: Schema.Codec<A, I, R>,
    options: RequestOptions = {},
  ) =>
    Effect.gen(function* () {
      if (state.closed) return yield* Effect.failCause(state.closed);
      const id = state.nextId++;
      const deferred = yield* Deferred.make<unknown, E | RpcError>();
      state.pending.set(id, deferred);
      return yield* send(state, { jsonrpc: "2.0", id, method, params }).pipe(
        Effect.andThen(Deferred.await(deferred)),
        withTimeout(method, options.timeout ?? DEFAULT_REQUEST_TIMEOUT),
        Effect.flatMap(Schema.decodeUnknownEffect(result)),
        Effect.ensuring(Effect.sync(() => state.pending.delete(id))),
      );
    });

const spawnChild = <E>(options: ChannelOptions<E>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* spawner
      .spawn(
        ChildProcess.make(options.command, [...options.args], {
          cwd: options.cwd,
          env: options.env,
          extendEnv: false,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          forceKillAfter: FORCE_KILL_AFTER,
        }),
      )
      .pipe(
        Effect.mapError(() =>
          options.unavailable({
            _tag: "Failed",
            detail: `Could not launch ${JSON.stringify(options.command)}.`,
          }),
        ),
      );
  });

type ChildHandle = Effect.Success<ReturnType<typeof spawnChild>>;

const joinWithin = (fiber: Fiber.Fiber<void>) =>
  Fiber.join(fiber).pipe(
    Effect.timeoutOrElse({ duration: DRAIN_AFTER_EXIT, orElse: () => Fiber.interrupt(fiber) }),
  );

/** Forks the stdin writer, stdout reader, stderr forwarder and exit watcher. */
const startPumps = Effect.fnUntraced(function* <E>(
  state: ChannelState<E>,
  handle: ChildHandle,
  options: ChannelOptions<E>,
) {
  const fork = supervise(state);
  yield* Stream.fromQueue(state.outgoing).pipe(
    Stream.encodeText,
    Stream.run(handle.stdin),
    Effect.catch(() => finish(state, state.failed("app server stdin failed"))),
    fork,
  );
  const reader = yield* handle.stdout.pipe(
    Stream.mapError(() => state.failed("app server stdout failed")),
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => receive(state, line)),
    Effect.catch((error) => finish(state, error)),
    fork,
  );
  const stderr = yield* handle.stderr.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach(options.stderr),
    Effect.catch(() => finish(state, state.failed("app server stderr failed"))),
    fork,
  );
  yield* Effect.gen(function* () {
    const code = yield* exitCodeOf(state, handle);
    yield* stopRequests(state, Cause.fail(state.failed(`app server exited with code ${code}`)));
    yield* joinWithin(reader);
    yield* endStreams(state);
    yield* joinWithin(stderr);
  }).pipe(
    Effect.catch((error) => finish(state, error)),
    fork,
  );
});

const exitCodeOf = <E>(state: ChannelState<E>, handle: ChildHandle) =>
  handle.exitCode.pipe(Effect.mapError(() => state.failed("could not observe app server exit")));

/**
 * Spawns the command and opens a channel on its stdio, closed with the caller's scope.
 * @throws E (from `unavailable`) When the command can't be launched.
 */
export const openChannel = Effect.fnUntraced(function* <E>(
  options: ChannelOptions<E>,
): Effect.fn.Return<Channel<E>, E, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner> {
  const handle = yield* spawnChild(options);
  const state = yield* makeState(options.unavailable);
  yield* startPumps(state, handle, options);
  yield* Effect.addFinalizer(() =>
    stopRequests(state, Cause.fail(options.unavailable({ _tag: "Closed" }))).pipe(
      Effect.andThen(endStreams(state)),
    ),
  );
  const channel: Channel<E> = {
    request: makeRequest(state),
    notify: (method, params) =>
      send(
        state,
        params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params },
      ),
    respond: (id, result) => send(state, { jsonrpc: "2.0", id, result }),
    respondError: (id, code, message) =>
      send(state, { jsonrpc: "2.0", id, error: { code, message } }),
    notifications: Stream.fromQueue(state.notifications),
    serverRequests: Stream.fromQueue(state.serverRequests),
    exitCode: exitCodeOf(state, handle),
    termination: Deferred.await(state.termination),
  };
  return channel;
});

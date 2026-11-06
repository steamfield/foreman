import { Cause, Data, Deferred, Duration, Effect, Fiber, Queue, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { CodexUnavailable } from "../errors";
import {
  InitializeParams,
  Method,
  type RpcId,
  RpcNotification,
  RpcResponse,
  RpcServerRequest,
  ThreadResumeParams,
  ThreadStartParams,
  TurnInterruptParams,
  TurnStartParams,
  TurnSteerParams,
} from "../schemas/codex";

export class CodexRpcError extends Schema.TaggedError<CodexRpcError>()("CodexRpcError", {
  code: Schema.Number,
  message: Schema.String,
}) {}

// Internal signal: the supervisor maps it to the existing public CodexUnavailable error.
export class CodexRequestTimeout extends Data.TaggedError("CodexRequestTimeout")<{
  readonly method: string;
  readonly timeoutMs: number;
}> {}

const JsonLine = Schema.fromJsonString(Schema.Unknown);
const Incoming = Schema.fromJsonString(
  Schema.Union([RpcServerRequest, RpcNotification, RpcResponse]),
);
const unavailable = (detail: string) => new CodexUnavailable({ detail });
const paramsSchemas: Readonly<Record<string, Schema.ConstraintEncoder<unknown>>> = {
  [Method.initialize]: InitializeParams,
  [Method.threadStart]: ThreadStartParams,
  [Method.threadResume]: ThreadResumeParams,
  [Method.turnStart]: TurnStartParams,
  [Method.turnSteer]: TurnSteerParams,
  [Method.turnInterrupt]: TurnInterruptParams,
};

export type ConnectionOptions = {
  codexBin: string;
  env: Readonly<Record<string, string>>;
  version: string;
  stderr: (line: string) => Effect.Effect<void>;
};

/** Single-consumer streams buffer even messages sent during initialization. */
export const openConnection = Effect.fn("codex.openConnection")(function* (
  options: ConnectionOptions,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner
    .spawn(
      ChildProcess.make(options.codexBin, ["app-server", "--listen", "stdio://"], {
        env: options.env,
        extendEnv: false,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        forceKillAfter: "2 seconds",
      }),
    )
    .pipe(Effect.mapError(() => unavailable("could not spawn app server")));
  const outgoing = yield* Queue.unbounded<string, Cause.Done>();
  const notifications = yield* Queue.unbounded<typeof RpcNotification.Type, Cause.Done>();
  const serverRequests = yield* Queue.unbounded<typeof RpcServerRequest.Type, Cause.Done>();
  const pending = new Map<RpcId, Deferred.Deferred<unknown, CodexUnavailable | CodexRpcError>>();
  let nextId = 0;
  let closed: Cause.Cause<CodexUnavailable> | undefined;
  const termination = yield* Deferred.make<Cause.Cause<CodexUnavailable>>();

  const stopRequests = Effect.fnUntraced(function* (cause: Cause.Cause<CodexUnavailable>) {
    if (closed) return;
    closed = cause;
    yield* Deferred.succeed(termination, cause);
    for (const deferred of pending.values()) yield* Deferred.failCause(deferred, cause);
    pending.clear();
    yield* Queue.end(outgoing);
  });
  const endStreams = Effect.gen(function* () {
    yield* Queue.end(notifications);
    yield* Queue.end(serverRequests);
  });
  const finish = Effect.fnUntraced(function* (error: CodexUnavailable) {
    if (closed) return;
    yield* stopRequests(Cause.fail(error));
    yield* endStreams;
  });
  const supervise = (work: Effect.Effect<void>) =>
    work.pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          if (closed && Cause.hasInterruptsOnly(cause)) return;
          yield* stopRequests(cause);
          yield* Queue.failCause(notifications, cause);
          yield* Queue.failCause(serverRequests, cause);
        }),
      ),
      Effect.forkScoped,
    );
  const send = Effect.fnUntraced(function* (message: unknown) {
    if (closed) return yield* Effect.failCause(closed);
    const line = yield* Schema.encodeEffect(JsonLine)(message).pipe(
      Effect.mapError(() => unavailable("could not encode app server message")),
    );
    yield* Queue.offer(outgoing, `${line}\n`);
  });
  const receive = Effect.fnUntraced(function* (line: string) {
    const message = yield* Schema.decodeUnknownEffect(Incoming)(line).pipe(
      Effect.mapError(() => unavailable("invalid app server JSON-RPC message")),
    );
    if ("method" in message) {
      if ("id" in message) yield* Queue.offer(serverRequests, message);
      else yield* Queue.offer(notifications, message);
    } else {
      const deferred = pending.get(message.id);
      if (!deferred) return; // A response arriving after cancellation or timeout has no waiter.
      if (message.error) yield* Deferred.fail(deferred, new CodexRpcError(message.error));
      else yield* Deferred.succeed(deferred, message.result);
    }
  });
  const request = <A, I, R>(
    method: string,
    params: unknown,
    resultSchema: Schema.Codec<A, I, R>,
    requestOptions: { timeout?: Duration.Input } = {},
  ) =>
    Effect.gen(function* () {
      if (closed) return yield* Effect.failCause(closed);
      const encodedParams = yield* Schema.encodeUnknownEffect(
        Object.hasOwn(paramsSchemas, method)
          ? (paramsSchemas[method] ?? Schema.Unknown)
          : Schema.Unknown,
      )(params);
      const id = nextId++;
      const deferred = yield* Deferred.make<unknown, CodexUnavailable | CodexRpcError>();
      const timeout = requestOptions.timeout ?? "30 seconds";
      pending.set(id, deferred);
      return yield* send({ jsonrpc: "2.0", id, method, params: encodedParams }).pipe(
        Effect.andThen(Deferred.await(deferred)),
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () =>
            Effect.fail(new CodexRequestTimeout({ method, timeoutMs: Duration.toMillis(timeout) })),
        }),
        Effect.flatMap(Schema.decodeUnknownEffect(resultSchema)),
        Effect.ensuring(
          Effect.sync(() => {
            pending.delete(id);
          }),
        ),
      );
    });

  yield* Stream.fromQueue(outgoing).pipe(
    Stream.encodeText,
    Stream.run(handle.stdin),
    Effect.catch(() => finish(unavailable("app server stdin failed"))),
    supervise,
  );
  const reader = yield* handle.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach(receive),
    Effect.catch((error) =>
      finish(error instanceof CodexUnavailable ? error : unavailable("app server stdout failed")),
    ),
    supervise,
  );
  const stderr = yield* handle.stderr.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach(options.stderr),
    Effect.catch(() => finish(unavailable("app server stderr failed"))),
    supervise,
  );
  const exitCode = handle.exitCode.pipe(
    Effect.mapError(() => unavailable("could not observe app server exit")),
  );
  yield* Effect.gen(function* () {
    const code = yield* exitCode;
    yield* stopRequests(Cause.fail(unavailable(`app server exited with code ${code}`)));
    yield* Fiber.join(reader).pipe(
      Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Fiber.interrupt(reader) }),
    );
    yield* endStreams;
    yield* Fiber.join(stderr).pipe(
      Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Fiber.interrupt(stderr) }),
    );
  }).pipe(Effect.catch(finish), supervise);
  yield* Effect.addFinalizer(() =>
    stopRequests(Cause.fail(unavailable("app server connection closed"))).pipe(
      Effect.andThen(endStreams),
    ),
  );

  yield* request(
    Method.initialize,
    {
      clientInfo: { name: "forman", title: "forman", version: options.version },
      capabilities: { experimentalApi: true },
    },
    Schema.Unknown,
  );
  yield* send({ jsonrpc: "2.0", method: Method.initialized });
  return {
    request,
    notifications: Stream.fromQueue(notifications),
    serverRequests: Stream.fromQueue(serverRequests),
    respond: (id: RpcId, result: unknown) => send({ jsonrpc: "2.0", id, result }),
    respondError: (id: RpcId, code: number, message: string) =>
      send({ jsonrpc: "2.0", id, error: { code, message } }),
    exitCode,
    termination: Deferred.await(termination),
  };
});

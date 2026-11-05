import {
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  FileSystem,
  Path,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect";
import { Socket } from "effect/socket";
import { type AppError, DaemonUnavailable } from "../errors";
import type { DaemonRequestBody, DaemonResult } from "../schemas/daemon";
import { Host } from "../services/host";
import { releaseLock, takeLock } from "./lock";
import { lines, respond, responseJson } from "./protocol";
import { DaemonSockets } from "./sockets";

export interface DaemonOptions {
  readonly dataDir: string;
  readonly version: string;
  readonly handler: (body: DaemonRequestBody) => Effect.Effect<DaemonResult, AppError>;
  readonly busy: Effect.Effect<boolean>;
  readonly idleLimitMs?: number;
}

const awaitIdle = Effect.fn("daemon.awaitIdle")(function* (
  busy: Effect.Effect<boolean>,
  activity: Ref.Ref<{ connections: number; last: number }>,
  limit: number,
) {
  while (true) {
    const now = yield* Clock.currentTimeMillis;
    const active = yield* busy;
    const state = yield* Ref.get(activity);
    if (active || state.connections > 0) {
      yield* Ref.update(activity, (value) => ({ ...value, last: now }));
    } else if (now - state.last >= limit) return;
    yield* Effect.sleep(Math.min(100, Math.max(1, limit)));
  }
});

export const daemon = Effect.fn("daemon")(
  function* (options: DaemonOptions) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const host = yield* Host;
    const sockets = yield* DaemonSockets;
    const socketPath = path.join(options.dataDir, "forman.sock");
    const lock = path.join(options.dataDir, "daemon.lock");
    if (new TextEncoder().encode(socketPath).length > 104) {
      return yield* new DaemonUnavailable({
        detail: `Socket path exceeds 104 bytes: ${socketPath}`,
      });
    }
    yield* fs.makeDirectory(options.dataDir, { recursive: true });
    const identity = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        if (!(yield* takeLock(options.dataDir, socketPath))) return undefined;
        return yield* fs.stat(lock);
      }),
      (identity) =>
        identity === undefined
          ? Effect.void
          : releaseLock(options.dataDir, socketPath, identity).pipe(Effect.orDie),
    );
    if (identity === undefined) return;
    yield* fs.remove(socketPath, { force: true });
    const activity = yield* Ref.make({ connections: 0, last: yield* Clock.currentTimeMillis });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const listener = yield* Effect.acquireRelease(Scope.make(), (scope) =>
          Scope.close(scope, Exit.void),
        );
        const server = yield* sockets.listen(socketPath).pipe(Scope.provide(listener));
        const shutdown = yield* Deferred.make<void>();
        let drainUntil: number | null = null;
        const serve = server.run((socket) =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* Effect.acquireRelease(
                Clock.currentTimeMillis.pipe(
                  Effect.flatMap((last) =>
                    Ref.update(activity, (state) => ({
                      connections: state.connections + 1,
                      last,
                    })),
                  ),
                ),
                () =>
                  Clock.currentTimeMillis.pipe(
                    Effect.flatMap((last) =>
                      Ref.update(activity, (state) => ({
                        connections: state.connections - 1,
                        last,
                      })).pipe(Effect.andThen(Effect.logDebug("daemon.connection.closed"))),
                    ),
                  ),
              );
              const reader = yield* socket.reader;
              const writer = yield* socket.writer;
              yield* Effect.addFinalizer(() =>
                Effect.gen(function* () {
                  if (drainUntil === null) return;
                  yield* Effect.sleep(Math.max(0, drainUntil - (yield* Clock.currentTimeMillis)));
                  yield* writer
                    .write(new Socket.CloseEvent())
                    .pipe(
                      Effect.catchTag("SocketError", () =>
                        Effect.logDebug("daemon.connection.close.failed"),
                      ),
                    );
                }),
              );
              const requests = yield* FiberSet.make<
                void,
                Schema.SchemaError | Socket.SocketError
              >();
              const reading = lines(reader).pipe(
                Stream.runForEach((line) =>
                  FiberSet.run(
                    requests,
                    Effect.suspend(() => {
                      let stopping = false;
                      return Effect.gen(function* () {
                        const response = yield* respond(line, (request) => {
                          if (request.body._tag === "Ping")
                            return Effect.succeed({
                              _tag: "Pong",
                              version: options.version,
                              pid: host.pid,
                            });
                          const handled = options.handler(request.body).pipe(
                            Effect.tap((result) =>
                              Effect.sync(() => {
                                stopping = request.body._tag === "Shutdown" && result._tag === "Ok";
                              }),
                            ),
                          );
                          return request.body._tag === "Shutdown"
                            ? Effect.uninterruptible(handled)
                            : handled;
                        });
                        const json = yield* Schema.encodeEffect(responseJson)(response);
                        yield* writer.write(`${json}\n`);
                      }).pipe(
                        Effect.ensuring(
                          Effect.suspend(() =>
                            stopping ? Deferred.succeed(shutdown, undefined) : Effect.void,
                          ),
                        ),
                      );
                    }),
                  ),
                ),
              );
              yield* Effect.raceFirst(reading, FiberSet.join(requests)).pipe(
                Effect.catchTag("SocketError", (error) =>
                  error.reason._tag === "SocketCloseError"
                    ? Effect.void
                    : Effect.logDebug("daemon.connection.closed", { reason: error.reason._tag }),
                ),
              );
            }),
          ),
        );
        const serving = yield* Effect.forkScoped(serve);
        yield* Effect.raceFirst(
          Fiber.join(serving),
          Effect.raceFirst(
            awaitIdle(options.busy, activity, options.idleLimitMs ?? 1_800_000),
            Deferred.await(shutdown),
          ),
        );
        yield* Effect.gen(function* () {
          // Closing starts synchronously, refusing new clients before dispatch is interrupted.
          // The close callback waits for existing clients, so join it after cancelling dispatch.
          // One deadline bounds output draining across all accepted connections.
          drainUntil = (yield* Clock.currentTimeMillis) + 100;
          const closing = yield* Effect.forkChild(Scope.close(listener, Exit.void), {
            startImmediately: true,
          });
          yield* Fiber.interrupt(serving);
          yield* Fiber.join(closing);
        }).pipe(Effect.uninterruptible);
      }),
    );
  },
  Effect.scoped,
  Effect.mapError((error) =>
    error._tag === "DaemonUnavailable"
      ? error
      : new DaemonUnavailable({ detail: `Daemon startup or listener failed: ${error._tag}` }),
  ),
);

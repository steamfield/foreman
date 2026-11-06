import {
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  FileSystem,
  Path,
  PlatformError,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect";
import { Socket } from "effect/socket";
import { type AppError, DaemonUnavailable } from "../errors";
import type { DaemonRequestBody, DaemonResult } from "../schemas/daemon";
import { Host } from "../services/host";
import { recordOwner, releaseLock, takeLock } from "./lock";
import { lines, respond, responseJson } from "./protocol";
import { DaemonSockets } from "./sockets";

export interface DaemonOptions {
  readonly dataDir: string;
  readonly version: string;
  readonly handler: (body: DaemonRequestBody) => Effect.Effect<DaemonResult, AppError>;
  readonly busy: Effect.Effect<boolean>;
  readonly shutdown?: Effect.Effect<void>;
  readonly idleLimitMs?: number;
  readonly codexBin?: string;
  readonly codexHome?: string;
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
    if (new TextEncoder().encode(socketPath).length > 104) {
      return yield* new DaemonUnavailable({
        detail: `Socket path exceeds 104 bytes: ${socketPath}`,
      });
    }
    yield* fs.makeDirectory(options.dataDir, { recursive: true, mode: 0o700 });
    yield* fs.chmod(options.dataDir, 0o700);
    if (!(yield* takeLock(options.dataDir))) return;
    yield* Effect.addFinalizer(() => releaseLock(options.dataDir, socketPath).pipe(Effect.orDie));
    yield* Effect.addFinalizer(() => options.shutdown ?? Effect.void);
    yield* recordOwner(options.dataDir);
    yield* fs.remove(socketPath, { force: true });
    const activity = yield* Ref.make({ connections: 0, last: yield* Clock.currentTimeMillis });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const listener = yield* Effect.acquireRelease(Scope.make(), (scope) =>
          Scope.close(scope, Exit.void),
        );
        const server = yield* sockets.listen(socketPath).pipe(Scope.provide(listener));
        yield* Effect.logInfo("daemon.started");
        yield* Effect.addFinalizer(() => Effect.logInfo("daemon.stopped"));
        const shutdown = yield* Deferred.make<void>();
        let drainUntil: number | null = null;
        let orderly = false;
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
                              build: host.build,
                              ...(options.codexBin === undefined
                                ? {}
                                : { codexBin: options.codexBin }),
                              ...(options.codexHome === undefined
                                ? {}
                                : { codexHome: options.codexHome }),
                            });
                          if (request.body._tag === "Shutdown") {
                            return Effect.gen(function* () {
                              const result = yield* options.handler(request.body);
                              stopping = result._tag === "Ok";
                              return result;
                            }).pipe(Effect.uninterruptible);
                          }
                          return options.handler(request.body);
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
                    : Effect.logDebug("daemon.connection.closed").pipe(
                        Effect.annotateLogs({ reason: error.reason._tag }),
                      ),
                ),
              );
            }),
          ),
        );
        const serving = yield* Effect.acquireRelease(Effect.forkScoped(serve), (serving) =>
          Effect.gen(function* () {
            // Closing starts synchronously, refusing new clients before dispatch is interrupted.
            // The close callback waits for existing clients, so join it after cancelling dispatch.
            // One deadline bounds output draining across all accepted connections.
            drainUntil = (yield* Clock.currentTimeMillis) + (orderly ? 100 : 0);
            const closing = yield* Effect.forkChild(Scope.close(listener, Exit.void), {
              startImmediately: true,
            });
            yield* Fiber.interrupt(serving);
            yield* Fiber.join(closing);
          }),
        );
        yield* Effect.raceFirst(
          Fiber.join(serving),
          Effect.raceFirst(
            awaitIdle(options.busy, activity, options.idleLimitMs ?? 1_800_000),
            Deferred.await(shutdown),
          ),
        );
        orderly = true;
      }),
    );
  },
  Effect.scoped,
  Effect.mapError((error) =>
    error._tag === "DaemonUnavailable"
      ? error
      : new DaemonUnavailable({
          detail: PlatformError.isPlatformError(error)
            ? `Daemon startup failed: ${error.reason.method} (${error.reason._tag})${"pathOrDescriptor" in error.reason ? `: ${error.reason.pathOrDescriptor}` : ""}. Check home permissions and logs/daemon.jsonl.`
            : `Daemon startup or listener failed: ${error._tag} (${error.reason._tag}). Check the socket path and logs/daemon.jsonl.`,
        }),
  ),
);

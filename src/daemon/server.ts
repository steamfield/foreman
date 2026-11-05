import {
  Clock,
  Effect,
  Exit,
  FiberSet,
  FileSystem,
  Path,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect";
import type { Socket } from "effect/socket";
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
              const requests = yield* FiberSet.make<
                void,
                Schema.SchemaError | Socket.SocketError
              >();
              const reading = lines(reader).pipe(
                Stream.runForEach((line) =>
                  FiberSet.run(
                    requests,
                    respond(line, (request) =>
                      request.body._tag === "Ping"
                        ? Effect.succeed({ _tag: "Pong", version: options.version, pid: host.pid })
                        : options.handler(request.body),
                    ).pipe(
                      Effect.flatMap((response) => Schema.encodeEffect(responseJson)(response)),
                      Effect.flatMap((json) => writer.write(`${json}\n`)),
                    ),
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
        yield* Effect.raceFirst(
          serve,
          awaitIdle(options.busy, activity, options.idleLimitMs ?? 1_800_000).pipe(
            Effect.andThen(Scope.close(listener, Exit.void)),
          ),
        );
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

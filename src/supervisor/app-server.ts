import { Effect, Exit, FileSystem, Path, Scope, Semaphore, Stream } from "effect";
import { checkProtocol } from "../codex/check";
import { openConnection } from "../codex/client";
import { appServerEnvironment } from "../codex/environment";
import type { AppConfig } from "../config";
import { probeSsh } from "../core/preflight/ssh";
import { CodexUnavailable } from "../errors";
import type * as Codex from "../schemas/codex";
import type { Registry } from "./registry";

export type Connection = Effect.Success<ReturnType<typeof openConnection>>;
export interface AppServer {
  readonly generation: symbol;
  readonly scope: Scope.Closeable;
  readonly connection: Connection;
  readonly loaded: Set<string>;
}

// Shared by the daemon logger and app-server stderr; serialized independently per file.
export const makeLogAppender = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lock = yield* Semaphore.make(1);
  return (text: string) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        const info = yield* fs
          .stat(file)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)));
        if (info !== null && info.size > 5_000_000n) yield* fs.rename(file, `${file}.1`);
        yield* fs.writeFileString(file, text, { flag: "a" });
      }),
    );
});

export const makeAppServer = Effect.fn("supervisor.appServer")(function* (
  config: AppConfig["Service"],
  version: string,
  registry: Registry,
  notify: (
    server: AppServer,
    message: typeof Codex.RpcNotification.Type,
  ) => Effect.Effect<
    void,
    unknown,
    | FileSystem.FileSystem
    | Path.Path
    | import("effect/process").ChildProcessSpawner.ChildProcessSpawner
  >,
  request: (
    server: AppServer,
    message: typeof Codex.RpcServerRequest.Type,
  ) => Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path>,
) {
  const owner = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const path = yield* Path.Path;
  const append = yield* makeLogAppender(path.join(config.dataDir, "logs/app-server.log"));
  const env = yield* Effect.cached(
    probeSsh(config.inheritedEnvironment).pipe(
      Effect.map((ssh) => appServerEnvironment(config.inheritedEnvironment, ssh)),
    ),
  );
  const protocolWarning = yield* Effect.cached(
    Effect.gen(function* () {
      const result = yield* checkProtocol(config.codexBin, yield* env).pipe(
        Effect.scoped,
        Effect.timeout("5 seconds"),
        Effect.result,
      );
      if (result._tag === "Failure")
        return "Could not check the Codex protocol; compatibility is unverified.";
      return result.success.matches
        ? null
        : "Codex protocol differs from the supported version; compatibility is unverified.";
    }),
  );
  let current: AppServer | undefined;
  const disconnected = Effect.fnUntraced(function* (server: AppServer) {
    if (current !== server) return;
    current = undefined;
    const affected = [...registry.runs.values()].filter(
      (run) => run.serverGeneration === server.generation,
    );
    yield* Scope.close(server.scope, Exit.void);
    for (const run of affected)
      yield* run.lock.withPermits(1)(
        Effect.gen(function* () {
          if (
            run.serverGeneration === server.generation &&
            registry.runs.get(run.record.name) === run
          )
            yield* registry.lost(run);
        }),
      );
  });
  const get = lock.withPermits(1)(
    Effect.gen(function* () {
      if (current) return current;
      const scope = yield* Scope.fork(owner);
      const connection = yield* openConnection({
        codexBin: config.codexBin,
        env: yield* env,
        version,
        stderr: (line) =>
          append(`${line}\n`).pipe(
            Effect.catch(() => Effect.logWarning("supervisor.appServer.stderr.unavailable")),
          ),
      }).pipe(
        Scope.provide(scope),
        Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)),
      );
      const server: AppServer = { connection, generation: Symbol(), scope, loaded: new Set() };
      current = server;
      yield* connection.notifications.pipe(
        Stream.runForEach((message) =>
          notify(server, message).pipe(
            Effect.catch((error) =>
              error instanceof CodexUnavailable ? Effect.void : Effect.fail(error),
            ),
          ),
        ),
        Effect.andThen(disconnected(server)),
        registry.fork,
      );
      yield* connection.serverRequests.pipe(
        Stream.runForEach((message) =>
          request(server, message).pipe(
            Effect.catch((error) =>
              error instanceof CodexUnavailable ? Effect.void : Effect.fail(error),
            ),
          ),
        ),
        registry.fork,
      );
      return server;
    }),
  );
  return { get, protocolWarning };
});
export type AppServers = Effect.Success<ReturnType<typeof makeAppServer>>;

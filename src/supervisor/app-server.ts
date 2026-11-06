import { Effect, Exit, type FileSystem, Path, Scope, Semaphore, Stream } from "effect";
import { checkProtocol } from "../codex/check";
import { openConnection } from "../codex/client";
import { appServerEnvironment } from "../codex/environment";
import type { AppConfig } from "../config";
import { probeSsh } from "../core/preflight/ssh";
import { CodexUnavailable } from "../errors";
import { makeLogAppender } from "../logging";
import type * as Codex from "../schemas/codex";
import type { Registry } from "./registry";

export type Connection = Effect.Success<ReturnType<typeof openConnection>>;
export interface AppServer {
  readonly generation: symbol;
  readonly scope: Scope.Closeable;
  readonly connection: Connection;
  readonly loaded: Set<string>;
}

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
  const append = yield* makeLogAppender(path.join(config.home, "logs/app-server.log"));
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
      yield* registry.enqueue(
        run,
        Effect.gen(function* () {
          if (run.serverGeneration === server.generation && registry.isCurrent(run))
            yield* registry.lost(run);
        }),
      );
  });
  const get = lock.withPermits(1)(
    Effect.gen(function* () {
      if (current) return current;
      const scope = yield* Scope.fork(owner);
      const opened = yield* openConnection({
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
      const rpcRequest: Connection["request"] = (method, params, schema, options) =>
        opened.request(method, params, schema, options).pipe(
          Effect.catchTag("SchemaError", () =>
            Effect.fail(
              new CodexUnavailable({
                detail:
                  "Codex reply did not match the supported protocol; run forman doctor and check the Codex version.",
              }),
            ),
          ),
        );
      const connection = { ...opened, request: rpcRequest };
      const server: AppServer = { connection, generation: Symbol(), scope, loaded: new Set() };
      current = server;
      yield* connection.notifications.pipe(
        Stream.runForEach((message) => notify(server, message)),
        Effect.catch((error) =>
          error instanceof CodexUnavailable ? Effect.void : Effect.fail(error),
        ),
        Effect.andThen(disconnected(server)),
        registry.fork,
      );
      yield* connection.serverRequests.pipe(
        Stream.runForEach((message) => request(server, message)),
        Effect.catch((error) =>
          error instanceof CodexUnavailable ? Effect.void : Effect.fail(error),
        ),
        registry.fork,
      );
      return server;
    }),
  );
  return { get, protocolWarning, environment: env };
});
export type AppServers = Effect.Success<ReturnType<typeof makeAppServer>>;

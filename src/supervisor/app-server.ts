import { Effect, FileSystem, Path, Scope, Semaphore, Stream } from "effect";
import { checkProtocol } from "../codex/check";
import { openConnection } from "../codex/client";
import { appServerEnvironment } from "../codex/environment";
import type { AppConfig } from "../config";
import { probeSsh } from "../core/preflight/ssh";
import type * as Codex from "../schemas/codex";
import type { Registry } from "./registry";

export type Connection = Effect.Success<ReturnType<typeof openConnection>>;
export interface AppServer {
  readonly connection: Connection;
  readonly loaded: Set<string>;
}

// Shared by the daemon logger and app-server stderr; serialized independently per file.
export const makeLogAppender = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lock = yield* Semaphore.make(1);
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  return (text: string) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
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
    for (const run of registry.runs.values()) yield* run.lock.withPermits(1)(registry.lost(run));
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
      }).pipe(Scope.provide(scope));
      const server: AppServer = { connection, loaded: new Set() };
      current = server;
      yield* connection.notifications.pipe(
        Stream.runForEach((message) => notify(server, message)),
        Effect.catch(() => Effect.logError("supervisor.notifications.failed")),
        Effect.andThen(disconnected(server)),
        Effect.forkIn(scope),
      );
      yield* connection.serverRequests.pipe(
        Stream.runForEach((message) => request(server, message)),
        Effect.catch(() =>
          Effect.logError("supervisor.requests.failed").pipe(Effect.andThen(disconnected(server))),
        ),
        Effect.forkIn(scope),
      );
      return server;
    }),
  );
  return { get, protocolWarning };
});
export type AppServers = Effect.Success<ReturnType<typeof makeAppServer>>;
